import type { Clock, HibernateTimer, Logger, TimerHandle } from "@omni-acp/protocol";

/**
 * The idle timer that drives `ready -> hibernated` (CONTRACTS.md §15.2, DESIGN §3.2:
 * 进程回收、lease 释放、记录与 session 指针保留).
 *
 * It NEVER fires mid-turn: `pause()` on prompt, `touch()` on turn end. And on an agent that
 * advertises no resume spelling it refuses to fire at all under the default
 * `hibernate.whenNotResumable: "keep"` — hibernating a worker you can never wake turns a healthy
 * worker into a guaranteed 422 on a timer (ruling M1-R15).
 *
 * Owned by M1-WP-C.
 */
export interface HibernateTimerOptions {
  readonly clock: Clock;
  /** `hibernate.idleMs`. **0 disables hibernation daemon-wide** and the timer never arms. */
  readonly idleMs: number;
  /** The `ready -> hibernated` transition. Called only when the worker IS resumable. */
  readonly onFire: () => void;
  /**
   * Ruling M1-R15's gate, consulted AT FIRE TIME rather than at construction: a worker's
   * `capabilities.resume.method` is resolved by a handshake that may not have happened yet when
   * the timer is built, and a wake can change it. Absent ⇒ always resumable, which is what a
   * caller that has already made the decision itself wants.
   */
  readonly resumable?: () => boolean;
  /**
   * What to do when the timer fires on a worker that cannot resume.
   *
   * "keep" (the DEFAULT, M1-R15) — refuse: hold the process, log once at info, and do not
   *   re-arm. §15.1's `ready -> ready` row emits no envelope at all, because nothing happened.
   * "close" — the operator would rather lose the session than the memory; `onNotResumable` is
   *   the `close("idle_timeout")` that row calls for.
   */
  readonly whenNotResumable?: "keep" | "close";
  /** The `"close"` opt-in's action. Absent under `"close"` ⇒ the timer degrades to `"keep"`. */
  readonly onNotResumable?: () => void;
  readonly logger?: Logger;
}

export function createHibernateTimer(o: HibernateTimerOptions): HibernateTimer {
  const { clock, idleMs } = o;
  const whenNotResumable = o.whenNotResumable ?? "keep";
  let timer: TimerHandle | null = null;
  /** Terminal. `cancel()` is for a worker that is CLOSING; `pause()` is for one mid-turn. */
  let stopped = false;
  /** §15.1's `ready -> ready` row: "(none; logged once at info)". Once, not once per timer. */
  let refusalLogged = false;

  const disarm = (): void => {
    timer?.cancel();
    timer = null;
  };

  const fire = (): void => {
    // Cleared BEFORE the callback: `armed` must read false from inside `onFire`, because that
    // callback runs the state transition and everything it touches asks whether the timer is up.
    timer = null;
    if (stopped) return;

    if (o.resumable?.() === false) {
      if (whenNotResumable === "close" && o.onNotResumable !== undefined) {
        o.onNotResumable();
        return;
      }
      // M1-R15's default: refuse, and do NOT re-arm. Re-arming would produce one log line per
      // idle period forever for a worker whose answer can only change when it wakes — and it
      // cannot wake, because it never slept.
      if (!refusalLogged) {
        refusalLogged = true;
        o.logger?.info(
          "idle timer fired on a worker whose agent advertises no resume spelling; " +
            "keeping the process (hibernate.whenNotResumable: keep)",
          { idleMs },
        );
      }
      return;
    }

    o.onFire();
  };

  return {
    touch(): void {
      // A `touch` after `cancel` is a no-op by design: `cancel()` means this worker is going
      // away, and a timer that could be revived from a listener would fire against a closed
      // worker. A worker that comes BACK — a wake — takes a new timer with it.
      if (stopped) return;
      disarm();
      // 0 disables hibernation daemon-wide (`HibernateConfig.idleMs`), and "disabled" must mean
      // "never fires", not "fires immediately".
      if (idleMs <= 0) return;
      timer = clock.setTimer(idleMs, fire);
    },

    pause(): void {
      // Suspended, not spent: `touch()` on the turn boundary starts the countdown again.
      disarm();
    },

    cancel(): void {
      stopped = true;
      disarm();
    },

    get armed(): boolean {
      return timer !== null;
    },
  };
}
