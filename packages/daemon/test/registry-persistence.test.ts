import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DaemonConfig,
  OmniError,
  type AgentCapabilitiesSnapshot,
  type AuthContext,
  type CloseResult,
  type ProcessInfo,
  type ResolvedDaemonConfig,
  type WorkerId,
  type WorkerRow,
  type WorkerSnapshot,
  type WorkerState,
} from "@omni-acp/protocol";
import { fakeClock, fakeSupervisor, nullLogger, seqIds } from "@omni-acp/testkit";
import { createCatalog } from "../src/catalog.js";
import { createWorkerRegistry } from "../src/registry.js";
import { coreScript, someWorkerId } from "./fake-core.js";
import { fakePersistence, type FakePersistence } from "./fake-persistence.js";

vi.mock("@omni-acp/core", async (importOriginal) => {
  const { fakeCoreModule } = await import("./fake-core.js");
  return await fakeCoreModule(importOriginal as never);
});

const DAEMON_ID = `d_${"0".repeat(25)}1`;
const CURRENT_BOOT = "boot_fake_current";

const clock = fakeClock();

const config = (o?: Record<string, unknown>): ResolvedDaemonConfig =>
  DaemonConfig.parse({
    dataDir: tmpdir(),
    tokens: [{ id: "t", secretSha256: "a".repeat(64) }],
    agents: [{ id: "claude", command: process.execPath, args: ["-e", "0"] }],
    ...o,
  } as Parameters<typeof DaemonConfig.parse>[0]) as ResolvedDaemonConfig;

function auth(o?: { tokenId?: string; role?: "user" | "admin"; maxWorkers?: number }): AuthContext {
  const tokenId = o?.tokenId ?? "t";
  return {
    tokenId,
    role: o?.role ?? "user",
    clientId: null,
    leaseEpoch: null,
    agents: "*",
    cwdRoots: [tmpdir()],
    maxWorkers: o?.maxWorkers ?? 16,
    assertAgent: () => {},
    assertCwd: (cwd: string) => Promise.resolve(cwd),
    // D13: same token only, so an "invisible" persisted row can be tested.
    canSee: (w: WorkerSnapshot) => (o?.role ?? "user") === "admin" || w.ownerTokenId === tokenId,
    asClientRef: () => ({ tokenId, clientId: null }),
    // ── M2-B (§5.8.7), completed at the join ───────────────────────────────
    //
    // The registry's creation path calls all three on EVERY create, so a double that omitted them
    // would only ever prove that the `as AuthContext` cast still compiles. Each answers exactly
    // what the real one answers for a request that asked for nothing — which is every request in
    // this file — and THROWS otherwise, so a future test that starts asking for an env, a preset
    // or a policy here gets a red rather than a silently ungated worker.
    policyCeiling: null,
    assertPolicy: () => {
      throw new Error("this double resolves no policy; use the real AuthContext to select one");
    },
    assertEnv: (env?: Readonly<Record<string, string>>) => {
      if (env === undefined || Object.keys(env).length === 0) {
        return { env: {}, keys: [], persist: true };
      }
      throw new Error("this double resolves no env; use the real AuthContext to set one");
    },
    assertMcp: (names?: readonly string[]) => {
      if (names === undefined || names.length === 0) return [];
      throw new Error("this double resolves no MCP preset; use the real AuthContext for one");
    },
  } as AuthContext;
}

