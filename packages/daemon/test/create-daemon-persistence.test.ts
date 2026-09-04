import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  HEADER,
  type AgentCapabilitiesSnapshot,
  type DaemonConfig as DaemonConfigInput,
  type DaemonInfo,
  type PersistenceHandle,
  type ProcessInfo,
  type WorkerRow,
  type WorkerSnapshot,
} from "@omni-acp/protocol";
import { fakeSupervisor, nullLogger, seqIds, type FakeSupervisor } from "@omni-acp/testkit";
import { createDaemon } from "../src/create-daemon.js";
import type { Daemon } from "../src/types.js";
import { someWorkerId } from "./fake-core.js";
import { fakePersistence, type FakePersistence } from "./fake-persistence.js";

vi.mock("@omni-acp/core", async (importOriginal) => {
  const { fakeCoreModule } = await import("./fake-core.js");
  return await fakeCoreModule(importOriginal as never);
});

const SECRET = "the-only-valid-secret-0123456789";
const CURRENT_BOOT = "boot_fake_current";

async function build(o?: {
  persistence?: PersistenceHandle | null;
  config?: Partial<DaemonConfigInput>;
}): Promise<{ daemon: Daemon; supervisor: FakeSupervisor; dataDir: string; root: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "omni-daemon-persist-")));
  const dataDir = join(root, "data");
  const supervisor = fakeSupervisor();
  const daemon = await createDaemon(
    {
      dataDir,
      listen: null,
      tokens: [{ id: "t", secret: SECRET, role: "admin", cwdRoots: [root] }],
      agents: [{ id: "claude", command: process.execPath, args: ["-e", "0"] }],
      logLevel: "silent",
      ...o?.config,
    },
    {
      supervisor,
      ids: seqIds(),
      logger: nullLogger(),
      ...(o?.persistence == null ? {} : { persistence: o.persistence }),
    },
  );
  return { daemon, supervisor, dataDir, root };
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

const processInfo = (fingerprint: string | null): ProcessInfo => ({
  pid: 4242,
  groupId: 4242,
  startedAt: "2026-09-03T23:00:00.000Z",
  command: "npx",
  argsRedacted: [],
  fingerprint,
});

