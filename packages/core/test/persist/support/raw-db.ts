import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Clock, EventStore, WorkerStore } from "@omni-acp/protocol";
import { fakeClock, nullLogger } from "@omni-acp/testkit";
import { createSqliteEventStore } from "../../../src/persist/event-store.js";
import { migrate, type SqliteDatabase } from "../../../src/persist/schema.js";
import { createSqliteWorkerStore } from "../../../src/persist/worker-store.js";

export type RawEventStore = EventStore & { flush(): void; payloadCount(): number };

export interface RawStore {
  db: SqliteDatabase;
  events: RawEventStore;
  workers: WorkerStore;
  clock: Clock;
  dir: string;
  file: string;
  /** Close and re-open the SAME file with FRESH stores — the restart, without the temp dir going. */
  reopen(): void;
  dispose(): Promise<void>;
}

function openDb(file: string): SqliteDatabase {
  const db = new DatabaseSync(file) as unknown as SqliteDatabase;
  db.exec("pragma auto_vacuum = INCREMENTAL");
  db.exec("pragma busy_timeout = 5000");
  db.exec("pragma foreign_keys = ON");
  db.exec("pragma synchronous = NORMAL");
  if (file !== ":memory:") db.prepare("pragma journal_mode = wal").get();
  migrate(db, { warn: (m) => nullLogger().warn(m) });
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
export async function rawStore(o: { file?: string; dir?: string } = {}): Promise<RawStore> {
  const dir = o.dir ?? (await mkdtemp(join(tmpdir(), "omni-acp-raw-")));
  const file = o.file ?? join(dir, "events.db");
  const clock = fakeClock();

  const store: RawStore = {
    db: openDb(file),
    events: null as unknown as RawEventStore,
    workers: null as unknown as WorkerStore,
    clock,
    dir,
    file,
    reopen(): void {
      store.events.flush();
      store.db.close();
      store.db = openDb(file);
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
    store.workers = createSqliteWorkerStore(store.db);
  }
  wire();

  return store;
}

/** `pragma <name>` as a number, for the freelist and page accounting §14.5 asks about. */
export function pragmaNumber(db: SqliteDatabase, name: string): number {
  const row = db.prepare(`pragma ${name}`).get();
  return Number(row?.[name] ?? 0);
}
