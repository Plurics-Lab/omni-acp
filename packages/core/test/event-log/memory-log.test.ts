import { describe, expect, it } from "vitest";
import { createMemoryEventLog } from "@omni-acp/core";
import { fakeClock, runEventLogConformance, seqIds } from "@omni-acp/testkit";
import {
  eventEnvelopeSchema,
  OmniError,
  type DaemonId,
  type EventEnvelope,
  type EventInput,
  type EventLog,
  type Seq,
  type TurnId,
  type WorkerId,
} from "@omni-acp/protocol";

const slow = Number(process.env["OMNI_TEST_SLOW_FACTOR"] ?? "1");

interface LogOpts {
  maxEvents?: number;
  subscriberQueueSize?: number;
}

function makeLog(o: LogOpts = {}): EventLog {
  const ids = seqIds();
  return createMemoryEventLog({
    workerId: ids.worker(),
    daemonId: ids.daemon(),
    clock: fakeClock(),
    maxEvents: o.maxEvents ?? 10_000,
    subscriberQueueSize: o.subscriberQueueSize ?? 1_024,
  });
}

const TURN = `t_${"0".repeat(25)}1` as TurnId;

const chunk = (text: string, turnId: TurnId | null = null): EventInput => ({
  kind: "acp.session_update",
  payloadVersion: 1,
  turnId,
  payload: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
});

const seqs = (envelopes: readonly EventEnvelope[]): Seq[] => envelopes.map((e) => e.seq);

/**
 * The only way a SYNCHRONOUS listener falls behind: it appends two events for every one it is
 * handed, so the queue grows by one per delivery and can never empty.
 *
 * `limit` is what keeps this a TEST rather than a hang. The bounded queue is exactly what stops
 * the loop, so a log that lost its bound would spin forever inside one synchronous append and
 * no test timeout could interrupt it — the suite would die of memory instead of reporting a
 * failure. With the limit, losing the bound is an ordinary red assertion below.
 */
function runaway(log: EventLog, seen: Seq[], limit = 200): (e: EventEnvelope) => void {
  return (e) => {
    seen.push(e.seq);
    if (log.head >= limit) return;
    log.append(chunk(`x${e.seq}`));
    log.append(chunk(`y${e.seq}`));
  };
}

// ── the suite M1's SQLite driver must pass verbatim ──────────────────────────
//
// Run twice: once with a ring far larger than the suite appends, and once with a ring small
// enough that eviction happens INSIDE it. Every assertion in the suite is written to hold
// either way, so the second run is what proves `tail` is honest rather than decorative.
runEventLogConformance("memory", () => makeLog());
runEventLogConformance("memory (ring evicts mid-suite, maxEvents=64)", () =>
  makeLog({ maxEvents: 64 }),
);

