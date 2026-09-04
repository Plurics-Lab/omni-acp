import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CloseResult, WorkerId, WorkerRow, WorkerSnapshot } from "@omni-acp/protocol";
import { workerId } from "./support/harness.js";
import { rawStore, type RawStore } from "./support/raw-db.js";

const DAEMON = `d_${"0".repeat(25)}7`;
const AT = Date.UTC(2026, 1, 1);

function snapshot(w: WorkerId, over: Partial<WorkerSnapshot> = {}): WorkerSnapshot {
  return {
    workerId: w,
    daemonId: DAEMON,
    ref: `${DAEMON}/${w}`,
    sessionId: "sess-1",
    agentId: "claude-acp",
    state: "ready",
    cwd: "/tmp/omni",
    label: "unit",
    ownerTokenId: "tok_test",
    createdAt: new Date(AT).toISOString(),
    updatedAt: new Date(AT).toISOString(),
    headSeq: 0,
    currentTurnId: null,
    capabilities: null,
    process: null,
    closeReason: null,
    lease: {
      workerId: w,
      holder: null,
      epoch: 0,
      expiresAt: null,
      acquiredAt: null,
      pinned: false,
    },
    hibernatedAt: null,
    crashed: false,
    resume: null,
    wakeCount: 0,
    wakeFailures: 0,
    orphan: null,
    generation: 1,
    runtimeId: "claude-acp@unresolved",
    persistence: "durable",
    ...over,
  } as unknown as WorkerSnapshot;
}

function row(
  w: WorkerId,
  over: Partial<WorkerRow> = {},
  snap: Partial<WorkerSnapshot> = {},
): WorkerRow {
  return {
    snapshot: snapshot(w, snap),
    agentId: "claude-acp",
    bootId: "boot_1",
    closeResult: null,
    lastActiveMs: AT,
    closedAtMs: null,
    hibernateIdleMs: null,
    ...over,
  };
}

