import { describe, expect, it } from "vitest";
import {
  DaemonConfig,
  reduceTurn,
  type EventEnvelope,
  type EventInput,
  type ResolvedWatchdogConfig,
  type TurnId,
  type Watchdog,
  type WatchdogSignal,
  type WorkerHandle,
  type WorkerId,
  type WorkerStatePayload,
} from "@omni-acp/protocol";
import {
  fakeClock,
  fakeDiffProvider,
  fakeRuntime,
  nullLogger,
  scriptedAgent,
} from "@omni-acp/testkit";
import { createHibernateTimer, createNormalizer, createWatchdog } from "@omni-acp/core";
import { createSessionStrategy } from "../../src/worker/session-open.js";
import { asScripted, resumableAgent } from "./support/resumable-agent.js";
import {
  controlledProcess,
  fixedSupervisor,
  flush,
  harness,
  LIMITS,
  OWNER,
  tapWrites,
  TEXT,
  WORKER_ID,
} from "./support/harness.js";
import type { ArrayLog } from "./support/array-log.js";

/** An agent that advertises a resume spelling, so `hibernate()` has somewhere to go. */
const RESUMABLE = fakeRuntime({
  prefer: {
    resume: { spellings: ["session/resume", "session/load"], onFailure: "fail" },
    close: { spellings: ["session/close"], onFailure: "fail" },
  },
});

/**
 * `createWatchdog` — the pure fold plus ONE `Clock.setTimer`, and the escalation it hands back to
 * M1's existing `cancel_timeout` ladder.
 *
 * Owned by M2-A-WP-W.
 */

const CFG: ResolvedWatchdogConfig = {
  enabled: true,
  silentMs: 1_000,
  toolMs: 10_000,
  cancelTimeoutMs: 60_000,
  action: "cancel",
};

const cfg = (o: Partial<ResolvedWatchdogConfig> = {}): ResolvedWatchdogConfig => ({ ...CFG, ...o });

let seq = 0;
function updateEnvelope(payload: Record<string, unknown>): EventEnvelope {
  seq += 1;
  return {
    seq: seq as never,
    ts: new Date(seq).toISOString(),
    daemonId: "d_00000000000000000000000001" as never,
    workerId: WORKER_ID,
    sessionId: null,
    turnId: "t_00000000000000000000000001" as TurnId,
    payloadVersion: 2,
    kind: "acp.session_update",
    payload: payload as never,
  };
}

const chunkAt = (at: number, text: string): WatchdogSignal => ({
  kind: "envelope",
  at,
  envelope: updateEnvelope({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text },
  }),
});

const openToolAt = (at: number, id: string): WatchdogSignal => ({
  kind: "envelope",
  at,
  envelope: updateEnvelope({ sessionUpdate: "tool_call", toolCallId: id, status: "pending" }),
});

/**
 * §21.5's ladder, as the WIRING supplies it.
 *
 * `WatchdogDeps` is `{workerId, clock, config, onFire}` — it holds no `EventLog` and no worker —
 * so the two envelopes are appended by whoever built the watchdog, which in the assembled daemon
 * is the worker-creation path (M2-WP-J's `registry.ts`) and here is this helper. The ORDER is the
 * contract: `omni.error{agent_timeout}` FIRST, because it is what makes `reduceTurn`'s verdict
 * `failed` and what a `?since=` reader sees, and only then is the agent touched.
 */
function armWatchdog(o: {
  /** LAZY: the watchdog is constructed BEFORE the worker, because the worker takes it as a dep. */
  worker: () => WorkerHandle;
  log: ArrayLog;
  clock: { now(): number; setTimer(ms: number, fn: () => void): { cancel(): void } };
  config: ResolvedWatchdogConfig;
  turnId: () => TurnId | null;
  fired?: string[];
}): Watchdog {
  const watchdog: Watchdog = createWatchdog({
    workerId: WORKER_ID,
    clock: o.clock as never,
    config: o.config,
    onFire: (budget) => {
      o.fired?.push(budget);
      const verdict = watchdog.verdict;
      const openToolCalls = verdict.openToolCalls.length;
      const idleMs = budget === "tool" ? o.config.toolMs : o.config.silentMs;
      const error: EventInput = {
        kind: "omni.error",
        payloadVersion: 2,
        turnId: o.turnId(),
        payload: {
          code: "agent_timeout",
          message:
            `idle watchdog: no activity for ${String(idleMs)}ms ` +
            `(budget ${String(idleMs)}ms, ${String(openToolCalls)} tool call(s) open)`,
        },
      };
      const state: EventInput = {
        kind: "omni.worker_state",
        payloadVersion: 2,
        turnId: o.turnId(),
        payload: {
          state: "running",
          previous: "running",
          reason: "watchdog_idle",
          watchdog: { budget, idleMs, openToolCalls },
        },
      };
      o.log.appendAll([error, state]);
      if (o.config.action === "close") {
        void o.worker().close("cancel_timeout");
        return;
      }
      void o.worker().cancelInternal(budget === "tool" ? "watchdog_tool" : "watchdog_silent");
    },
  });
  return watchdog;
}

