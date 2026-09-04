import {
  OmniError,
  type EventEnvelope,
  type EventInput,
  type EventListener,
  type EventLog,
  type EventLogCoreOptions,
  type EventStore,
  type SessionId,
  type Seq,
  type Subscription,
} from "@omni-acp/protocol";

/** Defaults for the two bounds a caller may leave out (`DaemonConfig.eventLog`'s own defaults). */
const DEFAULT_MAX_EVENTS = 10_000;
const DEFAULT_QUEUE_SIZE = 1_024;

/**
 * A durable store that can also be asked to settle its debounced bookkeeping.
 *
 * `EventStore` is frozen in `@omni-acp/protocol` and has no `flush`, but §14.4 lets the durable
 * `head_seq` lag behind by up to 256 appends or 5 s, and `EventLog.flush()` is the contract's
 * "commit anything pending" (called before `daemon.stop()` returns). Rather than widen a frozen
 * interface, the log asks structurally: a store that has a `flush` gets one, a store that does
 * not is already committed by construction.
 */
interface FlushableEventStore extends EventStore {
  flush?(): void;
}

/**
 * An `EventLog` that also says which of §14.3's three answers is true for it.
 *
 * `EventLog.persistent` is a boolean and cannot express "the write-through FAILED": a log that
 * is still perfectly correct in RAM but whose history a restart will not recover. The extra
 * member is the honest third answer (`WorkerSnapshot.persistence`, §6.6's honesty rule), and it
 * is additive — every existing `EventLog` consumer is unaffected.
 */
export interface EventLogCore extends EventLog {
  /**
   * "memory"   — no durable side; nothing here survives a restart, and we say so.
   * "durable"  — write-through is healthy.
   * "degraded" — a durable write FAILED and this worker's history will not survive a restart.
   *              STICKY: a later success does not clear it, because the gap is already on disk.
   */
  readonly persistence: "memory" | "durable" | "degraded";
}

/**
 * One subscriber's bookkeeping.
 *
 * `pending` exists for exactly one situation: an append that happens WHILE this subscriber's
 * listener is on the stack (a listener that itself appends). Delivery is otherwise immediate,
 * so the queue is empty in the normal path and a re-entrant append cannot reorder the stream —
 * it is appended to the same queue the outer loop is draining.
 */
interface Sub {
  readonly listener: EventListener;
  readonly queueSize: number;
  readonly onOverflow: ((lastDelivered: Seq) => void) | undefined;
  /** `head` at attach time: live fan-out delivers strictly above it, replay covered the rest. */
  readonly attachedAt: Seq;
  pending: EventEnvelope[];
  /** Read cursor into `pending`; the array is reset once drained, so it never grows unbounded. */
  next: number;
  lastDelivered: Seq;
  /** The listener is on the stack: enqueue, do not re-enter the drain loop. */
  busy: boolean;
  closed: boolean;
}

/**
 * The ring, the subscribers, the overflow policy, the re-entrancy guard and the ONE `seq`
 * assigner — M0's `memory-log.ts` moved here VERBATIM, so that both drivers sit on identical
 * behaviour (CONTRACTS.md §14.1).
 *
 * The ring stays in front of the durable store as a CONTRACT REQUIREMENT, not a performance
 * choice: `runEventLogConformance` asserts object IDENTITY (`log.read(0)[0]` is the object
 * `append()` returned, F11), and a pure-SQLite `read()` returns a deserialized copy.
 *
 * `startSeq` seeds `head` on a rehydrated worker so a log whose rows retention already evicted
 * does NOT restart its own sequence at 1 (§14.4, L15) — the single most dangerous line in M1.
 *
 * Three properties carry the whole design and none of them are negotiable:
 *  1. `append()` is SYNCHRONOUS and is the sole assigner of `seq` — an async append lets two
 *     concurrent turns interleave into a non-monotonic log, which is exactly the corruption
 *     `?since=` cannot recover from.
 *  2. envelopes are frozen at append, so two subscribers cannot see different history.
 *  3. `subscribe()` replays and attaches the live tail in ONE synchronous critical section,
 *     so no event can slip between the two.
 *
 * Owned by M1-WP-A.
 */
