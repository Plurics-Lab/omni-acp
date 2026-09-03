import {
  OmniError,
  type Clock,
  type DaemonId,
  type EventEnvelope,
  type EventInput,
  type EventListener,
  type EventLog,
  type SessionId,
  type Seq,
  type Subscription,
  type WorkerId,
} from "@omni-acp/protocol";

export interface MemoryEventLogOptions {
  readonly workerId: WorkerId;
  readonly daemonId: DaemonId;
  readonly clock: Clock;
  readonly maxEvents: number;
  readonly subscriberQueueSize: number;
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
 * The in-memory ring of CONTRACTS.md §8.
 *
 * Three properties carry the whole design and none of them are negotiable:
 *  1. `append()` is SYNCHRONOUS and is the sole assigner of `seq` — an async append lets two
 *     concurrent turns interleave into a non-monotonic log, which is exactly the corruption
 *     `?since=` cannot recover from.
 *  2. envelopes are frozen at append, so two subscribers cannot see different history.
 *  3. `subscribe()` replays and attaches the live tail in ONE synchronous critical section,
 *     so no event can slip between the two.
 *
 * `head`/`tail`/`read` are synchronous for a second reason: M1's `node:sqlite` driver is
 * `DatabaseSync`, and `runEventLogConformance()` is the suite it must pass verbatim.
 */
export function createMemoryEventLog(o: MemoryEventLogOptions): EventLog {
  const { workerId, daemonId, clock } = o;
  const maxEvents = positiveInt(o.maxEvents, "maxEvents");
  const defaultQueueSize = positiveInt(o.subscriberQueueSize, "subscriberQueueSize");

  /**
   * The ring, indexed by `(seq - 1) % maxEvents`. Because `seq` is gap-free and starts at 1,
   * that slot is unique for the newest `maxEvents` entries — so eviction costs one overwrite
   * rather than the O(n) element shift an `Array.shift()` ring would pay on every append once
   * full (WP-3 acceptance 3: the producer's latency is a property, not an aspiration).
   */
  const ring: EventEnvelope[] = [];
  const subs = new Set<Sub>();

  let head: Seq = 0;
  let sessionId: SessionId | null = null;

  /** Lowest retained seq. 1 while the log is empty or the ring has not yet evicted. */
  const tailOf = (): Seq => Math.max(1, head - maxEvents + 1);

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

  const append = (input: EventInput): EventEnvelope => {
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

    if (ring.length < maxEvents) ring.push(envelope);
    else ring[(seq - 1) % maxEvents] = envelope;

    fanOut(envelope);
    return envelope;
  };

  const read = (since: Seq, limit?: number): readonly EventEnvelope[] => {
    const from = Math.max(cursor(since) + 1, tailOf());
    if (from > head) return [];
    const want = limit === undefined ? Infinity : Math.max(0, Math.floor(limit));
    const count = Math.min(head - from + 1, want);
    const out: EventEnvelope[] = [];
    for (let s = from; s < from + count; s++) {
      const e = ring[(s - 1) % maxEvents];
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
      // `emit` array atomic with respect to seq (CONTRACTS.md §7.6).
      const out: EventEnvelope[] = [];
      for (const input of inputs) out.push(append(input));
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
      // still reach the log that `GET /turns/{id}` folds over.
      for (const sub of [...subs]) closeSub(sub);
    },
    setSessionId(id: SessionId): void {
      // §8.2 rule 3: no back-fill. Envelopes already appended stay frozen with `sessionId: null`
      // — they precede the session's existence (review R16).
      sessionId = id;
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
