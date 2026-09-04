import type {
  PersistenceHandle,
  RetentionInput,
  RetentionPlan,
  RetentionReport,
  Seq,
  WorkerId,
} from "@omni-acp/protocol";

const DAY_MS = 86_400_000;

/**
 * §14.5's THREE bounds, which are constantly confused, enumerated once:
 *
 *  1. the RAM ring (`maxEventsPerWorker`) — bounds MEMORY only, and never deletes a durable row;
 *  2. a per-worker durable row cap (`maxPersistedEventsPerWorker`), 0 = unbounded;
 *  3. 7 days after CLOSE (`retentionDays`, DESIGN §12).
 *
 * A LIVE or HIBERNATED worker is never aged out. `tail` tells the truth after every sweep.
 *
 * `planRetention` is PURE and table-tested; `runRetention` applies one plan, raising `tail_seq`
 * in the SAME transaction as the DELETE — a raise that lands separately is a window in which the
 * log reports rows it no longer has.
 *
 * Owned by M1-WP-A.
 */
export function planRetention(o: RetentionInput): RetentionPlan {
  const dropWorkers: WorkerId[] = [];
  const evictTo: { workerId: WorkerId; upTo: Seq }[] = [];

  // 0 = off, matching `maxPersistedEventsPerWorker`'s documented 0. The alternative reading —
  // "expire after zero days" — turns a config typo into the immediate deletion of every closed
  // worker's history, which is not a default anyone should be able to reach by accident.
  const ageMs = o.retentionDays > 0 ? o.retentionDays * DAY_MS : null;
  const cap = o.maxPersistedEventsPerWorker > 0 ? o.maxPersistedEventsPerWorker : null;

  for (const row of o.rows) {
    // Bound 3. A live or hibernated worker is NEVER aged out — a hibernated worker can still
    // wake, and its history is the reason to (§14.5).
    if (
      ageMs !== null &&
      row.state === "closed" &&
      row.closedAtMs !== null &&
      o.nowMs - row.closedAtMs > ageMs
    ) {
      dropWorkers.push(row.workerId);
      continue;
    }

    // Bound 2. `head - tail + 1` is the retained count, and the `tail > head` sentinel ("nothing
    // retained, and here is where the next one will be") makes it 0 rather than negative.
    if (cap === null) continue;
    const retained = row.tail > row.head ? 0 : row.head - row.tail + 1;
    if (retained <= cap) continue;
    const upTo = row.head - cap;
    if (upTo >= row.tail) evictTo.push({ workerId: row.workerId, upTo });
  }

  return { dropWorkers, evictTo };
}

/**
 * The only part of retention that touches I/O.
 *
 * Age expiry deletes the event rows AND the worker row, so `GET /v1/workers/{wid}` after 7 days
 * is a clean `404 worker_not_found` rather than a snapshot pointing at an empty log (§14.5).
 * The row-cap sweep deletes events only: the worker is still there, and so is its `tail`.
 */
export function runRetention(h: PersistenceHandle, p: RetentionPlan): RetentionReport {
  const startedAt = Date.now();
  let byAge = 0;
  let byRowCap = 0;

  for (const { workerId, upTo } of p.evictTo) {
    byRowCap += h.events.evict(workerId, upTo);
  }

  for (const workerId of p.dropWorkers) {
    // `headOf` is `max(seq) EVER assigned`, so this evicts everything the worker has without
    // needing the plan to carry a bound — and it leaves `head_seq` behind in the same
    // transaction, which is what stops a re-created worker id from restarting at seq 1.
    byAge += h.events.evict(workerId, h.events.headOf(workerId));
    h.workers.delete(workerId);
  }

  return {
    workersDropped: p.dropWorkers.length,
    eventsDeleted: byAge + byRowCap,
    byAge,
    byRowCap,
    durationMs: Date.now() - startedAt,
  };
}
