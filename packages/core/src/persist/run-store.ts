import type {
  DaemonId,
  OmniErrorBody,
  RunId,
  RunRow,
  RunState,
  RunStore,
  Seq,
  TokenId,
  TurnId,
  TurnResult,
  WebhookTarget,
  WorkerId,
} from "@omni-acp/protocol";
import type { SqliteDatabase } from "./schema.js";

/**
 * The states a run can still MOVE from — the ones a boot that owned them can no longer finish.
 *
 * `queued` is here and `abandoned` is not: a queued run of a dead boot never got a worker and
 * never will, so it is exactly as stranded as a running one, while an abandoned row has already
 * converged and re-abandoning it would enqueue a second terminal webhook (§24.4 rule 4).
 */
const LIVE_RUN_STATES: readonly RunState[] = ["queued", "starting", "running", "requires_action"];

/** A run in one of these has a `finished_at_ms`, and retention is allowed to age it out. */
export const TERMINAL_RUN_STATES: ReadonlySet<RunState> = new Set<RunState>([
  "succeeded",
  "failed",
  "cancelled",
  "abandoned",
]);

const json = (v: unknown): string | null =>
  v === null || v === undefined ? null : JSON.stringify(v);
const parse = <T>(v: unknown): T | null =>
  v === null || v === undefined ? null : (JSON.parse(String(v)) as T);
const nullable = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/**
 * What `request_json` actually holds, and why it is a PROJECTION rather than the request.
 *
 * §24.2 calls the column "the request, SANITIZED — env VALUES are already stripped". The frozen
 * `RunRow` (§5.8.8) carries no request at all, so the store is handed exactly two facts about it:
 * the webhook target (a url and a secret NAME, never a value) and how many deliveries it has
 * produced. Writing anything more would mean inventing a second source of truth for a blob whose
 * only durable reader is this file — and it would put a client's prompt text, which is the most
 * sensitive thing a run carries, on disk with nobody to read it back.
 *
 * `deliveries` lives here because `RunSnapshot.webhook.deliveries` has no column of its own and
 * giving it one would mean two writers for one number.
 */
interface PersistedRequest {
  readonly webhook?: WebhookTarget;
  readonly deliveries?: number;
  readonly seq?: number;
}

/**
 * `RunRow`, plus the position of the run's LAST `omni.run` envelope on its worker's log.
 *
 * It is here rather than on the frozen `RunRow` for the usual reason, and it earns its place
 * twice. A receiver holding a thin payload pulls the run back with `?since=seq-1` (§24.3), so the
 * number has to be a real position — and `seq-single-writer` (§8.2) allows a `WebhookPayload.seq`
 * to be built only by READING a seq the event log assigned, never by computing one. Persisting it
 * is what lets the boot path's terminal `run.failed` point at the last thing the run actually did,
 * on a log this process never opened.
 *
 * `undefined` means "no envelope has been appended for this run yet" — a run whose worker failed
 * to start. Such a run has no position a receiver could pull back, and it fires no delivery.
 */
export interface RunRowV2 extends RunRow {
  readonly seq?: Seq;
}

/** `RunStore`, returning the widened row. Every method is otherwise the frozen contract. */
export interface RunStoreV2 extends RunStore {
  put(row: RunRowV2): void;
  get(id: RunId): RunRowV2 | null;
  byIdempotencyKey(tokenId: TokenId, key: string): RunRowV2 | null;
  list(o: { tokenId?: TokenId; limit: number; cursor?: string }): {
    rows: readonly RunRowV2[];
    cursor: string | null;
  };
  liveFromOtherBoots(bootId: string): readonly RunRowV2[];
}

/**
 * The `runs` table (schema v2), behind the same prepared-statement discipline `worker-store.ts`
 * uses.
 *
 * `bootId` is a column rather than a detail, because §24.4's recovery is a QUERY: "every live run
 * that is not mine". `idempotency_key` is indexed per token, so a retry after a client timeout
 * finds the original run instead of starting a second agent process.
 *
 * `result_json` and `error_json` are their own columns rather than fields of one snapshot blob,
 * because they are the two values that arrive LAST and are by far the largest: folding them into
 * a single blob would make every state transition rewrite the payload-carrying one.
 *
 * Owned by M2-B-WP-R.
 */
