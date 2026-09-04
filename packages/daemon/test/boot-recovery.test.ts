import { describe, expect, it } from "vitest";
import {
  DaemonConfig,
  type AgentCapabilitiesSnapshot,
  type EventEnvelope,
  type EventLog,
  type ProcessInfo,
  type ResolvedDaemonConfig,
  type WorkerId,
  type WorkerRow,
  type WorkerSnapshot,
  type WorkerState,
} from "@omni-acp/protocol";
import { fakeClock, fakeSupervisor, nullLogger } from "@omni-acp/testkit";
import { recoverFromPreviousBoot } from "../src/boot-recovery.js";
import { testEventLog, someWorkerId } from "./fake-core.js";
import { fakePersistence, type FakePersistence } from "./fake-persistence.js";

const PREVIOUS_BOOT = "boot_the_one_that_died";
const CURRENT_BOOT = "boot_fake_current";
const DAEMON_ID = `d_${"0".repeat(25)}1`;

const clock = fakeClock();

const config = (o?: Record<string, unknown>): ResolvedDaemonConfig =>
  DaemonConfig.parse({
    tokens: [{ id: "t", secretSha256: "a".repeat(64) }],
    ...o,
  } as Parameters<typeof DaemonConfig.parse>[0]) as ResolvedDaemonConfig;

const RESUMABLE: AgentCapabilitiesSnapshot = {
  protocolVersion: 1,
  raw: {},
  loadSession: true,
  promptCapabilities: null,
  supportsSessionClose: true,
  resume: { method: "session/resume", replayFrom: true, requiresSameCwd: true },
  supportsSessionList: true,
  configOptions: null,
  modes: null,
  extensions: [],
} as unknown as AgentCapabilitiesSnapshot;

const NOT_RESUMABLE: AgentCapabilitiesSnapshot = {
  ...RESUMABLE,
  resume: { method: null, replayFrom: false, requiresSameCwd: false },
} as unknown as AgentCapabilitiesSnapshot;

const processInfo = (o?: Partial<ProcessInfo>): ProcessInfo => ({
  pid: 4242,
  groupId: 4242,
  startedAt: "2026-09-03T23:00:00.000Z",
  command: "npx",
  argsRedacted: ["-y", "agent"],
  fingerprint: "linux:1:2",
  ...o,
});

function row(o?: {
  id?: number;
  state?: WorkerState;
  bootId?: string;
  sessionId?: string | null;
  capabilities?: AgentCapabilitiesSnapshot | null;
  process?: ProcessInfo | null;
  epoch?: number;
}): WorkerRow {
  const workerId = someWorkerId(o?.id ?? 1);
  const snapshot = {
    workerId,
    daemonId: DAEMON_ID,
    ref: `${DAEMON_ID}:${workerId}`,
    sessionId: o?.sessionId === undefined ? "sess-1" : o.sessionId,
    agentId: "claude",
    state: o?.state ?? "ready",
    cwd: "/work",
    label: null,
    ownerTokenId: "t",
    createdAt: "2026-09-03T22:00:00.000Z",
    updatedAt: "2026-09-03T23:00:00.000Z",
    headSeq: 7,
    currentTurnId: null,
    capabilities: o?.capabilities === undefined ? RESUMABLE : o.capabilities,
    process: o?.process === undefined ? processInfo() : o.process,
    closeReason: null,
    lease: {
      workerId,
      holder: { tokenId: "t", clientId: "c_1" },
      epoch: o?.epoch ?? 3,
      expiresAt: null,
      acquiredAt: "2026-09-03T22:00:00.000Z",
      pinned: false,
    },
    hibernatedAt: null,
    crashed: false,
    resume: null,
    wakeCount: 0,
    wakeFailures: 0,
    orphan: null,
    generation: 1,
    runtimeId: "claude@abcdef012345",
    persistence: "durable",
  } as unknown as WorkerSnapshot;

  return {
    snapshot,
    agentId: "claude",
    bootId: o?.bootId ?? PREVIOUS_BOOT,
    closeResult: null,
    lastActiveMs: 1_000,
    closedAtMs: null,
    hibernateIdleMs: 1_800_000,
  };
}

