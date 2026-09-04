import { createHash } from "node:crypto";
import {
  OmniError,
  type Clock,
  type EventEnvelope,
  type EventStore,
  type EventStoreDiagnostics,
  type Seq,
  type WorkerId,
} from "@omni-acp/protocol";
import { SCHEMA_VERSION, type SqliteDatabase, type SqliteStatement } from "./schema.js";

/**
 * §14.4's debounce, verbatim: `head_seq` is flushed every 256 appends or 5 s.
 *
 * Staleness between flushes is harmless because `headOf()` takes the max with `max(seq)`; the
 * column only has to be right when the ROWS ARE GONE, and rows only go away through the
 * retention sweep — which raises `head_seq` and `tail_seq` in the same transaction as its
 * DELETE.
 */
const HEAD_FLUSH_EVERY = 256;
const HEAD_FLUSH_MS = 5_000;

/**
 * §14.6's digest threshold.
 *
 * `EventStore.put` is handed an `EventEnvelope` and nothing else — the descriptor's
 * `UpdateRule.digest` is per-AGENT while one store serves every worker in a `dataDir`, and the
 * envelope is forwarded byte-for-byte with nowhere to carry a routing hint. So the store owns
 * the MECHANISM (the refcounted side table, transparent on read) and applies it by payload size,
 * which subsumes every kind §14.6 names: `available_commands_update` is 12.7 KB and is always
 * digested, while a 200-byte `agent_message_chunk` stays inline where a second table row would
 * cost more than it saves. `digest` in the options is the seam a resolved descriptor plugs into.
 */
const DIGEST_MIN_BYTES = 1_024;

export interface SqliteEventStoreOptions {
  readonly clock: Clock;
  /** Absolute path, or `null` for `:memory:` — reported by `GET /v1/info.persistence.file`. */
  readonly file?: string | null;
  /** §14.6's rule, injectable so a descriptor (or a test) can widen or narrow it. */
  readonly digest?: (e: EventEnvelope, bytes: number) => boolean;
}

/**
 * A store that can settle its debounced bookkeeping on demand. `EventLog.flush()` finds it
 * structurally (see `log-core.ts`), because `EventStore` is frozen in `@omni-acp/protocol`.
 */
export interface FlushableSqliteEventStore extends EventStore {
  flush(): void;
  /** How many payload rows the digest side table holds — §14.6's "23 appends, 2 payloads". */
  payloadCount(): number;
}

interface WorkerCounters {
  head: Seq;
  tail: Seq;
  /** Appends since the last `head_seq` flush; §14.4's debounce. */
  since: number;
  lastFlushMs: number;
}

/**
 * The `EventStore` over `node:sqlite`'s `DatabaseSync` — SYNCHRONOUS, for exactly the reason
 * `EventLog.append` is (§8.1): an async `put` reintroduces the interleave that a non-monotonic
 * `seq` is. WAL + `synchronous=NORMAL`: a daemon crash loses nothing; only power loss can.
 *
 * `headOf` returns `max(seq)` EVER assigned, including rows retention has already evicted — the
 * §14.4 bug that eats a whole class of logs lives in the difference between that and
 * `max(seq) currently present`.
 *
 * Owned by M1-WP-A.
 */
