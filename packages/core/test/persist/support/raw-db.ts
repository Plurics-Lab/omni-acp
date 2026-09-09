import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Clock, EventStore, WorkerStore } from "@omni-acp/protocol";
import { fakeClock, nullLogger } from "@omni-acp/testkit";
import { createDeliveryStore, type DeliveryStoreV2 } from "../../../src/persist/delivery-store.js";
import { createSqliteEventStore } from "../../../src/persist/event-store.js";
import { createRunStore } from "../../../src/persist/run-store.js";
import {
  SCHEMA_VERSION,
  migrateTo,
  withTransaction,
  type SqliteDatabase,
} from "../../../src/persist/schema.js";
import { createSqliteWorkerStore } from "../../../src/persist/worker-store.js";

export type RawEventStore = EventStore & { flush(): void; payloadCount(): number };

export interface RawStore {
  db: SqliteDatabase;
  events: RawEventStore;
  workers: WorkerStore;
  /** Schema v2's two stores, over the same file (§24.2). */
  runs: ReturnType<typeof createRunStore>;
  deliveries: DeliveryStoreV2;
  /** §24.4 rule 1's transaction, so a test can plant a throw inside one. */
  transaction<T>(fn: () => T): T;
  clock: Clock;
  dir: string;
  file: string;
  /** Close and re-open the SAME file with FRESH stores — the restart, without the temp dir going. */
  reopen(): void;
  dispose(): Promise<void>;
}

/**
 * `version` is the SCHEMA a daemon of that vintage understands: `1` opens the file as an M1
 * daemon would, `2` as an M2 daemon written before schema v3 did, and the default as THIS one
 * does. It is what makes the BACKWARD direction of §24.2 testable against the shipped `migrateTo`
 * rather than against a copy of its logic.
 */
export function openDb(file: string, version = SCHEMA_VERSION): SqliteDatabase {
  const db = new DatabaseSync(file) as unknown as SqliteDatabase;
  db.exec("pragma auto_vacuum = INCREMENTAL");
  db.exec("pragma busy_timeout = 5000");
  db.exec("pragma foreign_keys = ON");
  db.exec("pragma synchronous = NORMAL");
  if (file !== ":memory:") db.prepare("pragma journal_mode = wal").get();
  migrateTo(db, { warn: (m) => nullLogger().warn(m) }, version);
  return db;
}

/**
 * A store over a database THIS TEST holds the handle to.
 *
 * `openPersistence` deliberately hides the `DatabaseSync` — nothing in `src/` needs it — but two
 * obligations cannot be checked from outside it: that `evict()` is ONE transaction (proved by
 * making the DELETE abort and watching the tail not move) and that the schema is the one §14.7
 * describes. Both are statements about the file, so the test opens the file.
 *
 * `node:sqlite` is imported at the top here on purpose: this module is only ever loaded by a
 * test that is already about SQLite, and the "memory driver never loads it" guarantee is proved
 * in a FRESH PROCESS (`support/child.ts`), where nothing this file does can flatter the result.
 */
export async function rawStore(
  o: { file?: string; dir?: string; version?: number } = {},
): Promise<RawStore> {
  const dir = o.dir ?? (await mkdtemp(join(tmpdir(), "omni-acp-raw-")));
  const file = o.file ?? join(dir, "events.db");
  const clock = fakeClock();
  // The SAME vintage on a reopen: a restart that silently upgraded the file would make
  // `reopen()` test a different daemon from the one that wrote it.
  const version = o.version ?? SCHEMA_VERSION;

  const store: RawStore = {
    db: openDb(file, version),
    events: null as unknown as RawEventStore,
    workers: null as unknown as WorkerStore,
    runs: null as unknown as RawStore["runs"],
    deliveries: null as unknown as DeliveryStoreV2,
    transaction<T>(fn: () => T): T {
      return withTransaction(store.db, fn);
    },
    clock,
    dir,
    file,
    reopen(): void {
      store.events.flush();
      store.db.close();
      store.db = openDb(file, version);
      wire();
    },
    async dispose(): Promise<void> {
      try {
        store.db.close();
      } catch {
        // Already closed by the test.
      }
      if (o.dir === undefined) await rm(dir, { recursive: true, force: true });
    },
  };

  function wire(): void {
    store.events = createSqliteEventStore(store.db, {
      clock,
      file: file === ":memory:" ? null : file,
    });
    // The worker store's upsert names `m2_json`, which schema v3 adds, so it is wired only when
    // the file actually has the column — the same rule the v2 stores below follow, for the same
    // reason: a prepare-time throw inside this helper is far harder to read than a null
    // dereference in the test that reached for a store its file cannot have.
    if (hasColumn(store.db, "workers", "m2_json")) {
      store.workers = createSqliteWorkerStore(store.db);
    }
    // The v2 stores prepare statements against tables a VERSION-1 open deliberately does not
    // create, so they are wired only when the file actually has them. Reaching `store.runs` on a
    // v1 handle is then a null dereference in the test rather than a confusing prepare-time
    // throw inside the helper.
    if (hasTable(store.db, "runs")) {
      store.runs = createRunStore(store.db);
      store.deliveries = createDeliveryStore(store.db);
    }
  }
  wire();

  return store;
}

export function hasColumn(db: SqliteDatabase, table: string, column: string): boolean {
  return db
    .prepare(`select name from pragma_table_info(?)`)
    .all(table)
    .some((r) => String(r["name"]) === column);
}

export function hasTable(db: SqliteDatabase, name: string): boolean {
  return (
    db.prepare("select name from sqlite_master where type = 'table' and name = ?").get(name) !==
    undefined
  );
}

/** `pragma <name>` as a number, for the freelist and page accounting §14.5 asks about. */
export function pragmaNumber(db: SqliteDatabase, name: string): number {
  const row = db.prepare(`pragma ${name}`).get();
  return Number(row?.[name] ?? 0);
}
