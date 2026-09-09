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
 * `fn`, inside ONE SQLite transaction (§24.4 rule 1).
 *
 * `begin immediate` rather than a deferred `begin`: the write lock is taken at the START, so two
 * writers contend here — where `busy_timeout` can wait for them — instead of at the first write,
 * where one of them would already be holding a read snapshot and would have to be aborted with
 * `SQLITE_BUSY_SNAPSHOT`.
 *
 * A `rollback` that itself throws is swallowed. It means the transaction was already unwound (a
 * statement error can do that), and letting that secondary failure replace the ORIGINAL error
 * would hide the reason the caller is here at all.
 *
 * NOT re-entrant, and deliberately not made so: a nested `begin` would silently become a no-op
 * inner "transaction" whose failure could not roll back independently of its parent. Every caller
 * in this package holds it for exactly one row-plus-delivery write.
 */
export function withTransaction<T>(db: SqliteDatabase, fn: () => T): T {
  db.exec("begin immediate");
  try {
    const out = fn();
    db.exec("commit");
    return out;
  } catch (e) {
    try {
      db.exec("rollback");
    } catch {
      // Already unwound; the original error below is the one worth reporting.
    }
    throw e;
  }
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
export const SCHEMA_VERSION = 2;

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
 * Version 2 (§24.2), and the property that matters more than any column in it: it is
 * **CREATE-only**.
 *
 * Not one column of `events`, `workers`, `payloads`, `event_state` or `meta` changes, so an M1
 * `events.db` opened by an M2 daemon keeps every row it had, `headOf` / `tailOf` are untouched,
 * and §14.11's conformance suite runs against the migrated file VERBATIM. The whole migration is
 * two `create table if not exists` statements and three indexes, which is also why it is safe to
 * run on every open rather than only on the step from 1 to 2.
 *
 * The direction that is not free is BACKWARD: a v2 file opened by an M1 daemon must still fail
 * loudly naming the version, and it does, because `migrateTo` refuses a `schema_version` from
 * the future exactly as §14.7 already required.
 *
 * Three column choices are decisions rather than shape:
 *
 *  - **`runs.boot_id`** is a column and an index because §24.4's recovery is a QUERY — "every
 *    live run that is not mine" — run once at boot. Deriving it from a JSON blob would make the
 *    one startup path a full-table parse.
 *  - **`runs.request_json` is SANITIZED before it arrives**: env VALUES are stripped by the
 *    registry. The row is read back by `GET /v1/runs/{rid}` and outlives the process; a durable
 *    copy of a client's secrets is not something a later reader can undo.
 *  - **`webhook_deliveries.lease_boot`** is the only thing that distinguishes "in flight NOW"
 *    from "in flight when the process died". Without it a restart has to guess — in one
 *    direction losing deliveries, in the other duplicating them with no `deliveryId` to
 *    deduplicate on.
 *
 * `deliveries_due` indexes `(state, next_attempt_ms)` because the dispatcher's hot query is
 * exactly `where state = 'pending' and next_attempt_ms <= ? order by next_attempt_ms`.
 */
const V2 = `
create table if not exists runs (
  run_id          text primary key,
  daemon_id       text not null,
  boot_id         text not null,
  token_id        text not null,
  worker_id       text,
  turn_id         text,
  agent_id        text not null,
  cwd             text not null,
  state           text not null,
  created_at      text not null,
  updated_at      text not null,
  finished_at_ms  integer,
  request_json    text not null,
  result_json     text,
  error_json      text,
  webhook_url     text,
  idempotency_key text
) without rowid;

create unique index if not exists runs_idem
  on runs (token_id, idempotency_key) where idempotency_key is not null;
create index if not exists runs_by_boot on runs (boot_id, state);

create table if not exists webhook_deliveries (
  delivery_id     text primary key,
  run_id          text not null,
  token_id        text not null,
  event           text not null,
  url             text not null,
  state           text not null,
  attempt         integer not null default 0,
  next_attempt_ms integer,
  lease_boot      text,
  last_status     integer,
  last_error      text,
  response_ms     integer,
  created_at      text not null,
  updated_at      text not null,
  payload_json    text not null
) without rowid;

create index if not exists deliveries_due on webhook_deliveries (state, next_attempt_ms);
`;

/**
 * Reads `meta.schema_version`, creates or forward-migrates, and returns the version in force.
 *
 * Forward-only. A file written by a NEWER daemon is a startup failure naming both versions: the
 * alternative is to open it anyway and write rows that silently drop whatever columns the newer
 * schema added, which corrupts the operator's data on a downgrade they may not know happened.
 */
export function migrate(db: SqliteDatabase, logger: { warn(m: string): void }): number {
  return migrateTo(db, logger, SCHEMA_VERSION);
}

/**
 * `migrate`, with the version this daemon understands made an ARGUMENT.
 *
 * It exists because the backward direction is a real obligation and the only honest way to test
 * it is to run the OLDER code against the NEWER file. `migrateTo(db, logger, 1)` IS an M1 daemon
 * — the same statements, the same refusal, the same message — so "a v2 file opened by an M1
 * daemon fails loudly naming the version" is asserted against the shipped code path rather than
 * against a copy of it in a test, which is the kind of copy that keeps passing after the
 * original changes.
 *
 * `target` is also why `V2` is applied conditionally rather than unconditionally: a daemon that
 * does not understand a table must not create it, or the file it leaves behind claims a schema
 * it cannot serve.
 */
export function migrateTo(
  db: SqliteDatabase,
  logger: { warn(m: string): void },
  target: number,
): number {
  db.exec(V1);
  if (target >= 2) db.exec(V2);

  const row = db.prepare("select value from meta where key = 'schema_version'").get();
  const found = row === undefined ? null : Number(row["value"]);

  if (found !== null && Number.isFinite(found) && found > target) {
    throw new OmniError(
      "internal",
      `event database schema_version ${found} is newer than this daemon understands (${target}); ` +
        `refusing to open it rather than silently downgrading the file`,
    );
  }

  if (found === null) {
    db.prepare("insert into meta (key, value) values ('schema_version', ?)").run(String(target));
    return target;
  }

  if (!Number.isFinite(found)) {
    // A meta row we cannot parse is not a version we can migrate FROM. Say so and rewrite it to
    // the version whose tables the statements above have just guaranteed are present.
    logger.warn(`event database schema_version is unreadable; rewriting it as ${target}`);
    db.prepare("update meta set value = ? where key = 'schema_version'").run(String(target));
    return target;
  }

  if (found < target) {
    // The 1 -> 2 step is `db.exec(V2)` above and nothing else: CREATE-only, so there is no data
    // to move and no column to rewrite. Recording the number is the whole remaining step, and
    // every M1 row in the file is still exactly where M1 left it.
    db.prepare("update meta set value = ? where key = 'schema_version'").run(String(target));
    return target;
  }

  return found;
}
