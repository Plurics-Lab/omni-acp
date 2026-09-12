import {
  OmniError,
  type CloseResult,
  type WorkerId,
  type WorkerRow,
  type WorkerSnapshot,
  type WorkerStore,
} from "@omni-acp/protocol";
import type { SqliteDatabase } from "./schema.js";

/**
 * The states that mean "a process exists, or existed and was never accounted for".
 *
 * `abandoned()` is §15.7's orphan query, and `hibernated` is deliberately NOT here: a hibernated
 * worker has no process by definition, so a previous boot's hibernated row is already converged
 * and reaping it would be reaping nothing. Every other non-`closed` state left behind by a boot
 * that is gone is an orphan we must at least RECORD, even where we refuse to signal it.
 */
const LIVE_STATES = ["starting", "ready", "running", "requires_action"] as const;

const json = (v: unknown): string | null =>
  v === null || v === undefined ? null : JSON.stringify(v);
const parse = <T>(v: unknown): T | null =>
  v === null || v === undefined ? null : (JSON.parse(String(v)) as T);

/**
 * The M2 half of a `WorkerRow`, as one JSON blob (§24.2 v3, review finding V2/V8).
 *
 * It is spelled out rather than derived with `Omit<>`, and the enumeration is the point: this is
 * the list of fields a WAKE has to reproduce, and a field added to `WorkerRow` that is not added
 * here is a field that silently stops surviving a restart — which is exactly the bug being fixed.
 */
type M2Row = Pick<
  WorkerRow,
  | "onUnresolved"
  | "parkTimeoutMs"
  | "parkTimeoutAction"
  | "mcpNames"
  | "policyRef"
  | "policy"
  | "env"
  | "watchdog"
  | "patchMode"
  // ── M3-WP1, on the same terms: persisted BECAUSE OF THE WAKE PATH ───────────
  | "credentialName"
  | "homeMode"
>;

const M2_KEYS = [
  "onUnresolved",
  "parkTimeoutMs",
  "parkTimeoutAction",
  "mcpNames",
  "policyRef",
  "policy",
  "env",
  "watchdog",
  "patchMode",
  "credentialName",
  "homeMode",
] as const satisfies readonly (keyof M2Row)[];

/**
 * The M2 fields a row actually carries, or `null` for a row that carries none.
 *
 * `undefined` and `null` are DIFFERENT here and both are kept: `policyRef: null` is "this worker
 * resolved to no engine id" while an absent `policyRef` is "a boot that did not know the field
 * wrote this row", and `viewRowsOf`'s `??` fallbacks read the second one as M1.
 */
function m2Of(row: WorkerRow): M2Row | null {
  const out: Record<string, unknown> = {};
  for (const key of M2_KEYS) {
    if (row[key] !== undefined) out[key] = row[key];
  }
  return Object.keys(out).length === 0 ? null : (out as M2Row);
}

/**
 * The durable half of the Worker Registry — D2's `workerId → (agentId, sessionId, cwd, label,
 * owner, state, capabilities, closeResult, …)` (§14.8, L17).
 *
 * It is what makes `GET` / `DELETE` / `?since=` work against a worker THIS PROCESS NEVER
 * CREATED, and it persists `closeResult` so `DELETE` is idempotent across a restart
 * byte-for-byte rather than recomputing a `treeGone` we never proved (§15.6).
 *
 * Visibility (D13) is the REGISTRY's job and never the store's: every query here is unfiltered,
 * and a store that quietly dropped rows a token cannot see would make `list()` and the audit log
 * disagree.
 *
 * The snapshot is stored TWICE on purpose — once as `snapshot_json`, once projected onto the
 * columns §14.7 names. The JSON is the source of truth, so a `WorkerSnapshot` that gains a field
 * in M2 round-trips without a migration; the columns exist only so `abandoned()`,
 * `closedBefore()` and `list()` are indexed queries rather than a full-table JSON parse. Reads
 * go to the JSON, ordering and filtering go to the columns.
 *
 * Owned by M1-WP-A.
 */
