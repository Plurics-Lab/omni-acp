import { OmniACP, type Server, type TurnResult } from "@omni-acp/client";
import type { EventEnvelope } from "@omni-acp/protocol";
import { describe, expect, it } from "vitest";
import {
  createWireDaemon,
  crashingTurn,
  fetchOf,
  type ScriptItem,
  type WireDaemon,
} from "./support/wire-daemon.js";

async function connected(wire: WireDaemon): Promise<Server> {
  return OmniACP.connect({ url: wire.url, token: wire.token, fetch: fetchOf(wire.daemon) });
}

/** The seq of a turn's `state_update{running}` — what `PromptAccepted.seq` carries. */
function runningSeq(envelopes: readonly EventEnvelope[]): number {
  const running = envelopes.find(
    (e) =>
      e.kind === "acp.session_update" &&
      (e.payload as unknown as Record<string, unknown>)["sessionUpdate"] === "state_update" &&
      (e.payload as unknown as Record<string, unknown>)["state"] === "running",
  );
  if (running === undefined) throw new Error("the log has no state_update{running}");
  return running.seq;
}

describe("Worker.prompt", () => {
  it("returns a TurnResult deep-equal to GET /v1/workers/{id}/turns/{turnId}'s result", async () => {
    // WP-6 acceptance 2: the shared-`reduceTurn` guarantee (DESIGN §5.5) asserted directly.
    // One pure fold, two callers, so polling and the SDK cannot disagree.
    const wire = createWireDaemon();
    const server = await connected(wire);
    const worker = await server.attach(wire.createWorker().workerId);

    const result = await worker.prompt("who are you?");
    const status = await worker.turn(result.turnId);

    expect(status.state).toBe("completed");
    expect(status.result).toEqual(result);
    expect(status.stopReason).toBe("end_turn");
    expect(result.text).toContain("I'll skip the configuration update.");
    expect(result.toolCalls.map((t) => t.toolCallId)).toEqual(["call_1", "call_2"]);
    expect(result.interactions).toEqual([
      {
        requestId: "req_1",
        title: "Modifying critical configuration file",
        decision: "deny",
        rule: "m0:auto-deny",
        optionId: "reject",
        at: expect.any(String) as unknown as string,
      },
    ]);
    expect(result.changes).toEqual([]);
    expect(result.patch).toBeNull();
    expect(result.error).toBeNull();
    expect(result.usage).toEqual({ used: 1_234, size: 200_000 });
  });

  it("subscribes with since = accepted.seq - 1, so a turn written before the subscription is complete", async () => {
    // WP-6 acceptance 3, first half. The wire fixture writes the WHOLE turn synchronously inside
    // the POST handler, so nothing at all reaches the client through the live tail: everything
    // it returns arrived by replay, and one-off-by-one in the cursor loses `state_update{running}`.
    const wire = createWireDaemon({ emit: "sync" });
    const server = await connected(wire);
    const snapshot = wire.createWorker();
    const worker = await server.attach(snapshot.workerId);

    const result = await worker.prompt("who are you?");

    const expected = runningSeq(wire.envelopes(snapshot.workerId)) - 1;
    expect(wire.connections).toEqual([{ since: expected, workerId: snapshot.workerId }]);
    expect(result.stopReason).toBe("end_turn");
  });

  it("settles when the worker closes mid-turn instead of waiting for an idle that never comes", async () => {
    // WP-6 acceptance 3, second half (CONTRACTS.md §7.3). `stopReason` stays null rather than
    // becoming a lie, and `error` carries the reason the turn actually ended.
    const wire = createWireDaemon({ emit: "async", stepMs: 1 });
    const server = await connected(wire);
    const snapshot = wire.createWorker({ script: crashingTurn() });
    const worker = await server.attach(snapshot.workerId);

    const result = await worker.prompt("who are you?");

    expect(result.stopReason).toBeNull();
    expect(result.text).toBe("about to crash");
    expect(result.error).toEqual({ code: "agent_error", message: "agent exited with code 1" });
    const kinds = wire.envelopes(snapshot.workerId).map((e) => e.kind);
    expect(kinds).toContain("omni.worker_state");
    // The crash rule: no fabricated idle anywhere in the log.
    const idles = wire
      .envelopes(snapshot.workerId)
      .filter((e) => (e.payload as unknown as Record<string, unknown>)["state"] === "idle");
    expect(idles).toEqual([]);
  });

  it("surfaces 409 as OmniError('worker_busy') when {queue:false}", async () => {
    // WP-6 acceptance 5, first half (D30): opting out of the SDK's serialization is how a caller
    // asks to SEE the daemon's answer rather than to be protected from it.
    const wire = createWireDaemon({ emit: "async", stepMs: 5 });
    const server = await connected(wire);
    const worker = await server.attach(wire.createWorker().workerId);

    const first = worker.prompt("one", { queue: false });
    await expect(worker.prompt("two", { queue: false })).rejects.toMatchObject({
      code: "worker_busy",
      status: 409,
    });
    await first;
  });

  it("runs two back-to-back prompts in order with the default {queue:true}", async () => {
    // WP-6 acceptance 5, second half. DESIGN §9.1 is explicit that a worker takes one turn at a
    // time; the SDK's five-line promise chain is what makes that the caller's default rather
    // than the caller's problem.
    const wire = createWireDaemon({ emit: "async", stepMs: 1 });
    const server = await connected(wire);
    const snapshot = wire.createWorker();
    const worker = await server.attach(snapshot.workerId);

    const results = await Promise.all([worker.prompt("one"), worker.prompt("two")]);

    expect(results).toHaveLength(2);
    expect(results[0]?.turnId).not.toBe(results[1]?.turnId);
    for (const r of results) expect(r.stopReason).toBe("end_turn");

    // In order, on the log: turn 1's idle precedes turn 2's running.
    const log = wire.envelopes(snapshot.workerId);
    const firstIdle = log.findIndex(
      (e) =>
        e.turnId === results[0]?.turnId &&
        (e.payload as unknown as Record<string, unknown>)["state"] === "idle",
    );
    const secondRunning = log.findIndex(
      (e) =>
        e.turnId === results[1]?.turnId &&
        (e.payload as unknown as Record<string, unknown>)["state"] === "running",
    );
    expect(firstIdle).toBeGreaterThanOrEqual(0);
    expect(secondRunning).toBeGreaterThan(firstIdle);
  });

  it("turns a bare string into a single type:'text' block and rejects anything else", async () => {
    // M0 accepts only `type:"text"` (CONTRACTS.md §2.3, review R12); everything past that is a
    // path surface M2 has to contain first.
    const wire = createWireDaemon();
    const server = await connected(wire);
    const worker = await server.attach(wire.createWorker().workerId);

    await worker.prompt("hello");
    await expect(
      worker.prompt({ type: "image", data: "x", mimeType: "image/png" } as never),
    ).rejects.toMatchObject({ code: "bad_request" });
    await expect(worker.prompt([] as never)).rejects.toMatchObject({ code: "bad_request" });
  });

  it("closes its SSE subscription the moment the turn goes terminal", async () => {
    // A subscription that outlives its reader is the classic SSE memory leak, and it is per
    // reconnect, so it compounds (CONTRACTS.md §8.4 "Abort").
    const wire = createWireDaemon({ emit: "async", stepMs: 1 });
    const server = await connected(wire);
    const snapshot = wire.createWorker();
    const worker = await server.attach(snapshot.workerId);

    await worker.prompt("who are you?");

    expect(wire.subscriberCount(snapshot.workerId)).toBe(0);
  });

  it("reports a rejected turn without inventing a stopReason", async () => {
    // `prompt_error`: the agent answered with a JSON-RPC error but is still alive, so the turn
    // ends cleanly with `stopReason: null` and an error body (CONTRACTS.md §7.3, last paragraph).
    const script: ScriptItem[] = [
      { kind: "text", text: "trying" },
      {
        kind: "error",
        body: {
          code: "agent_error",
          message: "model refused",
          acp: { code: -32000, message: "refused", data: { reason: "policy" } },
        },
      },
      { kind: "idle", stopReason: null },
    ];
    const wire = createWireDaemon({ emit: "async", stepMs: 1 });
    const server = await connected(wire);
    const snapshot = wire.createWorker({ script });
    const worker = await server.attach(snapshot.workerId);

    const result: TurnResult = await worker.prompt("go");

    expect(result.stopReason).toBeNull();
    expect(result.error).toEqual({
      code: "agent_error",
      message: "model refused",
      // `acp` is the agent's own JSON-RPC error, passed through verbatim (CONTRACTS.md §9).
      acp: { code: -32000, message: "refused", data: { reason: "policy" } },
    });
    expect(await worker.turn(result.turnId)).toMatchObject({ state: "failed", result });
  });
});
