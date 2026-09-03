import { describe, expect, it } from "vitest";
import { OmniError, type EventEnvelope, type WorkerState } from "@omni-acp/protocol";
import { scriptedAgent } from "@omni-acp/testkit";
import {
  controlledProcess,
  fixedSupervisor,
  flush,
  harness,
  OWNER,
  recordingLease,
  tapWrites,
  TEXT,
} from "./support/harness.js";
import { asScriptedAgent, rawAgent } from "./support/raw-agent.js";

const isStateUpdate = (e: EventEnvelope, state: string): boolean =>
  e.kind === "acp.session_update" &&
  (e.payload as unknown as Record<string, unknown>)["sessionUpdate"] === "state_update" &&
  (e.payload as unknown as Record<string, unknown>)["state"] === state;

describe("prompt — the running marker and the cursor it defines", () => {
  it("appends state_update{running} BEFORE the prompt bytes reach stdin (acceptance 2)", async () => {
    // A tapped writable records every outbound method in the SAME array the log records appends
    // into, so the interleaving is an observation rather than an inference.
    const h = harness();
    const agent = scriptedAgent();
    const proc = controlledProcess(tapWrites(agent.stream, h.trace));
    const w = await h.create({
      overrides: { supervisor: fixedSupervisor(proc, h.supervisor.platform) },
    });

    h.trace.length = 0;
    await w.prompt([TEXT("hello")], OWNER);
    await flush();

    const appendedRunning = h.trace.indexOf("append:acp.session_update");
    const wrotePrompt = h.trace.indexOf("write:session/prompt");
    expect(appendedRunning).toBeGreaterThanOrEqual(0);
    expect(wrotePrompt).toBeGreaterThanOrEqual(0);
    // §7.1: append is synchronous and the write is not, so appending first is SUFFICIENT — and
    // it is what makes `PromptAccepted.seq - 1` a sound subscription cursor.
    expect(appendedRunning).toBeLessThan(wrotePrompt);
  });

  it("PromptAccepted.seq is the seq of that state_update{running} (acceptance 3)", async () => {
    const h = harness();
    const agent = scriptedAgent();
    h.supervisor.enqueue(agent);
    const w = await h.create();

    const accepted = await w.prompt([TEXT("hello")], OWNER);
    const running = h.log.all.find((e) => isStateUpdate(e, "running"));
    expect(running?.seq).toBe(accepted.seq);
    expect(running?.turnId).toBe(accepted.turnId);
    expect(running?.payloadVersion).toBe(2);

    // The cursor property itself: subscribing at seq-1 hands you the running marker first, so no
    // part of the turn can slip past a client that prompted and then subscribed.
    const fromCursor = h.log.read(accepted.seq - 1);
    expect(fromCursor[0]?.seq).toBe(accepted.seq);
    expect(isStateUpdate(fromCursor[0]!, "running")).toBe(true);
  });

  it("orders the turn's events running < every agent update < idle", async () => {
    const h = harness();
    const agent = scriptedAgent();
    h.supervisor.enqueue(agent);
    const w = await h.create();

    const accepted = await w.prompt([TEXT("hello")], OWNER);
    await flush();
    await agent.emitChunk("one");
    await agent.emitChunk("two");
    agent.resolvePrompt("end_turn");
    await flush();
    h.clock.advance(250);
    await flush();

    const seqs = h.log.all.filter((e) => e.kind === "acp.session_update").map((e) => e.seq);
    const running = h.log.all.find((e) => isStateUpdate(e, "running"))!.seq;
    const idle = h.log.all.find((e) => isStateUpdate(e, "idle"))!.seq;
    const chunks = seqs.filter((s) => s !== running && s !== idle);
    expect(chunks).toHaveLength(2);
    for (const c of chunks) {
      expect(c).toBeGreaterThan(running);
      expect(c).toBeLessThan(idle);
    }
    expect(w.turn(accepted.turnId).result?.text).toBe("onetwo");
  });

  it("drives the quiet window through the tick scheduler: a late chunk still precedes idle", async () => {
    const h = harness({ quietMs: 250, hardMs: 5_000 });
    const agent = scriptedAgent();
    h.supervisor.enqueue(agent);
    const w = await h.create();

    const accepted = await w.prompt([TEXT("hello")], OWNER);
    await flush();
    agent.resolvePrompt("end_turn");
    await flush();

    // Nothing yet: the Worker holds a timer for the Normalizer's deadline, and the turn is
    // still settling. Emitting idle here would truncate the answer (L5).
    expect(h.log.all.some((e) => isStateUpdate(e, "idle"))).toBe(false);
    expect(w.snapshot().state).toBe("running");

    h.clock.advance(200);
    await agent.emitChunk("the late tail");
    await flush();

    // The deadline moved with the update, so the original 250 ms mark is no longer enough.
    h.clock.advance(50);
    await flush();
    expect(h.log.all.some((e) => isStateUpdate(e, "idle"))).toBe(false);

    h.clock.advance(200);
    await flush();
    const idle = h.log.all.find((e) => isStateUpdate(e, "idle"));
    expect(idle).toBeDefined();
    expect((idle!.payload as unknown as Record<string, unknown>)["stopReason"]).toBe("end_turn");
    expect(w.turn(accepted.turnId).result?.text).toBe("the late tail");
    expect(w.snapshot().state).toBe("ready");
  });

  it("returns to ready with a worker_state{turn_end} once the turn settles", async () => {
    const h = harness();
    const agent = scriptedAgent();
    h.supervisor.enqueue(agent);
    const w = await h.create();
    const seen: [WorkerState, WorkerState | null][] = [];
    w.onStateChange((s, prev) => seen.push([s, prev]));

    const accepted = await w.prompt([TEXT("hi")], OWNER);
    agent.resolvePrompt("end_turn");
    await flush();
    h.clock.advance(250);
    await flush();

    expect(seen).toEqual([
      ["running", "ready"],
      ["ready", "running"],
    ]);
    const turnEnd = h.log.all.at(-1)!;
    expect(turnEnd.kind).toBe("omni.worker_state");
    expect(turnEnd.payload).toMatchObject({
      state: "ready",
      previous: "running",
      reason: "turn_end",
    });
    expect(turnEnd.turnId).toBe(accepted.turnId);
    expect(w.snapshot().currentTurnId).toBeNull();
  });
});