export function createEventLogCore(o: EventLogCoreOptions): EventLogCore {
  const { workerId, daemonId, clock } = o;
  const maxEvents = positiveInt(o.maxEvents ?? DEFAULT_MAX_EVENTS, "maxEvents");
  const defaultQueueSize = positiveInt(o.queueSize ?? DEFAULT_QUEUE_SIZE, "queueSize");
  const store: FlushableEventStore | undefined = o.store;
  const logger = o.logger;

  /**
   * The seq the ring's slot arithmetic counts from. 0 for a fresh log, `startSeq` for a
   * rehydrated one: the ring is empty at that point and the first append lands in slot 0, so
   * indexing by `(seq - 1) % maxEvents` — correct only when the log started at 1 — would put
   * the envelope in one slot and look for it in another.
   */
  const base = nonNegativeInt(o.startSeq ?? 0, "startSeq");

  /**
   * The ring, indexed by `slot()`. Because `seq` is gap-free and contiguous from `base + 1`,
   * that slot is unique for the newest `maxEvents` entries — so eviction costs one overwrite
   * rather than the O(n) element shift an `Array.shift()` ring would pay on every append once
   * full (WP-3 acceptance 3: the producer's latency is a property, not an aspiration).
   */
  const ring: EventEnvelope[] = [];
  const subs = new Set<Sub>();

  let head: Seq = base;
  let sessionId: SessionId | null = null;

  /** Sticky (§14.3): the disk already has the gap, and a later success does not close it. */
  let degraded = false;
  let announced = false;
  /** Re-entrancy guards for the one in-band `omni.error` the degradation emits. */
  let announcing = false;
  let batching = false;

  const slot = (seq: Seq): number => (seq - base - 1) % maxEvents;

  /**
   * The lowest seq the RING can serve. `head + 1` — "nothing here, and here is where the next
   * one will be" — when it is empty, which is both a fresh log and a just-reopened one.
   */
  const ringFloor = (): Seq => (ring.length === 0 ? head + 1 : head - ring.length + 1);

  /**
   * The lowest seq `read()` can actually produce, across BOTH sources.
   *
   * §14.5 is the rule: the ring bounds memory only and never raises `tail`, so with a backend
   * `tail` comes from disk. §14.3's prose says `max(durable tail, ring floor)`, which is right
   * only in the case it was written for (retention has taken every row, so `tailOf` returns the
   * `head + 1` sentinel and the ring is the only source); with a small ring in front of a full
   * disk the max would report a tail ABOVE rows the log can still serve. `min` is the same
   * statement made total: whichever source reaches furthest back, that is the honest tail — and
   * the `head + 1` sentinel makes the "everything evicted" case fall out of it unchanged.
   */
  const tailOf = (): Seq => {
    const floor = Math.max(1, ringFloor());
    if (store === undefined) return floor;
    return Math.min(store.tailOf(workerId), floor);
  };

  const closeSub = (sub: Sub): void => {
    if (sub.closed) return;
    sub.closed = true;
    sub.pending = [];
    sub.next = 0;
    subs.delete(sub);
  };

  /**
   * Overflow is a live-fan-out condition only: a replay is the log's OWN retained history and
   * is already bounded by `maxEvents`, so it never counts against the queue.
   *
   * The subscription is closed BEFORE the callback runs, so an append made from inside
   * `onOverflow` cannot re-enter this subscriber, and the producer is never blocked
   * (CONTRACTS.md §8.4 "slow consumer": no event is silently dropped — the client is told the
   * last seq it holds and reconnects with `?since=`).
   */
  const overflow = (sub: Sub): void => {
    const lastDelivered = sub.lastDelivered;
    const notify = sub.onOverflow;
    closeSub(sub);
    if (notify !== undefined) notify(lastDelivered);
  };

  const drain = (sub: Sub): void => {
    if (sub.busy) return; // the outer loop owns the queue; it will pick this up
    sub.busy = true;
    try {
      while (!sub.closed && sub.next < sub.pending.length) {
        const e = sub.pending[sub.next];
        sub.next += 1;
        if (sub.next >= sub.pending.length) {
          sub.pending = [];
          sub.next = 0;
        }
        if (e === undefined) continue;
        sub.lastDelivered = e.seq;
        // A throwing listener propagates to the producer on purpose: the contract says it MUST
        // NOT throw, the envelope is already in the ring, and swallowing the error here would
        // turn a subscriber bug into events that silently stop arriving.
        sub.listener(e);
      }
    } finally {
      sub.busy = false;
    }
  };

  /**
   * TWO phases, and the order of them is the multi-observer guarantee (D5).
   *
   * A listener may append — the conformance suite requires it to work — and that append
   * re-enters this function before the first fan-out has reached the remaining subscribers. If
   * enqueue and delivery were one loop, subscriber B would be handed the re-entrant event
   * BEFORE the event that caused it: two observers, two different histories, and a `?since=`
   * cursor that cannot recover. Enqueuing to EVERY subscriber first makes each subscriber's
   * queue FIFO in seq order no matter when it is drained.
   */
  const fanOut = (e: EventEnvelope): void => {
    for (const sub of subs) {
      // A subscriber created from inside a listener during THIS append already saw `e` in its
      // own replay (or is cursored past it); delivering again would double it.
      if (sub.closed || e.seq <= sub.attachedAt) continue;
      sub.pending.push(e);
      if (sub.pending.length - sub.next > sub.queueSize) overflow(sub);
    }
    for (const sub of subs) drain(sub);
  };

  /**
   * §14.3, and the asymmetry is the whole point: a durable failure must NEVER throw into the
   * caller. `Worker.#feed` catches, logs and drops, so a disk-full would silently eat events.
   * The log degrades instead — correct in RAM, every observer still served — and SAYS so.
   *
   * The `seq` is deliberately NOT rolled back: rolling it back would leave the ring and the disk
   * holding different envelopes at the same seq, which is the one corruption `?since=` cannot
   * recover from.
   */
  const noteWriteFailure = (seq: Seq, cause: unknown): void => {
    const first = !degraded;
    degraded = true;
    logger?.[first ? "error" : "debug"]("event log durable write failed", {
      workerId,
      seq,
      error: cause instanceof Error ? cause.message : String(cause),
    });
  };

  /**
   * ONE in-band `omni.error` per worker telling subscribers that this worker's history will not
   * survive a restart (§14.3). It is a real envelope with a real `seq` — not an out-of-band SSE
   * control frame — because every subscriber must agree that it happened.
   */
  const announceDegradation = (): void => {
    if (!degraded || announced || announcing || batching) return;
    announcing = true;
    announced = true;
    try {
      appendOne({
        kind: "omni.error",
        payloadVersion: 2,
        payload: {
          code: "internal",
          message:
            "event log persistence degraded: a durable write failed, so this worker's history will not survive a restart",
        },
      });
    } finally {
      announcing = false;
    }
  };

  const appendOne = (input: EventInput): EventEnvelope => {
    const seq = head + 1;
    head = seq;
    const envelope = Object.freeze({
      ...input,
      turnId: input.turnId ?? null,
      seq,
      ts: clock.iso(),
      daemonId,
      workerId,
      sessionId,
    });

    // Durable FIRST (§14.3): it keeps the window in which a SIGKILL loses an envelope down to
    // the insert itself rather than the whole fan-out.
    if (store !== undefined) {
      try {
        store.put(envelope);
      } catch (e) {
        noteWriteFailure(seq, e);
      }
    }

    if (ring.length < maxEvents) ring.push(envelope);
    else ring[slot(seq)] = envelope;

    fanOut(envelope);
    return envelope;
  };

  const append = (input: EventInput): EventEnvelope => {
    const envelope = appendOne(input);
    announceDegradation();
    return envelope;
  };

  const read = (since: Seq, limit?: number): readonly EventEnvelope[] => {
    const from = Math.max(cursor(since) + 1, tailOf());
    if (from > head) return [];
    const want = limit === undefined ? Infinity : Math.max(0, Math.floor(limit));
    if (want === 0) return [];

    const out: EventEnvelope[] = [];
    const floor = Math.max(1, ringFloor());

    // The ring floor is the ONLY branch (§14.3), and the disk half is capped by it so the two
    // sources can never overlap and a seq can never appear twice.
    if (store !== undefined && from < floor) {
      const need = Math.min(want, floor - from);
      for (const e of store.read(workerId, from - 1, need)) {
        if (e.seq >= floor) break;
        out.push(e);
      }
    }

    for (let s = Math.max(from, floor); s <= head && out.length < want; s++) {
      const e = ring[slot(s)];
      if (e !== undefined) out.push(e);
    }
    return out;
  };

  return {
    workerId,
    get head(): Seq {
      return head;
    },
    get tail(): Seq {
      return tailOf();
    },
    get subscriberCount(): number {
      return subs.size;
    },
    append,
    appendAll(inputs: readonly EventInput[]): EventEnvelope[] {
      // One synchronous loop, in array order: `appendAll` is what makes a Normalizer step's
      // `emit` array atomic with respect to seq (CONTRACTS.md §7.6). The degradation notice is
      // held back until the batch is complete so it cannot land in the middle of one.
      const out: EventEnvelope[] = [];
      const outer = batching;
      batching = true;
      try {
        for (const input of inputs) out.push(appendOne(input));
      } finally {
        batching = outer;
      }
      announceDegradation();
      return out;
    },
    read,
    subscribe(
      since: Seq,
      listener: EventListener,
      opts?: { onOverflow?: (lastDelivered: Seq) => void; queueSize?: number },
    ): Subscription {
      const sub: Sub = {
        listener,
        queueSize:
          opts?.queueSize === undefined
            ? defaultQueueSize
            : positiveInt(opts.queueSize, "queueSize"),
        onOverflow: opts?.onOverflow,
        attachedAt: head,
        pending: [],
        next: 0,
        // Clamped to `head`: a cursor ahead of the log is accepted (skew must not be an error),
        // but reporting it back on overflow would tell the client to resume past events it
        // never received.
        lastDelivered: Math.min(cursor(since), head),
        busy: false,
        closed: false,
      };
      // Registered BEFORE the replay drains, so an append made from inside the listener lands
      // in this subscriber's queue and is delivered after the backlog — in seq order, with
      // nothing slipping between replay and live tail.
      subs.add(sub);
      sub.pending = [...read(since)];
      drain(sub);

      return {
        close(): void {
          closeSub(sub);
        },
        get closed(): boolean {
          return sub.closed;
        },
      };
    },
    close(): void {
      // Subscriptions only. The log stays appendable and readable: `daemon.stop()` closes the
      // SSE readers before the workers, and the worker's final `omni.worker_state{closed}` must
      // still reach the log that `GET /turns/{id}` folds over. The STORE is untouched — it
      // outlives every log over it (§14.11 item 8).
      for (const sub of [...subs]) closeSub(sub);
    },
    setSessionId(id: SessionId): void {
      // §8.2 rule 3: no back-fill. Envelopes already appended stay frozen with `sessionId: null`
      // — they precede the session's existence (review R16).
      sessionId = id;
    },

    // ── M1 (§14.1) ──────────────────────────────────────────────────────────

    persistent: store !== undefined,

    get persistence(): "memory" | "durable" | "degraded" {
      if (store === undefined) return "memory";
      return degraded ? "degraded" : "durable";
    },

    flush(): void {
      // The rows are already committed — `put` is autocommit. What can lag is §14.4's debounced
      // `head_seq`, and that is exactly what a store's `flush` settles.
      store?.flush?.();
    },
  };
}

/** A cursor from the wire may be anything; below zero and non-finite both mean "from birth". */
function cursor(since: Seq): number {
  return Number.isFinite(since) && since > 0 ? Math.floor(since) : 0;
}

function positiveInt(value: number, what: string): number {
  if (!Number.isInteger(value) || value < 1) {
    // `internal`, not `bad_request`: config reaches here through zod's positive-int schema, so
    // a bad value is a caller inside the process, never a request.
    throw new OmniError("internal", `event log ${what} must be a positive integer`, {
      detail: { [what]: value },
    });
  }
  return value;
}

function nonNegativeInt(value: number, what: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new OmniError("internal", `event log ${what} must be a non-negative integer`, {
      detail: { [what]: value },
    });
  }
  return value;
}