export function createSqliteWorkerStore(db: SqliteDatabase): WorkerStore {
  const upsert = db.prepare(
    `insert into workers (
       worker_id, daemon_id, boot_id, agent_id, session_id, cwd, label, owner_token, state,
       close_reason, close_result, crashed, created_at, updated_at, hibernated_at,
       last_active_ms, closed_at_ms, head_seq, tail_seq, capabilities, resume_json, orphan_json,
       process_json, wake_count, wake_failures, hibernate_idle_ms, snapshot_json, m2_json
     ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(worker_id) do update set
       daemon_id = excluded.daemon_id,
       boot_id = excluded.boot_id,
       agent_id = excluded.agent_id,
       session_id = excluded.session_id,
       cwd = excluded.cwd,
       label = excluded.label,
       owner_token = excluded.owner_token,
       state = excluded.state,
       close_reason = excluded.close_reason,
       close_result = excluded.close_result,
       crashed = excluded.crashed,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at,
       hibernated_at = excluded.hibernated_at,
       last_active_ms = excluded.last_active_ms,
       closed_at_ms = excluded.closed_at_ms,
       head_seq = max(workers.head_seq, excluded.head_seq),
       capabilities = excluded.capabilities,
       resume_json = excluded.resume_json,
       orphan_json = excluded.orphan_json,
       process_json = excluded.process_json,
       wake_count = excluded.wake_count,
       wake_failures = excluded.wake_failures,
       hibernate_idle_ms = excluded.hibernate_idle_ms,
       snapshot_json = excluded.snapshot_json,
       m2_json = excluded.m2_json`,
  );
  // `tail_seq` is absent from the update list on purpose: the EventStore raises it inside the
  // retention transaction, and a registry upsert that carried a stale value would tell a client
  // history is available that the sweep has already deleted.

  const selectOne = db.prepare("select * from workers where worker_id = ?");
  const selectAll = db.prepare("select * from workers order by updated_at desc, worker_id asc");
  const selectAbandoned = db.prepare(
    `select * from workers
      where boot_id <> ? and state in (${LIVE_STATES.map(() => "?").join(", ")})
      order by updated_at desc, worker_id asc`,
  );
  const selectClosedBefore = db.prepare(
    `select * from workers
      where state = 'closed' and closed_at_ms is not null and closed_at_ms < ?
      order by closed_at_ms asc, worker_id asc`,
  );
  const deleteOne = db.prepare("delete from workers where worker_id = ?");

  const toRow = (r: Record<string, unknown>): WorkerRow => {
    const snapshot = parse<WorkerSnapshot>(r["snapshot_json"]);
    if (snapshot === null) {
      throw new OmniError("internal", `worker row ${String(r["worker_id"])} has no snapshot`);
    }
    // `null` for every row written before schema v3, and for every worker that has no M2 rows at
    // all. Spread back verbatim: a key that is absent stays absent, which is what makes
    // `viewRowsOf`'s M1 fallbacks fire for exactly the rows they are meant for.
    const m2 = parse<M2Row>(r["m2_json"]) ?? {};
    const headSeq = Math.max(Number(r["head_seq"] ?? 0), snapshot.headSeq);
    return {
      // §14.4 again, one layer up: the column can be AHEAD of the snapshot (retention raises it
      // inside its own transaction), and a rehydrated worker seeded from the lower number would
      // reissue seqs a client already holds.
      snapshot: headSeq === snapshot.headSeq ? snapshot : { ...snapshot, headSeq },
      agentId: String(r["agent_id"]),
      bootId: String(r["boot_id"]),
      closeResult: parse<CloseResult>(r["close_result"]),
      lastActiveMs: Number(r["last_active_ms"] ?? 0),
      closedAtMs:
        r["closed_at_ms"] === null || r["closed_at_ms"] === undefined
          ? null
          : Number(r["closed_at_ms"]),
      hibernateIdleMs:
        r["hibernate_idle_ms"] === null || r["hibernate_idle_ms"] === undefined
          ? null
          : Number(r["hibernate_idle_ms"]),
      ...m2,
    };
  };

  return {
    upsert(row: WorkerRow): void {
      const s = row.snapshot;
      upsert.run(
        s.workerId,
        s.daemonId,
        row.bootId,
        row.agentId,
        s.sessionId,
        s.cwd,
        s.label,
        s.ownerTokenId,
        s.state,
        s.closeReason,
        json(row.closeResult),
        s.crashed ? 1 : 0,
        s.createdAt,
        s.updatedAt,
        s.hibernatedAt,
        row.lastActiveMs,
        row.closedAtMs,
        s.headSeq,
        json(s.capabilities),
        json(s.resume),
        json(s.orphan),
        json(s.process),
        s.wakeCount,
        s.wakeFailures,
        row.hibernateIdleMs,
        JSON.stringify(s),
        // §24.2 v3, and review finding V2/V8: these are the fields `WorkerRow` has always
        // documented as "persisted BECAUSE OF THE WAKE PATH" and that nothing ever wrote. A row
        // whose M2 fields are all absent stores `null` and reads back as the M1 row it is.
        json(m2Of(row)),
      );
    },

    get(id: WorkerId): WorkerRow | null {
      const r = selectOne.get(id);
      return r === undefined ? null : toRow(r);
    },

    list(): readonly WorkerRow[] {
      return selectAll.all().map(toRow);
    },

    abandoned(currentBootId: string): readonly WorkerRow[] {
      return selectAbandoned.all(currentBootId, ...LIVE_STATES).map(toRow);
    },

    delete(id: WorkerId): void {
      deleteOne.run(id);
    },

    closedBefore(cutoffMs: number): readonly WorkerRow[] {
      return selectClosedBefore.all(cutoffMs).map(toRow);
    },
  };
}