describe("prompt — admission control (acceptance 5)", () => {
  it("throws worker_busy while a turn is live and worker_closed after close", async () => {
    const h = harness();
    const agent = scriptedAgent();
    h.supervisor.enqueue(agent);
    const w = await h.create();

    await w.prompt([TEXT("first")], OWNER);
    await expect(w.prompt([TEXT("second")], OWNER)).rejects.toMatchObject({
      code: "worker_busy",
      status: 409,
    });

    agent.resolvePrompt("end_turn");
    await flush();
    h.clock.advance(250);
    await flush();
    await expect(w.prompt([TEXT("third")], OWNER)).resolves.toMatchObject({
      seq: expect.any(Number),
    });

    agent.resolvePrompt("end_turn");
    await flush();
    h.clock.advance(250);
    await flush();

    await w.close("client_request");
    await expect(w.prompt([TEXT("fourth")], OWNER)).rejects.toMatchObject({
      code: "worker_closed",
      status: 410,
    });
  });

  it("admits exactly one of 50 concurrent prompts — the check-and-set is synchronous", async () => {
    const h = harness();
    h.supervisor.enqueue(scriptedAgent());
    const w = await h.create();

    const results = await Promise.allSettled(
      Array.from({ length: 50 }, (_, i) => w.prompt([TEXT(`p${String(i)}`)], OWNER)),
    );
    const accepted = results.filter((r) => r.status === "fulfilled");
    expect(accepted).toHaveLength(1);
    for (const r of results.filter((x) => x.status === "rejected")) {
      expect((r.reason as OmniError).code).toBe("worker_busy");
    }
    // One acceptance means one turn: exactly one running marker in the log.
    expect(h.log.all.filter((e) => isStateUpdate(e, "running"))).toHaveLength(1);
  });

  it("rejects prompt content M0 does not accept, without consuming the ready state (R12)", async () => {
    const h = harness();
    h.supervisor.enqueue(scriptedAgent());
    const w = await h.create();

    for (const bad of [
      [],
      [{ type: "image", data: "…", mimeType: "image/png" }],
      [{ type: "resource_link", uri: "file:///etc/passwd" }],
      [TEXT("ok"), { type: "audio", data: "…" }],
      ["just a string"],
      [{ type: "text" }],
    ]) {
      await expect(w.prompt(bad, OWNER)).rejects.toMatchObject({
        code: "bad_request",
        status: 400,
      });
    }
    // Still ready, and no turn was ever started.
    expect(w.snapshot().state).toBe("ready");
    expect(h.log.all).toHaveLength(2);
    await expect(w.prompt([TEXT("fine")], OWNER)).resolves.toBeDefined();
  });

  it("asks the lease on every controlling call (D5's seam, even though M0 grants it)", async () => {
    const h = harness();
    const lease = recordingLease(OWNER);
    const agent = scriptedAgent();
    h.supervisor.enqueue(agent);
    const w = await h.create({ overrides: { lease } });

    const other = { tokenId: "tok_other", clientId: null };
    await w.prompt([TEXT("hi")], OWNER);
    await w.cancel(other);
    expect(lease.asserted).toEqual([OWNER, other]);
    expect(w.lease).toBe(lease);
  });
});

describe("prompt — the agent answers with an error but stays alive (§7.3)", () => {
  it("ends the turn CLEANLY: omni.error, then idle{stopReason:null}, then ready", async () => {
    const h = harness();
    const agent = rawAgent({ failPrompt: { code: -32000, message: "model unavailable" } });
    h.supervisor.enqueue(asScriptedAgent(agent));
    const w = await h.create();

    const accepted = await w.prompt([TEXT("hi")], OWNER);
    await flush();

    const kinds = h.log.kinds().slice(2);
    expect(kinds).toEqual([
      "acp.session_update", // running
      "omni.worker_state", // running
      "omni.error",
      "acp.session_update", // idle
      "omni.worker_state", // ready
    ]);
    const idle = h.log.all.find((e) => isStateUpdate(e, "idle"))!;
    expect((idle.payload as unknown as Record<string, unknown>)["stopReason"]).toBeNull();

    const status = w.turn(accepted.turnId);
    expect(status.state).toBe("failed");
    expect(status.result?.error).toMatchObject({
      code: "agent_error",
      acp: { code: -32000, message: "model unavailable" },
    });
    // Alive, and usable: this is not a crash.
    expect(w.snapshot().state).toBe("ready");
    expect(h.supervisor.live.size).toBe(1);
  });
});
