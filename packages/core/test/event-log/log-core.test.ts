import { describe, expect, it } from "vitest";
import { createEventLogCore } from "@omni-acp/core";
import { fakeClock, nullLogger } from "@omni-acp/testkit";
import {
  OmniError,
  type EventEnvelope,
  type EventInput,
  type EventLog,
  type EventStore,
  type EventStoreDiagnostics,
  type Seq,
  type WorkerId,
} from "@omni-acp/protocol";

const DAEMON = `d_${"0".repeat(25)}7`;
const W = `w_${"0".repeat(25)}1` as WorkerId;

const chunk = (text: string): EventInput => ({
  kind: "acp.session_update",
  payloadVersion: 1,
  payload: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
});

const seqs = (e: readonly EventEnvelope[]): Seq[] => e.map((x) => x.seq);

/** An in-RAM `EventStore` — enough to exercise the write-through path without a database. */
function fakeStore(o: { failFrom?: number } = {}): EventStore & {
  rows: Map<WorkerId, EventEnvelope[]>;
  failures: number;
  failFrom: number;
} {
  const rows = new Map<WorkerId, EventEnvelope[]>();
  const heads = new Map<WorkerId, Seq>();
  const of = (id: WorkerId): EventEnvelope[] => {
    const existing = rows.get(id);
    if (existing !== undefined) return existing;
    const fresh: EventEnvelope[] = [];
    rows.set(id, fresh);
    return fresh;
  };
  const store = {
    rows,
    failures: 0,
    failFrom: o.failFrom ?? Number.POSITIVE_INFINITY,
    headOf: (id: WorkerId): Seq => heads.get(id) ?? 0,
    tailOf(id: WorkerId): Seq {
      const kept = of(id);
      return kept.length === 0 ? store.headOf(id) + 1 : (kept[0]?.seq ?? 1);
    },
    put(e: EventEnvelope): void {
      if (e.seq >= store.failFrom) {
        store.failures += 1;
        throw new Error("the disk says no");
      }
      of(e.workerId).push(e);
      heads.set(e.workerId, Math.max(heads.get(e.workerId) ?? 0, e.seq));
    },
    read(id: WorkerId, since: Seq, limit: number): readonly EventEnvelope[] {
      return of(id)
        .filter((e) => e.seq > since)
        .slice(0, limit);
    },
    evict(id: WorkerId, upTo: Seq): number {
      const kept = of(id);
      const before = kept.length;
      rows.set(
        id,
        kept.filter((e) => e.seq > upTo),
      );
      return before - (rows.get(id)?.length ?? 0);
    },
    seqAtOffset: (id: WorkerId, offset: number): Seq | null => of(id)[offset]?.seq ?? null,
    workersWithEvents: (): readonly WorkerId[] => [...rows.keys()],
    get diagnostics(): EventStoreDiagnostics {
      return {
        driver: "memory",
        file: null,
        schemaVersion: 0,
        sizeBytes: 0,
        writeFailures: store.failures,
      };
    },
  };
  return store;
}

const persistenceOf = (log: EventLog): string =>
  (log as EventLog & { persistence?: string }).persistence ?? "unknown";