describe("createSqliteWorkerStore (§14.8, §15.6, §15.7)", () => {
  let raw: RawStore;

  beforeEach(async () => {
    raw = await rawStore();
  });

  afterEach(async () => {
    await raw.dispose();
  });

  it("round-trips a full row, snapshot included", () => {
    const w = workerId(1);
    const original = row(w, { hibernateIdleMs: 900_000 }, {
      capabilities: {
        protocolVersion: 1,
        raw: { loadSession: true },
        loadSession: true,
        promptCapabilities: null,
        supportsSessionClose: true,
        resume: { method: "session/load", replayFrom: true, requiresSameCwd: false },
        supportsSessionList: false,
        configOptions: null,
        modes: null,
        extensions: ["session/set_mode"],
      },
      process: {
        pid: 4242,
        groupId: 4242,
        startedAt: new Date(AT).toISOString(),
        command: "npx",
        argsRedacted: ["-y", "claude-agent-acp"],
        fingerprint: "linux:1:2",
      },
    } as unknown as Partial<WorkerSnapshot>);
    raw.workers.upsert(original);

    // The whole snapshot survives, which is what lets a REHYDRATED worker be the same `Worker`
    // class in a non-`starting` initial state rather than a second implementation (§14.8).
    expect(raw.workers.get(w)).toEqual(original);
    expect(raw.workers.get(workerId(99))).toBeNull();
  });

  it("persists closeResult so DELETE is idempotent ACROSS a restart, byte-for-byte", () => {
    const w = workerId(2);
    const closeResult: CloseResult = {
      workerId: w,
      state: "closed",
      reason: "client_request",
      leaderExited: true,
      treeGone: false,
      sessionClosed: true,
    };
    raw.workers.upsert(
      row(w, { closeResult, closedAtMs: AT }, { state: "closed", closeReason: "client_request" }),
    );

    raw.reopen();

    // Byte-for-byte, not recomputed: `treeGone: false` is a fact we observed on Windows and must
    // not turn into an optimistic `true` just because the process is gone now (§15.6).
    expect(raw.workers.get(w)?.closeResult).toEqual(closeResult);
  });

  it("upserts in place and lists newest updatedAt first", () => {
    const a = workerId(3);
    const b = workerId(4);
    raw.workers.upsert(row(a, {}, { updatedAt: "2026-02-01T00:00:00.000Z" }));
    raw.workers.upsert(row(b, {}, { updatedAt: "2026-02-02T00:00:00.000Z" }));
    expect(raw.workers.list().map((r) => r.snapshot.workerId)).toEqual([b, a]);

    raw.workers.upsert(row(a, {}, { updatedAt: "2026-02-03T00:00:00.000Z", state: "running" }));
    expect(raw.workers.list()).toHaveLength(2);
    expect(raw.workers.list().map((r) => r.snapshot.workerId)).toEqual([a, b]);
    expect(raw.workers.get(a)?.snapshot.state).toBe("running");
  });

  it("never lets an upsert lower head_seq, and never touches tail_seq", () => {
    const w = workerId(5);
    raw.workers.upsert(row(w, {}, { headSeq: 400 }));
    // The retention sweep raises both columns inside its own transaction; a debounced registry
    // upsert carrying a stale snapshot must not walk either of them back.
    raw.events.put(dummy(w, 400));
    raw.events.evict(w, 400);
    const tailAfterSweep = Number(
      raw.db.prepare("select tail_seq from workers where worker_id = ?").get(w)?.["tail_seq"],
    );
    expect(tailAfterSweep).toBe(401);

    raw.workers.upsert(row(w, {}, { headSeq: 12 }));
    const after = raw.db
      .prepare("select head_seq, tail_seq from workers where worker_id = ?")
      .get(w);
    expect(Number(after?.["head_seq"])).toBe(400);
    expect(Number(after?.["tail_seq"])).toBe(401);
    // …and the row a caller reads back carries the HIGHER head, so a rehydrated worker seeded
    // from it cannot reissue seqs a client already holds.
    expect(raw.workers.get(w)?.snapshot.headSeq).toBe(400);
  });

  it("abandoned() finds LIVE rows from another boot, and only those", () => {
    const mine = workerId(6);
    const theirsLive = workerId(7);
    const theirsClosed = workerId(8);
    const theirsHibernated = workerId(9);

    raw.workers.upsert(row(mine, { bootId: "boot_now" }, { state: "running" }));
    raw.workers.upsert(row(theirsLive, { bootId: "boot_old" }, { state: "running" }));
    raw.workers.upsert(row(theirsClosed, { bootId: "boot_old" }, { state: "closed" }));
    raw.workers.upsert(row(theirsHibernated, { bootId: "boot_old" }, { state: "hibernated" }));

    const found = raw.workers.abandoned("boot_now").map((r) => r.snapshot.workerId);
    expect(found).toEqual([theirsLive]);
    // `hibernated` is deliberately not an orphan: it has no process by definition, so a previous
    // boot's hibernated row is already converged and reaping it would be reaping nothing (§15.7).
    expect(found).not.toContain(theirsHibernated);
    expect(found).not.toContain(mine);
  });

  it("closedBefore() is the age sweep's cursor, oldest first", () => {
    const day = 86_400_000;
    raw.workers.upsert(row(workerId(10), { closedAtMs: AT - 10 * day }, { state: "closed" }));
    raw.workers.upsert(row(workerId(11), { closedAtMs: AT - 2 * day }, { state: "closed" }));
    raw.workers.upsert(row(workerId(12), { closedAtMs: null }, { state: "closed" }));
    raw.workers.upsert(row(workerId(13), { closedAtMs: AT - 99 * day }, { state: "ready" }));

    expect(raw.workers.closedBefore(AT - 5 * day).map((r) => r.snapshot.workerId)).toEqual([
      workerId(10),
    ]);
    expect(raw.workers.closedBefore(AT).map((r) => r.snapshot.workerId)).toEqual([
      workerId(10),
      workerId(11),
    ]);
  });

  it("delete() removes the row and is idempotent", () => {
    const w = workerId(14);
    raw.workers.upsert(row(w));
    raw.workers.delete(w);
    expect(raw.workers.get(w)).toBeNull();
    expect(() => raw.workers.delete(w)).not.toThrow();
    expect(raw.workers.list()).toEqual([]);
  });

  it("does no visibility filtering — that is the REGISTRY's job (D13)", () => {
    raw.workers.upsert(row(workerId(15), {}, { ownerTokenId: "tok_a" } as Partial<WorkerSnapshot>));
    raw.workers.upsert(row(workerId(16), {}, { ownerTokenId: "tok_b" } as Partial<WorkerSnapshot>));
    // A store that quietly dropped rows a token cannot see would make `list()` and the audit log
    // disagree about what exists.
    expect(raw.workers.list()).toHaveLength(2);
  });
});

function dummy(w: WorkerId, n: number): Parameters<RawStore["events"]["put"]>[0] {
  return Object.freeze({
    seq: n,
    ts: new Date(AT).toISOString(),
    daemonId: DAEMON,
    workerId: w,
    sessionId: null,
    turnId: null,
    payloadVersion: 2,
    kind: "omni.error",
    payload: { code: "internal", message: "x" },
  }) as unknown as Parameters<RawStore["events"]["put"]>[0];
}
