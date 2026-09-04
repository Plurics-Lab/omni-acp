import { describe, expect, it } from "vitest";
import { fakeClock } from "@omni-acp/testkit";
import { createHibernateTimer } from "../../src/worker/hibernate.js";
import { recordingLogger } from "../process/support.js";

/**
 * The idle timer that drives `ready -> hibernated` (CONTRACTS.md §15.2, §15.1's three
 * idle-timer rows).
 *
 * Everything here is on a `fakeClock`: the timer's whole contract is about WHEN, and a test that
 * waited on real time would either be slow or be flaky, and would prove nothing about the 30
 * minutes an operator actually configures.
 */

const IDLE = 1_800_000;

describe("createHibernateTimer", () => {
  it("starts DISARMED: a timer nobody touched is not counting down", () => {
    const clock = fakeClock();
    let fired = 0;
    const timer = createHibernateTimer({
      clock,
      idleMs: IDLE,
      onFire: () => {
        fired += 1;
      },
    });
    expect(timer.armed).toBe(false);
    clock.advance(IDLE * 10);
    expect(fired).toBe(0);
  });

  it("fires exactly once, exactly at `idleMs` — not a millisecond early", () => {
    const clock = fakeClock();
    let fired = 0;
    const timer = createHibernateTimer({
      clock,
      idleMs: IDLE,
      onFire: () => {
        fired += 1;
      },
    });
    timer.touch();
    expect(timer.armed).toBe(true);

    clock.advance(IDLE - 1);
    expect(fired).toBe(0);
    clock.advance(1);
    expect(fired).toBe(1);
    // Spent, not repeating: the transition it drives happens once, and the next `ready` takes a
    // fresh countdown with it.
    expect(timer.armed).toBe(false);
    clock.advance(IDLE * 3);
    expect(fired).toBe(1);
  });

  it("`armed` reads false from INSIDE onFire — the callback runs the transition", () => {
    const clock = fakeClock();
    let armedDuringFire: boolean | null = null;
    const timer: { armed: boolean } = createHibernateTimer({
      clock,
      idleMs: IDLE,
      onFire: () => {
        armedDuringFire = timer.armed;
      },
    });
    timer.touch();
    clock.advance(IDLE);
    expect(armedDuringFire).toBe(false);
  });

  it("touch() RESTARTS the countdown, so a chatty worker never idles out", () => {
    const clock = fakeClock();
    let fired = 0;
    const timer = createHibernateTimer({
      clock,
      idleMs: 1_000,
      onFire: () => {
        fired += 1;
      },
    });
    for (let i = 0; i < 10; i += 1) {
      timer.touch();
      clock.advance(999);
      expect(fired).toBe(0);
    }
    clock.advance(1);
    expect(fired).toBe(1);
  });

  it("pause() suspends and touch() resumes — this is what keeps it off a live turn (§15.2)", () => {
    const clock = fakeClock();
    let fired = 0;
    const timer = createHibernateTimer({
      clock,
      idleMs: 1_000,
      onFire: () => {
        fired += 1;
      },
    });
    timer.touch();
    clock.advance(900);
    // A prompt arrives: the turn is live, and a worker mid-turn must NEVER be hibernated.
    timer.pause();
    expect(timer.armed).toBe(false);
    clock.advance(1_000_000);
    expect(fired).toBe(0);

    // The turn settles.
    timer.touch();
    expect(timer.armed).toBe(true);
    // A FULL idle period from the turn boundary, not the 100 ms that were left before it.
    clock.advance(999);
    expect(fired).toBe(0);
    clock.advance(1);
    expect(fired).toBe(1);
  });

  it("cancel() is FINAL: a closed worker's timer can never be revived by a stray touch()", () => {
    const clock = fakeClock();
    let fired = 0;
    const timer = createHibernateTimer({
      clock,
      idleMs: 1_000,
      onFire: () => {
        fired += 1;
      },
    });
    timer.touch();
    timer.cancel();
    expect(timer.armed).toBe(false);
    timer.touch();
    expect(timer.armed).toBe(false);
    clock.advance(1_000_000);
    expect(fired).toBe(0);
  });

  it("leaves no pending timer behind on pause or cancel", () => {
    const clock = fakeClock();
    const timer = createHibernateTimer({ clock, idleMs: 1_000, onFire: () => {} });
    timer.touch();
    expect(clock.pendingTimers).toBe(1);
    timer.touch();
    // Restarting replaces rather than stacking: ten turn boundaries must not leave ten timers.
    expect(clock.pendingTimers).toBe(1);
    timer.pause();
    expect(clock.pendingTimers).toBe(0);
    timer.touch();
    timer.cancel();
    expect(clock.pendingTimers).toBe(0);
  });

  it("`idleMs: 0` disables hibernation daemon-wide — never fires, never arms", () => {
    const clock = fakeClock();
    let fired = 0;
    const timer = createHibernateTimer({
      clock,
      // `HibernateConfig.idleMs`: "0 disables hibernation daemon-wide". Disabled must mean
      // "never", not "immediately", which is what a naive `setTimer(0)` would produce.
      idleMs: 0,
      onFire: () => {
        fired += 1;
      },
    });
    timer.touch();
    expect(timer.armed).toBe(false);
    clock.advance(1_000_000);
    expect(fired).toBe(0);
  });
});

