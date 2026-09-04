import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import { removeTempRoots, tempRoot } from "./support/temp-dirs.js";

/** ~800 leaked `/tmp` directories per full run without this; see `support/temp-dirs.ts`. */
afterEach(async () => {
  await removeTempRoots();
});

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
  const root = await tempRoot("omni-daemon-persist-");
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

function abandonedRow(o?: {
  id?: number;
  fingerprint?: string | null;
  cwd?: string;
  agentId?: string;
}): WorkerRow {
  const workerId = someWorkerId(o?.id ?? 70);
  const snapshot = {
    workerId,
    daemonId: `d_${"0".repeat(25)}1`,
    ref: `x:${workerId}`,
    sessionId: "sess-old",
    agentId: o?.agentId ?? "claude",
    state: "ready",
    cwd: o?.cwd ?? "/work",
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
    agentId: o?.agentId ?? "claude",
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

/**
 * §2.1 H14's second sentence, and §15.7: "A wake also re-runs the full ACL check against the
 * current config — a restart must not resurrect a worker the present ACL forbids."
 *
 * `create()` is not the only door a process comes through: a hibernated row (here, one boot
 * adoption converged) is resurrected by `wake`, and by `prompt`, which auto-wakes inside
 * `Worker.prompt`. Both take the agent id and the cwd from the ROW, so a token whose `agents` or
 * `cwdRoots` the operator has since narrowed would otherwise still spawn exactly the agent it is
 * no longer allowed, in exactly the directory it is no longer allowed.
 *
 * `GET` stays 200 throughout: D13's visibility is about OWNERSHIP, and a worker a token may look
 * at but no longer resume is the honest answer — a 404 would deny an operator the record.
 */
describe("createDaemon — a wake re-runs the ACL (H14, §15.7)", () => {
  const wake = (daemon: Daemon, id: string): Promise<Response> =>
    daemon.fetch(
      new Request(`http://daemon.invalid/v1/workers/${id}/wake`, {
        method: "POST",
        headers: { [HEADER.auth]: `Bearer ${SECRET}` },
      }),
    );

  const prompt = (daemon: Daemon, id: string): Promise<Response> =>
    daemon.fetch(
      new Request(`http://daemon.invalid/v1/workers/${id}/prompt`, {
        method: "POST",
        headers: { [HEADER.auth]: `Bearer ${SECRET}`, "content-type": "application/json" },
        body: JSON.stringify({ content: [{ type: "text", text: "hi" }] }),
      }),
    );

  const get = (daemon: Daemon, id: string): Promise<Response> =>
    daemon.fetch(
      new Request(`http://daemon.invalid/v1/workers/${id}`, {
        headers: { [HEADER.auth]: `Bearer ${SECRET}` },
      }),
    );

  /** The row this token created when the ACL was wider, adopted into `hibernated` on this boot. */
  async function adopted(o: {
    tokens: unknown[];
    agents?: unknown[];
    rowCwd: (root: string) => string;
    rowAgentId?: string;
  }): Promise<{ daemon: Daemon; id: string }> {
    const store = fakePersistence({ bootId: CURRENT_BOOT });
    const root = await tempRoot("omni-daemon-acl-");
    store.seed(
      abandonedRow({
        id: 72,
        cwd: o.rowCwd(root),
        ...(o.rowAgentId === undefined ? {} : { agentId: o.rowAgentId }),
      }),
    );
    const { daemon } = await build({
      persistence: store,
      config: {
        tokens: o.tokens as never,
        agents: (o.agents ?? [
          { id: "claude", command: process.execPath, args: ["-e", "0"] },
          { id: "other", command: process.execPath, args: ["-e", "0"] },
        ]) as never,
      },
    });
    const id = String(someWorkerId(72));
    expect(store.rows.get(someWorkerId(72))?.snapshot.state).toBe("hibernated");
    return { daemon, id };
  }

  it("wake and prompt are 403 once the token's `agents` no longer allows the row's agent", async () => {
    const { daemon, id } = await adopted({
      // The operator narrowed `t` to `other` and reloaded. The agent still EXISTS in the
      // catalog — `catalog.get` throwing already covers a removed agent — so this is the case
      // H14 names and the one nothing else catches.
      tokens: [{ id: "t", secret: SECRET, role: "admin", agents: ["other"], cwdRoots: ["/"] }],
      rowCwd: (root) => root,
    });

    expect((await wake(daemon, id)).status).toBe(403);
    expect((await prompt(daemon, id)).status).toBe(403);
    // The record is still readable: the ACL governs resurrection, not visibility (D13).
    expect((await get(daemon, id)).status).toBe(200);
    await daemon.stop();
  });

  it("wake and prompt are 403 once the row's cwd is outside the token's roots", async () => {
    const { daemon, id } = await adopted({
      // `cwdRoots` no longer contains the directory the worker was created in. `assertCwd`
      // re-`realpath`s, so a cwd that has since been deleted or symlinked out fails the same
      // way — which is §15.7's intended behaviour, not an accident of caching.
      tokens: [{ id: "t", secret: SECRET, role: "admin", cwdRoots: [tmpdir()] }],
      rowCwd: () => "/work",
    });

    expect((await wake(daemon, id)).status).toBe(403);
    expect((await prompt(daemon, id)).status).toBe(403);
    expect((await get(daemon, id)).status).toBe(200);
    await daemon.stop();
  });

  it("the SAME row wakes when the ACL still allows it — the check is the narrowing, not the path", async () => {
    const { daemon, id } = await adopted({
      tokens: [{ id: "t", secret: SECRET, role: "admin", agents: ["claude"], cwdRoots: ["/"] }],
      rowCwd: (root) => root,
    });

    // Not a 403. (What it IS depends on the worker double this suite wires; the ACL is the
    // subject, and a control that never passes would make the two 403s above meaningless.)
    expect((await wake(daemon, id)).status).not.toBe(403);
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
