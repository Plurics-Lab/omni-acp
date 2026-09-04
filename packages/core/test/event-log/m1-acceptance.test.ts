import { readFileSync, readdirSync } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BUILTIN_RUNTIMES,
  DEFAULT_V1_PROFILE,
  createMemoryEventLog,
  createPersistedEventLog,
  openPersistence,
  planRetention,
} from "@omni-acp/core";
import {
  fakeClock,
  nullLogger,
  runEventLogConformance,
  runEventLogPersistenceConformance,
} from "@omni-acp/testkit";
import {
  OmniError,
  type EventEnvelope,
  type EventInput,
  type EventLog,
  type EventStore,
  type EventStoreDiagnostics,
  type NormalizedSessionUpdate,
  type Seq,
  type UpdateRule,
  type WorkerId,
} from "@omni-acp/protocol";
import {
  DAEMON_ID,
  makeTmpPersistence,
  openTmpPersistence,
  payloadCountOf,
  sqliteConfig,
  workerId,
  type OpenedPersistence,
} from "../persist/support/harness.js";
import { runInFreshNode, sqliteWarnings } from "../persist/support/child.js";

const chunk = (text: string): EventInput => ({
  kind: "acp.session_update",
  payloadVersion: 1,
  payload: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
});

const seqs = (envelopes: readonly EventEnvelope[]): Seq[] => envelopes.map((e) => e.seq);

/**
 * M1-WP-A's acceptance bullets, one `it` each (M1-PLAN §2, WP-A).
 *
 * Landed as todos by the Land step so the obligations were visible in the tree that owns them
 * from the first commit — the same discipline M0-PLAN §1 used, and the reason six parallel
 * packages worked the first time. This file is where each one became a real test; the depth
 * behind several of them lives in `test/persist/**`, which this file names as it goes.
 */
