import {
  type EventEnvelope,
  type EventStore,
  type EventStoreDiagnostics,
  type PersistenceHandle,
  type RetentionReport,
  type Seq,
  type WorkerId,
  type WorkerRow,
} from "@omni-acp/protocol";

/**
 * An in-memory `PersistenceHandle` for the DAEMON WIRING's own tests.
 *
 * `@omni-acp/core`'s real store is M1-WP-A's and is a throwing stub in this tree, and the thing
 * under test here is not SQLite: it is whether `createDaemon` opens a store before adoption,
 * whether `registry.get()` rehydrates a row it never created, whether `list()` reads the store
 * with live entries overriding, and whether `stop()` closes it AFTER `closeAll`. Every one of
 * those is a statement about the wiring, and a real database would only make them slower and
 * dependent on a package that has not landed.
 *
 * It is REAL where the daemon can observe it — `headOf` is monotonic, `put` actually stores,
 * `abandoned()` filters by boot id exactly as §15.7 requires — so an assertion against it is an
 * assertion, not a tautology.
 */
export interface FakePersistence extends PersistenceHandle {
  /** Every envelope ever put, per worker, in order. */
  readonly stored: ReadonlyMap<WorkerId, readonly EventEnvelope[]>;
  readonly rows: ReadonlyMap<WorkerId, WorkerRow>;
  /** Set to make every `put` throw, for the §14.3 degraded-write path. */
  failWrites: boolean;
  readonly closed: boolean;
  readonly sweeps: number;
  /** Seed a row as if a previous boot had written it. */
  seed(row: WorkerRow): void;
}

export function fakePersistence(o?: { bootId?: string }): FakePersistence {
  const events = new Map<WorkerId, EventEnvelope[]>();
  /** `max(seq)` EVER assigned, including evicted rows — §14.4's whole point. */
  const heads = new Map<WorkerId, Seq>();
  const tails = new Map<WorkerId, Seq>();
  const rows = new Map<WorkerId, WorkerRow>();
  let closed = false;
  let sweeps = 0;
  let writeFailures = 0;
  const state = { failWrites: false };

  const diagnostics: EventStoreDiagnostics = {
    driver: "memory",
    file: "<fake>",
    schemaVersion: 1,
    get sizeBytes(): number {
      return [...events.values()].reduce((n, list) => n + list.length, 0);
    },
    get writeFailures(): number {
      return writeFailures;
    },
  };

  const store: EventStore = {
    headOf: (workerId) => heads.get(workerId) ?? 0,
    tailOf: (workerId) => tails.get(workerId) ?? events.get(workerId)?.[0]?.seq ?? 1,
    put(e): void {
      if (state.failWrites) {
        writeFailures += 1;
        throw new Error("fake persistence: writes are failing");
      }
      const list = events.get(e.workerId) ?? [];
      list.push(e);
      events.set(e.workerId, list);
      heads.set(e.workerId, Math.max(heads.get(e.workerId) ?? 0, e.seq));
    },
    read: (workerId, since, limit) =>
      (events.get(workerId) ?? []).filter((e) => e.seq > since).slice(0, limit),
    evict(workerId, upTo): number {
      const list = events.get(workerId) ?? [];
      const kept = list.filter((e) => e.seq > upTo);
      events.set(workerId, kept);
      tails.set(workerId, upTo + 1);
      return list.length - kept.length;
    },
    seqAtOffset: (workerId, offset) => (events.get(workerId) ?? [])[offset]?.seq ?? null,
    workersWithEvents: () => [...events.keys()],
    diagnostics,
  };

  return {
    events: store,
    workers: {
      upsert(row): void {
        rows.set(row.snapshot.workerId, row);
      },
      get: (id) => rows.get(id) ?? null,
      list: () =>
        [...rows.values()].sort(
          (a, b) => Date.parse(b.snapshot.updatedAt) - Date.parse(a.snapshot.updatedAt),
        ),
      // §15.7 exactly: rows a DIFFERENT boot owned. The live-state filter is the caller's, so a
      // test can seed a `hibernated` row and prove adoption leaves it alone.
      abandoned: (currentBootId) => [...rows.values()].filter((r) => r.bootId !== currentBootId),
      delete(id): void {
        rows.delete(id);
        events.delete(id);
      },
      closedBefore: (cutoffMs) =>
        [...rows.values()].filter((r) => r.closedAtMs !== null && r.closedAtMs < cutoffMs),
    },
    bootId: o?.bootId ?? "boot_fake_current",
    sweep(): RetentionReport {
      sweeps += 1;
      return { workersDropped: 0, eventsDeleted: 0, byAge: 0, byRowCap: 0, durationMs: 0 };
    },
    close(): void {
      closed = true;
    },

    stored: events,
    rows,
    get failWrites(): boolean {
      return state.failWrites;
    },
    set failWrites(v: boolean) {
      state.failWrites = v;
    },
    get closed(): boolean {
      return closed;
    },
    get sweeps(): number {
      return sweeps;
    },
    seed(row): void {
      rows.set(row.snapshot.workerId, row);
    },
  };
}