const RESUMABLE = {
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

function persistedRow(o?: {
  id?: number;
  state?: WorkerState;
  ownerTokenId?: string;
  closeResult?: CloseResult | null;
  closeReason?: string | null;
  process?: ProcessInfo | null;
}): WorkerRow {
  const workerId = someWorkerId(o?.id ?? 50);
  const snapshot = {
    workerId,
    daemonId: DAEMON_ID,
    ref: `${DAEMON_ID}:${workerId}`,
    sessionId: "sess-persisted",
    agentId: "claude",
    state: o?.state ?? "hibernated",
    cwd: "/work",
    label: null,
    ownerTokenId: o?.ownerTokenId ?? "t",
    createdAt: "2026-09-03T22:00:00.000Z",
    updatedAt: "2026-09-03T23:00:00.000Z",
    headSeq: 12,
    currentTurnId: null,
    capabilities: RESUMABLE,
    process: o?.process ?? null,
    closeReason: o?.closeReason ?? null,
    lease: {
      workerId,
      holder: null,
      epoch: 1,
      expiresAt: null,
      acquiredAt: null,
      pinned: false,
    },
    hibernatedAt: "2026-09-03T23:00:00.000Z",
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
    bootId: CURRENT_BOOT,
    closeResult: o?.closeResult ?? null,
    lastActiveMs: 1_000,
    closedAtMs: o?.state === "closed" ? 2_000 : null,
    hibernateIdleMs: 1_800_000,
  };
}

function registry(o?: { store?: FakePersistence | null; config?: ResolvedDaemonConfig }) {
  const resolved = o?.config ?? config();
  const supervisor = fakeSupervisor();
  const store = o?.store === undefined ? fakePersistence({ bootId: CURRENT_BOOT }) : o.store;
  const workers = createWorkerRegistry({
    daemonId: DAEMON_ID,
    config: resolved,
    catalog: createCatalog(resolved),
    supervisor,
    responder: { decide: () => ({ response: null, record: {} as never }) },
    clock,
    ids: seqIds(),
    logger: nullLogger(),
    persistence: store,
  });
  return { workers, store, supervisor, config: resolved };
}

beforeEach(() => {
  coreScript.reset();
});

/**
 * WP-E acceptance 7: lazy rehydration in `get()`/`delete()`; `list()` straight from the store
 * with live entries overriding; hibernated workers counted separately from `maxWorkers`, and a
 * wake that would exceed it is 429.
 */
describe("registry — lazy rehydration (§14.8)", () => {
  it("get() rehydrates a worker THIS PROCESS never created", () => {
    const { workers, store } = registry();
    store.seed(persistedRow());
    const handle = workers.get(someWorkerId(50), auth());
    expect(handle.snapshot().state).toBe("hibernated");
    expect(handle.snapshot().sessionId).toBe("sess-persisted");
  });

  it("MEMOISES it: a second get() returns the same handle, not a second log", () => {
    const { workers, store } = registry();
    store.seed(persistedRow());
    expect(workers.get(someWorkerId(50), auth())).toBe(workers.get(someWorkerId(50), auth()));
  });

  it("is LAZY: seeding 100 rows constructs nothing until one is asked for", () => {
    const { workers, store } = registry();
    for (let i = 0; i < 100; i += 1) store.seed(persistedRow({ id: 100 + i }));
    // `size` counts LIVE workers, and rehydration has not run.
    expect(workers.size).toBe(0);
    workers.get(someWorkerId(100), auth());
    // A hibernated row still holds no slot.
    expect(workers.size).toBe(0);
  });

  it("checks the ACL BEFORE constructing anything — an invisible row is worker_not_found", () => {
    const { workers, store } = registry();
    store.seed(persistedRow({ ownerTokenId: "somebody-else" }));
    // D13: the same error as absent, never a 403 that would confirm the id exists.
    expect(() => workers.get(someWorkerId(50), auth())).toThrow(OmniError);
    try {
      workers.get(someWorkerId(50), auth());
    } catch (e) {
      expect(OmniError.is(e, "worker_not_found")).toBe(true);
    }
  });

  it("an admin CAN see and rehydrate another token's row (D13)", () => {
    const { workers, store } = registry();
    store.seed(persistedRow({ ownerTokenId: "somebody-else" }));
    expect(workers.get(someWorkerId(50), auth({ role: "admin" })).snapshot().state).toBe(
      "hibernated",
    );
  });

  it("without persistence there is nothing to rehydrate — M0 exactly", () => {
    const { workers } = registry({ store: null });
    expect(() => workers.get(someWorkerId(50), auth())).toThrow(/not found/);
  });
});

describe("registry — list() reads the store, live entries overriding (§14.8)", () => {
  it("includes persisted rows this process never created", () => {
    const { workers, store } = registry();
    store.seed(persistedRow({ id: 50 }));
    store.seed(persistedRow({ id: 51, state: "closed" }));
    expect(
      workers
        .list(auth())
        .map((w) => w.workerId)
        .sort(),
    ).toEqual([someWorkerId(50), someWorkerId(51)]);
  });

  it("constructs NO handle to do it", () => {
    const { workers, store } = registry();
    store.seed(persistedRow());
    workers.list(auth());
    // A handle would have been memoised; asking again would return it. Instead the FIRST get()
    // is what constructs one, which is what makes `list()` cheap at 10 000 rows.
    expect(workers.size).toBe(0);
  });

  it("a LIVE entry overrides its own row — a live snapshot is fresher than a debounced one", async () => {
    const { workers, store } = registry();
    const handle = await workers.create({ agent: "claude", cwd: tmpdir() }, auth());
    const id = handle.id;
    // The registry wrote the row on create; now stale it deliberately.
    const row = store.rows.get(id);
    store.seed({ ...row!, snapshot: { ...row!.snapshot, state: "hibernated" } });

    const listed = workers.list(auth()).filter((w) => w.workerId === id);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.state).toBe("ready");
    await workers.closeAll("daemon_shutdown");
  });

  it("filters persisted rows by visibility, exactly as it filters live ones (D13)", () => {
    const { workers, store } = registry();
    store.seed(persistedRow({ id: 50, ownerTokenId: "t" }));
    store.seed(persistedRow({ id: 51, ownerTokenId: "somebody-else" }));
    expect(workers.list(auth()).map((w) => w.workerId)).toEqual([someWorkerId(50)]);
    expect(
      workers
        .list(auth({ role: "admin" }))
        .map((w) => w.workerId)
        .sort(),
    ).toEqual([someWorkerId(50), someWorkerId(51)]);
  });

  it("a store read that fails still returns the live half rather than an empty list", async () => {
    const { workers, store } = registry();
    const handle = await workers.create({ agent: "claude", cwd: tmpdir() }, auth());
    (store.workers as { list: () => never }).list = () => {
      throw new Error("the disk went away");
    };
    expect(workers.list(auth()).map((w) => w.workerId)).toEqual([handle.id]);
    await workers.closeAll("daemon_shutdown");
  });
});