describe("createWatchdog — one timer, and only one", () => {
  it("arms a single timer and re-arms it on every append, never accumulating", () => {
    const clock = fakeClock();
    const fired: string[] = [];
    const w = createWatchdog({
      workerId: WORKER_ID,
      clock,
      config: CFG,
      onFire: (b) => fired.push(b),
    });

    expect(clock.pendingTimers).toBe(0);
    w.observe({ kind: "turn_start", at: clock.now() });
    expect(clock.pendingTimers).toBe(1);

    for (let i = 0; i < 5; i += 1) {
      clock.advance(100);
      w.observe(chunkAt(clock.now(), `chunk ${String(i)}`));
      expect(clock.pendingTimers).toBe(1);
    }
    expect(fired).toEqual([]);

    // 500 ms of activity, then 999 ms of silence: still inside the budget.
    clock.advance(999);
    expect(fired).toEqual([]);
    clock.advance(1);
    expect(fired).toEqual(["silent"]);
    expect(clock.pendingTimers).toBe(0);
  });

  it("fires the TOOL budget when a call is open, and not the silent one", () => {
    const clock = fakeClock();
    const fired: string[] = [];
    const w = createWatchdog({
      workerId: WORKER_ID,
      clock,
      config: CFG,
      onFire: (b) => fired.push(b),
    });

    w.observe({ kind: "turn_start", at: clock.now() });
    w.observe(openToolAt(clock.now(), "call_a"));

    // Far past `silentMs`, nowhere near `toolMs`. An `npm install` silent for twenty minutes is
    // normal, and the small budget must not be the one measuring it.
    clock.advance(CFG.silentMs * 5);
    expect(fired).toEqual([]);
    expect(w.verdict.budget).toBe("tool");

    clock.advance(CFG.toolMs);
    expect(fired).toEqual(["tool"]);
  });

  it("fires ONCE per turn, however many envelopes arrive after the budget is spent", () => {
    // claude `16`: a `usage_update` lands 29 ms after `session/cancel` and the response 31 ms
    // after that. Re-arming on them would append a second `omni.error{agent_timeout}` for one
    // stall, on a worker that is already closing.
    const clock = fakeClock();
    const fired: string[] = [];
    const w = createWatchdog({
      workerId: WORKER_ID,
      clock,
      config: CFG,
      onFire: (b) => fired.push(b),
    });

    w.observe({ kind: "turn_start", at: clock.now() });
    clock.advance(CFG.silentMs);
    expect(fired).toEqual(["silent"]);
    expect(w.verdict).toStrictEqual({
      deadlineAt: null,
      budget: "silent",
      phase: "spent",
      openToolCalls: [],
    });

    w.observe(chunkAt(clock.now(), "late"));
    expect(w.verdict.phase).toBe("spent");
    expect(clock.pendingTimers).toBe(0);
    clock.advance(CFG.silentMs * 10);
    expect(fired).toEqual(["silent"]);

    // The NEXT turn is armed normally — the latch is per-turn, not per-watchdog.
    w.observe({ kind: "turn_end", at: clock.now() });
    w.observe({ kind: "turn_start", at: clock.now() });
    expect(w.verdict.phase).toBe("silent");
    clock.advance(CFG.silentMs);
    expect(fired).toEqual(["silent", "silent"]);
  });

  it("cancel_sent replaces the budget with the cancelTimeoutMs backstop, and never fires again", () => {
    const clock = fakeClock();
    const fired: string[] = [];
    const w = createWatchdog({
      workerId: WORKER_ID,
      clock,
      config: CFG,
      onFire: (b) => fired.push(b),
    });

    w.observe({ kind: "turn_start", at: clock.now() });
    clock.advance(CFG.silentMs);
    expect(fired).toEqual(["silent"]);

    w.observe({ kind: "cancel_sent", at: clock.now() });
    expect(w.verdict.phase).toBe("cancelling");
    expect(w.verdict.deadlineAt).toBe(clock.now() + CFG.cancelTimeoutMs);
    expect(clock.pendingTimers).toBe(1);

    // The backstop is REPORTED, not a second fire: the close it would ask for is already armed by
    // `Worker.cancel()`'s `cancelGraceMs` escalation, and `cancelTimeoutMs > turn.cancelGraceMs`
    // is a config LOAD error precisely so that rung gets there first.
    clock.advance(CFG.cancelTimeoutMs);
    expect(fired).toEqual(["silent"]);
    expect(w.verdict).toStrictEqual({
      deadlineAt: null,
      budget: null,
      phase: "spent",
      openToolCalls: [],
    });
    expect(clock.pendingTimers).toBe(0);
  });

  it("a park disarms the timer entirely and an unpark re-arms it from the unpark instant", () => {
    const clock = fakeClock();
    const fired: string[] = [];
    const w = createWatchdog({
      workerId: WORKER_ID,
      clock,
      config: CFG,
      onFire: (b) => fired.push(b),
    });

    w.observe({ kind: "turn_start", at: clock.now() });
    w.observe({ kind: "parked", at: clock.now() });
    expect(clock.pendingTimers).toBe(0);
    expect(w.verdict.phase).toBe("paused");

    // Twenty minutes of a human thinking, under a one-second budget.
    clock.advance(20 * 60_000);
    expect(fired).toEqual([]);

    w.observe({ kind: "unparked", at: clock.now() });
    expect(clock.pendingTimers).toBe(1);
    clock.advance(CFG.silentMs - 1);
    expect(fired).toEqual([]);
    clock.advance(1);
    expect(fired).toEqual(["silent"]);
  });

  it("enabled:false arms nothing at all, and `0` never fires rather than firing now", () => {
    for (const config of [cfg({ enabled: false }), cfg({ silentMs: 0, toolMs: 0 })]) {
      const clock = fakeClock();
      const fired: string[] = [];
      const w = createWatchdog({
        workerId: WORKER_ID,
        clock,
        config,
        onFire: (b) => fired.push(b),
      });
      w.observe({ kind: "turn_start", at: clock.now() });
      w.observe(openToolAt(clock.now(), "a"));
      expect(clock.pendingTimers).toBe(0);
      clock.advance(86_400_000);
      expect(fired).toEqual([]);
    }
  });

  it("cancel() disarms, is idempotent, and leaves the watchdog REUSABLE after a wake", () => {
    // Review R15: a watchdog that outlives a close can fire `onFire -> cancelInternal()` on a
    // dead worker and its timer keeps the process alive. But `#disposeSeams` also runs on the way
    // into `hibernated`, and the woken worker keeps the SAME instance — one that had made itself
    // permanently dead would leave every turn after a wake unguarded.
    const clock = fakeClock();
    const fired: string[] = [];
    const w = createWatchdog({
      workerId: WORKER_ID,
      clock,
      config: CFG,
      onFire: (b) => fired.push(b),
    });

    w.observe({ kind: "turn_start", at: clock.now() });
    expect(clock.pendingTimers).toBe(1);

    w.cancel();
    w.cancel();
    expect(clock.pendingTimers).toBe(0);
    expect(w.verdict).toStrictEqual({
      deadlineAt: null,
      budget: null,
      phase: "idle",
      openToolCalls: [],
    });
    clock.advance(86_400_000);
    expect(fired).toEqual([]);

    w.observe({ kind: "turn_start", at: clock.now() });
    clock.advance(CFG.silentMs);
    expect(fired).toEqual(["silent"]);
  });

  it("reports the RESOLVED budgets, so WorkerSnapshot.watchdog cannot disagree with the timer", () => {
    const clock = fakeClock();
    const config = cfg({ silentMs: 7, toolMs: 9, cancelTimeoutMs: 11 });
    const w = createWatchdog({ workerId: WORKER_ID, clock, config, onFire: () => {} });
    expect(w.config).toBe(config);
  });

  it("WorkerSnapshot.watchdog reports the resolved budgets, and is null when nothing will fire", async () => {
    // §5.8.4: an operator reads the numbers without re-deriving config — and `null` for a worker
    // with no watchdog AND for a disabled one, because those are the same fact (nothing will
    // cancel this turn on a timer) and reporting numbers for a disarmed timer reads true and is
    // not. The view lives in the frozen `worker.ts`; this is the test that pins it.
    const none = harness();
    none.supervisor.enqueue(scriptedAgent());
    expect((await none.create()).snapshot().watchdog).toBeNull();

    const off = harness();
    off.supervisor.enqueue(scriptedAgent());
    const disabled = await off.create({
      overrides: {
        watchdog: createWatchdog({
          workerId: WORKER_ID,
          clock: off.clock,
          config: cfg({ enabled: false }),
          onFire: () => {
            throw new Error("a disabled watchdog fired");
          },
        }),
      },
    });
    expect(disabled.snapshot().watchdog).toBeNull();
    await disabled.prompt([TEXT("go")], OWNER);
    await flush();
    expect(disabled.snapshot().watchdog).toBeNull();
    expect(off.clock.pendingTimers).toBe(0);

    const on = harness();
    on.supervisor.enqueue(scriptedAgent());
    const armed = await on.create({
      overrides: {
        watchdog: createWatchdog({
          workerId: WORKER_ID,
          clock: on.clock,
          config: cfg({ silentMs: 4_000, toolMs: 8_000, cancelTimeoutMs: 12_000 }),
          onFire: () => {},
        }),
      },
    });
    expect(armed.snapshot().watchdog).toStrictEqual({
      silentMs: 4_000,
      toolMs: 8_000,
      cancelTimeoutMs: 12_000,
      armedAt: null,
      budget: null,
    });
    await armed.prompt([TEXT("go")], OWNER);
    await flush();
    const view = armed.snapshot().watchdog;
    expect(view?.budget).toBe("silent");
    expect(view?.armedAt).toBe(new Date(on.clock.now() + 4_000).toISOString());
  });

  it("a deadline already in the past is due NOW and never fires synchronously inside observe", () => {
    const clock = fakeClock();
    const fired: string[] = [];
    const w = createWatchdog({
      workerId: WORKER_ID,
      clock,
      config: CFG,
      onFire: (b) => fired.push(b),
    });

    // `at` is two budgets ago — the shape a slow caller produces, and the shape a rehydrated
    // timestamp would. `Math.max(0, …)` makes it due, and `Clock.setTimer` decides when "now" is.
    w.observe({ kind: "turn_start", at: clock.now() - CFG.silentMs * 2 });
    expect(fired).toEqual([]);
    expect(clock.pendingTimers).toBe(1);
    clock.advance(0);
    expect(fired).toEqual(["silent"]);
  });
});

