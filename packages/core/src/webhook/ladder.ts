import { OmniError } from "@omni-acp/protocol";

/**
 * D9's retry ladder — 0s / 30s / 2m / 10m / 30m / 2h, then `failed`. PURE, and `rnd` is INJECTED
 * so the test is deterministic under `fakeClock()` with no network at all.
 *
 * The jitter is not decoration. Without it a restart makes hundreds of deliveries due in the same
 * tick, the receiver 429s the lot, and they all retry together thirty seconds later — a
 * self-inflicted thundering herd that the ladder's spacing was supposed to prevent. Full jitter
 * on every rung after the first, bounded to `[0, base * jitter]`.
 *
 * Owned by M2-B-WP-R.
 */
export function planNextAttempt(
  _attempt: number,
  _nowMs: number,
  _jitter: number,
  _rnd: () => number,
): { state: "pending" | "failed"; nextAttemptMs: number | null } {
  throw new OmniError("internal", "unimplemented: M2-B-WP-R");
}