describe("registry — DELETE across a restart (§15.6 level 3)", () => {
  it("returns the persisted CloseResult BYTE-FOR-BYTE, with no handle constructed", async () => {
    const closeResult: CloseResult = {
      workerId: someWorkerId(50),
      state: "closed",
      reason: "client_request",
      leaderExited: true,
      treeGone: false,
      sessionClosed: true,
    };
    const { workers, store } = registry();
    store.seed(persistedRow({ state: "closed", closeResult }));

    expect(await workers.delete(someWorkerId(50), auth())).toEqual(closeResult);
    // Recomputing would have reported `treeGone: true` for a tree nobody proved gone.
    expect(await workers.delete(someWorkerId(50), auth())).toEqual(closeResult);
  });

  it("falls back PESSIMISTICALLY when a boot crashed mid-close and left no result", async () => {
    const { workers, store } = registry();
    store.seed(persistedRow({ state: "closed", closeResult: null, closeReason: "agent_crashed" }));
    expect(await workers.delete(someWorkerId(50), auth())).toEqual({
      workerId: someWorkerId(50),
      state: "closed",
      reason: "agent_crashed",
      leaderExited: false,
      treeGone: false,
      sessionClosed: false,
    });
  });

  it("an invisible closed row is worker_not_found, not somebody else's CloseResult", async () => {
    const { workers, store } = registry();
    store.seed(persistedRow({ state: "closed", ownerTokenId: "somebody-else" }));
    await expect(workers.delete(someWorkerId(50), auth())).rejects.toMatchObject({
      code: "worker_not_found",
    });
  });

  it("a HIBERNATED row is rehydrated and closed properly, not short-circuited", async () => {
    const { workers, store } = registry();
    store.seed(persistedRow({ state: "hibernated" }));
    const result = await workers.delete(someWorkerId(50), auth());
    expect(result.state).toBe("closed");
    // §15.6: we do not pay a 7-second npx cold start to politely close a hibernated session.
    expect(result.sessionClosed).toBe(false);
  });
});

describe("registry — hibernated workers are bounded SEPARATELY from maxWorkers (H14)", () => {
  it("counts live hibernated workers and persisted hibernated rows", async () => {
    const { workers, store } = registry();
    expect(workers.hibernatedSize).toBe(0);
    store.seed(persistedRow({ id: 50 }));
    store.seed(persistedRow({ id: 51 }));
    store.seed(persistedRow({ id: 52, state: "closed" }));
    expect(workers.hibernatedSize).toBe(2);
  });

  it("does not double-count a row it has rehydrated", () => {
    const { workers, store } = registry();
    store.seed(persistedRow({ id: 50 }));
    workers.get(someWorkerId(50), auth());
    expect(workers.hibernatedSize).toBe(1);
  });

  it("hibernating GIVES BACK the maxWorkers slot", async () => {
    const { workers } = registry();
    const handle = await workers.create({ agent: "claude", cwd: tmpdir() }, auth());
    expect(workers.size).toBe(1);
    await workers.hibernate(handle.id, auth());
    expect(workers.size).toBe(0);
    expect(workers.hibernatedSize).toBe(1);
  });

  it("refuses to hibernate past `hibernate.maxHibernated`", async () => {
    const { workers, store } = registry({
      config: config({ hibernate: { maxHibernated: 1 } }),
    });
    store.seed(persistedRow({ id: 50 }));
    const handle = await workers.create({ agent: "claude", cwd: tmpdir() }, auth());
    await expect(workers.hibernate(handle.id, auth())).rejects.toMatchObject({
      code: "worker_limit",
    });
    await workers.closeAll("daemon_shutdown");
  });

  it("hibernating an already-hibernated worker is idempotent, limit or no limit", async () => {
    const { workers, store } = registry({ config: config({ hibernate: { maxHibernated: 1 } }) });
    store.seed(persistedRow({ id: 50 }));
    const snapshot = await workers.hibernate(someWorkerId(50), auth());
    expect(snapshot.state).toBe("hibernated");
  });
});

