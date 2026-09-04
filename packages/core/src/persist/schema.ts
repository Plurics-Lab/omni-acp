import { OmniError } from "@omni-acp/protocol";

/**
 * The subset of `node:sqlite`'s `DatabaseSync` this package uses.
 *
 * It is declared structurally rather than imported, for the reason §14.2 gives: importing
 * `node:sqlite` for its TYPES would make every module that touches persistence load the
 * experimental builtin, and `driver:"memory"` must never load it at all. The one real import
 * lives in `open.ts`, behind the driver gate and behind the warning interposer.
 */
export interface SqliteStatement {
  run(...params: readonly unknown[]): {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  };
  get(...params: readonly unknown[]): Record<string, unknown> | undefined;
  all(...params: readonly unknown[]): Record<string, unknown>[];
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

/**
 * The on-disk schema (§14.7) and its migrations.
 *
 * `SCHEMA_VERSION` is reported by `GET /v1/info.persistence.schemaVersion`. A file whose
 * `schema_version` is FROM THE FUTURE is a startup failure that NAMES the version — never a
 * silent downgrade, which would quietly drop columns a newer daemon wrote.
 *
 * Owned by M1-WP-A.
 */
export const SCHEMA_VERSION = 1;

/**
 * Version 1, and the three decisions §14.7 makes, spelled out where they live:
 *
 *  - **`events` is `WITHOUT ROWID` on `(worker_id, seq)`** because the only access pattern is a
 *    clustered prefix scan — `read(workerId, since, limit)` and nothing else. The primary key is
 *    also the backstop against a second daemon over one data dir: two writers assigning from
 *    their own head collide on insert with a loud `SQLITE_CONSTRAINT` rather than silently
 *    forking a worker's history (§14.10's second defence).
 *  - **Envelope meta in columns, payload in ONE blob**, because `kind` / `turn_id` / `replay`
 *    are queried and the payload never is — which also means §7.5's byte-for-byte forwarding
 *    guarantee extends to disk with no reshaping.
 *  - **`head_seq` as a column, not `max(seq)`** (§14.4). It lives in `event_state` rather than
 *    on `workers`: the two tables have different owners (the `EventStore` and the `WorkerStore`)
 *    and different lifetimes — a worker can have events before the registry has ever upserted a
 *    row for it, and `evict()` has to raise the tail in the SAME transaction as its DELETE
 *    without reaching into a table it does not own. `workers` keeps its own `head_seq` /
 *    `tail_seq` columns as the registry's projection of the snapshot, and `headOf()` takes the
 *    max over BOTH plus `max(seq)`, so no single one of the three can lose the sequence.
 *  - **`payloads`** is §14.6's digest side table: one row per distinct payload, refcounted, so
 *    the corpus's 23 `available_commands_update` notifications occupy 2 rows and `read()`
 *    rehydrates the identical bytes.
 *
 * One column is here that §14.7's enumeration does not name: `events.daemon_id`. `EventEnvelope`
 * carries it and `EventStore.read()` has to return a VALID envelope, so the alternative is a
 * join against `workers` (a table with a different owner, and a row that need not exist yet) on
 * the one path that has a latency budget. 26 bytes a row next to a 12.7 KB payload is the right
 * trade.
 */
const V1 = `
create table if not exists meta (
  key   text primary key,
  value text not null
) without rowid;

create table if not exists workers (
  worker_id          text primary key,
  daemon_id          text not null,
  boot_id            text not null,
  agent_id           text not null,
  session_id         text,
  cwd                text not null,
  label              text,
  owner_token        text not null,
  state              text not null,
  close_reason       text,
  close_result       text,
  crashed            integer not null default 0,
  created_at         text not null,
  updated_at         text not null,
  hibernated_at      text,
  last_active_ms     integer not null default 0,
  closed_at_ms       integer,
  head_seq           integer not null default 0,
  tail_seq           integer not null default 1,
  capabilities       text,
  resume_json        text,
  orphan_json        text,
  process_json       text,
  wake_count         integer not null default 0,
  wake_failures      integer not null default 0,
  hibernate_idle_ms  integer,
  snapshot_json      text not null
) without rowid;

create index if not exists workers_by_state on workers (state, last_active_ms);
create index if not exists workers_by_boot on workers (boot_id, state);
create index if not exists workers_closed on workers (closed_at_ms) where closed_at_ms is not null;

create table if not exists events (
  worker_id       text not null,
  seq             integer not null,
  ts              text not null,
  daemon_id       text not null,
  session_id      text,
  turn_id         text,
  kind            text not null,
  payload_version integer not null,
  replay          integer not null default 0,
  payload         text,
  digest_ref      text,
  primary key (worker_id, seq)
) without rowid;

create index if not exists events_by_turn on events (worker_id, turn_id, seq);

create table if not exists payloads (
  sha256   text primary key,
  payload  text not null,
  refcount integer not null default 0
) without rowid;

create table if not exists event_state (
  worker_id text primary key,
  head_seq  integer not null default 0,
  tail_seq  integer not null default 1
) without rowid;
`;

/**
 * Reads `meta.schema_version`, creates or forward-migrates, and returns the version in force.
 *
 * Forward-only. A file written by a NEWER daemon is a startup failure naming both versions: the
 * alternative is to open it anyway and write rows that silently drop whatever columns the newer
 * schema added, which corrupts the operator's data on a downgrade they may not know happened.
 */
export function migrate(db: SqliteDatabase, logger: { warn(m: string): void }): number {
  db.exec(V1);

  const row = db.prepare("select value from meta where key = 'schema_version'").get();
  const found = row === undefined ? null : Number(row["value"]);

  if (found !== null && Number.isFinite(found) && found > SCHEMA_VERSION) {
    throw new OmniError(
      "internal",
      `event database schema_version ${found} is newer than this daemon understands (${SCHEMA_VERSION}); ` +
        `refusing to open it rather than silently downgrading the file`,
    );
  }

  if (found === null) {
    db.prepare("insert into meta (key, value) values ('schema_version', ?)").run(
      String(SCHEMA_VERSION),
    );
    return SCHEMA_VERSION;
  }

  if (!Number.isFinite(found)) {
    // A meta row we cannot parse is not a version we can migrate FROM. Say so and rewrite it to
    // the version whose tables `db.exec(V1)` has just guaranteed are present.
    logger.warn(`event database schema_version is unreadable; rewriting it as ${SCHEMA_VERSION}`);
    db.prepare("update meta set value = ? where key = 'schema_version'").run(
      String(SCHEMA_VERSION),
    );
    return SCHEMA_VERSION;
  }

  if (found < SCHEMA_VERSION) {
    // No forward migration exists yet — V1 is the first version. When one does, it goes here as
    // a numbered step, and this branch stops being a no-op that only rewrites the number.
    db.prepare("update meta set value = ? where key = 'schema_version'").run(
      String(SCHEMA_VERSION),
    );
    return SCHEMA_VERSION;
  }

  return found;
}