describe("createEventLogCore — the ring, shared by both drivers (§14.1)", () => {
  it("reports memory when no store is behind it, and never touches disk", () => {
    const log = createEventLogCore({ workerId: W, daemonId: DAEMON, clock: fakeClock() });
    log.append(chunk("a"));
    expect(log.persistent).toBe(false);
    expect(persistenceOf(log)).toBe("memory");
    expect(() => {
      log.flush();
    }).not.toThrow();
    log.close();
  });

  it("seeds head from startSeq without breaking the ring's slot arithmetic", () => {
    // A rehydrated worker: `head` starts at 4 210 and the ring is empty. Indexing the ring by
    // `(seq - 1) % maxEvents` — correct only for a log that started at 1 — would put the first
    // envelope in one slot and look for it in another.
    const log = createEventLogCore({
      workerId: W,
      daemonId: DAEMON,
      clock: fakeClock(),
      maxEvents: 3,
      startSeq: 4_210,
    });
    expect(log.head).toBe(4_210);
    // Nothing retained, and here is where the next one will be — never 1.
    expect(log.tail).toBe(4_211);
    expect(log.read(0)).toEqual([]);

    const appended = [1, 2, 3, 4, 5].map((i) => log.append(chunk(`m${i}`)));
    expect(seqs(appended)).toEqual([4_211, 4_212, 4_213, 4_214, 4_215]);
    // The ring holds the newest three, and each is the object `append()` returned.
    expect(seqs(log.read(0))).toEqual([4_213, 4_214, 4_215]);
    expect(log.read(0)[0]).toBe(appended[2]);
    expect(log.tail).toBe(4_213);
    log.close();
  });

  it("writes through to the store BEFORE the ring and the fan-out", () => {
    const store = fakeStore();
    const order: string[] = [];
    const log = createEventLogCore({
      workerId: W,
      daemonId: DAEMON,
      clock: fakeClock(),
      store: {
        ...store,
        put(e: EventEnvelope): void {
          order.push(`put:${e.seq}`);
          store.put(e);
        },
        get diagnostics(): EventStoreDiagnostics {
          return store.diagnostics;
        },
      },
    });
    log.subscribe(0, (e) => order.push(`deliver:${e.seq}`));
    log.append(chunk("a"));
    // Durable first: it keeps the window in which a SIGKILL loses an envelope down to the insert
    // itself rather than the whole fan-out (§14.3).
    expect(order).toEqual(["put:1", "deliver:1"]);
    expect(log.persistent).toBe(true);
    expect(persistenceOf(log)).toBe("durable");
    log.close();
  });

  it("holds the degradation notice back until an appendAll batch is complete", () => {
    const store = fakeStore({ failFrom: 2 });
    const log = createEventLogCore({
      workerId: W,
      daemonId: DAEMON,
      clock: fakeClock(),
      store,
      logger: nullLogger(),
    });
    const out = log.appendAll([chunk("a"), chunk("b"), chunk("c")]);

    // `appendAll` is what makes a Normalizer step's `emit` array atomic with respect to seq
    // (§7.6), so the in-band `omni.error` lands AFTER the batch rather than inside it.
    expect(seqs(out)).toEqual([1, 2, 3]);
    expect(log.head).toBe(4);
    expect(log.read(0).map((e) => e.kind)).toEqual([
      "acp.session_update",
      "acp.session_update",
      "acp.session_update",
      "omni.error",
    ]);
    expect(persistenceOf(log)).toBe("degraded");
    log.close();
  });

  it("emits the degradation notice exactly ONCE, however many writes fail", () => {
    const store = fakeStore({ failFrom: 1 });
    const log = createEventLogCore({
      workerId: W,
      daemonId: DAEMON,
      clock: fakeClock(),
      store,
      logger: nullLogger(),
    });
    for (let i = 0; i < 10; i++) log.append(chunk(`m${i}`));
    expect(log.read(0).filter((e) => e.kind === "omni.error")).toHaveLength(1);
    // The notice itself could not be persisted either, and that must not recurse.
    expect(store.failures).toBe(11);
    expect(seqs(log.read(0))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    log.close();
  });

  it("serves a read that straddles the ring floor from both sources, once each", () => {
    const store = fakeStore();
    const log = createEventLogCore({
      workerId: W,
      daemonId: DAEMON,
      clock: fakeClock(),
      maxEvents: 4,
      store,
    });
    const appended: EventEnvelope[] = [];
    for (let i = 1; i <= 12; i++) appended.push(log.append(chunk(`m${i}`)));

    expect(log.tail).toBe(1);
    expect(seqs(log.read(0))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    // The cap between the two sources is what stops a seq appearing twice.
    expect(new Set(seqs(log.read(0))).size).toBe(12);
    // Identity above the floor, deserialized copies below it — and the fake store hands back the
    // SAME objects, so this asserts the boundary rather than the store's serialization.
    expect(log.read(0)[11]).toBe(appended[11]);
    expect(seqs(log.read(6, 3))).toEqual([7, 8, 9]);
    expect(seqs(log.read(0, 5))).toEqual([1, 2, 3, 4, 5]);
    log.close();
  });

  it("reports the honest tail when the store has been swept under it", () => {
    const store = fakeStore();
    const log = createEventLogCore({
      workerId: W,
      daemonId: DAEMON,
      clock: fakeClock(),
      maxEvents: 4,
      store,
    });
    for (let i = 1; i <= 12; i++) log.append(chunk(`m${i}`));

    store.evict(W, 6);
    // Disk keeps 7..12, the ring keeps 9..12: the honest tail is the furthest back either can
    // reach, which is the disk's.
    expect(log.tail).toBe(7);
    expect(seqs(log.read(0))).toEqual([7, 8, 9, 10, 11, 12]);

    store.evict(W, 12);
    // Nothing on disk at all: the ring is the only source left and `tail` says so.
    expect(log.tail).toBe(9);
    expect(seqs(log.read(0))).toEqual([9, 10, 11, 12]);
    log.close();
  });

  it("rejects a nonsense ring or cursor size loudly", () => {
    const bad = { workerId: W, daemonId: DAEMON, clock: fakeClock() };
    expect(() => createEventLogCore({ ...bad, maxEvents: 0 })).toThrow(OmniError);
    expect(() => createEventLogCore({ ...bad, queueSize: -1 })).toThrow(OmniError);
    expect(() => createEventLogCore({ ...bad, startSeq: -1 })).toThrow(OmniError);
    expect(() => createEventLogCore({ ...bad, startSeq: 1.5 })).toThrow(OmniError);
  });
});
