import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openPersistence } from "@omni-acp/core";
import {
  EventLogConfig,
  type DaemonConfig,
  type DeliveryId,
  type PersistenceHandle,
  type WebhookDispatcher,
  type WorkerSnapshot,
} from "@omni-acp/protocol";
import { fakeSupervisor, nullLogger, sdkExampleAgentPath } from "@omni-acp/testkit";
import { createDaemon } from "../src/create-daemon.js";
import { systemClock } from "../src/clock.js";

/**
 * M2-WP-J acceptance 7: `create-daemon.ts` flips six defaults, and the BOOT and STOP orders are
 * asserted by a recording test rather than by reading the file.
 *
 *     boot:  persistence → worker adopt → run recover → delivery requeue → dispatcher.start → listen
 *     stop:  interactions.settleAll → dispatcher.drain(bounded) → workers → socket
 *
 * Every arrow is load-bearing (§24.4): recovering runs before workers were adopted would abandon
 * runs whose workers were about to be rehydrated, and starting the dispatcher before the requeue
 * would let it claim rows a previous boot still owns. On the way down, settling first is §19.8 —
 * an agent BLOCKED on our answer may never read the shutdown.
 *
 * Owned by M2-WP-J.
 */

const TOKEN = "m2-wiring-token-0123456789abcdef";

const dirs: string[] = [];
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close().catch(() => undefined);
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/**
 * A REAL durable handle whose three recovery entry points announce themselves.
 *
 * The wrapper is explicit rather than a `Proxy`: the three methods below are the boot steps, and
 * a proxy that recorded everything would turn this test into a transcript nobody can read.
 */
function recording(handle: PersistenceHandle, order: string[]): PersistenceHandle {
  const h = handle as PersistenceHandle & {
    runs: { liveFromOtherBoots(bootId: string): unknown[] };
    deliveries: { requeueStale(bootId: string, nowMs: number): number };
    transaction<T>(fn: () => T): T;
  };
  return {
    ...h,
    workers: {
      ...h.workers,
      // Adoption's own query (§15.7): the rows a PREVIOUS boot left live. `list()` is not it —
      // that is what `GET /v1/workers` reads — so recording the wrong one would make this test
      // agree with any order at all.
      abandoned: (bootId: string) => {
        order.push("worker adopt");
        return h.workers.abandoned(bootId);
      },
      upsert: (row) => {
        // The close writes the row twice — once from the state listener and once with the
        // persisted `CloseResult` (§15.6) — and the SECOND is not a second close.
        if (row.snapshot.state === "closed" && !order.includes("worker closed")) {
          order.push("worker closed");
        }
        h.workers.upsert(row);
      },
    },
    runs: {
      ...h.runs,
      liveFromOtherBoots: (bootId: string) => {
        order.push("run recover");
        return h.runs.liveFromOtherBoots(bootId);
      },
    },
    deliveries: {
      ...h.deliveries,
      requeueStale: (bootId: string, nowMs: number) => {
        order.push("delivery requeue");
        return h.deliveries.requeueStale(bootId, nowMs);
      },
    },
    transaction: <T>(fn: () => T): T => h.transaction(fn),
  } as unknown as PersistenceHandle;
}

/** A dispatcher that records its lifecycle and delivers nothing. */
function recordingDispatcher(order: string[]): WebhookDispatcher {
  return {
    start: () => {
      order.push("dispatcher.start");
    },
    dispatch: () => "dl_00000000000000000000000001" as DeliveryId,
    redeliver: () => Promise.reject(new Error("not used")),
    drain: () => {
      order.push("dispatcher.drain");
      return Promise.resolve();
    },
    stop: () => {
      order.push("dispatcher.stop");
      return Promise.resolve();
    },
  };
}

async function baseConfig(o: { dataDir: string; workspace: string }): Promise<DaemonConfig> {
  return {
    dataDir: o.dataDir,
    listen: { host: "127.0.0.1", port: 0 },
    logLevel: "warn",
    eventLog: { driver: "sqlite" },
    tokens: [{ id: "t", secret: TOKEN, role: "admin", cwdRoots: [o.workspace] }],
    agents: [{ id: "sdk", command: process.execPath, args: [sdkExampleAgentPath()] }],
  };
}

