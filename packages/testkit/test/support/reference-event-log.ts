import type {
  DaemonId,
  EventEnvelope,
  EventInput,
  EventListener,
  EventLog,
  Seq,
  SessionId,
  Subscription,
  WorkerId,
} from "@omni-acp/protocol";

/**
 * A reference EventLog — TEST SUPPORT ONLY.
 *
 * It exists so `runEventLogConformance()` is proven self-consistent before five work packages
 * depend on it; the shipped log is WP-3's `createMemoryEventLog` in
 * `packages/core/src/event-log/`, which is also the only place in `src/**` that may assign a
 * `seq` (CONTRACTS.md §7.6). Nothing outside this directory imports this file.
 */
export function referenceEventLog(opts?: {
  workerId?: WorkerId;
  daemonId?: DaemonId;
  maxEvents?: number;
}): EventLog {
  const workerId = opts?.workerId ?? (`w_${"0".repeat(26)}` as WorkerId);
  const daemonId = opts?.daemonId ?? (`d_${"0".repeat(26)}` as DaemonId);
  const maxEvents = opts?.maxEvents ?? 10_000;

  const ring: EventEnvelope[] = [];
  const subs = new Set<{ cursor: Seq; listener: EventListener; sub: Subscription }>();
  let head = 0;
  let sessionId: SessionId | null = null;
  let closed = false;

  const append = (input: EventInput): EventEnvelope => {
    head += 1;
    const envelope = Object.freeze({
      ...input,
      turnId: input.turnId ?? null,
      seq: head,
      ts: new Date().toISOString(),
      daemonId,
      workerId,
      sessionId,
    }) as EventEnvelope;
    ring.push(envelope);
    while (ring.length > maxEvents) ring.shift();
    for (const s of [...subs]) {
      if (envelope.seq <= s.cursor) continue;
      s.cursor = envelope.seq;
      s.listener(envelope);
    }
    return envelope;
  };

  const read = (since: Seq, limit?: number): readonly EventEnvelope[] => {
    const out = ring.filter((e) => e.seq > since);
    return limit === undefined ? out : out.slice(0, limit);
  };

  return {
    workerId,
    get head() {
      return head;
    },
    get tail() {
      return ring[0]?.seq ?? head + 1;
    },
    get subscriberCount() {
      return subs.size;
    },
    append,
    appendAll: (inputs) => inputs.map(append),
    read,
    subscribe(since, listener, _opts): Subscription {
      let subClosed = closed;
      const entry = {
        cursor: since,
        listener,
        sub: {
          close() {
            subClosed = true;
            subs.delete(entry);
          },
          get closed() {
            return subClosed;
          },
        },
      };
      if (closed) return entry.sub;

      // Replay and live attachment in ONE synchronous critical section: the loop re-reads
      // until it is caught up, so an append made from inside the listener cannot slip through
      // the gap between the two.
      for (;;) {
        const backlog = read(entry.cursor);
        if (backlog.length === 0) break;
        for (const e of backlog) {
          entry.cursor = e.seq;
          listener(e);
        }
      }
      // The cursor now means "delivered up to", not "asked for": a subscriber whose `since`
      // ran ahead of `head` (cursor skew) must still get the live tail (CONTRACTS.md §8.4).
      entry.cursor = head;
      subs.add(entry);
      return entry.sub;
    },
    close() {
      closed = true;
      for (const s of [...subs]) s.sub.close();
      subs.clear();
    },
    setSessionId(id) {
      sessionId = id;
    },
  };
}
