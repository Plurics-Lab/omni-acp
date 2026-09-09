import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  alwaysGrantedLease,
  createMemoryEventLog,
  createNormalizer,
  createSessionStrategy,
  createSupervisor,
  createWatchdog,
  createWorker,
  createBaselineResponder,
  type CreateWorkerDeps,
} from "@omni-acp/core";
import {
  AgentDescriptor,
  reduceTurn,
  SupervisorConfig,
  type ClientRef,
  type Clock,
  type DaemonId,
  type EventEnvelope,
  type EventInput,
  type EventLog,
  type ResolvedWatchdogConfig,
  type TimerHandle,
  type TokenId,
  type TurnId,
  type Watchdog,
  type WorkerHandle,
  type WorkerId,
  type WorkerStatePayload,
} from "@omni-acp/protocol";
import { fakeRuntime, fixtureAgentPath, nullLogger, seqIds } from "@omni-acp/testkit";
import { scaled, until } from "./support/harness.js";

/**
 * The idle watchdog against `stall-silent.mjs` and `stall-in-tool.mjs` — REAL processes, real
 * ndJSON over real pipes, real timers.
 *
 * The unit tests over `fakeClock()` prove the arithmetic; this proves the WIRING: that the signals
 * `worker.ts` feeds actually arrive, that `cancelInternal` is not lease-gated in practice, and that
 * M1's existing `cancelGraceMs` escalation is what turns a stalled agent into a
 * `close("cancel_timeout")` rather than anything M2 added.
 *
 * The budgets are small and `scaled()`, because a real process's own scheduling is the thing being
 * measured; there is no fake clock that can drive an agent that is genuinely asleep.
 *
 * Owned by M2-A-WP-W.
 */

const DAEMON_ID = "d_00000000000000000000000001" as DaemonId;
const WORKER_ID = "w_00000000000000000000000001" as WorkerId;
const OWNER: ClientRef = { tokenId: "tok_it" as TokenId, clientId: "cli_it" };

const RUNTIME = fakeRuntime();

function systemClock(): Clock {
  return {
    now: () => Date.now(),
    iso: () => new Date().toISOString(),
    setTimer(ms: number, fn: () => void): TimerHandle {
      const handle = setTimeout(fn, ms);
      handle.unref?.();
      return { cancel: () => clearTimeout(handle) };
    },
  };
}

interface Rig {
  readonly worker: WorkerHandle;
  readonly log: EventLog;
  readonly watchdog: Watchdog;
  /** `["silent"]` / `["tool"]`, in the order the watchdog fired. */
  readonly fired: readonly ("silent" | "tool")[];
  /** `append:<kind>` and `fire:<budget>` and `cancelInternal:<reason>`, in real order. */
  readonly trace: readonly string[];
  events(): readonly EventEnvelope[];
  dispose(): Promise<void>;
}

/**
 * §21.5's ladder, wired the way the assembled daemon will wire it (M2-WP-J owns `registry.ts`).
 *
 * `WatchdogDeps` is `{workerId, clock, config, onFire}` and holds no `EventLog`, so the two
 * envelopes are the CALLER's — and their ORDER is the contract: `omni.error{agent_timeout}` first,
 * because it is what makes `reduceTurn`'s verdict `failed` and what a `?since=` reader sees, then
 * `worker_state{watchdog_idle}`, and only then is the agent touched.
 */