function abandonedRow(o?: { id?: number; fingerprint?: string | null }): WorkerRow {
  const workerId = someWorkerId(o?.id ?? 70);
  const snapshot = {
    workerId,
    daemonId: `d_${"0".repeat(25)}1`,
    ref: `x:${workerId}`,
    sessionId: "sess-old",
    agentId: "claude",
    state: "ready",
    cwd: "/work",
    label: null,
    ownerTokenId: "t",
    createdAt: "2026-09-03T22:00:00.000Z",
    updatedAt: "2026-09-03T23:00:00.000Z",
    headSeq: 3,
    currentTurnId: null,
    capabilities: RESUMABLE,
    process: processInfo(o?.fingerprint === undefined ? "linux:1:2" : o.fingerprint),
    closeReason: null,
    lease: { workerId, holder: null, epoch: 0, expiresAt: null, acquiredAt: null, pinned: false },
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

/**
 * WP-E acceptance 5 and 9: `createDaemon` opens persistence → runs boot adoption → arms
 * retention; `stop()` closes the store AFTER `closeAll`; and `GET /v1/info` reports
 * `persistence`, `bootId` and `orphansAtStart` honestly.
 */
describe("createDaemon — the boot sequence (§14, §15.7)", () => {
  it("takes the bootId from the STORE, not from a fresh per-process value", async () => {
    const store = fakePersistence({ bootId: "boot_from_the_store" });
    const { daemon } = await build({ persistence: store });
    expect(daemon.info.bootId).toBe("boot_from_the_store");
    await daemon.stop();
  });

  it("invents a per-process bootId for the memory driver, which is the honest answer", async () => {
    const { daemon } = await build();
    expect(daemon.info.bootId).toMatch(/^boot_/);
    await daemon.stop();
  });

  it("runs boot adoption BEFORE start() returns, and reports it in orphansAtStart", async () => {
    const store = fakePersistence({ bootId: CURRENT_BOOT });
    store.seed(abandonedRow({ id: 70 }));
    store.seed(abandonedRow({ id: 71 }));
    const { daemon } = await build({ persistence: store });

    expect(daemon.info.orphansAtStart).toEqual({ found: 2, reaped: 2, skipped: 0 });
    // Converged before anything could bind a port.
    expect(store.rows.get(someWorkerId(70))?.snapshot.state).toBe("hibernated");
    expect(store.rows.get(someWorkerId(71))?.bootId).toBe(CURRENT_BOOT);
    await daemon.stop();
  });

  it("reports `{found:n, reaped:0, skipped:n}` when nothing can be fingerprinted (Windows)", async () => {
    const store = fakePersistence({ bootId: CURRENT_BOOT });
    store.seed(abandonedRow({ id: 70, fingerprint: null }));
    store.seed(abandonedRow({ id: 71, fingerprint: null }));
    const { daemon } = await build({ persistence: store });
    // §14.9's honesty contract: a Windows operator sees the skip, not a quiet lie.
    expect(daemon.info.orphansAtStart).toEqual({ found: 2, reaped: 0, skipped: 2 });
    await daemon.stop();
  });

  it("reports zeroes with no store, because nothing survived to be adopted", async () => {
    const { daemon } = await build();
    expect(daemon.info.orphansAtStart).toEqual({ found: 0, reaped: 0, skipped: 0 });
    await daemon.stop();
  });

  it("makes the adopted worker visible through the ordinary API", async () => {
    const store = fakePersistence({ bootId: CURRENT_BOOT });
    store.seed(abandonedRow({ id: 70 }));
    const { daemon } = await build({ persistence: store });

    const res = await daemon.fetch(
      new Request("http://daemon.invalid/v1/workers", {
        headers: { [HEADER.auth]: `Bearer ${SECRET}` },
      }),
    );
    const body = (await res.json()) as { workers: WorkerSnapshot[] };
    expect(body.workers.map((w) => [w.workerId, w.state])).toEqual([
      [someWorkerId(70), "hibernated"],
    ]);
    await daemon.stop();
  });

  it("is a NO-OP on a second boot over the same store", async () => {
    const store = fakePersistence({ bootId: CURRENT_BOOT });
    store.seed(abandonedRow({ id: 70 }));
    const first = await build({ persistence: store });
    expect(first.daemon.info.orphansAtStart.found).toBe(1);
    await first.daemon.stop();

    const second = await build({ persistence: store });
    expect(second.daemon.info.orphansAtStart).toEqual({ found: 0, reaped: 0, skipped: 0 });
    await second.daemon.stop();
  });

  it("arms retention, and `lastSweep` is null until one has run", async () => {
    const store = fakePersistence();
    const { daemon } = await build({ persistence: store });
    expect(daemon.info.persistence.lastSweep).toBeNull();
    expect(store.sweeps).toBe(0);
    await daemon.stop();
  });
});

describe("createDaemon — GET /v1/info tells the truth about persistence (§14.9, H21)", () => {
  const info = async (daemon: Daemon): Promise<DaemonInfo> => {
    const res = await daemon.fetch(
      new Request("http://daemon.invalid/v1/info", {
        headers: { [HEADER.auth]: `Bearer ${SECRET}` },
      }),
    );
    return (await res.json()) as DaemonInfo;
  };

  it("says `memory` with no file when nothing survives a restart", async () => {
    const { daemon } = await build();
    expect(await info(daemon)).toMatchObject({
      persistence: { driver: "memory", file: null, schemaVersion: 0, writeFailures: 0 },
    });
    await daemon.stop();
  });

  it("reports the STORE's own diagnostics when there is one, not the configured value", async () => {
    const store = fakePersistence();
    const { daemon } = await build({ persistence: store });
    const body = await info(daemon);
    expect(body.persistence).toMatchObject({
      driver: "memory",
      file: "<fake>",
      schemaVersion: 1,
      retentionDays: 7,
    });
    await daemon.stop();
  });

  it("`writeFailures` is LIVE: a store that starts failing is visible without a restart", async () => {
    const store = fakePersistence();
    const { daemon, root } = await build({ persistence: store });
    expect((await info(daemon)).persistence.writeFailures).toBe(0);

    store.failWrites = true;
    const auth = daemon.authContextFor("t");
    await daemon.workers.create({ agent: "claude", cwd: root }, auth);

    // The whole point of the field: an operator reads it BEFORE the log turns out to be missing.
    expect((await info(daemon)).persistence.writeFailures).toBeGreaterThan(0);
    await daemon.stop();
  });

  it("`retentionDays` reflects the configured bound, so a client can reason about a 404", async () => {
    const { daemon } = await build({ config: { eventLog: { retentionDays: 30 } } });
    expect((await info(daemon)).persistence.retentionDays).toBe(30);
    await daemon.stop();
  });
});

describe("createDaemon — stop() closes the store AFTER closeAll (acceptance 5)", () => {
  it("the closing envelopes reach the store before it is closed", async () => {
    const store = fakePersistence();
    const { daemon, root } = await build({ persistence: store });
    const auth = daemon.authContextFor("t");
    const handle = await daemon.workers.create({ agent: "claude", cwd: root }, auth);

    await daemon.stop();

    const kinds = (store.stored.get(handle.id) ?? []).map((e) => e.kind);
    // `closeAll` appends `omni.worker_state{closed}`; closing the store first would drop exactly
    // the envelope that tells the next boot this worker shut down cleanly.
    expect(kinds.filter((k) => k === "omni.worker_state").length).toBeGreaterThanOrEqual(2);
    const last = (store.stored.get(handle.id) ?? []).at(-1);
    expect(last?.payload).toMatchObject({ state: "closed" });
  });

  it("does NOT close a store the embedder injected — it is not ours to close", async () => {
    const store = fakePersistence();
    const { daemon } = await build({ persistence: store });
    await daemon.stop();
    expect(store.closed).toBe(false);
  });

  it("is idempotent, and a second stop() does not re-close anything", async () => {
    const store = fakePersistence();
    const { daemon } = await build({ persistence: store });
    await daemon.stop();
    await expect(daemon.stop()).resolves.toBeUndefined();
  });
});

describe("createDaemon — the descriptor governs the workers it creates (§17.1)", () => {
  it("stamps the catalog's runtimeId onto the worker, so the log and the catalog agree", async () => {
    const { daemon, root } = await build();
    const auth = daemon.authContextFor("t");
    const handle = await daemon.workers.create({ agent: "claude", cwd: root }, auth);
    const entry = daemon.catalog.list().find((a) => a.id === "claude");
    // The fake worker reports `deps.runtimeId`; the value is the catalog's, not a second
    // computation of the same digest.
    expect(entry?.runtimeId).toMatch(/^claude@[0-9a-f]{12}$/);
    expect(handle.snapshot().agentId).toBe("claude");
    await daemon.stop();
  });
});