describe("the escalation (§21.5)", () => {
  it("appends omni.error{agent_timeout} BEFORE cancelInternal, and closes with cancel_timeout", async () => {
    const h = harness();
    const agent = scriptedAgent();
    const proc = controlledProcess(tapWrites(agent.stream, h.trace));
    const fired: string[] = [];

    // A holder, not a `let`: the watchdog is built BEFORE the worker (it is one of its deps) and
    // the ladder has to reach the worker from inside `onFire`.
    const ref: { worker?: WorkerHandle } = {};
    const watchdog = armWatchdog({
      worker: () => ref.worker as WorkerHandle,
      log: h.log,
      clock: h.clock,
      config: CFG,
      turnId: () => ref.worker?.snapshot().currentTurnId ?? null,
      fired,
    });
    const w = await h.create({
      overrides: { supervisor: fixedSupervisor(proc, h.supervisor.platform), watchdog },
    });
    ref.worker = w;

    const accepted = await w.prompt([TEXT("long job")], OWNER);
    await flush();
    h.trace.length = 0;

    // Silence for the whole budget.
    h.clock.advance(CFG.silentMs);
    await flush();

    expect(fired).toEqual(["silent"]);
    // THE ORDER. The error is what makes `reduceTurn`'s verdict `failed` and what a `?since=`
    // reader sees, so it is appended before the agent is touched at all.
    expect(h.trace).toEqual([
      "append:omni.error",
      "append:omni.worker_state",
      "write:session/cancel",
    ]);

    const error = h.log.all.find((e) => e.kind === "omni.error");
    expect(error?.payload).toMatchObject({ code: "agent_timeout" });
    expect(String((error?.payload as { message: string }).message)).toContain("idle watchdog");

    const idle = h.log.all
      .filter((e) => e.kind === "omni.worker_state")
      .map((e) => e.payload as WorkerStatePayload)
      .find((p) => p.reason === "watchdog_idle");
    expect(idle?.watchdog).toStrictEqual({
      budget: "silent",
      idleMs: CFG.silentMs,
      openToolCalls: 0,
    });

    // The lease was NOT asserted for the daemon's own cancel (M2-R20): the lease governs CLIENTS
    // and the watchdog is not one. Without the bypass the daemon's own timer `423`s itself the
    // moment a real `createLease` replaces the granting double.
    const assertedAfterFire = h.lease.asserted.length;

    // NOT closed yet: `session/cancel` went out and the process is still alive.
    expect(w.snapshot().state).toBe("running");
    expect(proc.terminateCalls).toEqual([]);

    // M1's EXISTING escalation, unchanged: `cancelGraceMs`, then `cancel_timeout`.
    h.clock.advance(LIMITS.cancelGraceMs);
    await flush();
    h.clock.advance(1_000);
    await flush(20);

    const closed = await w.closed;
    expect(closed.reason).toBe("cancel_timeout");
    expect(h.lease.asserted.length).toBe(assertedAfterFire);

    // And the turn says so: the error is on the fold, so the verdict is `failed`.
    const result = reduceTurn(accepted.turnId, h.log.all);
    expect(result.error?.code).toBe("agent_timeout");
    expect(result.verdict).toBe("failed");
  });

  it('action:"close" skips the cooperative rungs and still appends both envelopes FIRST', async () => {
    const h = harness();
    const agent = scriptedAgent();
    const proc = controlledProcess(tapWrites(agent.stream, h.trace));

    const ref: { worker?: WorkerHandle } = {};
    const watchdog = armWatchdog({
      worker: () => ref.worker as WorkerHandle,
      log: h.log,
      clock: h.clock,
      config: cfg({ action: "close" }),
      turnId: () => ref.worker?.snapshot().currentTurnId ?? null,
    });
    const w = await h.create({
      overrides: { supervisor: fixedSupervisor(proc, h.supervisor.platform), watchdog },
    });
    ref.worker = w;

    await w.prompt([TEXT("long job")], OWNER);
    await flush();
    h.trace.length = 0;

    h.clock.advance(CFG.silentMs);
    await flush(20);
    h.clock.advance(60_000);
    await flush(20);

    const kinds = h.trace.filter((t) => t.startsWith("append:omni."));
    expect(kinds[0]).toBe("append:omni.error");
    expect(kinds[1]).toBe("append:omni.worker_state");

    const closed = await w.closed;
    // Land exit criterion 4 forbids adding a `WorkerCloseReason`, and every alternative would be
    // a false statement in a different way — review R7 is the record that this was CHOSEN.
    expect(closed.reason).toBe("cancel_timeout");
  });

  it("cancelTimeoutMs <= turn.cancelGraceMs is a config LOAD error", () => {
    const base = {
      dataDir: "/tmp/omni-acp-cfg",
      tokens: [{ id: "t", secret: "x".repeat(32), role: "admin" as const, cwdRoots: ["/tmp"] }],
    };
    const parse = (cancelTimeoutMs: number, cancelGraceMs: number) =>
      DaemonConfig.safeParse({
        ...base,
        turn: { cancelGraceMs },
        watchdog: { cancelTimeoutMs },
      });

    // Equal is a load error too: a watchdog that closed first would report a fake agent timeout
    // for a turn that was still settling.
    for (const [timeout, grace] of [
      [10_000, 10_000],
      [5_000, 10_000],
      [1, 10_000],
    ] as const) {
      const bad = parse(timeout, grace);
      expect(bad.success, `${String(timeout)} vs ${String(grace)}`).toBe(false);
      if (!bad.success) {
        expect(bad.error.issues.some((i) => i.path.join(".") === "watchdog.cancelTimeoutMs")).toBe(
          true,
        );
      }
    }
    expect(parse(10_001, 10_000).success).toBe(true);
    // …and the defaults are legal, which is what makes an unmodified M1 config still load.
    expect(DaemonConfig.safeParse(base).success).toBe(true);
  });
});

