/**
 * A closed worker must not leave its lease's TTL timer armed.
 *
 * `createLease` arms a `setTimer(ttlMs)` (15 min by default) whenever it has a holder. The worker
 * releases the lease on hibernate but never on CLOSE — so after `DELETE` (or `daemon.stop()`) a
 * referenced timer outlived the worker, and an embedded daemon's process (`OmniACP.local()`, the
 * CLI after SIGINT) stayed alive for the rest of the TTL. Found by running examples/01-local.mjs:
 * everything printed, `daemon stopped` was logged, and node did not exit.
 *
 * The registry's close bookkeeping (`onClosed`, attached to `handle.closed` on both the create
 * and the rehydrate path) now calls `lease.close()`. This test drives the rehydrate path — the
 * same shape as lease-epoch-restart.test.ts — with ONE shared fake clock, so "no timer left" is
 * a count, not an inference.
 */
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  DaemonConfig,
  type AgentCapabilitiesSnapshot,
  type AuthContext,
  type ClientRef,
  type EventLog,
  type Lease,
  type ResolvedDaemonConfig,
  type WorkerId,
  type WorkerRow,
  type WorkerSnapshot,
} from "@omni-acp/protocol";
import { createLease } from "@omni-acp/core";
import { fakeClock, fakeSupervisor, nullLogger, seqIds } from "@omni-acp/testkit";
import { createCatalog } from "../src/catalog.js";
import { createWorkerRegistry } from "../src/registry.js";
import { someWorkerId } from "./fake-core.js";
import { fakePersistence } from "./fake-persistence.js";
import { removeTempRoots, tempRoot } from "./support/temp-dirs.js";

const DAEMON_ID = `d_${"0".repeat(25)}1`;

afterEach(async () => {
  await removeTempRoots();
});

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

function auth(): AuthContext {
  const clientRef: ClientRef = { tokenId: "t", clientId: "cli_a" };
  return {
    tokenId: "t",
    role: "admin",
    clientId: "cli_a",
    leaseEpoch: null,
    agents: "*",
    cwdRoots: [tmpdir()],
    maxWorkers: 16,
    assertAgent: () => {},
    assertCwd: (cwd: string) => Promise.resolve(cwd),
    canSee: () => true,
    asClientRef: () => clientRef,
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

function abandonedRow(cwd: string): WorkerRow {
  const workerId = someWorkerId(81);
  const snapshot = {
    workerId,
    daemonId: DAEMON_ID,
    ref: `${DAEMON_ID}:${workerId}`,
    sessionId: "sess-old",
    agentId: "claude",
    state: "ready",
    cwd,
    label: null,
    ownerTokenId: "t",
    createdAt: "2026-09-03T22:00:00.000Z",
    updatedAt: "2026-09-03T23:00:00.000Z",
    headSeq: 12,
    currentTurnId: null,
    capabilities: RESUMABLE,
    process: {
      pid: 4242,
      groupId: 4242,
      startedAt: "2026-09-03T23:00:00.000Z",
      command: "npx",
      argsRedacted: [],
      fingerprint: null,
    },
    closeReason: null,
    lease: {
      workerId,
      holder: { tokenId: "t", clientId: "cli_gone" },
      epoch: 1,
      expiresAt: null,
      acquiredAt: "2026-09-03T22:30:00.000Z",
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
    bootId: "boot_the_one_that_died",
    closeResult: null,
    lastActiveMs: 1_000,
    closedAtMs: null,
    hibernateIdleMs: 1_800_000,
  };
}

async function booted(): Promise<{
  workers: ReturnType<typeof createWorkerRegistry>;
  workerId: WorkerId;
  clock: ReturnType<typeof fakeClock>;
}> {
  const cwd = await tempRoot("omni-lease-timer-");
  const resolved = DaemonConfig.parse({
    dataDir: tmpdir(),
    tokens: [{ id: "t", secretSha256: "a".repeat(64) }],
    agents: [{ id: "claude", command: process.execPath, args: ["-e", "0"] }],
  } as Parameters<typeof DaemonConfig.parse>[0]) as ResolvedDaemonConfig;
  const store = fakePersistence({ bootId: "boot_fake_current" });
  store.seed(abandonedRow(cwd));
  // ONE clock for the registry AND every lease, so the assertion below counts everything.
  const clock = fakeClock();
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
    leaseFactory: (owner, workerId, log: EventLog, initialEpoch): Lease =>
      createLease({
        workerId,
        clock,
        config: resolved.lease,
        initialHolder: owner,
        initialEpoch,
        onEvent: (payload) => {
          log.append({ kind: "omni.lease", payloadVersion: 2, turnId: null, payload });
        },
      }),
  });
  await workers.adopt();
  return { workers, workerId: someWorkerId(81), clock };
}

describe("a closed worker leaves no lease TTL timer behind", () => {
  it("acquire arms the TTL timer; DELETE cancels it (lease.close() on the closed promise)", async () => {
    const { workers, workerId, clock } = await booted();
    const a = auth();
    // Boot adoption dropped the dead holder; take the lease so the 15-minute TTL timer is armed.
    workers.lease(workerId, a, "acquire", {});
    const before = clock.pendingTimers;
    expect(before).toBeGreaterThan(0);

    await workers.delete(workerId, a);

    // Everything the worker and its lease scheduled on this clock is gone — the exact property
    // that lets an embedded daemon's process exit after stop().
    expect(clock.pendingTimers).toBe(0);
    expect(workers.snapshot(workerId, a).state).toBe("closed");
  });

  it("closeAll (the daemon.stop() path) cancels it too", async () => {
    const { workers, workerId, clock } = await booted();
    const a = auth();
    workers.lease(workerId, a, "acquire", {});
    expect(clock.pendingTimers).toBeGreaterThan(0);

    await workers.closeAll("daemon_shutdown");

    expect(clock.pendingTimers).toBe(0);
  });
});
