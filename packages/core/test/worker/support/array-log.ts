import type {
  Clock,
  DaemonId,
  EventEnvelope,
  EventInput,
  EventListener,
  EventLog,
  SessionId,
  Seq,
  Subscription,
  WorkerId,
} from "@omni-acp/protocol";

export interface ArrayLog extends EventLog {
  readonly all: readonly EventEnvelope[];
  /** Every `append`/`appendAll` call, in order — the interleaving oracle for WP-4 acceptance 2. */
  readonly trace: readonly string[];
  kinds(): string[];
}

/**
 * The array-backed log WP-4's tests use instead of WP-3's `createMemoryEventLog`, so the two
 * work packages merge independently (M0-PLAN §2, WP-4 "Depends on").
 *
 * It implements exactly the properties the Worker relies on and no more: synchronous `append` as
 * the sole assigner of `seq`, `seq` starting at 1 and gap-free, frozen envelopes, and a
 * `sessionId` that is stamped from `setSessionId()` forward and never back-filled (§8.2 rule 3).
 * Ring eviction and bounded subscriber queues are WP-3's problem, and modelling them here would
 * only let this file disagree with the real one.
 */
export function arrayLog(o: {
  workerId: WorkerId;
  daemonId: DaemonId;
  clock: Clock;
  trace?: string[];
}): ArrayLog {
  const events: EventEnvelope[] = [];
  const trace = o.trace ?? [];
  const subs = new Set<{ listener: EventListener }>();
  let sessionId: SessionId | null = null;
  let head = 0;

  const appendOne = (input: EventInput): EventEnvelope => {
    head += 1;
    const envelope = Object.freeze({
      ...input,
      seq: head,
      ts: o.clock.iso(),
      daemonId: o.daemonId,
      workerId: o.workerId,
      sessionId,
      turnId: input.turnId ?? null,
    }) as EventEnvelope;
    events.push(envelope);
    trace.push(`append:${input.kind}`);
    for (const s of subs) s.listener(envelope);
    return envelope;
  };

  return {
    workerId: o.workerId,
    get head(): Seq {
      return head;
    },
    get tail(): Seq {
      return 1;
    },
    get subscriberCount(): number {
      return subs.size;
    },
    get all(): readonly EventEnvelope[] {
      return events;
    },
    get trace(): readonly string[] {
      return trace;
    },
    kinds(): string[] {
      return events.map((e) => e.kind);
    },
    append: appendOne,
    appendAll(inputs) {
      return inputs.map(appendOne);
    },
    read(since, limit) {
      const out = events.filter((e) => e.seq > since);
      return limit === undefined ? out : out.slice(0, limit);
    },
    subscribe(since: Seq, listener: EventListener): Subscription {
      for (const e of events) if (e.seq > since) listener(e);
      const entry = { listener };
      subs.add(entry);
      let closed = false;
      return {
        close(): void {
          closed = true;
          subs.delete(entry);
        },
        get closed(): boolean {
          return closed;
        },
      };
    },
    close(): void {
      subs.clear();
    },
    setSessionId(id: SessionId): void {
      sessionId = id;
    },
  };
}
