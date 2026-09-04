import { describe, expect, it } from "vitest";
import { planRetention, runRetention } from "@omni-acp/core";
import type {
  EventEnvelope,
  RetentionInput,
  RetentionPlan,
  WorkerId,
  WorkerRow,
  WorkerSnapshot,
} from "@omni-acp/protocol";
import { openTmpPersistence, workerId } from "./support/harness.js";
import { pragmaNumber, rawStore } from "./support/raw-db.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 1, 1);

type Row = RetentionInput["rows"][number];

const row = (o: Partial<Row> & { workerId: WorkerId }): Row => ({
  state: "closed",
  closedAtMs: null,
  head: 0,
  tail: 1,
  ...o,
});

const input = (rows: readonly Row[], o: Partial<RetentionInput> = {}): RetentionInput => ({
  nowMs: NOW,
  retentionDays: 7,
  maxPersistedEventsPerWorker: 200_000,
  rows,
  ...o,
});

/**
 * §14.5's three bounds are "constantly confused", so the table is the specification: one row per
 * case, naming which bound is supposed to fire and which is supposed to stay out of it.
 */
describe("planRetention — pure, table-tested (§14.5)", () => {
  const W = (n: number): WorkerId => workerId(n);

  const cases: {
    name: string;
    input: RetentionInput;
    expected: RetentionPlan;
  }[] = [
    {
      name: "an empty data dir plans nothing",
      input: input([]),
      expected: { dropWorkers: [], evictTo: [] },
    },
    {
      name: "a worker closed longer ago than retentionDays goes entirely",
      input: input([row({ workerId: W(1), closedAtMs: NOW - 8 * DAY, head: 10 })]),
      expected: { dropWorkers: [W(1)], evictTo: [] },
    },
    {
      name: "a worker closed EXACTLY at the boundary is kept — the bound is strict",
      input: input([row({ workerId: W(2), closedAtMs: NOW - 7 * DAY, head: 10 })]),
      expected: { dropWorkers: [], evictTo: [] },
    },
    {
      name: "a closed worker with no closedAtMs is never aged out",
      input: input([row({ workerId: W(3), closedAtMs: null, head: 10 })]),
      expected: { dropWorkers: [], evictTo: [] },
    },
    {
      name: "a LIVE worker is never aged out, however old it looks",
      input: input([row({ workerId: W(4), state: "running", closedAtMs: NOW - 90 * DAY })]),
      expected: { dropWorkers: [], evictTo: [] },
    },
    {
      name: "a HIBERNATED worker is never aged out — it can still wake, and its history is why",
      input: input([row({ workerId: W(5), state: "hibernated", closedAtMs: NOW - 90 * DAY })]),
      expected: { dropWorkers: [], evictTo: [] },
    },
    {
      name: "retentionDays 0 is OFF, not 'expire immediately'",
      input: input([row({ workerId: W(6), closedAtMs: 0, head: 10 })], { retentionDays: 0 }),
      expected: { dropWorkers: [], evictTo: [] },
    },
    {
      name: "the row cap trims a live worker down to exactly the cap",
      input: input([row({ workerId: W(7), state: "ready", head: 1_000, tail: 1 })], {
        maxPersistedEventsPerWorker: 100,
      }),
      expected: { dropWorkers: [], evictTo: [{ workerId: W(7), upTo: 900 }] },
    },
    {
      name: "the row cap is a no-op when the worker is already under it",
      input: input([row({ workerId: W(8), state: "ready", head: 50, tail: 1 })], {
        maxPersistedEventsPerWorker: 100,
      }),
      expected: { dropWorkers: [], evictTo: [] },
    },
    {
      name: "the row cap counts RETAINED rows, not the head — a raised tail already paid",
      input: input([row({ workerId: W(9), state: "ready", head: 1_000, tail: 901 })], {
        maxPersistedEventsPerWorker: 100,
      }),
      expected: { dropWorkers: [], evictTo: [] },
    },
    {
      name: "a worker whose rows are all gone (tail > head) is not evicted again",
      input: input([row({ workerId: W(10), state: "ready", head: 1_000, tail: 1_001 })], {
        maxPersistedEventsPerWorker: 1,
      }),
      expected: { dropWorkers: [], evictTo: [] },
    },
    {
      name: "maxPersistedEventsPerWorker 0 is unbounded",
      input: input([row({ workerId: W(11), state: "ready", head: 10_000_000, tail: 1 })], {
        maxPersistedEventsPerWorker: 0,
      }),
      expected: { dropWorkers: [], evictTo: [] },
    },
    {
      name: "age wins over the row cap: a dropped worker is not also evicted",
      input: input([row({ workerId: W(12), closedAtMs: NOW - 30 * DAY, head: 1_000, tail: 1 })], {
        maxPersistedEventsPerWorker: 10,
      }),
      expected: { dropWorkers: [W(12)], evictTo: [] },
    },
    {
      name: "both bounds fire across a mixed data dir, in row order",
      input: input(
        [
          row({ workerId: W(13), closedAtMs: NOW - 9 * DAY, head: 5 }),
          row({ workerId: W(14), state: "ready", head: 300, tail: 1 }),
          row({ workerId: W(15), state: "hibernated", head: 300, tail: 1 }),
        ],
        { maxPersistedEventsPerWorker: 100 },
      ),
      expected: {
        dropWorkers: [W(13)],
        evictTo: [
          { workerId: W(14), upTo: 200 },
          { workerId: W(15), upTo: 200 },
        ],
      },
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const frozen = JSON.stringify(c.input);
      expect(planRetention(c.input)).toEqual(c.expected);
      // PURE: no mutation of the input, and the same answer every time.
      expect(JSON.stringify(c.input)).toBe(frozen);
      expect(planRetention(c.input)).toEqual(c.expected);
    });
  }
});

