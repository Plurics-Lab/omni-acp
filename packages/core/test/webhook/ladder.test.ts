import { describe, expect, it } from "vitest";
import { fakeClock } from "@omni-acp/testkit";
import { D9_BACKOFF_MS, planNextAttempt } from "../../src/webhook/ladder.js";

/**
 * D9's retry ladder, as a pure table under `fakeClock()` — no network, no timers, `rnd` injected.
 *
 * Owned by M2-B-WP-R.
 */

/** No jitter, so the rung itself is what the assertion sees. */
const ZERO = (): number => 0;

describe("planNextAttempt (D9)", () => {
  it("reproduces 0s / 30s / 2m / 10m / 30m / 2h and then `failed`, exactly", () => {
    const clock = fakeClock();
    const now = clock.now();

    // `attempt` is the number of attempts that have COMPLETED, so rung N is what a delivery with
    // N attempts behind it waits for. Six rungs ⇒ six attempts.
    const delays = [0, 1, 2, 3, 4, 5].map((attempt) => {
      const plan = planNextAttempt(attempt, now, 0, ZERO);
      expect(plan.state).toBe("pending");
      return (plan.nextAttemptMs ?? 0) - now;
    });

    expect(delays).toEqual([0, 30_000, 120_000, 600_000, 1_800_000, 7_200_000]);
    expect(delays).toEqual([...D9_BACKOFF_MS]);

    // The sixth attempt has completed and the ladder is spent.
    expect(planNextAttempt(6, now, 0, ZERO)).toEqual({ state: "failed", nextAttemptMs: null });
    expect(planNextAttempt(99, now, 0, ZERO)).toEqual({ state: "failed", nextAttemptMs: null });
  });

  it("is PURE: same inputs in, deep-equal answer out, and the clock never moves", () => {
    const clock = fakeClock();
    const before = clock.now();
    const a = planNextAttempt(3, 1_000, 0.1, () => 0.5);
    const b = planNextAttempt(3, 1_000, 0.1, () => 0.5);
    expect(a).toEqual(b);
    // No timers were armed and no time passed — this function has neither.
    expect(clock.pendingTimers).toBe(0);
    expect(clock.now()).toBe(before);
  });

  it("keeps full jitter within [0, base*jitter] on every rung after the first", () => {
    const now = 1_700_000_000_000;
    const jitter = 0.1;

    for (const [attempt, base] of D9_BACKOFF_MS.entries()) {
      for (const roll of [0, 0.25, 0.5, 0.999_999, 1]) {
        const plan = planNextAttempt(attempt, now, jitter, () => roll);
        const delay = (plan.nextAttemptMs ?? 0) - now;
        // ADDITIVE, never a replacement: a rung may be later than its nominal delay and is never
        // earlier, so the ladder's spacing is a floor rather than an average.
        expect(delay).toBeGreaterThanOrEqual(base);
        expect(delay - base).toBeLessThanOrEqual(base * jitter);
      }
    }
  });

  it("rung 0 is exactly 0 whatever the jitter — the first attempt is due immediately", () => {
    // `0 * jitter` is 0, so "jitter on every rung AFTER the first" needs no branch to be true.
    for (const roll of [0, 0.5, 1]) {
      expect(planNextAttempt(0, 500, 1, () => roll).nextAttemptMs).toBe(500);
    }
  });

  it("clamps a hostile `rnd`, so the documented bound is a bound and not a hope", () => {
    const now = 0;
    const base = 30_000;
    // An injected generator that answers outside [0,1) must not be able to push a delivery past
    // the ceiling this function documents, in either direction.
    expect(planNextAttempt(1, now, 0.1, () => 5).nextAttemptMs).toBe(base + base * 0.1);
    expect(planNextAttempt(1, now, 0.1, () => -3).nextAttemptMs).toBe(base);
    expect(planNextAttempt(1, now, 9, () => 1).nextAttemptMs).toBe(base + base);
    expect(planNextAttempt(1, now, -1, () => 1).nextAttemptMs).toBe(base);
  });

  it("honours an operator's own `webhooks.backoffMs` rather than only D9's", () => {
    // The schema makes the array configurable (§5.8.7); a "pure" ladder that ignored it would be
    // configurable only in the config file.
    const ladder = [0, 5_000, 10_000];
    expect(planNextAttempt(1, 0, 0, ZERO, ladder).nextAttemptMs).toBe(5_000);
    expect(planNextAttempt(2, 0, 0, ZERO, ladder).nextAttemptMs).toBe(10_000);
    expect(planNextAttempt(3, 0, 0, ZERO, ladder)).toEqual({
      state: "failed",
      nextAttemptMs: null,
    });
  });
});
