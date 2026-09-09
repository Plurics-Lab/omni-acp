import { OmniError } from "@omni-acp/protocol";
import type {
  DeliveryId,
  DeliveryRecord,
  DeliveryStore,
  RunId,
  TokenId,
  WebhookEvent,
  WebhookPayload,
} from "@omni-acp/protocol";
import type { SqliteDatabase } from "./schema.js";

/**
 * One delivery row with the three things the DISPATCHER needs and `DeliveryRecord` does not
 * carry: where to send it, whose token owns it, and what to send.
 *
 * `DeliveryRecord` (§5.8.6) is the WIRE view — what `GET /v1/webhooks/deliveries` shows an
 * operator — and putting a url, a token id and a payload on it would publish three things the
 * dead-letter listing has no business publishing. So the store returns a SUBTYPE: every
 * `DeliveryRow` is a valid `DeliveryRecord`, `DeliveryStore` sees exactly the frozen shape, and
 * the dispatcher (which holds the store directly) sees the rest.
 */
export interface DeliveryRow extends DeliveryRecord {
  readonly url: string;
  readonly tokenId: TokenId;
  readonly payload: WebhookPayload;
  /** The boot that owns an in-flight attempt, or null. §24.4's whole restart argument (rule 3). */
  readonly leaseBoot: string | null;
}

/**
 * `DeliveryStore`, widened where the frozen seam cannot say what §24 requires.
 *
 * The split between the two return types is the load-bearing part, and it is a boundary rather
 * than a convenience:
 *
 *  - `due` and `get` are the DISPATCHER's reads and return `DeliveryRow`, because sending needs a
 *    url, a token and a payload;
 *  - `list` and `redeliver` are `GET /v1/webhooks/deliveries`' reads and return `DeliveryRecord`,
 *    because that route serializes whatever it is handed — so the store hands it the wire view and
 *    a url or a payload cannot leak onto the dead-letter listing by a route forgetting to project.
 *
 * `list` and `redeliver` also accept `tokenId`: "admin **or the owning token**" is a filter, and
 * the route is the only place that knows which token is asking. Pushing it into the query keeps it
 * one indexed read instead of a fetch-then-drop in the adapter, which would page wrongly — a page
 * of 50 rows filtered down to 3 is not a page of 3, and its cursor would skip what it dropped.
 */
export interface DeliveryStoreV2 extends DeliveryStore {
  due(nowMs: number, limit: number): readonly DeliveryRow[];
  get(id: DeliveryId): DeliveryRow | null;
  list(o: { runId?: RunId; state?: string; limit: number; cursor?: string; tokenId?: TokenId }): {
    rows: readonly DeliveryRecord[];
    cursor: string | null;
  };
  /**
   * `tokenId` scopes the replay: a delivery this token does not own is `worker_not_found`, the
   * same answer it gets from `list` (§24.5's "admin or the owning token only"). Absent ⇒ no
   * scope, which is admin.
   */
  redeliver(id: DeliveryId, nowMs: number, tokenId?: TokenId): DeliveryRecord;
  /** Retention: deliveries of runs that have aged out go WITH them (§24.5). */
  sweep(o: { olderThanMs: number }): number;
}

const nullableNumber = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);
const nullableText = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v);

/**
 * The `webhook_deliveries` table (schema v2).
 *
 * `claim` is the load-bearing method and it is an ATOMIC compare-and-set: `pending → delivering`
 * stamping this boot's id, returning false when somebody else got there first. Two dispatchers
 * racing one row must see exactly one success, and doing it any other way turns a duplicate
 * delivery into a routine event rather than an accident.
 *
 * `requeueStale` is its restart counterpart: a `delivering` row owned by a FOREIGN boot goes back
 * to `pending` with `attempt` UNCHANGED, because that attempt never happened — charging it would
 * silently shorten the ladder every time the daemon restarted. The consequence is written down
 * rather than discovered: delivery is AT LEAST ONCE and `deliveryId` is the dedupe key.
 *
 * `attempt` counts attempts that COMPLETED, and it is incremented by `settle` and by nothing
 * else. That is the same fact from the other side: a claim that never reached a settle never
 * happened, so `requeueStale` has nothing to undo.
 *
 * Owned by M2-B-WP-R.
 */