describe("memory event log: stamping", () => {
  it("stamps every field the producer may not stamp, and freezes the result", () => {
    const ids = seqIds();
    const workerId = ids.worker();
    const daemonId = ids.daemon();
    const clock = fakeClock();
    const log = createMemoryEventLog({
      workerId,
      daemonId,
      clock,
      maxEvents: 16,
      subscriberQueueSize: 8,
    });

    const e = log.append(chunk("hello", TURN));
    expect(e).toEqual({
      kind: "acp.session_update",
      payloadVersion: 1,
      turnId: TURN,
      payload: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } },
      seq: 1,
      ts: clock.iso(),
      daemonId,
      workerId,
      sessionId: null,
    });
    expect(Object.isFrozen(e)).toBe(true);
    expect(() => {
      (e as { seq: number }).seq = 99;
    }).toThrow(TypeError);
    expect(e.seq).toBe(1);
    log.close();
  });

  it("produces envelopes the wire schema accepts", () => {
    const log = makeLog();
    log.setSessionId("sess-1");
    const envelopes = [
      log.append(chunk("text", TURN)),
      log.append({
        kind: "omni.error",
        payloadVersion: 2,
        turnId: TURN,
        payload: { code: "agent_error", message: "boom", stderrTail: "trace" },
      }),
      log.append({
        kind: "omni.worker_state",
        payloadVersion: 2,
        payload: { state: "closed", previous: "running", reason: "agent_crashed" },
      }),
    ];
    for (const e of envelopes) expect(() => eventEnvelopeSchema.parse(e)).not.toThrow();
    log.close();
  });

  it("defaults an absent turnId to null rather than leaving the key out", () => {
    const log = makeLog();
    const e = log.append({
      kind: "acp.session_update",
      payloadVersion: 1,
      payload: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hm" } },
    });
    expect("turnId" in e).toBe(true);
    expect(e.turnId).toBeNull();
    log.close();
  });

  it("carries the replay marker through untouched", () => {
    const log = makeLog();
    const e = log.append({ ...chunk("replayed", TURN), replay: true });
    expect(e.replay).toBe(true);
    log.close();
  });

  it("takes ts from the injected clock, never from Date.now", () => {
    const clock = fakeClock(Date.UTC(2026, 0, 2, 3, 4, 5));
    const ids = seqIds();
    const log = createMemoryEventLog({
      workerId: ids.worker(),
      daemonId: ids.daemon(),
      clock,
      maxEvents: 8,
      subscriberQueueSize: 8,
    });
    expect(log.append(chunk("a")).ts).toBe("2026-01-02T03:04:05.000Z");
    clock.advance(1_500);
    expect(log.append(chunk("b")).ts).toBe("2026-01-02T03:04:06.500Z");
    log.close();
  });

  it("rejects a non-positive ring or queue size instead of silently clamping", () => {
    const ids = seqIds();
    const base = {
      workerId: ids.worker(),
      daemonId: ids.daemon(),
      clock: fakeClock(),
      maxEvents: 8,
      subscriberQueueSize: 8,
    };
    expect(() => createMemoryEventLog({ ...base, maxEvents: 0 })).toThrow(OmniError);
    expect(() => createMemoryEventLog({ ...base, maxEvents: 1.5 })).toThrow(/positive integer/);
    expect(() => createMemoryEventLog({ ...base, subscriberQueueSize: -1 })).toThrow(OmniError);
  });
});

describe("memory event log: the ring", () => {
  it("evicts from the tail, raises tail, and never reorders what is left", () => {
    const log = makeLog({ maxEvents: 8 });
    for (let i = 1; i <= 20; i++) log.append(chunk(`m${i}`));

    expect(log.head).toBe(20);
    expect(log.tail).toBe(13); // 20 - 8 + 1
    const retained = log.read(0);
    expect(seqs(retained)).toEqual([13, 14, 15, 16, 17, 18, 19, 20]);
    expect(retained.map((e) => (e.payload as { content: { text: string } }).content.text)).toEqual([
      "m13",
      "m14",
      "m15",
      "m16",
      "m17",
      "m18",
      "m19",
      "m20",
    ]);
    log.close();
  });

  it("tells a cursor below tail the truth: it is the caller's `since < log.tail` check", () => {
    const log = makeLog({ maxEvents: 4 });
    for (let i = 1; i <= 10; i++) log.append(chunk(`m${i}`));
    expect(log.tail).toBe(7);

    // WP-5's SSE writer emits `omni.stream_truncated{tail}` off exactly this comparison; the
    // log's job is to surface `tail` and then replay from it rather than pretend.
    const since = 2 as Seq;
    expect(since < log.tail).toBe(true);
    const seen: Seq[] = [];
    const sub = log.subscribe(since, (e) => seen.push(e.seq));
    expect(seen).toEqual([7, 8, 9, 10]);
    expect(log.read(since)[0]?.seq).toBe(log.tail);
    sub.close();
    log.close();
  });

  it("keeps head monotone and tail honest across an eviction of many rings", () => {
    const log = makeLog({ maxEvents: 3 });
    for (let i = 1; i <= 1_000; i++) {
      const e = log.append(chunk(`m${i}`));
      expect(e.seq).toBe(i);
      expect(log.tail).toBe(Math.max(1, i - 2));
      expect(log.read(0).length).toBe(Math.min(i, 3));
    }
    log.close();
  });

  it("honours read limits and treats a nonsense cursor as birth", () => {
    const log = makeLog();
    for (let i = 1; i <= 5; i++) log.append(chunk(`m${i}`));
    expect(seqs(log.read(0, 2))).toEqual([1, 2]);
    expect(seqs(log.read(2, 2))).toEqual([3, 4]);
    expect(seqs(log.read(0, 0))).toEqual([]);
    expect(seqs(log.read(-5))).toEqual([1, 2, 3, 4, 5]);
    expect(seqs(log.read(Number.NaN))).toEqual([1, 2, 3, 4, 5]);
    expect(seqs(log.read(2.7))).toEqual([3, 4, 5]);
    log.close();
  });
});

