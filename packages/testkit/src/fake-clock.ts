import type { Clock, TimerHandle } from "@omni-acp/protocol";

export interface FakeClock extends Clock {
  advance(ms: number): void;
  readonly pendingTimers: number;
  set(epochMs: number): void;
}

interface Scheduled {
  readonly at: number;
  readonly seq: number;
  readonly fn: () => void;
}

/** 2026-01-01T00:00:00.000Z — a fixed, readable epoch so `iso()` output is stable in snapshots. */
const DEFAULT_START = Date.UTC(2026, 0, 1);

/**
 * A deterministic Clock.
 *
 * `advance()` is the ONLY thing that fires timers, and it fires them in due order, moving `now`
 * to each timer's own deadline first — so a callback that schedules another timer sees the time
 * its own timer was due at, not the end of the window. `set()` re-bases the clock WITHOUT
 * firing anything; a timer whose deadline it steps past fires on the next `advance()`.
 */
export function fakeClock(startEpochMs: number = DEFAULT_START): FakeClock {
  let now = startEpochMs;
  let seq = 0;
  const timers: Scheduled[] = [];

  const dueIndex = (limit: number): number => {
    let best = -1;
    for (let i = 0; i < timers.length; i++) {
      const t = timers[i];
      const b = best === -1 ? undefined : timers[best];
      if (t === undefined || t.at > limit) continue;
      if (b === undefined || t.at < b.at || (t.at === b.at && t.seq < b.seq)) best = i;
    }
    return best;
  };

  return {
    now: () => now,
    iso: () => new Date(now).toISOString(),
    setTimer(delayMs: number, fn: () => void): TimerHandle {
      const entry: Scheduled = { at: now + Math.max(0, delayMs), seq: seq++, fn };
      timers.push(entry);
      return {
        cancel() {
          const i = timers.indexOf(entry);
          if (i !== -1) timers.splice(i, 1);
        },
      };
    },
    advance(ms: number): void {
      const target = now + Math.max(0, ms);
      for (;;) {
        const i = dueIndex(target);
        if (i === -1) break;
        const [entry] = timers.splice(i, 1);
        if (entry === undefined) break;
        if (entry.at > now) now = entry.at;
        entry.fn();
      }
      now = target;
    },
    get pendingTimers(): number {
      return timers.length;
    },
    set(epochMs: number): void {
      now = epochMs;
    },
  };
}