async function startRig(o: {
  agent: "stall-silent" | "stall-in-tool";
  watchdog: Partial<ResolvedWatchdogConfig>;
  cancelGraceMs?: number;
  env?: Record<string, string>;
}): Promise<Rig> {
  const clock = systemClock();
  const cwd = await mkdtemp(join(tmpdir(), "omni-watchdog-it-"));
  const trace: string[] = [];
  const fired: ("silent" | "tool")[] = [];

  const config: ResolvedWatchdogConfig = {
    enabled: true,
    silentMs: 300_000,
    toolMs: 1_800_000,
    cancelTimeoutMs: 60_000,
    action: "cancel",
    ...o.watchdog,
  };

  const supervisor = createSupervisor({
    config: SupervisorConfig.parse({
      gracefulMs: scaled(2_000),
      killConfirmMs: scaled(2_000),
      exitGraceMs: scaled(500),
    }),
    clock,
    logger: nullLogger(),
  });

  const log = createMemoryEventLog({
    workerId: WORKER_ID,
    daemonId: DAEMON_ID,
    clock,
    maxEvents: 10_000,
    subscriberQueueSize: 256,
  });
  const appendAll = log.appendAll.bind(log);
  log.appendAll = (inputs: readonly EventInput[]) => {
    for (const input of inputs) trace.push(`append:${input.kind}`);
    return appendAll(inputs);
  };
  const append = log.append.bind(log);
  log.append = (input: EventInput) => {
    trace.push(`append:${input.kind}`);
    return append(input);
  };

  // A holder, not a `let`: the watchdog is one of the worker's deps, so it is built first and the
  // ladder has to reach the worker from inside `onFire`.
  const ref: { worker?: WorkerHandle } = {};
  const watchdog = createWatchdog({
    workerId: WORKER_ID,
    clock,
    config,
    onFire: (budget) => {
      fired.push(budget);
      trace.push(`fire:${budget}`);
      const openToolCalls = watchdog.verdict.openToolCalls.length;
      const idleMs = budget === "tool" ? config.toolMs : config.silentMs;
      const turnId = ref.worker?.snapshot().currentTurnId ?? null;
      log.appendAll([
        {
          kind: "omni.error",
          payloadVersion: 2,
          turnId,
          payload: {
            code: "agent_timeout",
            message:
              `idle watchdog: no activity for ${String(idleMs)}ms ` +
              `(budget ${String(idleMs)}ms, ${String(openToolCalls)} tool call(s) open)`,
          },
        },
        {
          kind: "omni.worker_state",
          payloadVersion: 2,
          turnId,
          payload: {
            state: "running",
            previous: "running",
            reason: "watchdog_idle",
            watchdog: { budget, idleMs, openToolCalls },
          },
        },
      ]);
      trace.push(`cancelInternal:watchdog_${budget}`);
      void ref.worker?.cancelInternal(budget === "tool" ? "watchdog_tool" : "watchdog_silent");
    },
  });

  const deps: CreateWorkerDeps = {
    workerId: WORKER_ID,
    daemonId: DAEMON_ID,
    descriptor: AgentDescriptor.parse({
      id: `it-${o.agent}`,
      // `process.execPath <fixture>`, never npx — a `.cmd` shim on Windows (§6.3, F8).
      command: process.execPath,
      args: [fixtureAgentPath(o.agent)],
      env: { ...o.env },
      protocolVersion: 1,
      shutdown: { signal: "SIGTERM", graceMs: scaled(2_000) },
    }),
    cwd,
    label: "watchdog-it",
    owner: OWNER,
    supervisor,
    log,
    normalizer: createNormalizer({
      quietMs: scaled(100),
      hardMs: scaled(5_000),
      drainGraceMs: scaled(300),
      cancelGraceMs: scaled(o.cancelGraceMs ?? 400),
      descriptor: RUNTIME,
      cwd,
    }),
    session: createSessionStrategy({ descriptor: RUNTIME, clock, logger: nullLogger() }),
    responder: createBaselineResponder("deny", clock),
    lease: alwaysGrantedLease(OWNER, WORKER_ID),
    clock,
    ids: seqIds(),
    logger: nullLogger(),
    limits: {
      handshakeTimeoutMs: scaled(20_000),
      cancelGraceMs: scaled(o.cancelGraceMs ?? 400),
      exitGraceMs: scaled(500),
      gracefulMs: scaled(2_000),
      closeOutMs: scaled(10_000),
    },
    runtime: RUNTIME,
    watchdog,
  };

  const worker = await createWorker(deps);
  ref.worker = worker;

  return {
    worker,
    log,
    watchdog,
    fired,
    trace,
    events: () => log.read(0),
    async dispose(): Promise<void> {
      if (worker.snapshot().state !== "closed") {
        await worker.close("client_request").catch(() => {});
      }
      await supervisor.shutdown().catch(() => {});
      await rm(cwd, { recursive: true, force: true }).catch(() => {});
    },
  };
}

const stateOf = (e: EventEnvelope): WorkerStatePayload => e.payload as WorkerStatePayload;

const watchdogStates = (rig: Rig): WorkerStatePayload[] =>
  rig
    .events()
    .filter((e) => e.kind === "omni.worker_state")
    .map(stateOf)
    .filter((p) => p.reason === "watchdog_idle");