interface Harness {
  readonly store: FakePersistence;
  readonly logs: Map<WorkerId, EventLog>;
  readonly supervisor: ReturnType<typeof fakeSupervisor>;
  run(o?: { config?: ResolvedDaemonConfig }): ReturnType<typeof recoverFromPreviousBoot>;
  envelopes(id: WorkerId): readonly EventEnvelope[];
}

function harness(rows: readonly WorkerRow[], o?: { windows?: boolean }): Harness {
  const store = fakePersistence({ bootId: CURRENT_BOOT });
  for (const r of rows) store.seed(r);
  const supervisor = fakeSupervisor(
    o?.windows === true
      ? {
          ownership: {
            kind: "windows-taskkill-tree",
            confirmsTreeGone: false,
            survivesDaemonKill: true,
            caveat: "taskkill /T cannot prove the tree is gone",
          },
        }
      : undefined,
  );
  const logs = new Map<WorkerId, EventLog>();
  const captured = new Map<WorkerId, EventEnvelope[]>();

  const logFor = (workerId: WorkerId): EventLog => {
    const existing = logs.get(workerId);
    if (existing !== undefined) return existing;
    const log = testEventLog({
      workerId,
      daemonId: DAEMON_ID,
      clock,
      maxEvents: 100,
      subscriberQueueSize: 16,
      // Continue the worker's OWN seq space (§14.4): adoption's envelopes must land at the next
      // seq a reconnecting client expects.
      startSeq: store.events.headOf(workerId),
    });
    const seen: EventEnvelope[] = [];
    log.subscribe(store.events.headOf(workerId), (e) => seen.push(e));
    captured.set(workerId, seen);
    logs.set(workerId, log);
    return log;
  };

  return {
    store,
    logs,
    supervisor,
    run: (opts) =>
      recoverFromPreviousBoot({
        persistence: store,
        supervisor,
        config: opts?.config ?? config(),
        clock,
        logger: nullLogger(),
        logFor,
      }),
    envelopes: (id) => captured.get(id) ?? [],
  };
}

/**
 * WP-E acceptance 6: boot adoption converges every abandoned row on `hibernated` or `closed`,
 * appends the in-band `omni.error` + the `daemon_restart`/`orphaned` envelope + the
 * `omni.lease{expired}`, and is a NO-OP on a second run.
 */