export function createDeliveryStore(db: SqliteDatabase): DeliveryStoreV2 {
  const insert = db.prepare(
    `insert into webhook_deliveries (
       delivery_id, run_id, token_id, event, url, state, attempt, next_attempt_ms, lease_boot,
       last_status, last_error, response_ms, created_at, updated_at, payload_json
     ) values (?, ?, ?, ?, ?, 'pending', 0, ?, null, null, null, null, ?, ?, ?)`,
  );
  const selectOne = db.prepare("select * from webhook_deliveries where delivery_id = ?");
  const selectDue = db.prepare(
    `select * from webhook_deliveries
      where state = 'pending' and next_attempt_ms is not null and next_attempt_ms <= ?
      order by next_attempt_ms asc, created_at asc, delivery_id asc
      limit ?`,
  );
  // ONE statement, and the `state = 'pending'` in the WHERE is the whole compare-and-set: SQLite
  // applies it under the write lock, so `changes === 1` means THIS process won the row.
  const claimOne = db.prepare(
    `update webhook_deliveries
        set state = 'delivering', lease_boot = ?, updated_at = ?
      where delivery_id = ? and state = 'pending'`,
  );
  const settleOne = db.prepare(
    `update webhook_deliveries
        set state = ?, attempt = attempt + 1, next_attempt_ms = ?, lease_boot = null,
            last_status = ?, last_error = ?, response_ms = ?, updated_at = ?
      where delivery_id = ?`,
  );
  const requeue = db.prepare(
    `update webhook_deliveries
        set state = 'pending', lease_boot = null, next_attempt_ms = ?, updated_at = ?
      where state = 'delivering' and (lease_boot is null or lease_boot <> ?)`,
  );
  // The owner check is INSIDE the statement rather than a read-then-write: two round trips would
  // leave a window in which the row's ownership could change between the check and the update.
  // `? is null` is the "no scope" arm, which is admin.
  const redeliverOne = db.prepare(
    `update webhook_deliveries
        set state = 'pending', attempt = 0, next_attempt_ms = ?, lease_boot = null,
            last_status = null, last_error = null, response_ms = null, updated_at = ?
      where delivery_id = ? and (? is null or token_id = ?)`,
  );
  const deleteOlder = db.prepare("delete from webhook_deliveries where created_at < ?");

  /** The WIRE view: exactly `DeliveryRecord`, and nothing an operator has no business seeing. */
  const toRecord = (r: Record<string, unknown>): DeliveryRecord => ({
    deliveryId: String(r["delivery_id"]) as DeliveryId,
    runId: String(r["run_id"]) as RunId,
    event: String(r["event"]) as WebhookEvent,
    state: String(r["state"]) as DeliveryRecord["state"],
    attempt: Number(r["attempt"] ?? 0),
    nextAttemptAt:
      r["next_attempt_ms"] === null || r["next_attempt_ms"] === undefined
        ? null
        : new Date(Number(r["next_attempt_ms"])).toISOString(),
    lastStatus: nullableNumber(r["last_status"]),
    lastError: nullableText(r["last_error"]),
    responseMs: nullableNumber(r["response_ms"]),
    createdAt: String(r["created_at"]),
    updatedAt: String(r["updated_at"]),
  });

  /** The DISPATCHER's view: the wire record plus the three things sending needs. */
  const toRow = (r: Record<string, unknown>): DeliveryRow => ({
    ...toRecord(r),
    url: String(r["url"]),
    tokenId: String(r["token_id"]) as TokenId,
    payload: JSON.parse(String(r["payload_json"])) as WebhookPayload,
    leaseBoot: nullableText(r["lease_boot"]),
  });

  return {
    enqueue(r): void {
      const iso = new Date(r.nowMs).toISOString();
      insert.run(
        r.deliveryId,
        r.runId,
        r.tokenId,
        r.event,
        r.url,
        // Rung 0 is 0s: the first attempt is due the moment the row exists (§24.3).
        r.nowMs,
        iso,
        iso,
        JSON.stringify(r.payload),
      );
    },

    due(nowMs: number, limit: number): readonly DeliveryRow[] {
      return selectDue.all(nowMs, Math.max(1, Math.min(500, limit))).map(toRow);
    },

    claim(id: DeliveryId, bootId: string, nowMs: number): boolean {
      return Number(claimOne.run(bootId, new Date(nowMs).toISOString(), id).changes) === 1;
    },

    settle(r): void {
      settleOne.run(
        r.state,
        r.nextAttemptMs,
        r.status,
        r.error,
        r.responseMs,
        new Date(r.nowMs).toISOString(),
        r.deliveryId,
      );
    },

    requeueStale(bootId: string, nowMs: number): number {
      // `next_attempt_ms = nowMs` and NOT a fresh rung: the attempt this row was claimed for may
      // never have reached the wire, so the ladder owes it that attempt immediately.
      return Number(requeue.run(nowMs, new Date(nowMs).toISOString(), bootId).changes);
    },

    list(o): { rows: readonly DeliveryRecord[]; cursor: string | null } {
      const limit = Math.max(1, Math.min(500, o.limit));
      const where: string[] = [];
      const params: unknown[] = [];
      if (o.runId !== undefined) {
        where.push("run_id = ?");
        params.push(o.runId);
      }
      if (o.state !== undefined) {
        where.push("state = ?");
        params.push(o.state);
      }
      if (o.tokenId !== undefined) {
        where.push("token_id = ?");
        params.push(o.tokenId);
      }
      if (o.cursor !== undefined) {
        // The tuple cursor again: newest first, keyed on the row's own primary key, so a delivery
        // enqueued mid-page sorts above everything already read and can neither duplicate a row
        // onto a later page nor push one off the end unseen.
        where.push(
          "(created_at, delivery_id) < " +
            "(select created_at, delivery_id from webhook_deliveries where delivery_id = ?)",
        );
        params.push(o.cursor);
      }
      params.push(limit + 1);
      const rows = db
        .prepare(
          "select * from webhook_deliveries" +
            (where.length === 0 ? "" : ` where ${where.join(" and ")}`) +
            " order by created_at desc, delivery_id desc limit ?",
        )
        .all(...params)
        // `toRecord`, not `toRow`: this is the dead-letter LISTING, and its route serializes
        // whatever it is handed.
        .map(toRecord);
      const more = rows.length > limit;
      const trimmed = more ? rows.slice(0, limit) : rows;
      return { rows: trimmed, cursor: more ? (trimmed.at(-1)?.deliveryId ?? null) : null };
    },

    get(id: DeliveryId): DeliveryRow | null {
      const r = selectOne.get(id);
      return r === undefined ? null : toRow(r);
    },

    redeliver(id: DeliveryId, nowMs: number, tokenId?: TokenId): DeliveryRecord {
      // The SAME `deliveryId`, and that is the whole point: it is the key a receiver deduplicates
      // on, so a replay of a dead letter is the event it already has rather than a second one.
      const scope = tokenId ?? null;
      const changes = Number(
        redeliverOne.run(nowMs, new Date(nowMs).toISOString(), id, scope, scope).changes,
      );
      // One answer for "no such delivery" and for "not yours", because the second must not
      // confirm that the id is real (D13's rule, applied to a delivery).
      if (changes !== 1) throw new OmniError("worker_not_found", `no delivery ${id}`);
      const row = selectOne.get(id);
      if (row === undefined) throw new OmniError("worker_not_found", `no delivery ${id}`);
      return toRecord(row);
    },

    sweep(o: { olderThanMs: number }): number {
      return Number(deleteOlder.run(new Date(o.olderThanMs).toISOString()).changes);
    },
  };
}
