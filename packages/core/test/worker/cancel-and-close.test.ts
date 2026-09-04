import { describe, expect, it } from "vitest";
import type { EventEnvelope, PlatformOwnership, WorkerStatePayload } from "@omni-acp/protocol";
import { fakeSupervisor, scriptedAgent } from "@omni-acp/testkit";
import {
  controlledProcess,
  fixedSupervisor,
  flush,
  harness,
  LIMITS,
  OWNER,
  tapWrites,
  TEXT,
} from "./support/harness.js";
import { asScriptedAgent, rawAgent } from "./support/raw-agent.js";

const stateOf = (e: EventEnvelope | undefined): WorkerStatePayload =>
  (e as EventEnvelope).payload as WorkerStatePayload;

const WINDOWS_OWNERSHIP: PlatformOwnership = {
  kind: "windows-taskkill-tree",
  confirmsTreeGone: false,
  survivesDaemonKill: true,
  caveat: "taskkill /T cannot prove the whole tree is gone; only the leader is confirmed.",
};

describe("cancel (WP-4 acceptance 10, §6.5)", () => {
  it("sends session/cancel FIRST and leaves the process alive; a second prompt succeeds", async () => {
    const h = harness();
    const agent = scriptedAgent();
    const proc = controlledProcess(tapWrites(agent.stream, h.trace));
    const w = await h.create({
      overrides: { supervisor: fixedSupervisor(proc, h.supervisor.platform) },
    });

    await w.prompt([TEXT("long job")], OWNER);
    await flush();
    h.trace.length = 0;
    await w.cancel(OWNER);
    await flush();

    // The notification, and NOTHING else: killing at the response boundary truncates the
    // agent's last output, and a Worker is long-lived across turns (§6.5).
    expect(h.trace).toEqual(["write:session/cancel"]);
    expect(proc.terminateCalls).toEqual([]);
    expect(proc.pid).not.toBeNull();
    expect(w.snapshot().state).toBe("running");

    agent.resolvePrompt("cancelled");
    await flush();
    h.clock.advance(250);
    await flush();

    expect(w.snapshot().state).toBe("ready");
    // The regression multica's turn teardown would have caused: `closeStdin()` appears only in
    // `terminate()`, so the worker survives its own cancel.
    await expect(w.prompt([TEXT("second")], OWNER)).resolves.toBeDefined();
    expect(proc.terminateCalls).toEqual([]);
  });

  it("records the cancelled turn honestly: stopReason 'cancelled', never a fabricated failure", async () => {
    const h = harness();
    const agent = scriptedAgent();
    h.supervisor.enqueue(agent);
    const w = await h.create();

    const accepted = await w.prompt([TEXT("long job")], OWNER);
    await flush();
    await w.cancel(OWNER);
    agent.resolvePrompt("cancelled");
    await flush();
    h.clock.advance(250);
    await flush();

    const status = w.turn(accepted.turnId);
    expect(status.state).toBe("completed");
    expect(status.stopReason).toBe("cancelled");
    expect(status.result?.error).toBeNull();
  });

  it("escalates to terminate({force:true}) and closes with cancel_timeout after cancelGraceMs", async () => {
    const h = harness();
    const agent = scriptedAgent();
    const proc = controlledProcess(agent.stream);
    const w = await h.create({
      overrides: { supervisor: fixedSupervisor(proc, h.supervisor.platform) },
    });

    const accepted = await w.prompt([TEXT("ignores cancel")], OWNER);
    await flush();
    await w.cancel(OWNER);
    await flush();

    h.clock.advance(LIMITS.cancelGraceMs - 1);
    await flush();
    expect(proc.terminateCalls).toEqual([]);

    h.clock.advance(1);
    const closed = await w.closed;

    expect(proc.terminateCalls).toEqual([{ force: true }]);
    expect(closed.reason).toBe("cancel_timeout");
    expect(stateOf(h.log.all.at(-1))).toMatchObject({
      state: "closed",
      reason: "cancel_timeout",
    });
    // The turn is terminal because the worker closed — a 504-shaped failure, not a fake idle.
    const status = w.turn(accepted.turnId);
    expect(status.state).toBe("failed");
    expect(status.stopReason).toBeNull();
    expect(status.result?.error?.code).toBe("agent_timeout");
  });

  it("does not escalate if the agent answers inside the grace window", async () => {
    const h = harness();
    const agent = scriptedAgent();
    h.supervisor.enqueue(agent);
    const w = await h.create();

    await w.prompt([TEXT("hi")], OWNER);
    await flush();
    await w.cancel(OWNER);
    agent.resolvePrompt("cancelled");
    await flush();
    h.clock.advance(250);
    await flush();

    h.clock.advance(LIMITS.cancelGraceMs * 2);
    await flush();
    expect(h.process().terminateCalls).toEqual([]);
    expect(w.snapshot().state).toBe("ready");
  });

  it("is a no-op when no turn is live, and worker_closed once closed (H9, §9)", async () => {
    const h = harness();
    h.supervisor.enqueue(scriptedAgent());
    const w = await h.create();

    await expect(w.cancel(OWNER)).resolves.toBeUndefined();
    expect(h.log.all).toHaveLength(2);

    await w.close("client_request");
    await expect(w.cancel(OWNER)).rejects.toMatchObject({ code: "worker_closed", status: 410 });
  });
});

