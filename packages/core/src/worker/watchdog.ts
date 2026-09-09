import type {
  TimerHandle,
  Watchdog,
  WatchdogDeps,
  WatchdogSignal,
  WatchdogState,
  WatchdogVerdict,
} from "@omni-acp/protocol";
import { initialWatchdogState, watchdogStep, watchdogVerdict } from "./watchdog-state.js";

/**
 * `watchdogStep` plus ONE `Clock.setTimer`, and nothing else.
 *
 * When it fires it appends `omni.error{agent_timeout}` and then calls `cancelInternal` — the
 * daemon-initiated cancel that is deliberately NOT lease-gated, because the lease governs CLIENTS
 * and the idle watchdog is not one. The close, if the agent ignores the cancel, comes from M1's
 * EXISTING `cancelGraceMs` escalation and is `cancel_timeout`: M2 adds no `WorkerCloseReason`, so
 * `turn.ts`'s total `CLOSE_REASON_CODE` cannot silently rot (§5.8.3).
 *
 * It does not survive a restart, and that needs no code: an adopted row is never `running`, so
 * there is nothing to arm. WP-W asserts it anyway.
 *
 * Owned by M2-A-WP-W.
 *
 * ── What `onFire` is, and what it is NOT ────────────────────────────────────────────────────
 *
 * `onFire(budget)` is called AT MOST ONCE PER TURN, at the instant a BUDGET is spent, and the
 * two envelopes of §21.5's ladder are the caller's:
 *
 *     omni.error{agent_timeout}                       ← appended FIRST, always
 *     omni.worker_state{reason:"watchdog_idle", watchdog:{budget, idleMs, openToolCalls}}
 *     then  config.action === "close" ? close("cancel_timeout")
 *                                     : handle.cancelInternal("watchdog_" + budget)
 *
 * They are the caller's because appending them needs the worker's `EventLog` and its state, and
 * this object holds neither — `WatchdogDeps` is `{workerId, clock, config, onFire}` and widening
 * it would put a log writer inside a timer.
 *
 * The `cancel_sent` signal that `cancelInternal` feeds back moves the fold to `phase:"cancelling"`
 * and arms `cancelTimeoutMs` as a BACKSTOP whose expiry is REPORTED (`phase:"spent"`,
 * `deadlineAt:null`) and calls nothing. It calls nothing because the close it would ask for is
 * already armed: `cancelInternal` goes through `Worker.cancel()`, which arms M1's `cancelGraceMs`
 * escalation into `close("cancel_timeout")`, and `watchdog.cancelTimeoutMs > turn.cancelGraceMs`
 * is a config LOAD error precisely so that rung always gets there first. A second `onFire` would
 * therefore be a second `omni.error{agent_timeout}` for one stall, on a worker that is already
 * closing.
 */
export function createWatchdog(o: WatchdogDeps): Watchdog {
  const { clock, config, onFire } = o;

  let state: WatchdogState = initialWatchdogState();
  let current: WatchdogVerdict = watchdogVerdict(state, config);
  let timer: TimerHandle | null = null;

  /**
   * The once-per-turn latch. Cleared on `turn_start` / `turn_end` and by `cancel()`, and by
   * nothing else: an envelope that arrives AFTER the budget was spent (F36's late `usage_update`
   * lands 29 ms after `session/cancel` on claude `16`) must not re-arm a budget we already acted
   * on.
   */
  let firedBudget: "silent" | "tool" | null = null;
  /** The same, for the `cancelling` backstop, so its deadline is reported as past once it is. */
  let cancelSpent = false;

  const disarm = (): void => {
    timer?.cancel();
    timer = null;
  };

  const spent = (v: WatchdogVerdict, budget: "silent" | "tool" | null): WatchdogVerdict => ({
    deadlineAt: null,
    budget,
    phase: "spent",
    openToolCalls: v.openToolCalls,
  });

  const onDeadline = (): void => {
    // Cleared BEFORE the callback, for `HibernateTimer`'s reason: `verdict` is read from inside
    // `onFire` (the ladder stamps `watchdog:{budget, idleMs, openToolCalls}` on the state
    // envelope) and it must not describe a timer that is up as armed.
    timer = null;
    const at = current;
    if (at.phase === "silent" || at.phase === "tool") {
      const budget = at.phase;
      firedBudget = budget;
      current = spent(at, budget);
      onFire(budget);
      return;
    }
    if (at.phase === "cancelling") {
      cancelSpent = true;
      current = spent(at, null);
    }
  };

  const publish = (v: WatchdogVerdict): void => {
    disarm();
    if (firedBudget !== null && (v.phase === "silent" || v.phase === "tool")) {
      current = spent(v, firedBudget);
      return;
    }
    if (cancelSpent && v.phase === "cancelling") {
      current = spent(v, null);
      return;
    }
    current = v;
    if (v.deadlineAt === null) return;
    // `Math.max(0, …)` and not a negative delay: a deadline already in the past is due NOW, and
    // `Clock.setTimer` is the only thing that decides when "now" runs. It is never synchronous,
    // so `onFire` can never re-enter `observe` (which is what `worker.ts` calls it from).
    timer = clock.setTimer(Math.max(0, v.deadlineAt - clock.now()), onDeadline);
  };

  return {
    observe(sig: WatchdogSignal): WatchdogVerdict {
      if (sig.kind === "turn_start" || sig.kind === "turn_end") {
        firedBudget = null;
        cancelSpent = false;
      }
      const next = watchdogStep(state, sig, config);
      state = next.state;
      publish(next.verdict);
      return current;
    },

    get verdict(): WatchdogVerdict {
      return current;
    },

    config,

    /**
     * Review R15. Called from every teardown path beside `InteractionStrategy.close()`, because a
     * watchdog that outlives a close can fire `onFire -> cancelInternal()` on a dead worker and
     * its timer keeps the process alive (commit 7c80f15 is the recording of what one surviving
     * timer costs).
     *
     * It DISARMS rather than poisons: `#disposeSeams` also runs on the way into `hibernated`, and
     * a woken worker keeps the very same `Watchdog` instance — one that had made itself permanently
     * dead would leave every turn after a wake unguarded. Idempotent, and a no-op on a worker that
     * is never fed again.
     */
    cancel(): void {
      disarm();
      state = initialWatchdogState();
      firedBudget = null;
      cancelSpent = false;
      current = watchdogVerdict(state, config);
    },
  };
}