describe("registry — a wake that would exceed maxWorkers is 429 (acceptance 7)", () => {
  it("takes the slot back on a successful wake", async () => {
    const { workers, store } = registry();
    store.seed(persistedRow({ id: 50 }));
    expect(workers.size).toBe(0);
    const snapshot = await workers.wake(someWorkerId(50), auth());
    expect(snapshot.state).toBe("ready");
    expect(workers.size).toBe(1);
    expect(workers.hibernatedSize).toBe(0);
  });

  it("429s BEFORE the ~7 s cold start when the daemon is at maxWorkers", async () => {
    const { workers, store } = registry({ config: config({ maxWorkers: 1 }) });
    await workers.create({ agent: "claude", cwd: tmpdir() }, auth());
    store.seed(persistedRow({ id: 50 }));

    await expect(workers.wake(someWorkerId(50), auth())).rejects.toMatchObject({
      code: "worker_limit",
    });
    // The worker is still hibernated and still holds no slot: a refused wake changes nothing.
    expect(workers.get(someWorkerId(50), auth()).snapshot().state).toBe("hibernated");
    expect(workers.size).toBe(1);
    await workers.closeAll("daemon_shutdown");
  });

  it("429s on the TOKEN's own limit too", async () => {
    const { workers, store } = registry();
    store.seed(persistedRow({ id: 50 }));
    const tight = auth({ maxWorkers: 0 });
    await expect(workers.wake(someWorkerId(50), tight)).rejects.toMatchObject({
      code: "worker_limit",
    });
  });

  it("waking a worker that is already awake takes no second slot", async () => {
    const { workers } = registry();
    const handle = await workers.create({ agent: "claude", cwd: tmpdir() }, auth());
    await workers.wake(handle.id, auth());
    expect(workers.size).toBe(1);
    await workers.closeAll("daemon_shutdown");
  });
});

describe("registry — slot accounting for a REHYDRATED worker", () => {
  it("gives the slot back when an adopted worker is closed", async () => {
    // A rehydrated worker has no `create()` frame, so the close bookkeeping has to be attached
    // where the handle is built. Without it the slot leaks for the life of the daemon.
    const { workers, store } = registry();
    store.seed(persistedRow({ id: 50, state: "ready", process: null }));
    expect(workers.get(someWorkerId(50), auth()).snapshot().state).toBe("ready");
    expect(workers.size).toBe(1);

    await workers.delete(someWorkerId(50), auth());
    expect(workers.size).toBe(0);
  });

  it("a rehydrated LIVE-state row takes a slot; a hibernated one does not", () => {
    const { workers, store } = registry();
    store.seed(persistedRow({ id: 50, state: "ready", process: null }));
    store.seed(persistedRow({ id: 51, state: "hibernated" }));
    workers.get(someWorkerId(50), auth());
    workers.get(someWorkerId(51), auth());
    expect(workers.size).toBe(1);
    expect(workers.hibernatedSize).toBe(1);
  });

  it("charges a wake to the worker's OWNER, not to the admin who asked", async () => {
    const { workers, store } = registry();
    store.seed(persistedRow({ id: 50, ownerTokenId: "owner" }));
    // An admin whose own quota is zero may still wake somebody else's worker: the quota belongs
    // to the owner, and the daemon-wide limit is what bounds an admin (D13).
    await workers.wake(someWorkerId(50), auth({ tokenId: "admin", role: "admin", maxWorkers: 0 }));
    expect(workers.size).toBe(1);

    // And the slot comes back to the OWNER's account on close, not the admin's.
    await workers.delete(someWorkerId(50), auth({ tokenId: "admin", role: "admin" }));
    expect(workers.size).toBe(0);
  });
});