export function createRunStore(db: SqliteDatabase): RunStoreV2 {
  const upsert = db.prepare(
    `insert into runs (
       run_id, daemon_id, boot_id, token_id, worker_id, turn_id, agent_id, cwd, state,
       created_at, updated_at, finished_at_ms, request_json, result_json, error_json,
       webhook_url, idempotency_key
     ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(run_id) do update set
       daemon_id = excluded.daemon_id,
       boot_id = excluded.boot_id,
       token_id = excluded.token_id,
       worker_id = excluded.worker_id,
       turn_id = excluded.turn_id,
       agent_id = excluded.agent_id,
       cwd = excluded.cwd,
       state = excluded.state,
       updated_at = excluded.updated_at,
       finished_at_ms = excluded.finished_at_ms,
       request_json = excluded.request_json,
       result_json = excluded.result_json,
       error_json = excluded.error_json,
       webhook_url = excluded.webhook_url,
       idempotency_key = excluded.idempotency_key`,
  );
  // `created_at` is absent from the update list on purpose: it is the one field a later write may
  // not move, and an `on conflict` that carried it would let every state transition rewrite the
  // run's own birthday — which is also the key `list()` pages on.

  const selectOne = db.prepare("select * from runs where run_id = ?");
  const selectByKey = db.prepare("select * from runs where token_id = ? and idempotency_key = ?");
  const selectLiveOtherBoots = db.prepare(
    `select * from runs
      where boot_id <> ? and state in (${LIVE_RUN_STATES.map(() => "?").join(", ")})
      order by created_at asc, run_id asc`,
  );
  const deleteOlder = db.prepare(
    "delete from runs where finished_at_ms is not null and finished_at_ms < ?",
  );

  const toRow = (r: Record<string, unknown>): RunRowV2 => {
    const request = parse<PersistedRequest>(r["request_json"]) ?? {};
    const webhook = request.webhook ?? null;
    return {
      snapshot: {
        runId: String(r["run_id"]) as RunId,
        daemonId: String(r["daemon_id"]) as DaemonId,
        state: String(r["state"]) as RunState,
        agentId: String(r["agent_id"]),
        cwd: String(r["cwd"]),
        workerId: nullable(r["worker_id"]) as WorkerId | null,
        turnId: nullable(r["turn_id"]) as TurnId | null,
        createdAt: String(r["created_at"]),
        updatedAt: String(r["updated_at"]),
        result: parse<TurnResult>(r["result_json"]),
        error: parse<OmniErrorBody>(r["error_json"]),
        // A row that is on disk is durable BY DEFINITION — that is what being here means. A run
        // created under the memory driver never reaches this store at all (ruling M2-R14).
        persistence: "durable",
        webhook:
          webhook === null ? null : { url: webhook.url, deliveries: request.deliveries ?? 0 },
      },
      tokenId: String(r["token_id"]) as TokenId,
      bootId: String(r["boot_id"]),
      idempotencyKey: nullable(r["idempotency_key"]),
      webhook,
      createdAtMs: Date.parse(String(r["created_at"])),
      updatedAtMs: Date.parse(String(r["updated_at"])),
      ...(request.seq === undefined ? {} : { seq: request.seq as Seq }),
    };
  };

  /**
   * One page, ordered by `(created_at desc, run_id desc)` and cursored on the row's own id.
   *
   * The tuple comparison is what makes the cursor stable: a run created while a client pages
   * sorts ABOVE everything it has already read, so it can neither duplicate a row onto a later
   * page nor push one off the end unseen.
   */
  const page = (
    tokenId: TokenId | null,
    limit: number,
    cursor: string | null,
  ): Record<string, unknown>[] => {
    const where: string[] = [];
    const params: unknown[] = [];
    if (tokenId !== null) {
      where.push("token_id = ?");
      params.push(tokenId);
    }
    if (cursor !== null) {
      where.push("(created_at, run_id) < (select created_at, run_id from runs where run_id = ?)");
      params.push(cursor);
    }
    params.push(limit + 1);
    return db
      .prepare(
        `select * from runs${where.length === 0 ? "" : ` where ${where.join(" and ")}`}` +
          " order by created_at desc, run_id desc limit ?",
      )
      .all(...params);
  };

  return {
    put(row: RunRowV2): void {
      const request: PersistedRequest = {
        ...(row.webhook === null ? {} : { webhook: row.webhook }),
        ...(row.snapshot.webhook === null ? {} : { deliveries: row.snapshot.webhook.deliveries }),
        ...(row.seq === undefined ? {} : { seq: row.seq }),
      };
      upsert.run(
        row.snapshot.runId,
        row.snapshot.daemonId,
        row.bootId,
        row.tokenId,
        row.snapshot.workerId,
        row.snapshot.turnId,
        row.snapshot.agentId,
        row.snapshot.cwd,
        row.snapshot.state,
        row.snapshot.createdAt,
        row.snapshot.updatedAt,
        TERMINAL_RUN_STATES.has(row.snapshot.state) ? row.updatedAtMs : null,
        JSON.stringify(request),
        json(row.snapshot.result),
        json(row.snapshot.error),
        row.webhook?.url ?? null,
        row.idempotencyKey,
      );
    },

    get(id: RunId): RunRowV2 | null {
      const r = selectOne.get(id);
      return r === undefined ? null : toRow(r);
    },

    byIdempotencyKey(tokenId: TokenId, key: string): RunRowV2 | null {
      const r = selectByKey.get(tokenId, key);
      return r === undefined ? null : toRow(r);
    },

    list(o: { tokenId?: TokenId; limit: number; cursor?: string }): {
      rows: readonly RunRowV2[];
      cursor: string | null;
    } {
      const limit = Math.max(1, Math.min(500, o.limit));
      const rows = page(o.tokenId ?? null, limit, o.cursor ?? null).map(toRow);
      const more = rows.length > limit;
      const trimmed = more ? rows.slice(0, limit) : rows;
      return { rows: trimmed, cursor: more ? (trimmed.at(-1)?.snapshot.runId ?? null) : null };
    },

    liveFromOtherBoots(bootId: string): readonly RunRowV2[] {
      return selectLiveOtherBoots.all(bootId, ...LIVE_RUN_STATES).map(toRow);
    },

    sweep(o: { olderThanMs: number }): number {
      // Only FINISHED runs age out: a run with no `finished_at_ms` is either live or was left
      // behind by a boot that never converged it, and deleting the second silently would remove
      // the very row §24.4's recovery exists to find.
      return Number(deleteOlder.run(o.olderThanMs).changes);
    },
  };
}
