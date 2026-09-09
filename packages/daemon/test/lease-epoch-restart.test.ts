import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  DaemonConfig,
  OmniError,
  type AgentCapabilitiesSnapshot,
  type AuthContext,
  type ClientRef,
  type EventLog,
  type Lease,
  type LeaseEventPayload,
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

/**
 * §16.1 rule L7's other half, END TO END: **the fencing epoch is monotonic per worker, ACROSS a
 * daemon restart** — and ruling M1-R8's audited transfer depends on it.
 *
 * Boot adoption already computes `snapshot.lease.epoch + 1`, persists it into the row, and
 * announces it in band as `omni.lease{op:"expired", how:"daemon_restart"}` at the next `seq` a
 * reconnecting client expects (`boot-recovery.test.ts` pins that side). What this file pins is
 * that the LIVE lease the same daemon then reports agrees with what it just published: a
 * rehydrated worker whose lease restarted at 0 would re-issue numbers its own log has already
 * spent, so a replay would read 1 -> 2 -> 1 and `isStaleEpoch` — exact equality — would accept a
 * fence minted before the crash.
 *
 * The REAL `createLease` and the REAL `createRehydratedWorker` are used (no `@omni-acp/core`
 * mock, unlike the sibling suites), because a double's lease is precisely the thing under test.
 */

const DAEMON_ID = `d_${"0".repeat(25)}1`;
const CURRENT_BOOT = "boot_fake_current";
const DEAD_BOOT = "boot_the_one_that_died";

/** ~800 leaked `/tmp` directories per full run without this; see `support/temp-dirs.ts`. */
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

