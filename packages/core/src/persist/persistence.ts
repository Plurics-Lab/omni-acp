import type {
  Clock,
  EventStore,
  Logger,
  PersistenceHandle,
  ResolvedEventLogConfig,
  RetentionInput,
  RetentionReport,
  WorkerId,
  WorkerState,
  WorkerStore,
} from "@omni-acp/protocol";
import { planRetention, runRetention } from "../event-log/retention.js";

/**
 * How many freed pages one sweep hands back to the OS.
 *
 * `pragma incremental_vacuum` with no argument moves the WHOLE freelist, which on a data dir
 * that has just aged out a month of logs is an unbounded stall inside a periodic timer. A bound
 * makes the sweep's cost proportional to its own deletions; the remainder goes back on the next
 * pass, which is the pass that would otherwise have nothing to do.
 */
const VACUUM_PAGES_PER_SWEEP = 4_096;

export interface CreatePersistenceHandleOptions {
  readonly events: EventStore;
  readonly workers: WorkerStore;
  readonly bootId: string;
  readonly config: ResolvedEventLogConfig;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Releases the §14.10 data-dir lock. Best effort; a stale lock is broken by the next start. */
  readonly release: () => Promise<void>;
  /** Bounded `pragma incremental_vacuum`, so freed pages actually return to the OS (§14.5). */
  readonly vacuum: (pages: number) => void;
  readonly closeDb: () => void;
}

/**
 * The `PersistenceHandle` `createDaemon()` opens once and hands to the registry: the two stores,
 * this boot's id, one bounded `sweep()`, and `close()`.
 *
 * `bootId` is this daemon INSTANCE's id, not the stable `daemonId` — the difference is what lets
 * boot adoption recognise a row a PREVIOUS boot owned (§15.7).
 *
 * Owned by M1-WP-A.
 */
export function createPersistenceHandle(o: CreatePersistenceHandleOptions): PersistenceHandle {
  const { events, workers, config, logger } = o;
  let closed = false;

  /**
   * The sweep's input, and the one subtlety in building it: a worker can have EVENTS without a
   * `workers` row — the registry's row is debounced and a crash between the first append and the
   * first upsert is ordinary. Such a worker must still be row-capped, so it is included with the
   * only honest description available (`closedAtMs: null`), which by construction makes the age
   * bound skip it: we will not delete a history whose owner we cannot identify.
   */
  const rows = (): RetentionInput["rows"] => {
    const out: {
      workerId: WorkerId;
      state: WorkerState;
      closedAtMs: number | null;
      head: number;
      tail: number;
    }[] = [];
    const seen = new Set<WorkerId>();

    for (const row of workers.list()) {
      const id = row.snapshot.workerId;
      seen.add(id);
      out.push({
        workerId: id,
        state: row.snapshot.state,
        closedAtMs: row.closedAtMs,
        head: events.headOf(id),
        tail: events.tailOf(id),
      });
    }
    for (const id of events.workersWithEvents()) {
      if (seen.has(id)) continue;
      out.push({
        workerId: id,
        state: "closed",
        closedAtMs: null,
        head: events.headOf(id),
        tail: events.tailOf(id),
      });
    }
    return out;
  };

  const handle: PersistenceHandle = {
    events,
    workers,
    bootId: o.bootId,

    sweep(nowMs: number): RetentionReport {
      const plan = planRetention({
        nowMs,
        retentionDays: config.retentionDays,
        maxPersistedEventsPerWorker: config.maxPersistedEventsPerWorker,
        rows: rows(),
      });
      const report = runRetention(handle, plan);
      if (report.eventsDeleted > 0 || report.workersDropped > 0) {
        // AFTER the deletes, and bounded: pages only return to the OS when something asks, and
        // `auto_vacuum = INCREMENTAL` is set before the first table exists precisely so that
        // asking is possible at all.
        try {
          o.vacuum(VACUUM_PAGES_PER_SWEEP);
        } catch (e) {
          logger.warn("incremental vacuum failed", {
            error: e instanceof Error ? e.message : String(e),
          });
        }
        logger.info("retention sweep", { ...report });
      }
      return report;
    },

    close(): void {
      if (closed) return;
      closed = true;
      // §14.4's debounced `head_seq` is the only thing that can be pending; settling it here is
      // what makes "close the store → reopen ⇒ head is unchanged" true even when the last 255
      // appends never triggered a flush.
      flushIfPossible(events);
      o.closeDb();
      // Not awaited: `PersistenceHandle.close()` is synchronous by contract, and an unlink that
      // loses the race with process exit leaves a lock naming a pid that is provably gone — the
      // exact case `acquireDataDirLock` breaks on the next start.
      void o.release().catch((e: unknown) => {
        logger.warn("releasing the data-dir lock failed", {
          error: e instanceof Error ? e.message : String(e),
        });
      });
    },
  };

  return handle;
}

function flushIfPossible(events: EventStore): void {
  const maybe = events as EventStore & { flush?: () => void };
  if (typeof maybe.flush === "function") maybe.flush();
}
