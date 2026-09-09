import type { Clock, TimerHandle } from "@omni-acp/protocol";

/**
 * The park deadline, split from the park itself for the reason `HibernateTimer` is split from
 * hibernation: one `Clock.setTimer`, no policy.
 *
 * `timeoutMs: 0` NEVER arms — a park that waits forever is a real configuration (a human is
 * genuinely expected), and `InteractionSnapshot.expiresAt` must read `null` rather than a
 * deadline nothing is counting down to. `armed` is what the snapshot reads.
 *
 * When it fires, `parkTimeoutAction` applies — `"deny"` or `"fail"`, never `"allow"`: an
 * auto-allow on a timer is a remote-execution primitive whose only guard is a clock (ruling
 * M2-R7). This file does not know which; it only owns the deadline.
 *
 * `cancel()` is idempotent and safe after firing, because every teardown path calls it blindly
 * beside `Watchdog.cancel()` (review R15) and a park that expired one tick before a close must
 * not throw its way out of the close.
 *
 * Owned by M2-A-WP-I.
 */
export function createParkTimer(o: {
  clock: Clock;
  timeoutMs: number;
  onExpire: () => void;
}): TimerHandle & { readonly armed: boolean } {
  // 0 (and any non-positive value a caller managed to produce) is "wait forever", not "expire
  // immediately". The distinction is load-bearing: `parkTimeoutMs: 0` is the documented way to
  // say a human is genuinely expected, and a timer that fired at once would turn it into the
  // opposite of what it asks for.
  if (!Number.isFinite(o.timeoutMs) || o.timeoutMs <= 0) {
    return { cancel: () => {}, armed: false };
  }

  let live = true;
  const handle = o.clock.setTimer(o.timeoutMs, () => {
    if (!live) return;
    // Disarmed BEFORE the callback runs, so `armed` is already false while `onExpire` settles the
    // interaction — the snapshot it builds must not advertise a deadline that has just passed.
    live = false;
    o.onExpire();
  });

  return {
    cancel(): void {
      if (!live) return;
      live = false;
      handle.cancel();
    },
    get armed(): boolean {
      return live;
    },
  };
}