/**
 * Ruling M1-R15 — the reason `whenNotResumable` exists at all: hibernating a worker you can
 * never wake turns a healthy worker into a guaranteed 422 on a timer, and memory is the cheaper
 * loss.
 */
describe("createHibernateTimer — the not-resumable gate (M1-R15)", () => {
  it('default "keep": REFUSES to fire, logs once at info, and does not re-arm', () => {
    const clock = fakeClock();
    const logger = recordingLogger();
    let fired = 0;
    const timer = createHibernateTimer({
      clock,
      idleMs: 1_000,
      resumable: () => false,
      logger,
      onFire: () => {
        fired += 1;
      },
    });

    timer.touch();
    clock.advance(1_000);
    expect(fired).toBe(0);
    expect(timer.armed).toBe(false);

    const info = logger.lines.filter((l) => l.level === "info");
    expect(info).toHaveLength(1);
    expect(info[0]?.msg).toContain("no resume spelling");

    // §15.1's `ready -> ready` row logs ONCE, not once per idle period: the answer can only
    // change on a wake, and this worker never slept.
    timer.touch();
    clock.advance(1_000);
    expect(logger.lines.filter((l) => l.level === "info")).toHaveLength(1);
    expect(fired).toBe(0);
  });

  it('"close" is the opt-in: `onNotResumable` runs instead, and `onFire` never does', () => {
    const clock = fakeClock();
    let hibernated = 0;
    let closed = 0;
    const timer = createHibernateTimer({
      clock,
      idleMs: 1_000,
      resumable: () => false,
      whenNotResumable: "close",
      onNotResumable: () => {
        closed += 1;
      },
      onFire: () => {
        hibernated += 1;
      },
    });
    timer.touch();
    clock.advance(1_000);
    expect(closed).toBe(1);
    expect(hibernated).toBe(0);
  });

  it('"close" with no action degrades to "keep" rather than hibernating an unwakeable worker', () => {
    const clock = fakeClock();
    let hibernated = 0;
    const timer = createHibernateTimer({
      clock,
      idleMs: 1_000,
      resumable: () => false,
      whenNotResumable: "close",
      onFire: () => {
        hibernated += 1;
      },
    });
    timer.touch();
    clock.advance(1_000);
    expect(hibernated).toBe(0);
  });

  it("is consulted AT FIRE TIME: a handshake that has not happened yet must not decide", () => {
    const clock = fakeClock();
    let resumable = false;
    let fired = 0;
    const timer = createHibernateTimer({
      clock,
      idleMs: 1_000,
      resumable: () => resumable,
      onFire: () => {
        fired += 1;
      },
    });
    timer.touch();
    clock.advance(1_000);
    expect(fired).toBe(0);

    // The worker woke, and this time the agent advertised a spelling.
    resumable = true;
    timer.touch();
    clock.advance(1_000);
    expect(fired).toBe(1);
  });

  it("cancel() beats a due timer: a worker closing while the timer is up does not hibernate", () => {
    const clock = fakeClock();
    let fired = 0;
    const timer = createHibernateTimer({
      clock,
      idleMs: 1_000,
      onFire: () => {
        fired += 1;
      },
    });
    timer.touch();
    timer.cancel();
    clock.advance(1_000);
    expect(fired).toBe(0);
  });
});