describe("memory event log: subscribers", () => {
  it("hands every subscriber the SAME frozen envelope object", () => {
    const log = makeLog();
    const a: EventEnvelope[] = [];
    const b: EventEnvelope[] = [];
    const subA = log.subscribe(0, (e) => a.push(e));
    const subB = log.subscribe(0, (e) => b.push(e));
    const appended = log.append(chunk("shared", TURN));
    expect(a[0]).toBe(appended);
    expect(b[0]).toBe(appended);
    subA.close();
    subB.close();
    log.close();
  });

  it("delivers appendAll in array order to a live subscriber", () => {
    const log = makeLog();
    const seen: Seq[] = [];
    const sub = log.subscribe(0, (e) => seen.push(e.seq));
    const out = log.appendAll([chunk("a"), chunk("b"), chunk("c")]);
    expect(seqs(out)).toEqual([1, 2, 3]);
    expect(seen).toEqual([1, 2, 3]);
    sub.close();
    log.close();
  });

  it("does not double-deliver to a subscriber created from inside a listener", () => {
    const log = makeLog();
    const outer: Seq[] = [];
    const inner: Seq[] = [];
    let nested: { close(): void } | null = null;
    const sub = log.subscribe(0, (e) => {
      outer.push(e.seq);
      nested ??= log.subscribe(0, (n) => inner.push(n.seq));
    });
    log.append(chunk("first"));
    log.append(chunk("second"));
    // The nested subscriber replayed [1] and then saw 2 live — exactly once each.
    expect(outer).toEqual([1, 2]);
    expect(inner).toEqual([1, 2]);
    sub.close();
    nested?.close();
    log.close();
  });

  it("does not double-deliver to a subscriber created from inside an overflow callback", () => {
    // The one place user code still runs while an envelope is being handed out: the overflow
    // notification. The replacement subscription replays the event that is mid-fan-out, so
    // without the attach cursor it would be handed the same envelope twice.
    const log = makeLog({ subscriberQueueSize: 4 });
    const replacement: Seq[] = [];
    let resubscribed: { close(): void } | null = null;
    const sub = log.subscribe(0, runaway(log, []), {
      onOverflow: (lastDelivered) => {
        resubscribed = log.subscribe(lastDelivered - 1, (e) => replacement.push(e.seq));
      },
    });

    log.append(chunk("start"));
    expect(sub.closed).toBe(true);
    expect(replacement).toEqual([...replacement].sort((a, b) => a - b));
    expect(new Set(replacement).size).toBe(replacement.length);
    resubscribed = resubscribed as { close(): void } | null;
    resubscribed?.close();
    log.close();
  });

  it("keeps every subscriber in seq order when one of them appends from its listener", () => {
    // The fan-out is two phases — enqueue to everyone, THEN deliver — because a listener that
    // appends re-enters the fan-out. With a one-phase loop, the second subscriber receives the
    // re-entrant event BEFORE the one being fanned out: two subscribers, two different
    // histories, and a `?since=` cursor that cannot recover.
    const log = makeLog();
    const first: Seq[] = [];
    const second: Seq[] = [];
    const subA = log.subscribe(0, (e) => {
      first.push(e.seq);
      if (e.seq === 1) log.append(chunk("from-inside"));
    });
    const subB = log.subscribe(0, (e) => second.push(e.seq));

    log.append(chunk("trigger"));
    log.append(chunk("after"));

    expect(first).toEqual([1, 2, 3]);
    expect(second).toEqual([1, 2, 3]);
    subA.close();
    subB.close();
    log.close();
  });

  it("terminates a subscriber that never drains, at subscriberQueueSize", () => {
    const log = makeLog({ subscriberQueueSize: 4 });
    const seen: Seq[] = [];
    const overflows: Seq[] = [];
    const sub = log.subscribe(0, runaway(log, seen), {
      onOverflow: (lastDelivered) => overflows.push(lastDelivered),
    });

    log.append(chunk("start"));

    expect(sub.closed).toBe(true);
    expect(log.subscriberCount).toBe(0);
    expect(overflows).toEqual([seen.at(-1)]);
    expect(seen.length).toBeGreaterThan(1);

    // The producer is intact: seq stayed gap-free through the whole runaway, and the closed
    // subscriber receives nothing further.
    const before = log.head;
    expect(seqs(log.read(0))).toEqual(Array.from({ length: before }, (_, i) => i + 1));
    const delivered = seen.length;
    log.append(chunk("after"));
    expect(log.head).toBe(before + 1);
    expect(seen.length).toBe(delivered);
    log.close();
  });

  it("leaves the producer's append latency unchanged when a subscriber has overflowed", () => {
    const N = 20_000;
    const time = (log: EventLog): number => {
      for (let i = 0; i < 2_000; i++) log.append(chunk("warmup")); // JIT, and fill the ring
      const started = performance.now();
      for (let i = 0; i < N; i++) log.append(chunk("m"));
      return performance.now() - started;
    };

    const quiet = makeLog({ maxEvents: 1_000 });
    const baseline = time(quiet);
    quiet.close();

    const noisy = makeLog({ maxEvents: 1_000, subscriberQueueSize: 4 });
    const seen: Seq[] = [];
    const sub = noisy.subscribe(0, runaway(noisy, seen));
    noisy.append(chunk("start"));
    expect(sub.closed).toBe(true);
    const deliveredBefore = seen.length;

    const after = time(noisy);
    noisy.close();

    // Two independent facts, neither of them eyeballed: the producer does ZERO subscriber work
    // after the overflow, and the wall clock agrees. The bound is loose on purpose — it is
    // sized to catch an O(n)-per-append regression (a shift-based ring, or a fan-out that walks
    // a queue it never drains), not to police a few hundred microseconds of scheduler noise.
    expect(seen.length).toBe(deliveredBefore);
    expect(after).toBeLessThan(baseline * 8 + 250 * slow);
  });

  it("honours a per-subscription queueSize override", () => {
    const log = makeLog({ subscriberQueueSize: 1_024 });
    const overflows: Seq[] = [];
    const sub = log.subscribe(0, runaway(log, []), {
      queueSize: 2,
      onOverflow: (last) => overflows.push(last),
    });
    log.append(chunk("start"));
    expect(sub.closed).toBe(true);
    expect(overflows).toHaveLength(1);
    log.close();
  });

  it("survives an overflow with no onOverflow callback", () => {
    const log = makeLog({ subscriberQueueSize: 2 });
    const sub = log.subscribe(0, runaway(log, []));
    expect(() => log.append(chunk("start"))).not.toThrow();
    expect(sub.closed).toBe(true);
    log.close();
  });

  it("stops delivering the moment a subscription closes itself mid-stream", () => {
    const log = makeLog();
    const seen: Seq[] = [];
    let handle: { close(): void } | null = null;
    handle = log.subscribe(0, (e) => {
      seen.push(e.seq);
      if (e.seq === 2) handle?.close();
    });
    log.appendAll([chunk("a"), chunk("b"), chunk("c")]);
    expect(seen).toEqual([1, 2]);
    expect(log.subscriberCount).toBe(0);
    log.close();
  });

  it("keeps the log appendable and readable after close()", () => {
    // `daemon.stop()` closes SSE readers BEFORE the workers; the worker's final
    // `omni.worker_state{closed}` must still land in the log that GET /turns/{id} folds over.
    const log = makeLog();
    const sub = log.subscribe(0, () => {});
    log.close();
    expect(sub.closed).toBe(true);
    const e = log.append({
      kind: "omni.worker_state",
      payloadVersion: 2,
      turnId: TURN,
      payload: { state: "closed", previous: "running", reason: "daemon_shutdown" },
    });
    expect(e.seq).toBe(1);
    expect(log.read(0)).toHaveLength(1);
  });

  it("counts subscribers and drops the count back to zero on abort", () => {
    const log = makeLog();
    const subs = [
      log.subscribe(0, () => {}),
      log.subscribe(0, () => {}),
      log.subscribe(0, () => {}),
    ];
    expect(log.subscriberCount).toBe(3);
    subs[0]?.close();
    subs[0]?.close(); // idempotent
    expect(log.subscriberCount).toBe(2);
    log.close();
    expect(log.subscriberCount).toBe(0);
  });
});

describe("memory event log: session id", () => {
  it("stamps from the call onward and never back-fills", () => {
    const log = makeLog();
    const before = log.append(chunk("pre"));
    log.setSessionId("sess-42");
    const after = log.append(chunk("post"));
    expect(before.sessionId).toBeNull();
    expect(after.sessionId).toBe("sess-42");
    expect(log.read(0).map((e) => e.sessionId)).toEqual([null, "sess-42"]);
    log.close();
  });
});