function auth(o?: { epoch?: number }): AuthContext {
  const clientRef: ClientRef = {
    tokenId: "t",
    clientId: "cli_a",
    ...(o?.epoch === undefined ? {} : { epoch: o.epoch }),
  };
  return {
    tokenId: "t",
    role: "user",
    clientId: "cli_a",
    leaseEpoch: o?.epoch ?? null,
    agents: "*",
    cwdRoots: [tmpdir()],
    maxWorkers: 16,
    assertAgent: () => {},
    assertCwd: (cwd: string) => Promise.resolve(cwd),
    canSee: (w: WorkerSnapshot) => w.ownerTokenId === "t",
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

/** A row a PREVIOUS boot left `ready` — a SIGKILLed daemon, which is §15.7's own case. */
function abandonedRow(cwd: string, epoch: number): WorkerRow {
  const workerId = someWorkerId(80);
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
    // No fingerprint: nothing is signalled, so the reap is a recorded SKIP and the adoption
    // under test runs exactly as it does on the platform that cannot prove a pid (§14.9).
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
      epoch,
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
    bootId: DEAD_BOOT,
    closeResult: null,
    lastActiveMs: 1_000,
    closedAtMs: null,
    hibernateIdleMs: 1_800_000,
  };
}

async function booted(o: { epoch: number }): Promise<{
  workers: ReturnType<typeof createWorkerRegistry>;
  workerId: WorkerId;
  leaseEnvelopes: LeaseEventPayload[];
}> {
  const cwd = await tempRoot("omni-lease-epoch-");
  const resolved = DaemonConfig.parse({
    dataDir: tmpdir(),
    tokens: [{ id: "t", secretSha256: "a".repeat(64) }],
    agents: [{ id: "claude", command: process.execPath, args: ["-e", "0"] }],
  } as Parameters<typeof DaemonConfig.parse>[0]) as ResolvedDaemonConfig;

  const store = fakePersistence({ bootId: CURRENT_BOOT });
  store.seed(abandonedRow(cwd, o.epoch));

  const workers = createWorkerRegistry({
    daemonId: DAEMON_ID,
    config: resolved,
    catalog: createCatalog(resolved),
    supervisor: fakeSupervisor(),
    responder: { decide: () => ({ response: null, record: {} as never }) },
    clock: fakeClock(),
    ids: seqIds(),
    logger: nullLogger(),
    persistence: store,
    // Exactly what `create-daemon.ts` composes, including the fourth argument. Without it the
    // rehydrated lease would be born at epoch 0 and this file's subject would be unobservable.
    leaseFactory: (owner, workerId, log: EventLog, initialEpoch): Lease =>
      createLease({
        workerId,
        clock: fakeClock(),
        config: resolved.lease,
        initialHolder: owner,
        initialEpoch,
        onEvent: (payload) => {
          log.append({ kind: "omni.lease", payloadVersion: 2, turnId: null, payload });
        },
      }),
  });

  await workers.adopt();
  const workerId = someWorkerId(80);
  const leaseEnvelopes =
    store.stored.get(workerId)?.flatMap((e) => (e.kind === "omni.lease" ? [e.payload] : [])) ?? [];
  return { workers, workerId, leaseEnvelopes };
}

describe("the lease epoch survives a restart (§16.1 rule L7, M1-R8)", () => {
  it("the live lease reports the epoch boot adoption PUBLISHED, not 0", async () => {
    const { workers, workerId, leaseEnvelopes } = await booted({ epoch: 2 });

    const announced = leaseEnvelopes.find((p) => p.how === "daemon_restart");
    expect(announced?.op).toBe("expired");
    // Rule L7: expiry bumps. The row said 2, so the client is told 3.
    expect(announced?.lease.epoch).toBe(3);

    // …and the daemon that said it agrees. This is the whole defect: `GET /v1/workers/{id}`
    // used to answer 0 for a worker whose own log had just announced 3.
    const live = workers.snapshot(workerId, auth());
    expect(live.lease.epoch).toBe(announced?.lease.epoch);
    // The HOLDER is still dropped (M1-R8): a lease over a process that no longer exists is
    // meaningless, and reviving it would 423 the owner forever (§16.1 rule L4).
    expect(live.lease.holder).toBeNull();
  });

  it("a prompt carrying that epoch is NOT 423, and one carrying the pre-crash epoch is", async () => {
    const { workers, workerId, leaseEnvelopes } = await booted({ epoch: 2 });
    const epoch = leaseEnvelopes.find((p) => p.how === "daemon_restart")?.lease.epoch ?? 0;
    expect(epoch).toBe(3);

    // The PRE-CRASH value is a fence this worker has already spent. `isStaleEpoch` is exact
    // equality, so a lease that restarted at 0 would have made 1 valid again here — the same
    // number the log already used for the holder that died.
    const stale = await workers
      .prompt(workerId, auth({ epoch: 2 }), { content: [{ type: "text", text: "hi" }] })
      .then(
        () => null,
        (e: unknown) => e as OmniError,
      );
    expect(OmniError.is(stale, "lease_held")).toBe(true);
    // Rule L10: the 423 body NAMES the epoch, so the refused client learns the current value
    // rather than having to re-GET the worker and race a third holder.
    expect((stale as OmniError).lease?.epoch).toBe(3);

    // The CURRENT value is accepted. The prompt itself still has to wake a worker whose process
    // belonged to a dead boot, and this fake supervisor's agent will not complete a handshake —
    // so what is asserted is the LEASE answer, which is the one this file is about.
    const current = await workers
      .prompt(workerId, auth({ epoch }), { content: [{ type: "text", text: "hi" }] })
      .then(
        () => null,
        (e: unknown) => e as OmniError,
      );
    expect(OmniError.is(current, "lease_held")).toBe(false);
  });

  it("an unseeded lease is unaffected: holder-ful is still born at epoch 1", () => {
    const resolved = DaemonConfig.parse({
      dataDir: tmpdir(),
      tokens: [{ id: "t", secretSha256: "a".repeat(64) }],
    } as Parameters<typeof DaemonConfig.parse>[0]) as ResolvedDaemonConfig;
    const lease = createLease({
      workerId: someWorkerId(81),
      clock: fakeClock(),
      config: resolved.lease,
      initialHolder: { tokenId: "t", clientId: "cli_a" },
    });
    expect(lease.snapshot().epoch).toBe(1);
  });
});