export function createSqliteEventStore(
  db: SqliteDatabase,
  opts: SqliteEventStoreOptions,
): FlushableSqliteEventStore {
  const clock = opts.clock;
  const file = opts.file ?? null;
  const shouldDigest =
    opts.digest ?? ((_e: EventEnvelope, bytes: number): boolean => bytes >= DIGEST_MIN_BYTES);

  // Prepared ONCE. §14.11 item 7's per-append latency budget exists to catch exactly the
  // regression where one of these becomes a `db.prepare()` inside the loop.
  const insertEvent = db.prepare(
    `insert into events
       (worker_id, seq, ts, daemon_id, session_id, turn_id, kind, payload_version, replay, payload, digest_ref)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertPayload = db.prepare(
    `insert into payloads (sha256, payload, refcount) values (?, ?, 1)
       on conflict(sha256) do update set refcount = payloads.refcount + 1`,
  );
  const selectEvents = db.prepare(
    `select e.seq, e.ts, e.daemon_id, e.session_id, e.turn_id, e.kind, e.payload_version,
            e.replay, e.payload, p.payload as digest_payload
       from events e left join payloads p on p.sha256 = e.digest_ref
      where e.worker_id = ? and e.seq > ?
      order by e.seq
      limit ?`,
  );
  const selectMinSeq = db.prepare("select min(seq) as v from events where worker_id = ?");
  const selectMaxSeq = db.prepare("select max(seq) as v from events where worker_id = ?");
  const selectState = db.prepare("select head_seq, tail_seq from event_state where worker_id = ?");
  const selectWorkerHead = db.prepare("select head_seq from workers where worker_id = ?");
  const upsertState = db.prepare(
    `insert into event_state (worker_id, head_seq, tail_seq) values (?, ?, ?)
       on conflict(worker_id) do update
         set head_seq = max(event_state.head_seq, excluded.head_seq),
             tail_seq = excluded.tail_seq`,
  );
  const updateWorkerBounds = db.prepare(
    "update workers set head_seq = max(head_seq, ?), tail_seq = ? where worker_id = ?",
  );
  const derefPayloads = db.prepare(
    `update payloads
        set refcount = refcount - (select count(*) from events e
                                    where e.worker_id = ? and e.seq <= ? and e.digest_ref = payloads.sha256)
      where sha256 in (select digest_ref from events e
                        where e.worker_id = ? and e.seq <= ? and e.digest_ref is not null)`,
  );
  const gcPayloads = db.prepare("delete from payloads where refcount <= 0");
  const deleteEvents = db.prepare("delete from events where worker_id = ? and seq <= ?");
  const selectSeqAt = db.prepare(
    "select seq from events where worker_id = ? order by seq limit 1 offset ?",
  );
  const selectWorkerIds = db.prepare(
    `select worker_id from event_state
     union
     select distinct worker_id from events`,
  );
  const selectPayloadCount = db.prepare("select count(*) as v from payloads");
  const selectPageCount = db.prepare("pragma page_count");
  const selectPageSize = db.prepare("pragma page_size");

  const counters = new Map<WorkerId, WorkerCounters>();
  let writeFailures = 0;

  const num = (row: Record<string, unknown> | undefined, key: string): number | null => {
    if (row === undefined) return null;
    const v = row[key];
    if (v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  /**
   * §14.4's restore, and the reason it is a `max` of THREE sources rather than one `max(seq)`:
   *
   *  - `max(seq)` alone resets to 0 the moment retention has evicted every row, and the next
   *    append is seq 1 again — every client holding `?since=3000` then receives nothing forever;
   *  - `event_state.head_seq` alone is stale between debounced flushes;
   *  - `workers.head_seq` is the registry's own projection, written on every state transition —
   *    a third witness that costs one indexed lookup at open time and can only ever help.
   */
  const load = (workerId: WorkerId): WorkerCounters => {
    const existing = counters.get(workerId);
    if (existing !== undefined) return existing;

    const state = selectState.get(workerId);
    const head = Math.max(
      num(state, "head_seq") ?? 0,
      num(selectMaxSeq.get(workerId), "v") ?? 0,
      num(selectWorkerHead.get(workerId), "head_seq") ?? 0,
    );
    const minSeq = num(selectMinSeq.get(workerId), "v");
    const tail = minSeq ?? Math.max(num(state, "tail_seq") ?? 0, head + 1);

    const fresh: WorkerCounters = { head, tail, since: 0, lastFlushMs: clock.now() };
    counters.set(workerId, fresh);
    return fresh;
  };

  const flushOne = (workerId: WorkerId, c: WorkerCounters): void => {
    upsertState.run(workerId, c.head, c.tail);
    c.since = 0;
    c.lastFlushMs = clock.now();
  };

  const flushAll = (): void => {
    for (const [workerId, c] of counters) if (c.since > 0) flushOne(workerId, c);
  };

  const rowToEnvelope = (workerId: WorkerId, row: Record<string, unknown>): EventEnvelope => {
    const raw = (row["digest_payload"] ?? row["payload"]) as string | null;
    const envelope = {
      // A COPY, spelled as one on purpose: the `seq-single-writer` guard requires the read to be
      // VISIBLE, and wrapping it in `Number(...)` would hide which side of that line this is on.
      // The store never invents a seq — it is TOLD what it is (§5.1) — and this is that same
      // integer coming back out of its own row (`integer not null`, always inside 2^53).
      seq: row["seq"] as Seq,
      ts: String(row["ts"]),
      daemonId: String(row["daemon_id"]),
      workerId,
      sessionId: row["session_id"] === null ? null : String(row["session_id"]),
      turnId: row["turn_id"] === null ? null : String(row["turn_id"]),
      payloadVersion: Number(row["payload_version"]),
      // Absent, not `false`: `EventInput.replay` is `true | undefined`, and a `replay: false`
      // key would make a round-tripped envelope un-deep-equal to the one that was appended.
      ...(Number(row["replay"]) === 1 ? { replay: true as const } : {}),
      kind: String(row["kind"]),
      payload: raw === null ? null : (JSON.parse(raw) as unknown),
    };
    // Frozen like every envelope the log hands out (§8.2 rule 3), so a rehydrated replay cannot
    // be mutated into a history that differs from the live one.
    return Object.freeze(envelope) as unknown as EventEnvelope;
  };

  const store: FlushableSqliteEventStore = {
    headOf(workerId: WorkerId): Seq {
      return load(workerId).head;
    },

    tailOf(workerId: WorkerId): Seq {
      const c = load(workerId);
      // "Lowest RETAINED seq; head + 1 when everything for this worker is gone" — never 1 by
      // default, which would promise history that no longer exists (§14.4).
      return Math.min(c.tail, c.head + 1);
    },

    put(e: EventEnvelope): void {
      const c = load(e.workerId);
      try {
        const json = JSON.stringify(e.payload ?? null);
        const bytes = Buffer.byteLength(json, "utf8");
        let inline: string | null = json;
        let digestRef: string | null = null;
        if (shouldDigest(e, bytes)) {
          digestRef = createHash("sha256").update(json).digest("hex");
          insertPayload.run(digestRef, json);
          inline = null;
        }
        insertEvent.run(
          e.workerId,
          e.seq,
          e.ts,
          e.daemonId,
          e.sessionId,
          e.turnId,
          e.kind,
          e.payloadVersion,
          e.replay === true ? 1 : 0,
          inline,
          digestRef,
        );
      } catch (cause) {
        // Counted here and RETHROWN: the log is the layer that decides not to throw into its
        // caller (§14.3), and a store that swallowed its own failures would leave
        // `WorkerSnapshot.persistence` claiming "durable" over a disk that said no.
        writeFailures += 1;
        throw cause;
      }

      c.head = Math.max(c.head, e.seq);
      c.tail = Math.min(c.tail, e.seq);
      c.since += 1;
      if (c.since >= HEAD_FLUSH_EVERY || clock.now() - c.lastFlushMs >= HEAD_FLUSH_MS) {
        flushOne(e.workerId, c);
      }
    },

    read(workerId: WorkerId, since: Seq, limit: number): readonly EventEnvelope[] {
      const want = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
      if (want === 0) return [];
      const from = Number.isFinite(since) && since > 0 ? Math.floor(since) : 0;
      return selectEvents.all(workerId, from, want).map((row) => rowToEnvelope(workerId, row));
    },

    evict(workerId: WorkerId, upTo: Seq): number {
      const c = load(workerId);
      const bound = Math.floor(upTo);
      if (!Number.isFinite(bound) || bound < c.tail) return 0;

      // ONE transaction (§14.5): the DELETE and the tail raise land together, because a raise
      // that lands separately is a window in which the log reports rows it no longer has.
      db.exec("begin immediate");
      try {
        derefPayloads.run(workerId, bound, workerId, bound);
        gcPayloads.run();
        const changes = Number(deleteEvents.run(workerId, bound).changes);
        const tail = Math.min(bound + 1, c.head + 1);
        upsertState.run(workerId, c.head, tail);
        updateWorkerBounds.run(c.head, tail, workerId);
        db.exec("commit");
        c.tail = tail;
        c.since = 0;
        c.lastFlushMs = clock.now();
        return changes;
      } catch (cause) {
        db.exec("rollback");
        throw new OmniError("internal", `event retention failed for ${workerId}`, { cause });
      }
    },

    seqAtOffset(workerId: WorkerId, offset: number): Seq | null {
      if (!Number.isFinite(offset) || offset < 0) return null;
      const row = selectSeqAt.get(workerId, Math.floor(offset));
      return num(row, "seq");
    },

    workersWithEvents(): readonly WorkerId[] {
      return selectWorkerIds.all().map((r) => String(r["worker_id"]) as WorkerId);
    },

    get diagnostics(): EventStoreDiagnostics {
      return {
        driver: "sqlite",
        file,
        schemaVersion: SCHEMA_VERSION,
        sizeBytes: pageBytes(selectPageCount, selectPageSize),
        writeFailures,
      };
    },

    flush(): void {
      flushAll();
    },

    payloadCount(): number {
      return num(selectPayloadCount.get(), "v") ?? 0;
    },
  };

  return store;
}

function pageBytes(pageCount: SqliteStatement, pageSize: SqliteStatement): number {
  const count = Number(pageCount.get()?.["page_count"] ?? 0);
  const size = Number(pageSize.get()?.["page_size"] ?? 0);
  return Number.isFinite(count) && Number.isFinite(size) ? count * size : 0;
}