describe("recoverFromPreviousBoot — §15.7", () => {
  it("selects only rows a PREVIOUS boot owned", async () => {
    const h = harness([row({ id: 1 }), row({ id: 2, bootId: CURRENT_BOOT })]);
    const result = await h.run();
    expect(result.found).toBe(1);
    expect(h.store.rows.get(someWorkerId(2))?.snapshot.state).toBe("ready");
  });

  it("leaves an already-HIBERNATED row alone — it is at rest, not abandoned", async () => {
    // §15.7's matrix, first row: `abandoned()` selects only LIVE states.
    const h = harness([row({ id: 1, state: "hibernated", process: null })]);
    const result = await h.run();
    expect(result.found).toBe(0);
    expect(h.envelopes(someWorkerId(1))).toEqual([]);
  });

  it("leaves a CLOSED row alone", async () => {
    const h = harness([row({ id: 1, state: "closed", process: null })]);
    expect((await h.run()).found).toBe(0);
  });

  it("converges a resumable row on `hibernated` with reason `daemon_restart`", async () => {
    const h = harness([row({ id: 1, state: "ready" })]);
    const result = await h.run();
    expect(result).toMatchObject({ found: 1, hibernated: 1, closed: 0 });

    const adopted = h.store.rows.get(someWorkerId(1));
    expect(adopted?.snapshot.state).toBe("hibernated");
    expect(adopted?.snapshot.crashed).toBe(true);
    expect(adopted?.snapshot.process).toBeNull();
    expect(adopted?.closeResult).toBeNull();
  });

  it("converges a row with NO sessionId on `closed` with reason `orphaned`", async () => {
    // §15.7: a worker that was `starting` when the daemon died has nothing to resume.
    const h = harness([row({ id: 1, state: "starting", sessionId: null })]);
    const result = await h.run();
    expect(result).toMatchObject({ hibernated: 0, closed: 1 });
    expect(h.store.rows.get(someWorkerId(1))?.snapshot.state).toBe("closed");
    expect(h.store.rows.get(someWorkerId(1))?.snapshot.closeReason).toBe("orphaned");
  });

  it("converges a row whose agent resolved NO resume spelling on `closed`", async () => {
    // Ruling M1-R15's reasoning: hibernating a worker you can never wake is a one-way door.
    const h = harness([row({ id: 1, state: "running", capabilities: NOT_RESUMABLE })]);
    expect((await h.run()).closed).toBe(1);
  });

  it("appends the three envelopes, in order, to the worker's OWN log", async () => {
    const h = harness([row({ id: 1 })]);
    await h.run();
    const kinds = h.envelopes(someWorkerId(1)).map((e) => e.kind);
    expect(kinds).toEqual(["omni.error", "omni.worker_state", "omni.lease"]);
  });

  it("the in-band omni.error says WHY, at the next seq a reconnecting client expects (§14.4)", async () => {
    const h = harness([row({ id: 1 })]);
    // Pretend the previous boot's log reached seq 7.
    h.store.events.put({
      seq: 7,
      ts: "2026-09-03T23:00:00.000Z",
      daemonId: DAEMON_ID,
      workerId: someWorkerId(1),
      sessionId: "sess-1",
      turnId: null,
      payloadVersion: 2,
      kind: "omni.error",
      payload: { code: "internal", message: "an older event" },
    } as EventEnvelope);

    await h.run();
    const first = h.envelopes(someWorkerId(1))[0];
    expect(first?.seq).toBe(8);
    expect(first?.kind).toBe("omni.error");
    expect(first?.payload).toMatchObject({ code: "agent_error" });
    expect(JSON.stringify(first?.payload)).toMatch(/daemon restarted/);
  });

  it("the state envelope carries `crashed: true`, the reason, and the orphan record", async () => {
    const h = harness([row({ id: 1 })]);
    await h.run();
    const state = h.envelopes(someWorkerId(1)).find((e) => e.kind === "omni.worker_state");
    expect(state?.payload).toMatchObject({
      state: "hibernated",
      previous: "ready",
      reason: "daemon_restart",
      crashed: true,
      orphan: { pid: 4242, reaped: true },
    });
  });

  it("`orphaned` is a DIFFERENT reason from `daemon_restart` — asleep vs. gone", async () => {
    const h = harness([row({ id: 1, sessionId: null, state: "starting" })]);
    await h.run();
    const state = h.envelopes(someWorkerId(1)).find((e) => e.kind === "omni.worker_state");
    expect(state?.payload).toMatchObject({ state: "closed", reason: "orphaned", crashed: true });
  });

  it("emits omni.lease{expired, how:daemon_restart} with the epoch BUMPED (M1-R8, L7)", async () => {
    const h = harness([row({ id: 1, epoch: 3 })]);
    await h.run();
    const lease = h.envelopes(someWorkerId(1)).find((e) => e.kind === "omni.lease");
    expect(lease?.payload).toMatchObject({
      op: "expired",
      how: "daemon_restart",
      // Nobody caused it — the restart did.
      by: null,
      previous: { tokenId: "t", clientId: "c_1" },
      lease: { holder: null, epoch: 4 },
    });
  });

  it("persists a pessimistic CloseResult for a closed row, so DELETE replays it (§15.6)", async () => {
    const h = harness([row({ id: 1, sessionId: null, state: "starting", process: null })]);
    await h.run();
    expect(h.store.rows.get(someWorkerId(1))?.closeResult).toEqual({
      workerId: someWorkerId(1),
      state: "closed",
      reason: "orphaned",
      // Nothing was proved, so nothing is claimed (§6.6).
      leaderExited: false,
      treeGone: false,
      sessionClosed: false,
    });
  });

  it("is a NO-OP on a second run: the rows now carry the current boot id", async () => {
    const h = harness([row({ id: 1 }), row({ id: 2, sessionId: null, state: "starting" })]);
    const first = await h.run();
    expect(first.found).toBe(2);

    const before = h.envelopes(someWorkerId(1)).length;
    const second = await h.run();
    expect(second).toMatchObject({ found: 0, reaped: 0, skipped: 0, hibernated: 0, closed: 0 });
    expect(h.envelopes(someWorkerId(1))).toHaveLength(before);
  });
});

