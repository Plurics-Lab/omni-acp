import { OmniError, type Clock, type HibernateTimer } from "@omni-acp/protocol";

/**
 * The idle timer that drives `ready -> hibernated` (§15.2, DESIGN §3.2: 进程回收、lease 释放、
 * 记录与 session 指针保留).
 *
 * It NEVER fires mid-turn: `pause()` on prompt, `touch()` on turn end. And on an agent that
 * advertises no resume spelling it refuses to fire at all under the default
 * `hibernate.whenNotResumable: "keep"` — hibernating a worker you can never wake turns a healthy
 * worker into a guaranteed 422 on a timer (ruling M1-R15).
 *
 * Owned by M1-WP-C.
 */
export function createHibernateTimer(_o: {
  clock: Clock;
  idleMs: number;
  onFire: () => void;
}): HibernateTimer {
  throw new OmniError("internal", "unimplemented: M1-WP-C");
}