describe("runRetention — the only half that touches I/O (§14.5)", () => {
  it("raises tail_seq in the SAME transaction as the DELETE", async () => {
    const raw = await rawStore();
    try {
      const w = workerId(20);
      for (let i = 1; i <= 20; i++) raw.events.put(envelope(w, i));
      raw.events.flush();
      expect(raw.events.tailOf(w)).toBe(1);

      // A trigger that aborts the DELETE. If the tail raise were a second statement outside the
      // transaction, it would survive this — and the log would report a tail above rows it still
      // has, which is a window in which `?since=` lies in the OTHER direction.
      raw.db.exec(
        "create trigger block_delete before delete on events begin select raise(abort, 'blocked'); end",
      );
      expect(() => raw.events.evict(w, 10)).toThrow(/retention failed/);
      raw.db.exec("drop trigger block_delete");

      // Neither half landed: the rows are all there and the durable tail never moved.
      const persisted = raw.db
        .prepare("select head_seq, tail_seq from event_state where worker_id = ?")
        .get(w);
      expect(Number(persisted?.["tail_seq"])).toBe(1);
      expect(raw.events.read(w, 0, 100)).toHaveLength(20);

      // And with the trigger gone, both halves land together.
      expect(raw.events.evict(w, 10)).toBe(10);
      expect(raw.events.tailOf(w)).toBe(11);
      expect(
        Number(
          raw.db.prepare("select tail_seq from event_state where worker_id = ?").get(w)?.[
            "tail_seq"
          ],
        ),
      ).toBe(11);
      expect(raw.events.headOf(w)).toBe(20);
    } finally {
      await raw.dispose();
    }
  });

  it("drops the worker ROW as well as its events when the age bound fires", async () => {
    const opened = await openTmpPersistence({ retentionDays: 7 });
    try {
      const alive = workerId(21);
      const stale = workerId(22);
      opened.handle.workers.upsert(workerRow(alive, "ready", null));
      opened.handle.workers.upsert(workerRow(stale, "closed", NOW - 30 * DAY));
      for (const w of [alive, stale]) {
        for (let i = 1; i <= 5; i++) opened.handle.events.put(envelope(w, i));
      }

      const report = opened.handle.sweep(NOW);

      expect(report.workersDropped).toBe(1);
      expect(report.byAge).toBe(5);
      expect(report.byRowCap).toBe(0);
      expect(report.eventsDeleted).toBe(5);
      expect(report.durationMs).toBeGreaterThanOrEqual(0);

      // `GET /v1/workers/{wid}` after 7 days is a clean 404, not a snapshot pointing at an empty
      // log (§14.5).
      expect(opened.handle.workers.get(stale)).toBeNull();
      expect(opened.handle.events.read(stale, 0, 100)).toEqual([]);
      // …and the head SURVIVES the drop, so a re-created worker id cannot restart at seq 1.
      expect(opened.handle.events.headOf(stale)).toBe(5);
      expect(opened.handle.events.tailOf(stale)).toBe(6);

      expect(opened.handle.workers.get(alive)).not.toBeNull();
      expect(opened.handle.events.read(alive, 0, 100)).toHaveLength(5);
    } finally {
      await opened.dispose();
    }
  });

  it("applies the row cap without ever aging out a live or hibernated worker", async () => {
    const opened = await openTmpPersistence({ retentionDays: 7, maxPersistedEventsPerWorker: 10 });
    try {
      const live = workerId(23);
      const sleeping = workerId(24);
      opened.handle.workers.upsert(workerRow(live, "running", null));
      opened.handle.workers.upsert(workerRow(sleeping, "hibernated", NOW - 400 * DAY));
      for (const w of [live, sleeping]) {
        for (let i = 1; i <= 30; i++) opened.handle.events.put(envelope(w, i));
      }

      const report = opened.handle.sweep(NOW);
      expect(report.workersDropped).toBe(0);
      expect(report.byAge).toBe(0);
      expect(report.byRowCap).toBe(40);

      for (const w of [live, sleeping]) {
        expect(opened.handle.workers.get(w)).not.toBeNull();
        expect(opened.handle.events.tailOf(w)).toBe(21);
        expect(opened.handle.events.headOf(w)).toBe(30);
        expect(opened.handle.events.read(w, 0, 100)).toHaveLength(10);
      }

      // A second sweep with nothing left to do is a no-op, not a repeated eviction.
      expect(opened.handle.sweep(NOW).eventsDeleted).toBe(0);
    } finally {
      await opened.dispose();
    }
  });

  it("returns the freelist to zero after the sweep's incremental_vacuum", async () => {
    const opened = await openTmpPersistence({ maxPersistedEventsPerWorker: 50 });
    try {
      const w = workerId(25);
      opened.handle.workers.upsert(workerRow(w, "ready", null));
      // Enough bytes that the DELETE actually frees pages: 2 000 rows of ~1 KB.
      for (let i = 1; i <= 2_000; i++) opened.handle.events.put(envelope(w, i, "x".repeat(900)));

      const report = opened.handle.sweep(NOW);
      expect(report.byRowCap).toBe(1_950);

      // A second connection, because `openPersistence` keeps its own. WAL lets a reader in while
      // the writer holds the file, which is the whole reason WAL is not optional (§14.2).
      const raw = await rawStore({ file: opened.handle.events.diagnostics.file ?? ":memory:" });
      try {
        // `pragma incremental_vacuum` inside the sweep is what actually hands pages back to the
        // OS; without `auto_vacuum = INCREMENTAL` set before the first table, it is a silent
        // no-op and the file only ever grows.
        expect(pragmaNumber(raw.db, "auto_vacuum")).toBe(2);
        expect(pragmaNumber(raw.db, "freelist_count")).toBe(0);
      } finally {
        await raw.dispose();
      }
    } finally {
      await opened.dispose();
    }
  }, 30_000);

  it("plans and applies nothing for a data dir that has only live workers", async () => {
    const opened = await openTmpPersistence();
    try {
      const w = workerId(26);
      opened.handle.workers.upsert(workerRow(w, "ready", null));
      for (let i = 1; i <= 5; i++) opened.handle.events.put(envelope(w, i));
      const plan = planRetention({
        nowMs: NOW,
        retentionDays: 7,
        maxPersistedEventsPerWorker: 200_000,
        rows: [{ workerId: w, state: "ready", closedAtMs: null, head: 5, tail: 1 }],
      });
      expect(plan).toEqual({ dropWorkers: [], evictTo: [] });
      expect(runRetention(opened.handle, plan)).toMatchObject({
        workersDropped: 0,
        eventsDeleted: 0,
        byAge: 0,
        byRowCap: 0,
      });
      expect(opened.handle.events.read(w, 0, 100)).toHaveLength(5);
    } finally {
      await opened.dispose();
    }
  });
});