describe("close (WP-4 acceptance 11)", () => {
  it("is idempotent: one ladder run, one CloseResult, whoever calls it and however often", async () => {
    const h = harness();
    h.supervisor.enqueue(scriptedAgent());
    const w = await h.create();
    const proc = h.process();

    const [a, b, c] = await Promise.all([
      w.close("client_request"),
      w.close("daemon_shutdown"),
      w.close("client_request"),
    ]);
    const d = await w.close("client_request");

    // The FIRST caller's reason wins, and the body is the same one every time (H12).
    expect(a).toEqual(b);
    expect(a).toEqual(c);
    expect(a).toEqual(d);
    expect(a.reason).toBe("client_request");
    expect(proc.terminateCalls).toHaveLength(1);
    expect(
      h.log.all.filter((e) => e.kind === "omni.worker_state" && stateOf(e).state === "closed"),
    ).toHaveLength(1);
  });

  it("takes leaderExited/treeGone straight from the KillOutcome (POSIX: both true)", async () => {
    const h = harness();
    h.supervisor.enqueue(scriptedAgent());
    const w = await h.create();

    const result = await w.close("client_request");
    expect(result).toEqual({
      workerId: w.id,
      state: "closed",
      reason: "client_request",
      leaderExited: true,
      treeGone: true,
      // §15.6: the fixture does not advertise `sessionCapabilities.close`, so nothing was sent
      // and nothing is claimed. `sessionClosed` reports the SEND, never the agent's bookkeeping.
      sessionClosed: false,
    });
    // §6.6: the same two facts must reach the operator through the state envelope too.
    expect(stateOf(h.log.all.at(-1))).toMatchObject({ leaderExited: true, treeGone: true });
    expect(h.supervisor.allTreesReclaimed()).toBe(true);
    expect(w.snapshot().process).toBeNull();
    expect(w.snapshot().closeReason).toBe("client_request");
  });

  it("never claims treeGone on a platform that cannot prove it (D10, §6.6)", async () => {
    // The Windows M0 reality, reachable from any OS: the leader is confirmed, the tree is not.
    const h = harness();
    const supervisor = fakeSupervisor({ ownership: WINDOWS_OWNERSHIP });
    supervisor.enqueue(scriptedAgent());
    const w = await h.create({ overrides: { supervisor } });

    const result = await w.close("client_request");
    expect(result.leaderExited).toBe(true);
    expect(result.treeGone).toBe(false);
    expect(stateOf(h.log.all.at(-1))).toMatchObject({ leaderExited: true, treeGone: false });
  });

  it("closes a running worker without leaving the prompt path pending", async () => {
    const h = harness();
    const agent = scriptedAgent();
    h.supervisor.enqueue(agent);
    const w = await h.create();

    const accepted = await w.prompt([TEXT("hi")], OWNER);
    await flush();
    const result = await w.close("client_request");
    await flush();

    expect(result.reason).toBe("client_request");
    expect(w.snapshot().state).toBe("closed");
    expect(w.snapshot().currentTurnId).toBeNull();
    // Any `worker_state{closed}` ends the turn (§7.3), so nothing downstream waits for an idle
    // that a closed worker will never send.
    const status = w.turn(accepted.turnId);
    expect(status.state).toBe("failed");
    expect(status.stopReason).toBeNull();
    expect(status.result?.error?.code).toBe("worker_closed");
    await expect(w.closed).resolves.toEqual(result);
  });

  it("skips session/close unless the agent advertised it, and sends it when it did", async () => {
    const withoutCap = harness();
    const plainAgent = scriptedAgent();
    const plainProc = controlledProcess(tapWrites(plainAgent.stream, withoutCap.trace));
    const plain = await withoutCap.create({
      overrides: { supervisor: fixedSupervisor(plainProc, withoutCap.supervisor.platform) },
    });
    withoutCap.trace.length = 0;
    await plain.close("client_request");
    // An unadvertised `session/close` would only earn a -32601 (it does not exist in v1).
    expect(withoutCap.trace.filter((t) => t.startsWith("write:"))).toEqual([]);

    const withCap = harness();
    const capableAgent = scriptedAgent();
    capableAgent.setCapabilities({ loadSession: false, sessionCapabilities: { close: {} } });
    const capableProc = controlledProcess(tapWrites(capableAgent.stream, withCap.trace));
    const capable = await withCap.create({
      overrides: { supervisor: fixedSupervisor(capableProc, withCap.supervisor.platform) },
    });
    withCap.trace.length = 0;
    await capable.close("client_request");
    expect(withCap.trace).toContain("write:session/close");
  });

  it("skips session/close when the agent is already dead", async () => {
    const h = harness();
    const agent = scriptedAgent();
    agent.setCapabilities({ loadSession: false, sessionCapabilities: { close: {} } });
    const proc = controlledProcess(tapWrites(agent.stream, h.trace));
    const w = await h.create({
      overrides: { supervisor: fixedSupervisor(proc, h.supervisor.platform) },
    });

    h.trace.length = 0;
    proc.emitExit(9, null, false);
    await w.closed;
    // Talking to a corpse just burns the close path's budget.
    expect(h.trace.filter((t) => t.startsWith("write:"))).toEqual([]);
    expect(w.snapshot().state).toBe("closed");
  });

  it("does not let an unanswered session/close hold the kill open forever", async () => {
    // The agent advertises `session/close` and then never answers it. Every rung of the ladder
    // below this point is bounded (§6.5), so this one has to be too — otherwise `DELETE
    // /v1/workers` hangs on the politeness step and the tree is never reclaimed.
    const h = harness();
    const agent = rawAgent({
      capabilities: { loadSession: false, sessionCapabilities: { close: {} } },
      hangSessionClose: true,
    });
    h.supervisor.enqueue(asScriptedAgent(agent));
    const w = await h.create();
    const proc = h.process();

    const closing = w.close("client_request");
    await flush();
    expect(proc.terminateCalls).toEqual([]);

    h.clock.advance(LIMITS.gracefulMs);
    const result = await closing;
    expect(result.reason).toBe("client_request");
    expect(h.supervisor.allTreesReclaimed()).toBe(true);
  });
});