describe("the watchdog and the hibernate timer are never both armed (§15.1)", () => {
  /**
   * The registry's actual rule, restated: `ready` touches the idle timer, `closed` cancels it,
   * every other state pauses it (`registry.ts`'s `watchEntry`). The watchdog's rule is the fold's:
   * armed only while a turn is live and not parked.
   */
  it("holds for every state in the table", async () => {
    const h = harness();
    const agent = resumableAgent({ onResume: { kind: "ok" } });
    h.supervisor.enqueue(asScripted(agent));

    const clock = h.clock;
    const fired: string[] = [];
    const watchdog = createWatchdog({
      workerId: WORKER_ID,
      clock,
      config: cfg({ silentMs: 5_000, toolMs: 9_000 }),
      onFire: (b) => fired.push(b),
    });

    const w = await h.create({
      overrides: {
        watchdog,
        runtime: RESUMABLE,
        session: createSessionStrategy({
          descriptor: RESUMABLE,
          clock: h.clock,
          logger: nullLogger(),
        }),
      },
    });
    const idle = createHibernateTimer({ clock, idleMs: 30_000, onFire: () => {} });

    const seen: { state: string; watchdogArmed: boolean; idleArmed: boolean }[] = [];
    const observeState = (state: string): void => {
      if (state === "ready") idle.touch();
      else if (state === "closed") idle.cancel();
      else idle.pause();
      seen.push({
        state,
        watchdogArmed: watchdog.verdict.deadlineAt !== null,
        idleArmed: idle.armed,
      });
      expect(
        watchdog.verdict.deadlineAt !== null && idle.armed,
        `both timers armed in state "${state}"`,
      ).toBe(false);
    };

    w.onStateChange((state) => observeState(state));
    observeState(w.snapshot().state);

    // ready -> running -> ready
    await w.prompt([TEXT("go")], OWNER);
    await flush();
    observeState(w.snapshot().state);

    agent.resolvePrompt("end_turn");
    await flush(20);
    clock.advance(300);
    await flush(20);
    observeState(w.snapshot().state);

    // ready -> hibernated, and back through `starting` on the wake. A FRESH agent: hibernation
    // reclaims the process, so the wake spawns a second one.
    h.supervisor.enqueue(asScripted(resumableAgent({ onResume: { kind: "ok" } })));
    await w.hibernate("idle_timeout");
    await flush(20);
    observeState(w.snapshot().state);
    await w.wake(OWNER);
    await flush(20);
    observeState(w.snapshot().state);

    await w.close("client_request");
    await flush(20);
    observeState(w.snapshot().state);

    // Every reachable row of §15.1 was actually visited — `starting` comes from the wake, which
    // is the only transition that re-enters it after `create` has returned.
    expect(new Set(seen.map((s) => s.state))).toEqual(
      new Set(["ready", "running", "hibernated", "starting", "closed"]),
    );
    // …and each one is the RIGHT timer, not merely "not both".
    expect(seen.some((s) => s.state === "running" && s.watchdogArmed && !s.idleArmed)).toBe(true);
    expect(seen.some((s) => s.state === "ready" && s.idleArmed && !s.watchdogArmed)).toBe(true);
    for (const state of ["starting", "hibernated", "closed"]) {
      const rows = seen.filter((r) => r.state === state);
      expect(rows.length, state).toBeGreaterThan(0);
      expect(
        rows.every((r) => !r.watchdogArmed && !r.idleArmed),
        `${state} armed a timer`,
      ).toBe(true);
    }
    expect(fired).toEqual([]);
  });

  it("requires_action arms NEITHER: the park timer owns that deadline (§21.4)", () => {
    // The two rules meet on this row and are asserted where each one lives: the fold pauses on
    // `parked`, and the registry pauses the idle timer for every state that is not `ready`.
    const clock = fakeClock();
    const fired: string[] = [];
    const watchdog = createWatchdog({
      workerId: WORKER_ID,
      clock,
      config: CFG,
      onFire: (b) => fired.push(b),
    });
    const idle = createHibernateTimer({ clock, idleMs: 30_000, onFire: () => {} });

    watchdog.observe({ kind: "turn_start", at: clock.now() });
    watchdog.observe({ kind: "parked", at: clock.now() });
    idle.pause(); // registry's rule for any state that is not `ready`

    expect(watchdog.verdict.deadlineAt).toBeNull();
    expect(idle.armed).toBe(false);
    clock.advance(86_400_000);
    expect(fired).toEqual([]);
  });
});

