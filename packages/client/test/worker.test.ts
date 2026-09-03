import { OmniACP, type Worker } from "@omni-acp/client";
import type { EventEnvelope, WorkerSnapshot, WorkerState } from "@omni-acp/protocol";
import { describe, expect, it } from "vitest";
import { createWireDaemon, fetchOf, type WireDaemon } from "./support/wire-daemon.js";

async function attached(wire: WireDaemon, workerId: string): Promise<Worker> {
  const server = await OmniACP.connect({
    url: wire.url,
    token: wire.token,
    fetch: fetchOf(wire.daemon),
  });
  return server.attach(workerId);
}

describe("Worker handle", () => {
  it("exposes the snapshot it was created from and keeps it current from the log", async () => {
    const wire = createWireDaemon({ emit: "async", stepMs: 1 });
    const snapshot = wire.createWorker();
    const worker = await attached(wire, snapshot.workerId);

    expect(worker.id).toBe(snapshot.workerId);
    expect(worker.ref).toBe(`${snapshot.daemonId}:${snapshot.workerId}`);
    expect(worker.daemonId).toBe(snapshot.daemonId);
    expect(worker.agentId).toBe("example");
    expect(worker.state).toBe("ready");
    expect(worker.sessionId).toBe(snapshot.sessionId);

    const states: WorkerState[] = [];
    worker.on("state", (s) => states.push(s));
    await worker.prompt("who are you?");

    // The handle followed the worker through the turn without a second round trip.
    expect(states).toContain("running");
    expect(worker.snapshot.headSeq).toBeGreaterThan(snapshot.headSeq);
  });

  it("reports the last state it OBSERVED, and a fresh attach() re-reads it", async () => {
    // Documented behaviour, pinned so it stays a decision: `state` is a cached projection of the
    // envelopes this handle has read, never a hidden network call on a property access. A
    // handle that only ran `prompt()` stops reading at the turn's `idle`, so it has not yet seen
    // the worker return to `ready`.
    const wire = createWireDaemon({ emit: "async", stepMs: 1 });
    const server = await OmniACP.connect({
      url: wire.url,
      token: wire.token,
      fetch: fetchOf(wire.daemon),
    });
    const snapshot = wire.createWorker();
    const quiet = await server.attach(snapshot.workerId);

    await quiet.prompt("who are you?");
    expect(quiet.state).toBe("running");

    const fresh = await server.attach(snapshot.workerId);
    expect(fresh.state).toBe("ready");
  });

  it("delivers every envelope to on('event') exactly once, even with two streams open", async () => {
    // A background tail and a prompt's own subscription overlap by construction. The emitter's
    // high-water mark is what turns two deliveries into one notification.
    const wire = createWireDaemon({ emit: "async", stepMs: 1 });
    const snapshot = wire.createWorker();
    const worker = await attached(wire, snapshot.workerId);

    const seen: EventEnvelope[] = [];
    worker.on("event", (e) => seen.push(e)); // starts the background tail
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    await worker.prompt("who are you?");
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    const seqs = seen.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it("does not open a stream for a handle nobody listens to", async () => {
    const wire = createWireDaemon();
    const snapshot = wire.createWorker();
    const worker = await attached(wire, snapshot.workerId);

    expect(worker.id).toBe(snapshot.workerId);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    expect(wire.connections).toEqual([]);
    expect(wire.subscriberCount(snapshot.workerId)).toBe(0);
  });

  it("resolves `closed` with the final snapshot when the worker dies", async () => {
    const wire = createWireDaemon({ emit: "async", stepMs: 1 });
    const snapshot = wire.createWorker();
    const worker = await attached(wire, snapshot.workerId);

    const closed: Promise<WorkerSnapshot> = worker.closed;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    wire.closeWorker(snapshot.workerId, "agent_crashed");

    const final = await closed;
    expect(final.state).toBe("closed");
    expect(final.closeReason).toBe("agent_crashed");
    expect(final.process).toBeNull();
  });

  it("returns a CloseResult from close() and reports it in the snapshot", async () => {
    const wire = createWireDaemon();
    const snapshot = wire.createWorker();
    const worker = await attached(wire, snapshot.workerId);

    const result = await worker.close();

    expect(result).toEqual({
      workerId: snapshot.workerId,
      state: "closed",
      reason: "client_request",
      leaderExited: true,
      // Never optimistic: `treeGone` means the whole tree is PROVABLY gone (D10, §6.6).
      treeGone: process.platform !== "win32",
    });
    expect(worker.state).toBe("closed");
    expect(await worker.closed).toMatchObject({ state: "closed" });
  });

  it("is a no-op cancel and a 202, idempotently", async () => {
    const wire = createWireDaemon();
    const worker = await attached(wire, wire.createWorker().workerId);

    await expect(worker.cancel()).resolves.toBeUndefined();
    await expect(worker.cancel()).resolves.toBeUndefined();
    expect(wire.requests.filter((r) => r.path.endsWith("/cancel"))).toHaveLength(2);
  });

  it("rejects a malformed turn id before it reaches the wire", async () => {
    const wire = createWireDaemon();
    const worker = await attached(wire, wire.createWorker().workerId);

    await expect(worker.turn("not-a-turn")).rejects.toMatchObject({ code: "bad_request" });
    expect(wire.requests.some((r) => r.path.includes("/turns/"))).toBe(false);
  });

  it("reports an unknown turn as state 'unknown' rather than an error (D29)", async () => {
    const wire = createWireDaemon();
    const worker = await attached(wire, wire.createWorker().workerId);

    const status = await worker.turn("t_00000000000000000000009999");

    expect(status).toEqual({
      turnId: "t_00000000000000000000009999",
      state: "unknown",
      startSeq: null,
      endSeq: null,
      stopReason: null,
      result: null,
    });
  });

  it("lets a listener throw without killing the reader", async () => {
    const wire = createWireDaemon({ emit: "async", stepMs: 1 });
    const snapshot = wire.createWorker();
    const worker = await attached(wire, snapshot.workerId);

    const errors: unknown[] = [];
    worker.on("error", (e) => errors.push(e));
    worker.on("event", () => {
      throw new Error("listener blew up");
    });

    const result = await worker.prompt("who are you?");

    expect(result.stopReason).toBe("end_turn");
    expect(errors.length).toBeGreaterThan(0);
  });

  it("stops notifying after the unsubscribe function is called", async () => {
    const wire = createWireDaemon({ emit: "async", stepMs: 1 });
    const worker = await attached(wire, wire.createWorker().workerId);

    let count = 0;
    const off = worker.on("event", () => {
      count += 1;
    });
    await worker.prompt("who are you?");
    const afterFirst = count;
    expect(afterFirst).toBeGreaterThan(0);

    off();
    await worker.prompt("again");
    expect(count).toBe(afterFirst);
  });
});
