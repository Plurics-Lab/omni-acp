import { mkdtemp, readdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  DaemonConfig,
  OmniError,
  type PersistenceHandle,
  type ResolvedDaemonConfig,
} from "@omni-acp/protocol";
import { fakeClock, fakeSupervisor, nullLogger, seqIds } from "@omni-acp/testkit";
import { createDaemon } from "../src/create-daemon.js";
import { armRetention, openDaemonPersistence } from "../src/event-store.js";
import { fakePersistence } from "./fake-persistence.js";

const config = (o?: Record<string, unknown>): ResolvedDaemonConfig =>
  DaemonConfig.parse({
    dataDir: tmpdir(),
    tokens: [{ id: "t", secretSha256: "a".repeat(64) }],
    ...o,
  } as Parameters<typeof DaemonConfig.parse>[0]) as ResolvedDaemonConfig;

describe("openDaemonPersistence — the driver decides (ruling M1-R17)", () => {
  it('returns null for "memory", so createDaemon() leaves no file behind', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "omni-event-store-"));
    const handle = await openDaemonPersistence({
      config: config({ dataDir, eventLog: { driver: "memory" } }),
      clock: fakeClock(),
      logger: nullLogger(),
    });
    expect(handle).toBeNull();
    // Nothing was created; `OmniACP.local()` in a user's script must not leave a database.
    expect((await readdir(dataDir)).filter((e) => e.endsWith(".db"))).toEqual([]);
  });

  it('hands "sqlite" to M1-WP-A\'s openPersistence, config and all', async () => {
    // Reaching that body IS the assertion: the driver-gating decision is this module's, and the
    // store itself is M1-WP-A's (a throwing stub in this tree).
    await expect(
      openDaemonPersistence({
        config: config({ eventLog: { driver: "sqlite" } }),
        clock: fakeClock(),
        logger: nullLogger(),
      }),
    ).rejects.toThrow(/M1-WP-A/);
  });
});

describe("armRetention — §14.5's three bounds, on a timer", () => {
  it("does nothing at all with no store", () => {
    const clock = fakeClock();
    const timer = armRetention({
      persistence: null,
      config: config(),
      clock,
      logger: nullLogger(),
    });
    expect(clock.pendingTimers).toBe(0);
    expect(timer.sweepNow()).toBeNull();
    expect(timer.lastSweep).toBeNull();
    timer.stop();
  });

  it("sweeps on `retentionSweepMs`, and REARMS rather than queueing", () => {
    const clock = fakeClock();
    const store = fakePersistence();
    const timer = armRetention({
      persistence: store,
      config: config({ eventLog: { retentionSweepMs: 1_000 } }),
      clock,
      logger: nullLogger(),
    });

    expect(store.sweeps).toBe(0);
    clock.advance(1_000);
    expect(store.sweeps).toBe(1);
    clock.advance(1_000);
    expect(store.sweeps).toBe(2);
    // Rearmed, not intervalled: exactly one timer is outstanding at any moment, so a sweep that
    // overran its own period cannot stack a second one behind itself.
    expect(clock.pendingTimers).toBe(1);
    timer.stop();
  });

  it("publishes the last report for `GET /v1/info.persistence.lastSweep`", () => {
    const clock = fakeClock();
    const timer = armRetention({
      persistence: fakePersistence(),
      config: config({ eventLog: { retentionSweepMs: 1_000 } }),
      clock,
      logger: nullLogger(),
    });
    expect(timer.lastSweep).toBeNull();
    clock.advance(1_000);
    expect(timer.lastSweep).toMatchObject({ eventsDeleted: 0, workersDropped: 0 });
    timer.stop();
  });

  it("REARMS after a sweep that threw — a bad night must not stop retention forever", () => {
    const clock = fakeClock();
    const store = fakePersistence();
    let calls = 0;
    (store as { sweep: () => never }).sweep = () => {
      calls += 1;
      throw new Error("the disk is full");
    };
    const timer = armRetention({
      persistence: store,
      config: config({ eventLog: { retentionSweepMs: 1_000 } }),
      clock,
      logger: nullLogger(),
    });
    clock.advance(1_000);
    clock.advance(1_000);
    expect(calls).toBe(2);
    expect(timer.lastSweep).toBeNull();
    timer.stop();
  });

  it("`stop()` cancels the outstanding timer, so a stopped daemon holds nothing open", () => {
    const clock = fakeClock();
    const store = fakePersistence();
    const timer = armRetention({
      persistence: store,
      config: config({ eventLog: { retentionSweepMs: 1_000 } }),
      clock,
      logger: nullLogger(),
    });
    timer.stop();
    expect(clock.pendingTimers).toBe(0);
    clock.advance(10_000);
    expect(store.sweeps).toBe(0);
  });
});

vi.mock("@omni-acp/core", async (importOriginal) => {
  const { fakeCoreModule } = await import("./fake-core.js");
  return await fakeCoreModule(importOriginal as never);
});

describe("createDaemon — retention is armed, and stopped with the daemon", () => {
  const build = async (o?: {
    persistence?: PersistenceHandle;
    clock?: ReturnType<typeof fakeClock>;
  }) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "omni-retention-")));
    return await createDaemon(
      {
        dataDir: join(root, "data"),
        listen: null,
        tokens: [{ id: "t", secret: "the-only-valid-secret-0123456789", cwdRoots: [root] }],
        eventLog: { retentionSweepMs: 1_000 },
        logLevel: "silent",
      },
      {
        supervisor: fakeSupervisor(),
        ids: seqIds(),
        logger: nullLogger(),
        ...(o?.clock === undefined ? {} : { clock: o.clock }),
        ...(o?.persistence === undefined ? {} : { persistence: o.persistence }),
      },
    );
  };

  it("sweeps on the configured interval and publishes the report", async () => {
    const clock = fakeClock();
    const store = fakePersistence();
    const daemon = await build({ persistence: store, clock });

    expect(daemon.info.persistence.lastSweep).toBeNull();
    clock.advance(1_000);
    expect(store.sweeps).toBe(1);
    expect(daemon.info.persistence.lastSweep).not.toBeNull();

    await daemon.stop();
    clock.advance(10_000);
    // Stopped WITH the daemon: a timer that outlived `stop()` would hold the process open.
    expect(store.sweeps).toBe(1);
  });

  it("arms nothing for the memory driver", async () => {
    const clock = fakeClock();
    const daemon = await build({ clock });
    expect(clock.pendingTimers).toBe(0);
    await daemon.stop();
  });
});

describe("createDaemon — a store that refuses to open fails the START, naming why", () => {
  it("propagates the failure rather than starting without the persistence it was asked for", async () => {
    // Acceptance 10's WIRING half: a `schema_version` from the future is `openPersistence`'s own
    // startup failure (M1-WP-A), and what this owns is that such a failure REACHES the caller
    // instead of being swallowed into a daemon that quietly runs on memory.
    const root = await realpath(await mkdtemp(join(tmpdir(), "omni-retention-")));
    await expect(
      createDaemon(
        {
          dataDir: join(root, "data"),
          listen: null,
          tokens: [{ id: "t", secret: "the-only-valid-secret-0123456789", cwdRoots: [root] }],
          eventLog: { driver: "sqlite" },
          logLevel: "silent",
        },
        { supervisor: fakeSupervisor(), ids: seqIds(), logger: nullLogger() },
      ),
    ).rejects.toThrow(OmniError);
  });
});