describe("the watchdog does not survive a restart (§21.6)", () => {
  it("a hibernated worker's watchdog is disarmed, and there is nothing to re-arm", async () => {
    // M1's boot adoption turns every live-state row into `hibernated` or `closed`, so a `running`
    // worker cannot exist across a boot. This asserts the mechanism rather than the claim: the
    // state a restart can reach never arms the watchdog, and the teardown that produces it
    // disarms whatever was armed.
    const h = harness();
    const agent = resumableAgent({ onResume: { kind: "ok" } });
    h.supervisor.enqueue(asScripted(agent));
    const watchdog = createWatchdog({
      workerId: WORKER_ID,
      clock: h.clock,
      config: CFG,
      onFire: () => {
        throw new Error("the watchdog fired on a worker that is not running");
      },
    });
    const w = await h.create({
      overrides: {
        watchdog,
        runtime: RESUMABLE,
        session: createSessionStrategy({
          descriptor: RESUMABLE,
          clock: h.clock,
          logger: nullLogger(),
        }),
      },
    });

    await w.prompt([TEXT("go")], OWNER);
    await flush();
    expect(watchdog.verdict.deadlineAt).not.toBeNull();

    agent.resolvePrompt("end_turn");
    await flush(20);
    h.clock.advance(300);
    await flush(20);
    expect(w.snapshot().state).toBe("ready");

    const snapshot = await w.hibernate("idle_timeout");
    expect(snapshot.state).toBe("hibernated");
    // `#disposeSeams` ran: nothing is armed, and no timer is holding the process alive.
    expect(watchdog.verdict.deadlineAt).toBeNull();
    expect(h.clock.pendingTimers).toBe(0);
    h.clock.advance(86_400_000);
  });

  it("a fresh watchdog is disarmed until turn_start, so an adopted row arms nothing", () => {
    const clock = fakeClock();
    const w = createWatchdog({
      workerId: WORKER_ID,
      clock,
      config: CFG,
      onFire: () => {
        throw new Error("a watchdog that was never given a turn must not fire");
      },
    });
    expect(w.verdict).toStrictEqual({
      deadlineAt: null,
      budget: null,
      phase: "idle",
      openToolCalls: [],
    });
    expect(clock.pendingTimers).toBe(0);
    // Every signal an adopted row could plausibly produce, and none of them arms anything.
    for (const sig of [
      {
        kind: "envelope",
        at: clock.now(),
        envelope: updateEnvelope({ sessionUpdate: "session_info_update" }),
      },
      { kind: "parked", at: clock.now() },
      { kind: "unparked", at: clock.now() },
      { kind: "cancel_sent", at: clock.now() },
      { kind: "turn_end", at: clock.now() },
    ] satisfies WatchdogSignal[]) {
      w.observe(sig);
      expect(w.verdict.deadlineAt, sig.kind).toBeNull();
    }
    clock.advance(86_400_000);
  });

  it("WorkerRow persists the BUDGETS and no runtime state, so there is nothing to restore", () => {
    // §5.8.8's `WorkerRow.watchdog` is `{silentMs, toolMs, cancelTimeoutMs}`: three numbers a
    // wake re-resolves anyway. No deadline, no open set, no armed-at — nobody can "helpfully"
    // persist the timer, because the row has nowhere to put it.
    const row: NonNullable<import("@omni-acp/protocol").WorkerRow["watchdog"]> = {
      silentMs: 1,
      toolMs: 2,
      cancelTimeoutMs: 3,
    };
    expect(Object.keys(row).sort()).toEqual(["cancelTimeoutMs", "silentMs", "toolMs"]);
  });
});

