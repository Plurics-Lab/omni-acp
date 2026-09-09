/**
 * D9's ladder, as data: 0s / 30s / 2m / 10m / 30m / 2h. Six rungs, therefore six attempts.
 *
 * Rung 0 is `0` and that is deliberate — the first attempt is due the moment the row exists, so
 * `enqueue` needs no special case and a delivery is never delayed by the retry machinery it has
 * not yet needed.
 */
export const D9_BACKOFF_MS: readonly number[] = [0, 30_000, 120_000, 600_000, 1_800_000, 7_200_000];

/**
 * D9's retry ladder — 0s / 30s / 2m / 10m / 30m / 2h, then `failed`. PURE, and `rnd` is INJECTED
 * so the test is deterministic under `fakeClock()` with no network at all.
 *
 * `attempt` is the number of attempts that have COMPLETED, which is exactly the column the store
 * keeps: `planNextAttempt(0, …)` schedules the first attempt at `nowMs`, and `planNextAttempt(6,
 * …)` — six completed attempts, the whole ladder spent — is `failed`.
 *
 * The jitter is not decoration. Without it a restart makes hundreds of deliveries due in the same
 * tick, the receiver 429s the lot, and they all retry together thirty seconds later — a
 * self-inflicted thundering herd that the ladder's spacing was supposed to prevent. It is applied
 * on every rung after the first (rung 0 is `0`, and `0 * jitter` is `0`, so the rule and the
 * arithmetic agree without a branch), and it is bounded to `[0, base * jitter]`: an ADDITIVE
 * spread, never a replacement for the base, so a rung can be later than its nominal delay and
 * never earlier.
 *
 * `ladder` is a parameter with D9's array as its default rather than a constant, because
 * `webhooks.backoffMs` is configurable (§5.8.7) and a pure function that silently ignored the
 * operator's array would be the kind of "configurable" that is only true in the schema. Every
 * caller inside this package passes the resolved config; the four-argument form in §5.8.9 is what
 * the ladder test asserts against.
 *
 * Owned by M2-B-WP-R.
 */
export function planNextAttempt(
  attempt: number,
  nowMs: number,
  jitter: number,
  rnd: () => number,
  ladder: readonly number[] = D9_BACKOFF_MS,
): { state: "pending" | "failed"; nextAttemptMs: number | null } {
  const rung = Math.max(0, Math.trunc(attempt));
  const base = ladder[rung];
  // The ladder is spent. `failed` is terminal and carries no next attempt — a row with a
  // `nextAttemptMs` that nothing will ever act on is a row an operator has to reason about.
  if (base === undefined) return { state: "failed", nextAttemptMs: null };

  const spread = Math.max(0, Math.min(1, jitter)) * base;
  // `rnd()` is clamped rather than trusted: an injected generator that returns 1.0 (or 1.5) must
  // not be able to push a delivery past the bound this function documents.
  const roll = Math.min(1, Math.max(0, rnd()));
  return { state: "pending", nextAttemptMs: nowMs + base + Math.floor(roll * spread) };
}
