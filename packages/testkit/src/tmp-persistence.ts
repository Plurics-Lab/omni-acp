import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EventLogConfig,
  OmniError,
  type Clock,
  type DaemonId,
  type EventLog,
  type EventStore,
  type Logger,
  type PersistenceHandle,
  type ResolvedEventLogConfig,
  type Seq,
  type WorkerId,
} from "@omni-acp/protocol";
import { fakeClock } from "./fake-clock.js";
import { nullLogger } from "./seq-ids.js";

/**
 * The two factories the harness needs and CANNOT import.
 *
 * `@omni-acp/testkit` depends on `@omni-acp/protocol` and nothing else (CONTRACTS.md §3.1's
 * DAG, and `@omni-acp/core` dev-depends on THIS package, so the edge would also be a cycle).
 * `openPersistence` and `createPersistedEventLog` both live in core. Re-implementing them here
 * would give the conformance suite a second SQLite driver to pass instead of the shipped one,
 * which is the one thing a conformance suite must never do — so they are injected, and the
 * package under test supplies its own real implementations.
 */
export interface TmpPersistenceDeps {
  /** `openPersistence` from `@omni-acp/core`. */
  open(o: {
    dataDir: string;
    file?: string;
    config: ResolvedEventLogConfig;
    clock: Clock;
    logger: Logger;
  }): Promise<PersistenceHandle>;
  /** `createPersistedEventLog` from `@omni-acp/core`. */
  createLog(o: {
    workerId: WorkerId;
    daemonId: DaemonId;
    clock: Clock;
    store: EventStore;
    config: ResolvedEventLogConfig;
    maxEvents?: number;
    queueSize?: number;
    startSeq?: Seq;
  }): EventLog;
  /**
   * Rows in the §14.6 digest side table. §14.11 item 9 asserts "23 appends ⇒ 2 stored payloads",
   * which is a property of the store's on-disk shape and has no seat on `EventStore`; the
   * injector knows the concrete store and can answer it without giving testkit a second
   * `node:sqlite` dependency.
   */
  payloadCount(handle: PersistenceHandle): number;
}

export interface TmpPersistenceLogOptions {
  readonly workerId: WorkerId;
  /** Defaults to the CURRENT handle's store, so a log built after `reopen()` uses the new one. */
  readonly store?: EventStore;
  readonly maxEvents?: number;
  readonly queueSize?: number;
  /**
   * Normally omitted: the log restores its own head from the store, which is §14.4's whole
   * point. Passing it is how a test plants the bug on purpose.
   */
  readonly startSeq?: Seq;
}

/**
 * M1's persistence harness: a real sqlite file under `mkdtemp`, reopenable, self-cleaning
 * (CONTRACTS.md §5.7).
 *
 * `reopen()` is the whole point — SAME file, NEW handle. That is the restart test, and it is
 * what proves `?since=N` returns the same envelopes with the same `seq` after a `stop()` /
 * `createDaemon()` cycle, including for a worker whose rows retention already evicted (§14.4).
 *
 * Owned by M1-WP-A.
 */
export interface TmpPersistence {
  handle: PersistenceHandle;
  dir: string;
  /** `<dir>/events.db` — named so a test can inspect the file the daemon would have written. */
  file: string;
  /** A REAL persisted `EventLog` over the current handle's store. */
  log(o: TmpPersistenceLogOptions): EventLog;
  /** Rows in the digest side table (§14.6). */
  payloadCount(): number;
  reopen(): Promise<PersistenceHandle>;
  dispose(): Promise<void>;
}

/** The daemon id every harness log stamps; envelopes must carry a `d_`-prefixed ULID. */
const DAEMON_ID = `d_${"0".repeat(25)}9` as DaemonId;

export function tmpPersistence(deps?: TmpPersistenceDeps): Promise<TmpPersistence> {
  if (deps === undefined) {
    throw new OmniError(
      "internal",
      "tmpPersistence() needs its factories injected: @omni-acp/testkit may not depend on " +
        "@omni-acp/core (CONTRACTS.md §3.1), so the package under test passes its own " +
        "`openPersistence` / `createPersistedEventLog` — e.g. " +
        "`tmpPersistence({ open: openPersistence, createLog: createPersistedEventLog, payloadCount })`.",
    );
  }
  return build(deps);
}

async function build(deps: TmpPersistenceDeps): Promise<TmpPersistence> {
  const dir = await mkdtemp(join(tmpdir(), "omni-acp-persist-"));
  const file = join(dir, "events.db");
  const config: ResolvedEventLogConfig = EventLogConfig.parse({ driver: "sqlite" });
  const clock = fakeClock();
  const logger = nullLogger();

  const open = (): Promise<PersistenceHandle> =>
    deps.open({ dataDir: dir, file, config, clock, logger });

  const harness: TmpPersistence = {
    handle: await open(),
    dir,
    file,

    log(o: TmpPersistenceLogOptions): EventLog {
      return deps.createLog({
        workerId: o.workerId,
        daemonId: DAEMON_ID,
        clock,
        store: o.store ?? harness.handle.events,
        config,
        ...(o.maxEvents === undefined ? {} : { maxEvents: o.maxEvents }),
        ...(o.queueSize === undefined ? {} : { queueSize: o.queueSize }),
        ...(o.startSeq === undefined ? {} : { startSeq: o.startSeq }),
      });
    },

    payloadCount(): number {
      return deps.payloadCount(harness.handle);
    },

    async reopen(): Promise<PersistenceHandle> {
      // CLOSE then OPEN, in that order and on the same path: a second handle over a file the
      // first still holds would be the two-daemon case §14.10 exists to refuse, and the restart
      // this models is a process that went away.
      harness.handle.close();
      harness.handle = await open();
      return harness.handle;
    },

    async dispose(): Promise<void> {
      try {
        harness.handle.close();
      } catch {
        // A test that already closed the handle still deserves its temp dir cleaned up.
      }
      await rm(dir, { recursive: true, force: true });
    },
  };

  return harness;
}
