import { OmniError } from "@omni-acp/protocol";
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
 * M2-R7).
 *
 * Owned by M2-A-WP-I.
 */
export function createParkTimer(_o: {
  clock: Clock;
  timeoutMs: number;
  onExpire: () => void;
}): TimerHandle & { readonly armed: boolean } {
  throw new OmniError("internal", "unimplemented: M2-A-WP-I");
}