function envelope(w: WorkerId, n: number, text = "hello"): EventEnvelope {
  // `seq: n` is a COPY of a number this test chose for the store, which is `EventStore.put`'s
  // whole contract: "nothing here assigns a seq — the store is TOLD what it is" (§5.1).
  return Object.freeze({
    seq: n,
    ts: new Date(NOW).toISOString(),
    daemonId: `d_${"0".repeat(25)}7`,
    workerId: w,
    sessionId: null,
    turnId: null,
    payloadVersion: 1,
    kind: "acp.session_update",
    payload: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
  }) as unknown as EventEnvelope;
}

function workerRow(
  w: WorkerId,
  state: WorkerSnapshot["state"],
  closedAtMs: number | null,
): WorkerRow {
  const snapshot = {
    workerId: w,
    daemonId: `d_${"0".repeat(25)}7`,
    ref: `d_${"0".repeat(25)}7/${w}`,
    sessionId: null,
    agentId: "test-agent",
    state,
    cwd: "/tmp/omni",
    label: null,
    ownerTokenId: "tok_test",
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    headSeq: 0,
    currentTurnId: null,
    capabilities: null,
    process: null,
    closeReason: state === "closed" ? "client_request" : null,
    lease: {
      workerId: w,
      holder: null,
      epoch: 0,
      expiresAt: null,
      acquiredAt: null,
      pinned: false,
    },
    hibernatedAt: state === "hibernated" ? new Date(NOW).toISOString() : null,
    crashed: false,
    resume: null,
    wakeCount: 0,
    wakeFailures: 0,
    orphan: null,
    generation: 1,
    runtimeId: "test-agent@unresolved",
    persistence: "durable",
  } as unknown as WorkerSnapshot;

  return {
    snapshot,
    agentId: "test-agent",
    bootId: "boot_test",
    closeResult: null,
    lastActiveMs: NOW,
    closedAtMs,
    hibernateIdleMs: null,
  };
}