describe("M1-WP-A — event-log persistence, retention, restart-survivable ?since=", () => {
  // ── 1 ──────────────────────────────────────────────────────────────────────
  //
  // "runEventLogConformance passes for memory, sqlite(:memory:) and sqlite(file) — M0's suite
  // VERBATIM and UNEDITED, object-identity assertion included (F11). That is what proves the
  // ring stayed."
  //
  // The three invocations are at the bottom of this file: `runEventLogConformance` registers its
  // own `describe`, so it cannot be nested inside an `it`.

  // ── 3 ──────────────────────────────────────────────────────────────────────
  it("item 3 FAILS on a planted head = max(seq) — the §14.4 bug, demonstrated red", async () => {
    const t = await makeTmpPersistence();
    try {
      const fixed = workerId(901);
      const planted = workerId(902);

      for (const w of [fixed, planted]) {
        const log = t.log({ workerId: w });
        for (let i = 0; i < 50; i++) log.append(chunk(`m${i}`));
        log.close();
        // Retention takes every row while the worker itself is still inside the 7-day window —
        // the exact state §14.4 is written about.
        expect(t.handle.events.evict(w, t.handle.events.headOf(w))).toBe(50);
      }
      await t.reopen();

      // The shipped restore: `max(durable head_seq, max(seq))`.
      expect(t.log({ workerId: fixed }).append(chunk("after")).seq).toBe(51);

      // The bug, planted: a store whose `headOf` is `max(seq) CURRENTLY PRESENT`, which is what
      // the naive `SELECT max(seq) FROM events WHERE worker_id = ?` computes.
      const store = t.handle.events;
      const naive: EventStore = {
        ...store,
        headOf(id: WorkerId): Seq {
          const rows = store.read(id, 0, 1_000_000);
          return rows.length === 0 ? 0 : (rows.at(-1)?.seq ?? 0);
        },
        get diagnostics(): EventStoreDiagnostics {
          return store.diagnostics;
        },
      };
      const broken = createPersistedEventLog({
        workerId: planted,
        daemonId: DAEMON_ID,
        clock: fakeClock(),
        store: naive,
        config: sqliteConfig(),
      });

      // …and it restarts the worker's own sequence at 1.
      expect(broken.head).toBe(0);
      expect(broken.append(chunk("after")).seq).toBe(1);
      // Which is the whole bug: every client holding `?since=30` is told there is nothing new,
      // forever, while the log quietly re-issues seqs it already delivered — and §8.2 rule 2
      // ("seq 1 is always worker_state{starting}") becomes a lie inside one worker's own log.
      expect(broken.append(chunk("and again")).seq).toBe(2);
      expect(seqs(broken.read(0))).toEqual([1, 2]);
    } finally {
      await t.dispose();
    }
  }, 30_000);

  // ── 4 ──────────────────────────────────────────────────────────────────────
  describe('driver:"memory" never loads node:sqlite', () => {
    it("emits ZERO ExperimentalWarnings across a full worker-lifecycle log cycle", async () => {
      // A FRESH process: `node:sqlite`'s warning fires once per process at first import, so an
      // in-process assertion would pass for the wrong reason on any file that ran after a
      // SQLite test.
      const run = await runInFreshNode(`
        const ids = { d: "d_${"0".repeat(25)}1", w: "w_${"0".repeat(25)}1", t: "t_${"0".repeat(25)}1" };
        const clock = { now: () => Date.now(), iso: () => new Date().toISOString(),
                        setTimer: (ms, fn) => ({ cancel() {} }) };
        const log = core.createMemoryEventLog({
          workerId: ids.w, daemonId: ids.d, clock, maxEvents: 1000, subscriberQueueSize: 64,
        });
        const seen = [];
        const sub = log.subscribe(0, (e) => seen.push(e.seq));
        // The whole of a worker's life, as the log sees it: birth, handshake, a turn's updates,
        // idle, close.
        log.append({ kind: "omni.worker_state", payloadVersion: 2,
                     payload: { state: "starting", previous: null, reason: "created" } });
        log.setSessionId("sess-child");
        log.append({ kind: "omni.worker_state", payloadVersion: 2,
                     payload: { state: "ready", previous: "starting", reason: "handshake_ok" } });
        for (let i = 0; i < 200; i++) {
          log.appendAll([{ kind: "acp.session_update", payloadVersion: 1, turnId: ids.t,
                           payload: { sessionUpdate: "agent_message_chunk",
                                      content: { type: "text", text: "chunk " + i } } }]);
        }
        log.append({ kind: "omni.worker_state", payloadVersion: 2,
                     payload: { state: "closed", previous: "ready", reason: "client_request" } });
        const replay = log.read(0);
        log.flush();
        sub.close();
        log.close();
        return { head: log.head, tail: log.tail, replay: replay.length, delivered: seen.length,
                 persistent: log.persistent };
      `);

      expect(run.result).toMatchObject({
        head: 203,
        tail: 1,
        replay: 203,
        delivered: 203,
        persistent: false,
      });
      // Zero SQLite warnings and zero experimental warnings of ANY kind: an embedder running
      // `OmniACP.local()` inside their own script is not asked to explain our import noise.
      expect(sqliteWarnings(run)).toEqual([]);
      expect(run.warnings).toEqual([]);
    }, 60_000);

    it("emits ZERO ExperimentalWarnings when the sqlite driver IS selected", async () => {
      const run = await runInFreshNode(`
        const clock = { now: () => Date.now(), iso: () => new Date().toISOString(),
                        setTimer: () => ({ cancel() {} }) };
        const logger = { child: () => logger, debug(){}, info(){}, warn(){}, error(){} };
        // An UNRELATED ExperimentalWarning, emitted throughout the window the interposer is
        // installed: a blanket --no-warnings would have eaten these too, which is exactly why
        // §14.2 forbids it.
        const beat = setInterval(() => process.emitWarning("a totally unrelated experiment",
                                                          "ExperimentalWarning"), 1);
        const handle = await core.openPersistence({
          dataDir: ctx.dir,
          config: { driver: "sqlite", maxEventsPerWorker: 1000, maxPersistedEventsPerWorker: 0,
                    retentionDays: 7, retentionSweepMs: 3600000, synchronous: "normal",
                    suppressExperimentalWarning: true, subscriberQueueSize: 64,
                    sseHeartbeatMs: 15000 },
          clock, logger,
        });
        const log = core.createPersistedEventLog({
          workerId: "w_${"0".repeat(25)}2", daemonId: "d_${"0".repeat(25)}1", clock,
          store: handle.events,
          config: { driver: "sqlite", maxEventsPerWorker: 1000, maxPersistedEventsPerWorker: 0,
                    retentionDays: 7, retentionSweepMs: 3600000, synchronous: "normal",
                    suppressExperimentalWarning: true, subscriberQueueSize: 64,
                    sseHeartbeatMs: 15000 },
        });
        log.append({ kind: "omni.error", payloadVersion: 2,
                     payload: { code: "internal", message: "hello from the child" } });
        log.flush();
        clearInterval(beat);
        const out = { head: log.head, persistent: log.persistent,
                      driver: handle.events.diagnostics.driver };
        handle.close();
        return out;
      `);

      expect(run.result).toMatchObject({ head: 1, persistent: true, driver: "sqlite" });
      // Direction 1: ours is gone.
      expect(sqliteWarnings(run)).toEqual([]);
      // Direction 2: everyone else's still gets out. A suppression that swallowed these would
      // be `--no-warnings` with extra steps.
      expect(
        run.warnings.filter(
          (w) => w.name === "ExperimentalWarning" && w.message.includes("unrelated experiment"),
        ).length,
      ).toBeGreaterThan(0);
    }, 60_000);
  });

  // ── 5 ──────────────────────────────────────────────────────────────────────
  it("degrades on a put that throws: no throw out, gap-free seq, subscribers served", async () => {
    const opened = await openTmpPersistence();
    try {
      const w = workerId(903);
      const real = opened.handle.events;
      let failures = 0;
      let failFrom = Number.POSITIVE_INFINITY;

      const flaky: EventStore = {
        ...real,
        put(e: EventEnvelope): void {
          if (e.seq >= failFrom) {
            failures += 1;
            throw new Error("ENOSPC: no space left on device");
          }
          real.put(e);
        },
        get diagnostics(): EventStoreDiagnostics {
          return { ...real.diagnostics, writeFailures: real.diagnostics.writeFailures + failures };
        },
      };

      const log = createPersistedEventLog({
        workerId: w,
        daemonId: DAEMON_ID,
        clock: opened.clock,
        store: flaky,
        config: sqliteConfig(),
      });
      const seen: Seq[] = [];
      const sub = log.subscribe(0, (e) => seen.push(e.seq));

      for (let i = 0; i < 5; i++) log.append(chunk(`durable ${i}`));
      expect(persistenceOf(log)).toBe("durable");

      failFrom = 6;
      // The append must RETURN an envelope, not throw: `Worker.#feed` catches and drops, so a
      // throw here would turn a disk-full into events that silently stop existing (§14.3).
      let failed: EventEnvelope | null = null;
      expect(() => {
        failed = log.append(chunk("the disk says no"));
      }).not.toThrow();
      expect(failed).not.toBeNull();
      expect((failed as unknown as EventEnvelope).seq).toBe(6);

      expect(persistenceOf(log)).toBe("degraded");
      expect(flaky.diagnostics.writeFailures).toBeGreaterThan(0);

      for (let i = 0; i < 4; i++) log.append(chunk(`after ${i}`));

      // Still correct in RAM, and still gap-free: the `seq` is NOT rolled back on failure,
      // because a rollback would leave the ring and the disk holding different envelopes at the
      // same seq — the one corruption `?since=` cannot recover from.
      const all = log.read(0);
      expect(seqs(all)).toEqual(all.map((_, i) => i + 1));
      expect(seen).toEqual(seqs(all));

      // Exactly ONE in-band `omni.error`, so every subscriber agrees that it happened and none
      // of them has to guess why a restart will come back short.
      expect(all.filter((e) => e.kind === "omni.error")).toHaveLength(1);
      // Sticky: a later success does not clear it, because the gap is already on disk.
      failFrom = Number.POSITIVE_INFINITY;
      log.append(chunk("the disk is back"));
      expect(persistenceOf(log)).toBe("degraded");
      expect(log.read(0).filter((e) => e.kind === "omni.error")).toHaveLength(1);

      sub.close();
      log.close();
    } finally {
      await opened.dispose();
    }
  });

  // ── 6 ──────────────────────────────────────────────────────────────────────
  //
  // The table test for the pure `planRetention` and the transactional proof for `runRetention`
  // live in `test/persist/retention.test.ts`. Here is the bullet's own summary assertion: the
  // two bounds fire, and neither of them ever touches a live or hibernated worker.
  it("plans retention purely, and never ages out a live or hibernated worker", () => {
    const now = Date.UTC(2026, 0, 30);
    const day = 86_400_000;
    const input = {
      nowMs: now,
      retentionDays: 7,
      maxPersistedEventsPerWorker: 100,
      rows: [
        {
          workerId: workerId(1),
          state: "closed" as const,
          closedAtMs: now - 8 * day,
          head: 10,
          tail: 1,
        },
        {
          workerId: workerId(2),
          state: "closed" as const,
          closedAtMs: now - 1 * day,
          head: 500,
          tail: 1,
        },
        { workerId: workerId(3), state: "ready" as const, closedAtMs: null, head: 500, tail: 1 },
        {
          workerId: workerId(4),
          state: "hibernated" as const,
          closedAtMs: now - 90 * day,
          head: 4,
          tail: 1,
        },
        { workerId: workerId(5), state: "running" as const, closedAtMs: null, head: 40, tail: 1 },
      ],
    };
    const before = JSON.stringify(input);
    const plan = planRetention(input);

    expect(plan.dropWorkers).toEqual([workerId(1)]);
    // A hibernated worker is never aged out no matter how old its `closedAtMs` looks: it can
    // still wake, and its history is the reason to (§14.5).
    expect(plan.dropWorkers).not.toContain(workerId(4));
    expect(plan.evictTo).toEqual([
      { workerId: workerId(2), upTo: 400 },
      { workerId: workerId(3), upTo: 400 },
    ]);
    // PURE: no I/O, no mutation of its input, and the same answer twice.
    expect(JSON.stringify(input)).toBe(before);
    expect(planRetention(input)).toEqual(plan);
  });

  // ── 7 ──────────────────────────────────────────────────────────────────────
  it("cuts the corpus's 23 available_commands_update appends to 2 stored payloads", async () => {
    const updates = corpusAvailableCommands();
    // F13, re-derived from the recorded bytes rather than recalled: 23 notifications, 2 distinct
    // payloads, the largest line 12.7 KB.
    expect(updates).toHaveLength(23);
    expect(new Set(updates.map((u) => JSON.stringify(u))).size).toBe(2);
    expect(Math.max(...updates.map((u) => JSON.stringify(u).length))).toBeGreaterThan(12_000);

    const opened = await openTmpPersistence();
    try {
      const w = workerId(904);
      const log = createPersistedEventLog({
        workerId: w,
        daemonId: DAEMON_ID,
        clock: opened.clock,
        store: opened.handle.events,
        config: sqliteConfig(),
      });
      const appended = updates.map((payload) =>
        log.append({
          kind: "acp.session_update",
          payloadVersion: 1,
          payload: payload as NormalizedSessionUpdate,
        }),
      );

      // Stream in full, store by content digest (ruling M1-R3): 23 envelopes and 23 seqs, 2
      // payload rows. Envelope count, ordering and `seq` are untouched — the optimisation is
      // invisible to every reader, which is the only reason it is safe to have.
      expect(payloadCountOf(opened.handle.events)).toBe(2);
      expect(log.head).toBe(23);

      // Byte-identical off DISK, where the ring is not there to answer for it.
      const fromDisk = opened.handle.events.read(w, 0, 100);
      expect(fromDisk.map((e) => JSON.stringify(e.payload))).toEqual(
        appended.map((e) => JSON.stringify(e.payload)),
      );
      log.close();
    } finally {
      await opened.dispose();
    }
  });

  it("carries no UpdateRule in the forbidden stream:false, store:true shape", () => {
    // `resolveDescriptor` is M1-WP-E's file and is where the REJECTION lives (§14.6). What is
    // WP-A's to assert is that the shape is absent from every descriptor this milestone ships,
    // so the digest side table is never asked to hold an envelope withheld from the live tail —
    // which would make `?since=N` deliver a gap the client cannot distinguish from loss, and
    // would make two subscribers who reconnect at different times disagree about the log.
    const forbidden = (updates: Readonly<Record<string, UpdateRule>>): string[] =>
      Object.entries(updates)
        .filter(([, r]) => r.stream === false && r.store === true)
        .map(([kind]) => kind);

    const descriptors = [DEFAULT_V1_PROFILE, ...BUILTIN_RUNTIMES.map((b) => b.descriptor)];
    expect(descriptors.length).toBeGreaterThan(0);
    for (const d of descriptors) expect(forbidden(d.updates), d.id).toEqual([]);

    // …and the scan is not vacuous just because the shipped descriptors are clean today: a
    // planted rule is caught, and the two legal shapes are not.
    expect(
      forbidden({
        keep: { map: null, stream: true, store: true, digest: true },
        drop: { map: null, stream: false, store: false, digest: false },
        planted: { map: null, stream: false, store: true, digest: false },
      }),
    ).toEqual(["planted"]);
  });

  // ── 8 ──────────────────────────────────────────────────────────────────────
  it("answers identically to an unbounded memory log across the ring/disk boundary", async () => {
    // The differential oracle for §14.3's two-source merge: with the ring deliberately sized to
    // 3, a persisted log must return exactly what a log that never evicted would.
    const opened = await openTmpPersistence();
    try {
      const oracle = createMemoryEventLog({
        workerId: workerId(905),
        daemonId: DAEMON_ID,
        clock: opened.clock,
        maxEvents: 10_000,
        subscriberQueueSize: 64,
      });
      const log = createPersistedEventLog({
        workerId: workerId(906),
        daemonId: DAEMON_ID,
        clock: opened.clock,
        store: opened.handle.events,
        config: sqliteConfig(),
        maxEvents: 3,
      });

      for (let i = 0; i < 40; i++) {
        const input = chunk(`m${i}`);
        oracle.append(input);
        log.append(input);
      }

      expect(log.tail).toBe(oracle.tail);
      expect(log.head).toBe(oracle.head);
      for (const since of [0, 1, 2, 36, 37, 40, 99]) {
        for (const limit of [undefined, 1, 5, 100]) {
          expect(seqs(log.read(since, limit)), `since=${since} limit=${String(limit)}`).toEqual(
            seqs(oracle.read(since, limit)),
          );
        }
      }
      log.close();
      oracle.close();
    } finally {
      await opened.dispose();
    }
  });

  // ── 9 ──────────────────────────────────────────────────────────────────────
  //
  // The lock's three behaviours are proved in `test/persist/lock.test.ts` (refuse a live holder
  // naming its pid, break a stale one, and never touch a memory-driver data dir). Here is the
  // bullet's own end-to-end fact: an `openPersistence` over a file WRITES one, and an open with
  // no file at all does not.
  it("takes a data-dir lock for a file database and none for :memory:", async () => {
    const onDisk = await openTmpPersistence();
    const inMemory = await openTmpPersistence({}, { file: ":memory:" });
    try {
      await expect(access(join(onDisk.dir, "daemon.lock"))).resolves.toBeUndefined();
      await expect(access(join(inMemory.dir, "daemon.lock"))).rejects.toThrow();
      expect(inMemory.handle.events.diagnostics.file).toBeNull();
      expect(onDisk.handle.events.diagnostics.file).toBe(join(onDisk.dir, "events.db"));
    } finally {
      await onDisk.dispose();
      await inMemory.dispose();
    }
  });

  it("refuses the memory driver outright, so there is no path to a lock or an import", async () => {
    await expect(
      openPersistence({
        dataDir: join(dirname(fileURLToPath(import.meta.url)), "never-created"),
        config: sqliteConfig({ driver: "memory" }),
        clock: fakeClock(),
        logger: nullLogger(),
      }),
    ).rejects.toThrow(OmniError);
  });

  // ── the milestone's own headline ───────────────────────────────────────────
  //
  // "reconnect loses no events" (M1-PLAN §preamble), across a process boundary rather than a
  // reconnect: the SAME `?since=N` returns the same envelopes with the same seqs after the data
  // dir has been closed and reopened, and the live tail continues from there.
  it("returns the same ?since= window, with the same seqs, after reopening the data dir", async () => {
    const t = await makeTmpPersistence();
    try {
      const w = workerId(908);
      const before = t.log({ workerId: w });
      const appended: EventEnvelope[] = [];
      for (let i = 1; i <= 100; i++) appended.push(before.append(chunk(`m${i}`)));

      // What a live SSE reader at `?since=40` saw.
      const live: Seq[] = [];
      const sub = before.subscribe(40, (e) => live.push(e.seq));
      expect(live).toEqual(seqs(appended.slice(40)));
      sub.close();
      before.close();

      await t.reopen();
      const after = t.log({ workerId: w });

      // A client that reconnects with the cursor it held gets exactly the rest of its history…
      const replayed: Seq[] = [];
      const resumed = after.subscribe(40, (e) => replayed.push(e.seq));
      expect(replayed).toEqual(live);
      expect(seqs(after.read(40))).toEqual(live);
      expect(after.read(40).map((e) => JSON.stringify(e.payload))).toEqual(
        appended.slice(40).map((e) => JSON.stringify(e.payload)),
      );

      // …and then the live tail, continuing the sequence rather than restarting it.
      const next = after.append(chunk("after the restart"));
      expect(next.seq).toBe(101);
      expect(replayed.at(-1)).toBe(101);
      // A cursor from BEFORE the restart that is already past the head is skew, not an error.
      expect(after.read(500)).toEqual([]);
      resumed.close();
      after.close();
    } finally {
      await t.dispose();
    }
  });

  // ── 10 ─────────────────────────────────────────────────────────────────────
  it("holds a per-put latency budget over 5 000 store writes", async () => {
    const opened = await openTmpPersistence();
    try {
      const w = workerId(907);
      const log = createPersistedEventLog({
        workerId: w,
        daemonId: DAEMON_ID,
        clock: opened.clock,
        store: opened.handle.events,
        config: sqliteConfig(),
      });
      const started = performance.now();
      for (let i = 0; i < 5_000; i++) log.append(chunk(`m${i}`));
      const perAppend = (performance.now() - started) / 5_000;

      // F12 measured 1 000 prepared single-row inserts at 2.5 ms. The budget is ~90x that, which
      // is loose enough to survive shared CI hardware and tight enough to catch the two
      // regressions it exists for: a `db.prepare()` that slipped inside the loop, and a Windows
      // fsync that turned WAL + NORMAL into a per-append disk flush.
      expect(perAppend).toBeLessThan(1 * SLOW);
      expect(log.head).toBe(5_000);
      expect(opened.handle.events.headOf(w)).toBe(5_000);
      log.close();
    } finally {
      await opened.dispose();
    }
  }, 60_000);
});

