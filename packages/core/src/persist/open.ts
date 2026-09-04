import { mkdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  OmniError,
  type Clock,
  type EventEnvelope,
  type Logger,
  type PersistenceHandle,
  type ResolvedEventLogConfig,
} from "@omni-acp/protocol";
import { createSqliteEventStore } from "./event-store.js";
import { acquireDataDirLock } from "./lock.js";
import { createPersistenceHandle } from "./persistence.js";
import { migrate, type SqliteDatabase } from "./schema.js";
import { withSuppressedSqliteWarning } from "./warning.js";
import { createSqliteWorkerStore } from "./worker-store.js";

/** The database file name is part of the on-disk contract (§14.7): one per `dataDir`. */
export const EVENTS_DB_FILE = "events.db";

/** SQLite's own spelling for "no file at all". Skips the lock — there is nothing to contend for. */
const IN_MEMORY = ":memory:";

export interface OpenPersistenceOptions {
  readonly dataDir: string;
  /** Defaults to `<dataDir>/events.db`. */
  readonly file?: string;
  readonly config: ResolvedEventLogConfig;
  readonly clock: Clock;
  readonly logger: Logger;
  /** This daemon INSTANCE's id, stamped on every row it writes (§15.7). */
  readonly bootId?: string;
  /** §14.6's rule, injectable so a resolved descriptor (or a test) can widen or narrow it. */
  readonly digest?: (e: EventEnvelope, bytes: number) => boolean;
}

interface DatabaseSyncCtor {
  new (path: string, options?: Record<string, unknown>): SqliteDatabase;
}

/**
 * lock → open → migrate, in that order (§14.10, §14.7).
 *
 * The `node:sqlite` import is LAZY and DRIVER-GATED: `driver:"memory"` must never load it, which
 * is what keeps `OmniACP.local()` free of both a database file and an experimental-module
 * warning (ruling M1-R17, F12). The gate is an early throw rather than a silent fallback,
 * because a caller who asked for persistence and got memory would find out at the restart.
 *
 * Owned by M1-WP-A.
 */
export async function openPersistence(o: OpenPersistenceOptions): Promise<PersistenceHandle> {
  if (o.config.driver !== "sqlite") {
    throw new OmniError(
      "internal",
      `openPersistence requires eventLog.driver "sqlite"; got "${o.config.driver}". ` +
        "The memory driver has no durable side and must never load node:sqlite (§14.2).",
    );
  }

  const dir = isAbsolute(o.dataDir) ? o.dataDir : resolve(o.dataDir);
  const file = o.file ?? o.config.file ?? join(dir, EVENTS_DB_FILE);
  const inMemory = file === IN_MEMORY;
  const bootId =
    o.bootId ?? `boot_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

  if (!inMemory) await mkdir(dir, { recursive: true });

  // 1. LOCK first. Opening the database before taking the lock would create the WAL and shm
  //    files of a daemon we are about to refuse to be (§14.10).
  const lock = inMemory
    ? { release: async (): Promise<void> => {}, brokeStaleLock: false }
    : await acquireDataDirLock(dir, { pid: process.pid, bootId });
  if (lock.brokeStaleLock) {
    o.logger.warn("broke a stale data-dir lock", { dataDir: dir });
  }

  try {
    // 2. OPEN. The one `node:sqlite` import in the repository, lazy, driver-gated, and wrapped
    //    for exactly as long as the module evaluation that emits the warning takes.
    const mod = o.config.suppressExperimentalWarning
      ? await withSuppressedSqliteWarning(() => import("node:sqlite"))
      : await import("node:sqlite");
    const DatabaseSync = (mod as unknown as { DatabaseSync: DatabaseSyncCtor }).DatabaseSync;
    const db = new DatabaseSync(file);

    // 3. PRAGMAS, in the order that makes them stick. `auto_vacuum` must be set BEFORE the first
    //    table exists or it is a no-op for the life of the file.
    db.exec("pragma auto_vacuum = INCREMENTAL");
    db.exec("pragma busy_timeout = 5000");
    db.exec("pragma foreign_keys = ON");
    db.exec(`pragma synchronous = ${o.config.synchronous.toUpperCase()}`);

    if (!inMemory) {
      // WAL is not a preference, it is the reason a daemon crash loses nothing. A network or
      // shared-folder `dataDir` silently leaves the journal in `memory` mode — the known failure
      // mode — so this FAILS LOUDLY rather than running on a promise it cannot keep (§14.2).
      const mode = String(db.prepare("pragma journal_mode = wal").get()?.["journal_mode"] ?? "");
      if (mode.toLowerCase() !== "wal") {
        db.close();
        throw new OmniError(
          "internal",
          `journal_mode = wal did not stick for ${file} (it is "${mode}"). ` +
            "A network or shared-folder dataDir is the known cause; move the data dir to local " +
            'storage or run with eventLog.driver "memory", but do not run durably on a journal ' +
            "that cannot survive a crash.",
        );
      }
    }

    // 4. MIGRATE.
    const schemaVersion = migrate(db, { warn: (m) => o.logger.warn(m) });

    const events = createSqliteEventStore(db, {
      clock: o.clock,
      file: inMemory ? null : file,
      ...(o.digest === undefined ? {} : { digest: o.digest }),
    });
    const workers = createSqliteWorkerStore(db);

    o.logger.info("event persistence opened", {
      file: inMemory ? IN_MEMORY : file,
      schemaVersion,
      bootId,
      retentionDays: o.config.retentionDays,
    });

    return createPersistenceHandle({
      events,
      workers,
      bootId,
      config: o.config,
      clock: o.clock,
      logger: o.logger,
      release: lock.release,
      vacuum: (pages) => {
        db.prepare(`pragma incremental_vacuum(${Math.max(1, Math.floor(pages))})`).all();
      },
      closeDb: () => {
        db.close();
      },
    });
  } catch (e) {
    // The lock is ours only while the database behind it is ours. Leaving it behind on a failed
    // open would make the next start refuse a data dir nobody is using.
    await lock.release().catch(() => {});
    throw e;
  }
}
