import { mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import { removeTempRoots, tempRoot } from "./support/temp-dirs.js";

/** See `support/temp-dirs.ts`: these suites leaked ~800 `/tmp` directories per full run. */
afterEach(async () => {
  await removeTempRoots();
});

const config = (o?: Record<string, unknown>): ResolvedDaemonConfig =>
  DaemonConfig.parse({
    dataDir: tmpdir(),
    tokens: [{ id: "t", secretSha256: "a".repeat(64) }],
    ...o,
  } as Parameters<typeof DaemonConfig.parse>[0]) as ResolvedDaemonConfig;

describe("openDaemonPersistence — the driver decides (ruling M1-R17)", () => {
  it('returns null for "memory", so createDaemon() leaves no file behind', async () => {
    const dataDir = await tempRoot("omni-event-store-");
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
    // The driver-gating decision is this module's; the store is M1-WP-A's. With both landed the
    // assertion is that the two met: a real handle, over a file this dataDir owns, reporting the
    // driver the operator asked for.
    const dataDir = await tempRoot("omni-event-store-");
    const handle = await openDaemonPersistence({
      config: config({ dataDir, eventLog: { driver: "sqlite" } }),
      clock: fakeClock(),
      logger: nullLogger(),
    });
    expect(handle).not.toBeNull();
    try {
      expect(handle?.events.diagnostics.driver).toBe("sqlite");
      expect(handle?.events.diagnostics.file).toBe(join(dataDir, "events.db"));
      expect(handle?.events.diagnostics.schemaVersion).toBeGreaterThan(0);
      // The config reached it: a store opened under a dataDir leaves its file THERE, which is
      // what makes `OMNI_DATA_DIR` mean anything.
      expect((await readdir(dataDir)).filter((e) => e.endsWith(".db"))).toEqual(["events.db"]);
    } finally {
      handle?.close();
    }
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
    const root = await tempRoot("omni-retention-");
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
    const root = await tempRoot("omni-retention-");
    const dataDir = join(root, "data");
    await mkdir(dataDir, { recursive: true });
    await plantFutureSchema(join(dataDir, "events.db"));

    const start = createDaemon(
      {
        dataDir,
        listen: null,
        tokens: [{ id: "t", secret: "the-only-valid-secret-0123456789", cwdRoots: [root] }],
        eventLog: { driver: "sqlite" },
        logLevel: "silent",
      },
      { supervisor: fakeSupervisor(), ids: seqIds(), logger: nullLogger() },
    );
    await expect(start).rejects.toThrow(OmniError);
    // "naming why": the version is in the message, so an operator who downgraded a daemon by
    // accident is told which binary wrote the file rather than being handed a bare 500.
    await expect(start).rejects.toThrow(/999/);
  });

  it("starts on a GOOD sqlite file, so the refusal above is not vacuous", async () => {
    const root = await tempRoot("omni-retention-");
    const daemon = await createDaemon(
      {
        dataDir: join(root, "data"),
        listen: null,
        tokens: [{ id: "t", secret: "the-only-valid-secret-0123456789", cwdRoots: [root] }],
        eventLog: { driver: "sqlite" },
        logLevel: "silent",
      },
      { supervisor: fakeSupervisor(), ids: seqIds(), logger: nullLogger() },
    );
    expect(daemon.info.persistence.driver).toBe("sqlite");
    await daemon.stop();
  });
});

/**
 * Writes an `events.db` whose `schema_version` is from the future.
 *
 * Raw `node:sqlite` on purpose: the point is a file this build did NOT write, so going through
 * `openPersistence` to make one would only prove it agrees with itself.
 */
async function plantFutureSchema(file: string): Promise<void> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(file);
  try {
    db.exec("create table meta (key text primary key, value text not null)");
    db.exec("insert into meta (key, value) values ('schema_version', '999')");
  } finally {
    db.close();
  }
}
