import { describe, expect, it } from "vitest";
import { fakeClock } from "@omni-acp/testkit";

describe("fakeClock", () => {
  it("starts at a fixed, readable epoch and reports it as ISO-8601 with ms", () => {
    const clock = fakeClock();
    expect(clock.iso()).toBe("2026-01-01T00:00:00.000Z");
    expect(clock.now()).toBe(Date.UTC(2026, 0, 1));
    expect(fakeClock(0).iso()).toBe("1970-01-01T00:00:00.000Z");
  });

  it("fires timers deterministically, in due order, at their own deadline", () => {
    const clock = fakeClock(0);
    const fired: [string, number][] = [];
    clock.setTimer(30, () => fired.push(["c", clock.now()]));
    clock.setTimer(10, () => fired.push(["a", clock.now()]));
    clock.setTimer(20, () => fired.push(["b", clock.now()]));
    expect(clock.pendingTimers).toBe(3);

    clock.advance(9);
    expect(fired).toEqual([]);

    clock.advance(1);
    expect(fired).toEqual([["a", 10]]);
    expect(clock.pendingTimers).toBe(2);

    clock.advance(100);
    expect(fired).toEqual([
      ["a", 10],
      ["b", 20],
      ["c", 30],
    ]);
    expect(clock.now()).toBe(110);
    expect(clock.pendingTimers).toBe(0);
  });

  it("fires two timers due at the same instant in scheduling order", () => {
    const clock = fakeClock(0);
    const fired: string[] = [];
    clock.setTimer(5, () => fired.push("first"));
    clock.setTimer(5, () => fired.push("second"));
    clock.advance(5);
    expect(fired).toEqual(["first", "second"]);
  });

  it("runs a timer scheduled from inside a callback within the same advance", () => {
    // This is the Normalizer's tick loop: `step()` returns the next `scheduleTickAt`, and the
    // Worker arms it from inside the previous tick.
    const clock = fakeClock(0);
    const fired: number[] = [];
    clock.setTimer(10, () => {
      fired.push(clock.now());
      clock.setTimer(10, () => fired.push(clock.now()));
    });
    clock.advance(25);
    expect(fired).toEqual([10, 20]);
    expect(clock.now()).toBe(25);
  });

  it("cancels a timer exactly once, and cancelling twice is harmless", () => {
    const clock = fakeClock(0);
    let fired = 0;
    const handle = clock.setTimer(10, () => (fired += 1));
    handle.cancel();
    handle.cancel();
    expect(clock.pendingTimers).toBe(0);
    clock.advance(1_000);
    expect(fired).toBe(0);
  });

  it("set() re-bases the clock without firing anything", () => {
    const clock = fakeClock(0);
    let fired = false;
    clock.setTimer(10, () => (fired = true));
    clock.set(1_000);
    expect(fired).toBe(false);
    expect(clock.now()).toBe(1_000);
    // The deadline is absolute, so the timer is now overdue and fires on the next advance.
    clock.advance(0);
    expect(fired).toBe(true);
  });

  it("treats a negative or zero delay as due at the next advance", () => {
    const clock = fakeClock(0);
    const fired: string[] = [];
    clock.setTimer(0, () => fired.push("zero"));
    clock.setTimer(-5, () => fired.push("negative"));
    clock.advance(0);
    expect(fired).toEqual(["zero", "negative"]);
  });
});