// ── 1 ────────────────────────────────────────────────────────────────────────
//
// M0's suite, VERBATIM and UNEDITED, against all three drivers. The object-identity assertion
// (`expect(replayed).toBe(e)`) is the one that proves the ring stayed in front of the store: a
// pure-SQLite `read()` deserialises and returns a different object (F11, §14.1).

let onDisk: OpenedPersistence;
let inMemory: OpenedPersistence;
let nth = 0;

beforeAll(async () => {
  onDisk = await openTmpPersistence();
  inMemory = await openTmpPersistence({}, { file: ":memory:" });
});

afterAll(async () => {
  await onDisk?.dispose();
  await inMemory?.dispose();
});

/** A FRESH, empty log each time — a worker id no envelope has ever been written under. */
const overStore = (which: () => OpenedPersistence) => (): EventLog =>
  createPersistedEventLog({
    workerId: workerId(1_000 + ++nth),
    daemonId: DAEMON_ID,
    clock: which().clock,
    store: which().handle.events,
    config: sqliteConfig(),
  });

runEventLogConformance("memory", () =>
  createMemoryEventLog({
    workerId: workerId(2_000 + ++nth),
    daemonId: DAEMON_ID,
    clock: fakeClock(),
    maxEvents: 10_000,
    subscriberQueueSize: 1_024,
  }),
);
runEventLogConformance(
  "sqlite(:memory:)",
  overStore(() => inMemory),
);
runEventLogConformance(
  "sqlite(file)",
  overStore(() => onDisk),
);