describe("the turn projection (§21.5, ruling M2-R8)", () => {
  const TURN = "t_00000000000000000000000001" as TurnId;
  const WORKER = "w_00000000000000000000000001" as WorkerId;

  let n = 0;
  const envelope = (
    kind: EventEnvelope["kind"],
    payload: unknown,
    o?: { turnId?: TurnId | null },
  ): EventEnvelope =>
    ({
      seq: (n += 1),
      ts: new Date(n).toISOString(),
      daemonId: "d_00000000000000000000000001",
      workerId: WORKER,
      sessionId: null,
      turnId: o?.turnId === undefined ? TURN : o.turnId,
      payloadVersion: 2,
      kind,
      payload,
    }) as EventEnvelope;

  const su = (payload: Record<string, unknown>): EventEnvelope =>
    envelope("acp.session_update", payload);

  const idleEnvelope = (meta?: Record<string, unknown>): EventEnvelope =>
    su({
      sessionUpdate: "state_update",
      state: "idle",
      stopReason: "cancelled",
      ...(meta === undefined ? {} : { _meta: meta }),
    });

  it("strands exactly the one open id on claude 16's shape, and the verdict is partial", () => {
    n = 0;
    const id = "toolu_01SSKkXnrSBG3fd7pKyMvHBt";
    const envelopes = [
      su({ sessionUpdate: "state_update", state: "running" }),
      su({
        sessionUpdate: "tool_call_update",
        toolCallId: id,
        status: "pending",
        title: "Terminal",
      }),
      su({ sessionUpdate: "tool_call_update", toolCallId: id, title: "python3 …" }),
      su({ sessionUpdate: "usage_update", used: 25_157, size: 1_000_000 }),
      idleEnvelope(),
    ];
    const result = reduceTurn(TURN, envelopes);
    expect(result.strandedToolCalls).toStrictEqual([id]);
    expect(result.toolCalls[0]?.status).toBe("pending");
    expect(result.verdict).toBe("partial");
    // NEVER synthesized: the tool may well have completed agent-side, and both agents simply
    // never told us. We do not put a status on the wire that no agent sent (M2-R8).
    expect(result.failedToolCalls).toStrictEqual([]);
    expect(result.stopReason).toBe("cancelled");
  });

  it("strands exactly the one open id on codex 08's shape (in_progress)", () => {
    n = 0;
    const id = "exec-cba0d467-b26e-49be-90fc-b48f7be06b0d";
    const result = reduceTurn(TURN, [
      su({ sessionUpdate: "state_update", state: "running" }),
      su({
        sessionUpdate: "tool_call_update",
        toolCallId: id,
        status: "in_progress",
        title: "sleep 30",
      }),
      su({ sessionUpdate: "usage_update", used: 20_267, size: 258_400 }),
      idleEnvelope(),
    ]);
    expect(result.strandedToolCalls).toStrictEqual([id]);
    expect(result.verdict).toBe("partial");
  });

  it("is EMPTY on a clean turn, whatever the terminal status was", () => {
    n = 0;
    const clean = reduceTurn(TURN, [
      su({ sessionUpdate: "state_update", state: "running" }),
      su({ sessionUpdate: "tool_call_update", toolCallId: "a", status: "pending" }),
      su({ sessionUpdate: "tool_call_update", toolCallId: "a", status: "completed" }),
      su({ sessionUpdate: "tool_call_update", toolCallId: "b", status: "failed" }),
      su({ sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" }),
    ]);
    expect(clean.strandedToolCalls).toStrictEqual([]);
    // A `failed` call is a FAILURE, not a strand: we WERE told.
    expect(clean.failedToolCalls).toStrictEqual(["b"]);
    expect(clean.verdict).toBe("partial");
  });

  it("a RUNNING turn strands nothing — it is not over yet", () => {
    n = 0;
    const running = [
      su({ sessionUpdate: "state_update", state: "running" }),
      su({ sessionUpdate: "tool_call_update", toolCallId: "a", status: "in_progress" }),
    ];
    const result = reduceTurn(TURN, running);
    expect(result.strandedToolCalls).toStrictEqual([]);
    expect(result.verdict).toBe("ok");
  });

  it("counts a status we were NEVER given, because that is exactly what it reports", () => {
    n = 0;
    const result = reduceTurn(TURN, [
      su({ sessionUpdate: "state_update", state: "running" }),
      // A sparse update and nothing else: the call exists and no status was ever sent.
      su({ sessionUpdate: "tool_call_update", toolCallId: "ghost", title: "Terminal" }),
      su({ sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" }),
    ]);
    expect(result.toolCalls[0]?.status).toBeNull();
    expect(result.strandedToolCalls).toStrictEqual(["ghost"]);
  });

  it("strands on a turn ended by a CLOSE as well as by idle, in stream order", () => {
    n = 0;
    const result = reduceTurn(TURN, [
      su({ sessionUpdate: "state_update", state: "running" }),
      su({ sessionUpdate: "tool_call_update", toolCallId: "b", status: "pending" }),
      su({ sessionUpdate: "tool_call_update", toolCallId: "a", status: "in_progress" }),
      envelope(
        "omni.worker_state",
        { state: "closed", previous: "running", reason: "cancel_timeout" },
        { turnId: null },
      ),
    ]);
    expect(result.strandedToolCalls).toStrictEqual(["b", "a"]);
    // A close carries an error, so `failed` outranks `partial` — the ladder is unchanged.
    expect(result.verdict).toBe("failed");
  });

  it("aggregation NEVER blocks: a turn whose only tool call stays pending still settles", () => {
    n = 0;
    const envelopes = [
      su({ sessionUpdate: "state_update", state: "running" }),
      su({ sessionUpdate: "tool_call_update", toolCallId: "a", status: "pending" }),
      idleEnvelope(),
    ];
    // `reduceTurn` is synchronous by construction — there is nothing to await and nothing that
    // could wait for a terminal update. Asserting it is asserting that no future edit adds one.
    const before = Date.now();
    const result = reduceTurn(TURN, envelopes);
    expect(Date.now() - before).toBeLessThan(1_000);
    expect(result.strandedToolCalls).toStrictEqual(["a"]);
    expect(result.stopReason).toBe("cancelled");
  });
});

describe("patch and patchInfo ride on idle._meta (§25.1, seam D)", () => {
  const idleMeta = (h: ReturnType<typeof harness>): Record<string, unknown> | undefined => {
    const idle = h.log.all.find(
      (e) =>
        e.kind === "acp.session_update" &&
        (e.payload as unknown as Record<string, unknown>)["state"] === "idle",
    );
    return (idle?.payload as unknown as Record<string, unknown> | undefined)?.["_meta"] as
      Record<string, unknown> | undefined;
  };

  /**
   * The REAL `createNormalizer`, not the harness's recording double: seam D lives in
   * `turn-lifecycle.ts` (`prompt_result.meta` merged into `idle._meta`), and a double that did
   * not carry the meta would let this whole chain pass while the shipped one is dead — which is
   * exactly the hole review R10 recorded (ruling M2-R9).
   */
  const realNormalizer = (h: ReturnType<typeof harness>) =>
    createNormalizer({ quietMs: 250, hardMs: 5_000, cwd: "/tmp/omni-acp-test" });

  const runTurn = async (
    h: ReturnType<typeof harness>,
    overrides?: Parameters<ReturnType<typeof harness>["create"]>[0],
  ): Promise<TurnId> => {
    const agent = scriptedAgent();
    h.supervisor.enqueue(agent);
    const w = await h.create({
      ...overrides,
      overrides: { normalizer: realNormalizer(h), ...overrides?.overrides },
    });
    const accepted = await w.prompt([TEXT("go")], OWNER);
    await flush();
    agent.resolvePrompt("end_turn");
    await flush(20);
    h.clock.advance(300);
    await flush(20);
    return accepted.turnId;
  };

  it("with NO provider the key is ABSENT and the value is null — every M1 golden unchanged", async () => {
    const h = harness();
    const turnId = await runTurn(h);
    const meta = idleMeta(h);
    expect(meta === undefined || !("omni/patch" in meta)).toBe(true);

    const result = reduceTurn(turnId, h.log.all);
    expect(result.patch).toBeNull();
    expect(result.patchInfo).toBeNull();
  });

  it("with a provider the patch reaches reduceTurn through the generic meta channel", async () => {
    const h = harness();
    const diff = fakeDiffProvider({ text: "diff --git a/a b/a\n", quality: "exact" });
    const turnId = await runTurn(h, { overrides: { diff } });

    expect(diff.begun.length).toBe(1);
    expect(diff.ended.length).toBe(1);
    const result = reduceTurn(turnId, h.log.all);
    expect(result.patch).toBe("diff --git a/a b/a\n");
    expect(result.patchInfo).toStrictEqual({ source: "git", truncated: false, quality: "exact" });
  });

  it("a HUNG provider still yields idle with patch: null and a patch_timeout warning", async () => {
    const h = harness();
    const diff = fakeDiffProvider({ hang: true });
    const agent = scriptedAgent();
    h.supervisor.enqueue(agent);
    const w = await h.create({
      overrides: {
        diff,
        normalizer: realNormalizer(h),
        limits: { ...LIMITS, diffTimeoutMs: 2_000 },
      },
    });

    const accepted = await w.prompt([TEXT("go")], OWNER);
    await flush();
    agent.resolvePrompt("end_turn");
    await flush(20);
    // The bound: `end` is awaited before `prompt_result` is fed, so a provider that never returns
    // would hang the TURN. Expiry is `patch: null` and a warning, never a failed turn.
    h.clock.advance(2_000);
    await flush(20);
    h.clock.advance(300);
    await flush(20);

    const result = reduceTurn(accepted.turnId, h.log.all);
    expect(result.stopReason).toBe("end_turn");
    expect(result.patch).toBeNull();
    expect(result.patchInfo).toStrictEqual({
      source: null,
      truncated: false,
      quality: "unavailable",
    });
    expect(result.warnings.map((w2) => w2.code)).toContain("patch_timeout");
    expect(result.warnings.find((w2) => w2.code === "patch_timeout")?.source).toBe("patch");
    // The temp index is not leaked: a hung `end` is abandoned.
    expect(diff.abandoned.length).toBe(1);
  });
});

describe("reduceTurn is still pure, de-duplicating and replay-skipping", () => {
  const TURN = "t_00000000000000000000000001" as TurnId;
  let n = 0;
  const su = (
    payload: Record<string, unknown>,
    o?: { replay?: true; workerId?: string },
  ): EventEnvelope =>
    ({
      seq: (n += 1),
      ts: new Date(n).toISOString(),
      daemonId: "d_00000000000000000000000001",
      workerId: o?.workerId ?? "w_00000000000000000000000001",
      sessionId: null,
      turnId: TURN,
      payloadVersion: 2,
      kind: "acp.session_update",
      payload,
      ...(o?.replay === true ? { replay: true } : {}),
    }) as EventEnvelope;

  it("keeps every M1 property while computing the new key", () => {
    n = 0;
    const envelopes = [
      su({ sessionUpdate: "state_update", state: "running" }),
      su({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "one " } }),
      su({ sessionUpdate: "tool_call_update", toolCallId: "a", status: "pending" }),
      su(
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "two" } },
        { replay: true },
      ),
      su({ sessionUpdate: "state_update", state: "idle", stopReason: "cancelled" }),
    ];

    const first = reduceTurn(TURN, envelopes);
    const second = reduceTurn(TURN, envelopes);
    expect(second).toStrictEqual(first);
    // Replay-skipped: the replayed chunk contributes no text.
    expect(first.text).toBe("one ");
    // De-duplicated by `(workerId, seq)`: a `?since=` replay concatenated onto the live tail.
    expect(reduceTurn(TURN, [...envelopes, ...structuredClone(envelopes)])).toStrictEqual(first);
    // Order-independent.
    expect(reduceTurn(TURN, [...envelopes].reverse())).toStrictEqual(first);
    // And the new key is computed on all of them identically.
    expect(first.strandedToolCalls).toStrictEqual(["a"]);
  });
});