describe("idle watchdog (M2-A, DESIGN §7)", () => {
  let rig: Rig | undefined;

  afterEach(async () => {
    await rig?.dispose();
    rig = undefined;
  });

  it("a silent stall trips silentMs and escalates into M1's existing cancel_timeout close", async () => {
    // `stall-silent.mjs` emits ONE chunk and then never speaks again, and it IGNORES
    // `session/cancel` — so the whole ladder runs: budget → two envelopes → `session/cancel` →
    // `cancelGraceMs` → `close("cancel_timeout")`.
    rig = await startRig({
      agent: "stall-silent",
      watchdog: { silentMs: scaled(600), toolMs: scaled(60_000), cancelTimeoutMs: 60_000 },
      cancelGraceMs: 400,
    });
    const worker = rig.worker;

    const accepted = await worker.prompt([{ type: "text", text: "go" }], OWNER);
    expect(worker.snapshot().state).toBe("running");
    // The budgets an operator reads without re-deriving config (§5.8.4).
    expect(worker.snapshot().watchdog?.silentMs).toBe(scaled(600));
    expect(worker.snapshot().watchdog?.armedAt).not.toBeNull();

    const closed = await worker.closed;
    // M1's EXISTING reason. M2 adds no `WorkerCloseReason` (Land exit criterion 4).
    expect(closed.reason).toBe("cancel_timeout");
    expect(rig.fired).toEqual(["silent"]);

    // THE ORDER: the error is appended before the agent is touched at all. Sliced at the cancel,
    // because M1's escalation appends its OWN `omni.error` when it closes — which is the rung
    // after this one and not part of the claim.
    const relevant = rig.trace.filter(
      (t) => t.startsWith("fire:") || t.startsWith("cancelInternal:") || t === "append:omni.error",
    );
    const upToCancel = relevant.slice(0, relevant.indexOf("cancelInternal:watchdog_silent") + 1);
    expect(upToCancel).toEqual([
      "fire:silent",
      "append:omni.error",
      "cancelInternal:watchdog_silent",
    ]);

    const errors = rig
      .events()
      .filter((e) => e.kind === "omni.error")
      .map((e) => e.payload as { code: string; message: string });
    expect(errors[0]?.code).toBe("agent_timeout");
    expect(errors[0]?.message).toContain("idle watchdog");

    // WorkerStatePayload.watchdog says WHICH budget fired, so an operator tells a silent stall
    // from a stuck tool without reading the log.
    expect(watchdogStates(rig)).toHaveLength(1);
    expect(watchdogStates(rig)[0]?.watchdog).toStrictEqual({
      budget: "silent",
      idleMs: scaled(600),
      openToolCalls: 0,
    });

    // And the turn is honestly failed rather than silently truncated.
    const result = reduceTurn(accepted.turnId, rig.events());
    expect(result.error?.code).toBe("agent_timeout");
    expect(result.verdict).toBe("failed");
    expect(result.strandedToolCalls).toEqual([]);
  }, 60_000);

  it("a stall with a tool call OPEN uses the LARGER toolMs budget and reports strandedToolCalls", async () => {
    // `stall-in-tool.mjs` opens `tool_call{status:"pending"}`, sends three SPARSE updates and then
    // goes silent for ever — F36's shape. The SILENT budget here is far shorter than the tool one,
    // so a watchdog that did not switch budgets would fire on the wrong one and say so.
    rig = await startRig({
      agent: "stall-in-tool",
      watchdog: { silentMs: scaled(400), toolMs: scaled(1_500), cancelTimeoutMs: 60_000 },
      // Cooperative, so the TURN settles as `cancelled` with the call still in flight — which is
      // exactly claude `16` and codex `08`, and the shape `strandedToolCalls` exists for.
      env: { STALL_COOPERATIVE: "1" },
      cancelGraceMs: 2_000,
    });
    const worker = rig.worker;

    const accepted = await worker.prompt([{ type: "text", text: "run something long" }], OWNER);

    await until(() => rig?.fired.length === 1, scaled(20_000), 25);
    expect(rig.fired).toEqual(["tool"]);

    const states = watchdogStates(rig);
    expect(states).toHaveLength(1);
    expect(states[0]?.watchdog).toStrictEqual({
      budget: "tool",
      idleMs: scaled(1_500),
      openToolCalls: 1,
    });

    // The turn settles — it does NOT wait for a terminal update that is never coming.
    await until(() => rig?.worker.turn(accepted.turnId).state !== "running", scaled(20_000), 25);
    const result = reduceTurn(accepted.turnId, rig.events());
    expect(result.stopReason).toBe("cancelled");
    expect(result.strandedToolCalls).toEqual(["stall_call_1"]);
    // `failed`, NOT `partial`, and that is §21.5's own sentence: the `omni.error{agent_timeout}`
    // is appended first "because it is what makes `reduceTurn`'s verdict `failed`". §5.8.5's
    // ladder is unambiguous about the precedence (`failed` if `error`, else `partial` if …), so a
    // WATCHDOG-fired cancel can only ever be `failed`. §4's acceptance bullet 2 and §27.2's
    // `watchdog-cancel` row both say `partial`; they are summarising the M2-R8 half (the stranded
    // call) and are wrong about the verdict, because the error they themselves require outranks
    // it. `partial` IS reachable for a cancel with no error, and `turn.test.ts` covers that.
    expect(result.verdict).toBe("failed");
    expect(result.error?.code).toBe("agent_timeout");
    // Reported, never synthesized (M2-R8): the last status we were given, and no invention.
    expect(result.toolCalls.map((c) => c.status)).toEqual(["pending"]);
    expect(result.failedToolCalls).toEqual([]);

    // The worker survives its own cancel — this was a TURN cancel, not a close.
    await until(() => rig?.worker.snapshot().state === "ready", scaled(10_000), 25);
    expect(worker.snapshot().state).toBe("ready");
    // …and the watchdog is disarmed again, ready for the next turn.
    expect(worker.snapshot().watchdog?.armedAt).toBeNull();
  }, 60_000);

  it("the silent budget does not fire while a tool call is open, however long it stays open", async () => {
    // The other half of the dual budget, stated as the thing that would break without it: an
    // `npm install` silent for twenty minutes is normal (DESIGN §7), and `silentMs` must not be
    // the number measuring it.
    rig = await startRig({
      agent: "stall-in-tool",
      watchdog: { silentMs: scaled(300), toolMs: scaled(30_000), cancelTimeoutMs: 60_000 },
      env: { STALL_COOPERATIVE: "1" },
    });
    const worker = rig.worker;

    await worker.prompt([{ type: "text", text: "run something long" }], OWNER);
    // Wait until the tool call is genuinely open, then sit well past the SILENT budget.
    await until(() => (rig?.watchdog.verdict.openToolCalls.length ?? 0) === 1, scaled(15_000), 10);
    expect(rig.watchdog.verdict.budget).toBe("tool");

    await new Promise<void>((resolve) => setTimeout(resolve, scaled(1_200)));
    expect(rig.fired).toEqual([]);
    expect(worker.snapshot().state).toBe("running");
  }, 60_000);

  it("a healthy turn's watchdog never fires and leaves no timer behind", async () => {
    // The negative case, and the one a broken anchor breaks first (F25): the fixture speaks, the
    // turn settles, and a budget shorter than the whole test still never trips because every
    // append re-bases it.
    rig = await startRig({
      agent: "stall-silent",
      watchdog: { silentMs: scaled(60_000), toolMs: scaled(60_000), cancelTimeoutMs: 60_000 },
      env: { STALL_COOPERATIVE: "1" },
    });
    const worker = rig.worker;

    const accepted = await worker.prompt([{ type: "text", text: "hello" }], OWNER);
    await worker.cancel(OWNER);
    await until(() => rig?.worker.turn(accepted.turnId).state !== "running", scaled(15_000), 25);

    expect(rig.fired).toEqual([]);
    expect(watchdogStates(rig)).toEqual([]);
    const result = reduceTurn(accepted.turnId, rig.events());
    expect(result.stopReason).toBe("cancelled");
    expect(result.strandedToolCalls).toEqual([]);

    // A closed worker's watchdog is disposed (review R15): nothing armed, nothing holding the
    // event loop open.
    await worker.close("client_request");
    expect(rig.watchdog.verdict.deadlineAt).toBeNull();
    expect(worker.snapshot().watchdog?.armedAt ?? null).toBeNull();
  }, 60_000);
});
