import { describe, it } from "vitest";

/**
 * `parkTimeoutAction`, against `elicit-never-answers.mjs` — the only way to test it, because the
 * corpus answered both real elicitations in about a millisecond.
 *
 * Owned by M2-A-WP-I.
 */

describe("park timeout (M2-A, §19.7)", () => {
  it.todo(
    'parkTimeoutMs expiry produces by:"timeout" and applies parkTimeoutAction for both "deny" and "fail"',
  );
  it.todo(
    "parkTimeoutMs: 0 never expires, and InteractionSnapshot.expiresAt is null rather than a deadline nothing counts",
  );
});