// ── 2 ────────────────────────────────────────────────────────────────────────
//
// §14.11's ten items, over a real file that is closed and REOPENED.
runEventLogPersistenceConformance("sqlite(file)", makeTmpPersistence);

const SLOW = Number(process.env["OMNI_TEST_SLOW_FACTOR"] ?? "1");

function persistenceOf(log: EventLog): "memory" | "durable" | "degraded" {
  const maybe = log as EventLog & { persistence?: "memory" | "durable" | "degraded" };
  return maybe.persistence ?? (log.persistent ? "durable" : "memory");
}

/**
 * Every `available_commands_update` the recorded claude-acp corpus contains, read straight from
 * `docs/research/transcripts/claude-acp-0.73.0/*.jsonl`.
 *
 * Read here with `fs` rather than through testkit's `loadTranscript`, which is M1-WP-B's file:
 * this test needs the raw bytes of one update kind, not the parsed transcript model, and taking
 * the dependency would couple WP-A's acceptance to another package's stub.
 */
function corpusAvailableCommands(): Record<string, unknown>[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = join(
    here,
    "..",
    "..",
    "..",
    "..",
    "docs",
    "research",
    "transcripts",
    "claude-acp-0.73.0",
  );
  const out: Record<string, unknown>[] = [];
  for (const name of readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort()) {
    for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
      if (line.trim() === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const record = parsed as {
        dir?: string;
        msg?: { method?: string; params?: { update?: Record<string, unknown> } };
      };
      if (record.dir !== "agent->client") continue;
      if (record.msg?.method !== "session/update") continue;
      const update = record.msg.params?.update;
      if (update?.["sessionUpdate"] === "available_commands_update") out.push(update);
    }
  }
  return out;
}
