import { openPersistence } from "@omni-acp/core";
import {
  type Clock,
  type Logger,
  type PersistenceHandle,
  type ResolvedDaemonConfig,
  type RetentionReport,
  type TimerHandle,
} from "@omni-acp/protocol";

/**
 * The daemon's side of persistence: open it once, take the data-dir lock, migrate, arm the
 * retention timer, and close it AFTER `closeAll` so the closing envelopes reach disk
 * (CONTRACTS.md §14, M1-PLAN WP-E acceptance 5).
 *
 * Returns `null` for `eventLog.driver: "memory"`, which is still the default (ruling M1-R17):
 * `createDaemon()` must keep a zero-file, zero-experimental-module footprint so `OmniACP.local()`
 * in a user's script does not leave a database behind. `omni-acp start` is what writes
 * `"sqlite"` into the config it builds.
 *
 * The import of `openPersistence` is static, but `openPersistence` itself loads `node:sqlite`
 * LAZILY and only for the sqlite driver (§14.2, F12) — so the memory path below never touches an
 * experimental module, which is the property ruling M1-R17 is actually about.
 *
 * Owned by M1-WP-E (the wiring) over M1-WP-A's `openPersistence`.
 */
export async function openDaemonPersistence(o: {
  config: ResolvedDaemonConfig;
  clock: Clock;
  logger: Logger;
}): Promise<PersistenceHandle | null> {
  if (o.config.eventLog.driver === "memory") return null;

  const file = o.config.eventLog.file;
  return await openPersistence({
    dataDir: o.config.dataDir,
    ...(file === undefined ? {} : { file }),
    config: o.config.eventLog,
    clock: o.clock,
    logger: o.logger.child({ mod: "persist" }),
  });
}

export interface RetentionTimer {
  /** The last sweep's report, for `GET /v1/info.persistence.lastSweep`. Null until one has run. */
  readonly lastSweep: RetentionReport | null;
  /** Run one sweep now. Returns null when there is nothing to sweep or the sweep failed. */
  sweepNow(): RetentionReport | null;
  stop(): void;
}

/**
 * §14.5's three bounds, on a timer.
 *
 * `PersistenceHandle.sweep(nowMs)` is the driver's own one-shot; this only decides WHEN. The
 * timer is rearmed after each run rather than being an interval, so a sweep that takes longer
 * than `retentionSweepMs` cannot queue a second one behind itself.
 *
 * A sweep that throws is logged and the timer is REARMED: retention failing is a disk problem,
 * and a daemon that stopped sweeping after one bad night would silently grow forever — which is
 * the failure this whole section exists to prevent.
 */
export function armRetention(o: {
  persistence: PersistenceHandle | null;
  config: ResolvedDaemonConfig;
  clock: Clock;
  logger: Logger;
  /**
   * M3-WP1's HOME sweep, rid[d]en on the SAME timer (§Home 隔离: close + retention 后删除).
   *
   * It is the same timer rather than a second one for the reason the timer is rearmed rather than
   * an interval: two timers over the same worker rows is two answers to "is this worker retired",
   * and the one that ran second would find a home whose row the first had already dropped.
   *
   * Absent ⇒ nothing sweeps homes, which is M2 (there were none).
   */
  homes?: (nowMs: number) => Promise<void>;
}): RetentionTimer {
  let last: RetentionReport | null = null;
  let timer: TimerHandle | null = null;
  let stopped = false;

  const sweepNow = (): RetentionReport | null => {
    const handle = o.persistence;
    if (handle === null) return null;
    try {
      const report = handle.sweep(o.clock.now());
      last = report;
      if (report.eventsDeleted > 0 || report.workersDropped > 0) {
        o.logger.info("retention sweep", { ...report });
      }
      return report;
    } catch (e) {
      o.logger.warn("retention sweep failed", { error: String(e) });
      return null;
    }
  };

  const arm = (): void => {
    // `persistence === null` is the MEMORY driver: there are no rows to sweep — but there may
    // still be homes, because `home: "isolated"` does not depend on a database. So the timer is
    // armed whenever either half has work.
    if (stopped || (o.persistence === null && o.homes === undefined)) return;
    timer = o.clock.setTimer(o.config.eventLog.retentionSweepMs, () => {
      sweepNow();
      // AFTER the row sweep, deliberately: a worker whose row has just been dropped is a home
      // nothing can ever read again, and running the home sweep first would leave it for a whole
      // `retentionSweepMs`. It never throws — `sweepNow`'s rule — and it never blocks the rearm.
      void o.homes?.(o.clock.now()).catch((e: unknown) => {
        o.logger.warn("the worker-home retention sweep failed", { error: String(e) });
      });
      arm();
    });
  };
  arm();

  return {
    get lastSweep(): RetentionReport | null {
      return last;
    },
    sweepNow,
    stop(): void {
      stopped = true;
      timer?.cancel();
      timer = null;
    },
  };
}