describe("recoverFromPreviousBoot — reaping is proof, never a guess (§15.7, M1-R9)", () => {
  it("reaps a matching fingerprint and reports `{found:1, reaped:1, skipped:0}`", async () => {
    const h = harness([row({ id: 1 })]);
    expect(await h.run()).toMatchObject({ found: 1, reaped: 1, skipped: 0 });
  });

  it("NEVER signals a null fingerprint — pid reuse makes that somebody else's process", async () => {
    const h = harness([row({ id: 1, process: processInfo({ fingerprint: null }) })]);
    const result = await h.run();
    expect(result).toMatchObject({ found: 1, reaped: 0, skipped: 1 });
    expect(result.orphans[0]).toMatchObject({ reaped: false, reapSkipped: "unsupported_platform" });
  });

  it("Windows reports and does not touch: `{found:n, reaped:0, skipped:n}`", async () => {
    // The honest Windows answer §14.9 requires, modelled by the fake's platform split.
    const h = harness([row({ id: 1 }), row({ id: 2 })], { windows: true });
    const result = await h.run();
    expect(result).toMatchObject({ found: 2, reaped: 0, skipped: 2 });
    expect(result.orphans.every((o) => !o.reaped)).toBe(true);
  });

  it('`reapOrphans: "never"` records the orphan with `reapSkipped: "policy"`', async () => {
    const h = harness([row({ id: 1 })]);
    const result = await h.run({ config: config({ supervisor: { reapOrphans: "never" } }) });
    expect(result).toMatchObject({ found: 1, reaped: 0, skipped: 1 });
    expect(result.orphans[0]?.reapSkipped).toBe("policy");
  });

  it("a row with NO process is adopted but is not an orphan — nothing to reap", async () => {
    const h = harness([row({ id: 1, process: null })]);
    const result = await h.run();
    expect(result).toMatchObject({ found: 1, reaped: 0, skipped: 0 });
    expect(result.orphans).toEqual([]);
  });

  it("a reap that succeeded is allowed to claim leaderExited/treeGone; one that did not is not", async () => {
    const reaped = harness([row({ id: 1, sessionId: null, state: "starting" })]);
    await reaped.run();
    expect(reaped.store.rows.get(someWorkerId(1))?.closeResult).toMatchObject({
      leaderExited: true,
      treeGone: true,
    });

    const notReaped = harness([row({ id: 1, sessionId: null, state: "starting" })], {
      windows: true,
    });
    await notReaped.run();
    expect(notReaped.store.rows.get(someWorkerId(1))?.closeResult).toMatchObject({
      leaderExited: false,
      treeGone: false,
    });
  });

  it("one row that throws does not abandon the rest of the fleet", async () => {
    const h = harness([row({ id: 1 }), row({ id: 2 })]);
    const original = h.supervisor.reapOrphan.bind(h.supervisor);
    let calls = 0;
    (h.supervisor as { reapOrphan: typeof original }).reapOrphan = (o) => {
      calls += 1;
      if (calls === 1) throw new Error("reapOrphan should never reject, but suppose it did");
      return original(o);
    };
    const result = await h.run();
    expect(result.found).toBe(2);
    expect(h.store.rows.get(someWorkerId(1))?.bootId).toBe(CURRENT_BOOT);
    expect(h.store.rows.get(someWorkerId(2))?.bootId).toBe(CURRENT_BOOT);
  });
});