describe("createDaemon — M2's six defaults and the two orders (§24.4, acceptance 7)", () => {
  it("boots persistence → adopt → run recover → delivery requeue → dispatcher.start → listen", async () => {
    const dataDir = await tempDir("omni-m2-boot-");
    const workspace = await tempDir("omni-m2-ws-");
    const order: string[] = [];

    const handle = await openPersistence({
      dataDir,
      config: EventLogConfig.parse({ driver: "sqlite" }),
      clock: systemClock(),
      logger: nullLogger(),
    });
    const daemon = await createDaemon(await baseConfig({ dataDir, workspace }), {
      persistence: recording(handle, order),
      supervisor: fakeSupervisor(),
      webhooks: recordingDispatcher(order),
    });
    closers.push(async () => {
      await daemon.stop({ graceful: false }).catch(() => undefined);
      handle.close();
    });

    // Everything above happened INSIDE `createDaemon`, and the socket is not bound yet: "listen"
    // is last by construction rather than by ordering luck.
    expect(order).toEqual(["worker adopt", "run recover", "delivery requeue", "dispatcher.start"]);
    expect(daemon.url).toBeNull();

    await daemon.start();
    expect(daemon.url).not.toBeNull();
  });

  it("stops dispatcher.drain → dispatcher.stop → workers → socket", async () => {
    const dataDir = await tempDir("omni-m2-stop-");
    const workspace = await tempDir("omni-m2-ws-");
    const order: string[] = [];

    const handle = await openPersistence({
      dataDir,
      config: EventLogConfig.parse({ driver: "sqlite" }),
      clock: systemClock(),
      logger: nullLogger(),
    });
    const daemon = await createDaemon(await baseConfig({ dataDir, workspace }), {
      persistence: recording(handle, order),
      supervisor: fakeSupervisor(),
      webhooks: recordingDispatcher(order),
    });
    closers.push(() => Promise.resolve(handle.close()));
    await daemon.start();
    const url = daemon.url ?? "";

    await daemon.workers.create(
      { agent: "sdk", cwd: workspace },
      daemon.authContextFor("t", "cli_1"),
    );
    order.length = 0;

    await daemon.stop({ graceful: true });

    // The DRAIN is bounded and comes first, the workers close after it, and the socket is the
    // last thing to go — a `fetch` against the old url now fails to connect.
    expect(order).toEqual(["dispatcher.drain", "dispatcher.stop", "worker closed"]);
    expect(daemon.url).toBeNull();
    await expect(fetch(`${url}/v1/info`)).rejects.toThrow();
  });

  it("flips the six defaults: a worker created through the daemon carries every M2 row", async () => {
    const dataDir = await tempDir("omni-m2-defaults-");
    const workspace = await tempDir("omni-m2-ws-");
    const config = await baseConfig({ dataDir, workspace });
    const daemon = await createDaemon(
      {
        ...config,
        listen: null,
        // The one default that is config-gated rather than deps-gated: a daemon that ran `git` on
        // every turn without being asked would touch the operator's repository because it could.
        diff: { provider: "git" },
        watchdog: { silentMs: 300_000, toolMs: 30_000, cancelTimeoutMs: 60_000 },
      },
      { supervisor: fakeSupervisor() },
    );
    closers.push(() => daemon.stop({ graceful: false }));

    const handle = await daemon.workers.create(
      { agent: "sdk", cwd: workspace, onUnresolved: "park", parkTimeoutMs: 0 },
      daemon.authContextFor("t", "cli_1"),
    );
    const snapshot: WorkerSnapshot = handle.snapshot();

    // 1. interactions: the strategy is wired, so the worker knows its own disposition and D10's
    //    gate has something to read.
    expect(snapshot.onUnresolved).toBe("park");
    expect(snapshot.parkTimeoutMs).toBeNull();
    expect(snapshot.parkTimeoutAction).toBe("deny");
    expect(snapshot.interactions).toEqual([]);
    // 2. watchdog: the RESOLVED budgets, so an operator reads them without re-deriving config.
    expect(snapshot.watchdog).toMatchObject({
      silentMs: 300_000,
      toolMs: 30_000,
      cancelTimeoutMs: 60_000,
    });
    // 3. policy: a real engine decided, and it names the preset it came from.
    expect(snapshot.policy).toMatchObject({ sources: ["deny-all"], default: "deny" });
    // 4. diff: the provider is wired and this worker is not opted out.
    expect(snapshot.patchMode).toBe("on_write");
    // 5-6. mcp / env: reported, never silent — an empty request is an empty report.
    expect(snapshot.mcp).toEqual({ requested: [], applied: [], dropped: [] });
    expect(snapshot.envKeys).toEqual([]);

    // The Run API answers rather than throwing "not enabled" — `runs` is the sixth default.
    expect(daemon.runs.list(daemon.authContextFor("t", "cli_1"))).toEqual([]);
    expect(daemon.deliveries.list({ limit: 10 })).toEqual({ rows: [], cursor: null });
  });

  it("a worker that opts out of the patch gets no provider, and says so", async () => {
    const dataDir = await tempDir("omni-m2-nopatch-");
    const workspace = await tempDir("omni-m2-ws-");
    const daemon = await createDaemon(
      { ...(await baseConfig({ dataDir, workspace })), listen: null, diff: { provider: "git" } },
      { supervisor: fakeSupervisor() },
    );
    closers.push(() => daemon.stop({ graceful: false }));

    const handle = await daemon.workers.create(
      { agent: "sdk", cwd: workspace, patch: "off" },
      daemon.authContextFor("t", "cli_1"),
    );
    expect(handle.snapshot().patchMode).toBe("off");
  });

  it("refuses a per-worker watchdog whose cancelTimeoutMs would beat turn.cancelGraceMs", async () => {
    const dataDir = await tempDir("omni-m2-budget-");
    const workspace = await tempDir("omni-m2-ws-");
    const daemon = await createDaemon(
      { ...(await baseConfig({ dataDir, workspace })), listen: null },
      { supervisor: fakeSupervisor() },
    );
    closers.push(() => daemon.stop({ graceful: false }));

    // Daemon-wide this is a config LOAD error (§21.5); per worker it has to be refused HERE, or
    // the override would be the one way to reach the state the load check exists to forbid.
    await expect(
      daemon.workers.create(
        { agent: "sdk", cwd: workspace, watchdog: { cancelTimeoutMs: 1 } },
        daemon.authContextFor("t", "cli_1"),
      ),
    ).rejects.toThrow(/cancelTimeoutMs/);
  });
});
