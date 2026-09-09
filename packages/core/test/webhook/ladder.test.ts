import { describe, it } from "vitest";

/**
 * D9's retry ladder, as a pure table under `fakeClock()` — no network, no timers, `rnd` injected.
 *
 * Owned by M2-B-WP-R.
 */

describe("planNextAttempt (D9)", () => {
  it.todo("reproduces 0s / 30s / 2m / 10m / 30m / 2h and then `failed`, exactly");
  it.todo("keeps full jitter within [0, base*jitter] on every rung after the first");
});
