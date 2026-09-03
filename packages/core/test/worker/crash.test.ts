import { describe, expect, it } from "vitest";
import type { EventEnvelope, OmniErrorBody, WorkerStatePayload } from "@omni-acp/protocol";
import { scriptedAgent } from "@omni-acp/testkit";
import {
  controlledProcess,
  fixedSupervisor,
  flush,
  harness,
  LIMITS,
  OWNER,
  TEXT,
} from "./support/harness.js";
import { asScriptedAgent, rawAgent } from "./support/raw-agent.js";

const stateOf = (e: EventEnvelope | undefined): WorkerStatePayload =>
  (e as EventEnvelope).payload as WorkerStatePayload;

const isIdle = (e: EventEnvelope): boolean =>
  e.kind === "acp.session_update" &&
  (e.payload as unknown as Record<string, unknown>)["sessionUpdate"] === "state_update" &&
  (e.payload as unknown as Record<string, unknown>)["state"] === "idle";

/**
 * §7.3 and §6.7 together. The rule the whole crash path exists to protect is that a dead agent
 * never produces a fabricated `idle`: `stopReason` stays null, `error` is set, and the turn is
 * terminal because the worker closed — not because we invented an ending for it.
 */
describe("crash mid-turn (WP-4 acceptance 8)", () => {
  it("emits omni.error with the stderr tail, then worker_state{closed, agent_crashed}, and NO idle", async () => {
    const h = harness();
    const agent = scriptedAgent();
    h.supervisor.enqueue(agent);
    const w = await h.create();

    const accepted = await w.prompt([TEXT("do the thing")], OWNER);
    await flush();
    await agent.emitChunk("working on it");
    await flush();

    const proc = h.process();
    proc.writeStderr("panic: index out of range\n");
    proc.simulateExit(1, null);

    const closed = await w.closed;
    await flush();

    expect(h.log.kinds().slice(-2)).toEqual(["omni.error", "omni.worker_state"]);
    const error = h.log.all.at(-2)!;
    const errPayload = error.payload as OmniErrorBody & { stderrTail?: string };
    expect(errPayload.code).toBe("agent_error");
    expect(errPayload.stderrTail).toContain("panic: index out of range");
    expect(error.turnId).toBe(accepted.turnId);

    expect(stateOf(h.log.all.at(-1))).toMatchObject({
      state: "closed",
      previous: "running",
      reason: "agent_crashed",
      exit: { code: 1, signal: null },
    });

    // The rule (§7.3): NO fabricated idle, ever.
    expect(h.log.all.some(isIdle)).toBe(false);

    // ...and the turn is still terminal, so nothing downstream hangs.
    const status = w.turn(accepted.turnId);
    expect(status.state).toBe("failed");
    expect(status.stopReason).toBeNull();
    expect(status.result?.error?.code).toBe("agent_error");
    expect(status.result?.text).toBe("working on it");
    expect(closed).toMatchObject({ reason: "agent_crashed", state: "closed" });
    expect(h.supervisor.allTreesReclaimed()).toBe(true);
    expect(w.snapshot().process).toBeNull();
  });

  it("settles the pending prompt path instead of hanging on a dead transport", async () => {
    const h = harness();
    h.supervisor.enqueue(scriptedAgent());
    const w = await h.create();

    await w.prompt([TEXT("hi")], OWNER);
    await flush();
    h.process().simulateExit(null, "SIGKILL");

    // If the in-flight `session/prompt` rejection were classified as a turn outcome, this would
    // be a second, contradictory ending for the same turn. Instead §6.7 ignores it and the
    // process signals decide.
    await expect(w.closed).resolves.toMatchObject({ reason: "agent_crashed" });
    await flush();
    expect(h.log.all.filter((e) => e.kind === "omni.error")).toHaveLength(1);
    expect(w.snapshot().state).toBe("closed");
  });

  it("a clean requested exit is agent_exited, not a crash", async () => {
    const h = harness();
    h.supervisor.enqueue(scriptedAgent());
    await h.create();
    const proc = h.process();

    // `closeStdin()` is how the ladder asks an ACP agent to leave; the fake models it as a
    // requested exit with code 0 — the only combination §6.7 calls clean.
    proc.closeStdin();
    await flush();
    expect(stateOf(h.log.all.at(-1))).toMatchObject({ state: "closed", reason: "agent_exited" });
  });

  it("an unrequested exit(0) is STILL a crash — §6.7 requires both halves", async () => {
    const h = harness();
    h.supervisor.enqueue(scriptedAgent());
    await h.create();
    h.process().simulateExit(0, null);
    await flush();
    expect(stateOf(h.log.all.at(-1))).toMatchObject({ state: "closed", reason: "agent_crashed" });
  });

  it("the zombie: stdout EOF with no exit forces the ladder after exitGraceMs", async () => {
    // A grandchild holding the inherited stdout pipe. `terminate()` must not wait forever for an
    // `exit` that is never coming (§6.7 row 3, and the risk table's "hang forever" entry).
    const h = harness();
    const agent = scriptedAgent();
    const proc = controlledProcess(agent.stream);
    const w = await h.create({
      overrides: { supervisor: fixedSupervisor(proc, h.supervisor.platform) },
    });

    await w.prompt([TEXT("hi")], OWNER);
    await flush();
    proc.endStdout();
    await flush();

    // Nothing yet: EOF alone is not a verdict.
    expect(w.snapshot().state).toBe("running");
    expect(proc.terminateCalls).toEqual([]);

    h.clock.advance(LIMITS.exitGraceMs);
    const closed = await w.closed;

    expect(proc.terminateCalls).toEqual([{ force: true }]);
    expect(closed.reason).toBe("agent_crashed");
    expect(stateOf(h.log.all.at(-1))).toMatchObject({ state: "closed", reason: "agent_crashed" });
    expect(h.log.all.some(isIdle)).toBe(false);
  });

  it("never fabricates an idle when the prompt rejects with no JSON-RPC code and the agent is gone", async () => {
    // §6.7's rule — "an in-flight RPC that rejects with a plain Error is a dead transport; do not
    // classify from it" — was guarded only by `#linkClosed`, which is set from a `.then()` on the
    // SDK's `connection.closed`. That made §7.3 depend on the SDK resolving `closed` BEFORE it
    // rejects pending requests. It does today (probed against the pinned 1.4.0), but nothing in
    // this repo owns that ordering, and the cost if it inverted is a fabricated clean turn end
    // for a dead process — plus a second `prompt()` admitted against a corpse.
    //
    // So the process signals are made to arrive FIRST here: `stdoutEnded` settles while the
    // memory stream is still open (a `controlledProcess` settles the two independently, which is
    // exactly the grandchild-holds-the-pipe shape), and only then is the transport torn down.
    // Whatever order the SDK rejects in, the worker has already observed that the agent is gone.
    const h = harness();
    const agent = scriptedAgent();
    const proc = controlledProcess(agent.stream);
    const w = await h.create({
      overrides: { supervisor: fixedSupervisor(proc, h.supervisor.platform) },
    });

    const accepted = await w.prompt([TEXT("hi")], OWNER);
    await flush();

    proc.endStdout(); // the agent is gone; the exit-grace timer is armed on the fake clock
    await flush();
    agent.die(); // ...and NOW the in-flight session/prompt rejects with a plain Error
    await flush();

    // Nothing was invented from that rejection: no idle, and the worker did not go back to ready.
    expect(h.log.all.some(isIdle)).toBe(false);
    expect(w.snapshot().state).toBe("running");
    expect(w.snapshot().currentTurnId).toBe(accepted.turnId);

    // The crash classifier still owns the ending, and it is the honest one.
    h.clock.advance(LIMITS.exitGraceMs);
    await expect(w.closed).resolves.toMatchObject({ reason: "agent_crashed" });
    await flush();
    expect(h.log.all.some(isIdle)).toBe(false);
    expect(h.log.all.filter((e) => e.kind === "omni.error")).toHaveLength(1);
    expect(w.turn(accepted.turnId).stopReason).toBeNull();
  });

  it("a crash with no turn in flight still closes honestly, with the error on the state payload", async () => {
    const h = harness();
    h.supervisor.enqueue(asScriptedAgent(rawAgent()));
    const w = await h.create();

    h.process().writeStderr("out of memory\n");
    h.process().simulateExit(137, "SIGKILL");
    await w.closed;
    await flush();

    expect(h.log.kinds()).toEqual([
      "omni.worker_state",
      "omni.worker_state",
      "omni.error",
      "omni.worker_state",
    ]);
    const err = h.log.all[2]!;
    expect(err.turnId).toBeNull();
    expect((err.payload as { stderrTail?: string }).stderrTail).toContain("out of memory");
    expect(stateOf(h.log.all[3])).toMatchObject({
      state: "closed",
      previous: "ready",
      reason: "agent_crashed",
      exit: { code: 137, signal: "SIGKILL" },
    });
  });
});
