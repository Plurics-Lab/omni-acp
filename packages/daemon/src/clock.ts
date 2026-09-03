import type { Clock, TimerHandle } from "@omni-acp/protocol";

/**
 * The one place `Date.now()` and `setTimeout` are allowed to appear in the daemon. Everything
 * else takes a `Clock`, which is what makes the suites deterministic (CONTRACTS.md §1).
 *
 * The timer is deliberately NOT `unref()`d. A quiet window (§7.2) or a shutdown budget that the
 * event loop is allowed to skip is a promise that never settles — the caller awaiting it would
 * see the process exit instead of the turn ending. Every timer this clock hands out is owned by
 * something that cancels it (`Worker` on settle, `daemon.stop()` on teardown).
 */
export function systemClock(): Clock {
  return {
    now: () => Date.now(),
    /** ISO-8601 with milliseconds — `toISOString()` always emits `.mmm` (CONTRACTS.md §1). */
    iso: () => new Date().toISOString(),
    setTimer(delayMs: number, fn: () => void): TimerHandle {
      const handle = setTimeout(fn, Math.max(0, delayMs));
      return {
        cancel: () => {
          clearTimeout(handle);
        },
      };
    },
  };
}