describe("registry — the durable row (§14, §15.7)", () => {
  it("writes a row the moment a worker exists, so a crash one ms later leaves something", async () => {
    const { workers, store } = registry();
    const handle = await workers.create({ agent: "claude", cwd: tmpdir() }, auth());
    const row = store.rows.get(handle.id);
    expect(row?.agentId).toBe("claude");
    expect(row?.bootId).toBe(CURRENT_BOOT);
    expect(row?.snapshot.state).toBe("ready");
    await workers.closeAll("daemon_shutdown");
  });

  it("keeps the row in step with the worker's own state machine", async () => {
    const { workers, store } = registry();
    const handle = await workers.create({ agent: "claude", cwd: tmpdir() }, auth());
    await workers.delete(handle.id, auth());
    expect(store.rows.get(handle.id)?.snapshot.state).toBe("closed");
  });

  it("persists the CloseResult, which is what a DELETE after a restart replays", async () => {
    const { workers, store } = registry();
    const handle = await workers.create({ agent: "claude", cwd: tmpdir() }, auth());
    const result = await workers.delete(handle.id, auth());
    // The write happens on the `closed` promise; give the microtask queue a turn.
    await Promise.resolve();
    await Promise.resolve();
    expect(store.rows.get(handle.id)?.closeResult).toEqual(result);
  });

  it("a store that refuses every write does not break the worker (§14.3)", async () => {
    const { workers, store } = registry();
    (store.workers as { upsert: () => never }).upsert = () => {
      throw new Error("read-only filesystem");
    };
    const handle = await workers.create({ agent: "claude", cwd: tmpdir() }, auth());
    expect(handle.snapshot().state).toBe("ready");
    await workers.closeAll("daemon_shutdown");
  });

  it("writes envelopes THROUGH to the event store", async () => {
    const { workers, store } = registry();
    const handle = await workers.create({ agent: "claude", cwd: tmpdir() }, auth());
    expect((store.stored.get(handle.id) ?? []).map((e) => e.kind)).toContain("omni.worker_state");
    await workers.closeAll("daemon_shutdown");
  });

  it("a rehydrated log CONTINUES the worker's seq space rather than restarting at 1 (§14.4)", () => {
    const { workers, store } = registry();
    store.seed(persistedRow({ id: 50 }));
    // Pretend the previous boot's log reached seq 12.
    for (let seq = 1; seq <= 12; seq += 1) {
      store.events.put({
        seq,
        ts: "2026-09-03T23:00:00.000Z",
        daemonId: DAEMON_ID,
        workerId: someWorkerId(50),
        sessionId: "sess-persisted",
        turnId: null,
        payloadVersion: 2,
        kind: "omni.error",
        payload: { code: "internal", message: "older" },
      } as never);
    }
    const handle = workers.get(someWorkerId(50), auth());
    expect(handle.log.head).toBe(12);
    const appended = handle.log.append({
      kind: "omni.error",
      payloadVersion: 2,
      turnId: null,
      payload: { code: "internal", message: "after the restart" },
    });
    expect(appended.seq).toBe(13);
  });
});

describe("registry — adopt() (acceptance 6, through the registry)", () => {
  it("reports the narrow shape and hands the full result to `onBootAdoption`", async () => {
    const resolved = config();
    const store = fakePersistence({ bootId: CURRENT_BOOT });
    store.seed({ ...persistedRow({ id: 50, state: "ready" }), bootId: "boot_previous" });
    let captured: unknown = null;
    const workers = createWorkerRegistry({
      daemonId: DAEMON_ID,
      config: resolved,
      catalog: createCatalog(resolved),
      supervisor: fakeSupervisor(),
      responder: { decide: () => ({ response: null, record: {} as never }) },
      clock,
      ids: seqIds(),
      logger: nullLogger(),
      persistence: store,
      onBootAdoption: (r) => {
        captured = r;
      },
    });

    const narrow = await workers.adopt();
    expect(narrow).toMatchObject({ hibernated: 1, closed: 0 });
    expect(captured).toMatchObject({ found: 1, hibernated: 1, closed: 0 });
  });

  it("without persistence there is nothing to adopt, and it says so honestly", async () => {
    const { workers } = registry({ store: null });
    expect(await workers.adopt()).toEqual({ hibernated: 0, closed: 0, orphans: [] });
  });
});
