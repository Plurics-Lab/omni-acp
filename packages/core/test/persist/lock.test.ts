import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireDataDirLock, createMemoryEventLog, openPersistence } from "@omni-acp/core";
import { OmniError } from "@omni-acp/protocol";
import { fakeClock, nullLogger } from "@omni-acp/testkit";
import { sqliteConfig, workerId } from "./support/harness.js";

/**
 * A pid that is provably not a process: `process.kill(pid, 0)` answers ESRCH for it on every
 * platform. 0x7FFFFFFF is above every pid_max any of the three OSes will hand out, which is what
 * makes it safe to assert "gone" rather than "probably gone".
 */
const DEAD_PID = 0x7fff_ffff;

const LOCK = "daemon.lock";

describe("acquireDataDirLock — one daemon per data dir (§14.10)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "omni-acp-lock-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes a lock naming this process, and releases it", async () => {
    const lock = await acquireDataDirLock(dir, { pid: process.pid, bootId: "boot_a" });
    expect(lock.brokeStaleLock).toBe(false);

    const body = JSON.parse(await readFile(join(dir, LOCK), "utf8")) as Record<string, unknown>;
    // An operator may read this file to find out who is holding their data dir, so it names the
    // holder rather than merely existing.
    expect(body).toMatchObject({ pid: process.pid, bootId: "boot_a" });
    expect(typeof body["startedAt"]).toBe("string");
    expect(typeof body["hostname"]).toBe("string");

    await lock.release();
    await expect(readFile(join(dir, LOCK), "utf8")).rejects.toThrow();
  });

  it("REFUSES a second daemon while the first is alive, and names its pid", async () => {
    const first = await acquireDataDirLock(dir, { pid: process.pid, bootId: "boot_a" });

    // Two daemons over one events.db is not a sharing problem, it is a `seq` problem: both
    // would assign from their own head and fork every worker's log.
    const refusal = await acquireDataDirLock(dir, { pid: process.pid, bootId: "boot_b" }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(refusal).toBeInstanceOf(OmniError);
    expect((refusal as OmniError).message).toContain(String(process.pid));
    expect((refusal as OmniError).message).toContain("boot_a");

    // The refusal changed nothing: the first daemon still holds exactly what it wrote.
    const body = JSON.parse(await readFile(join(dir, LOCK), "utf8")) as Record<string, unknown>;
    expect(body["bootId"]).toBe("boot_a");
    await first.release();
  });

  it("BREAKS a stale lock whose holder is provably gone", async () => {
    await writeFile(
      join(dir, LOCK),
      JSON.stringify({
        pid: DEAD_PID,
        bootId: "boot_dead",
        startedAt: new Date(0).toISOString(),
        hostname: "somewhere",
      }),
      "utf8",
    );

    const lock = await acquireDataDirLock(dir, { pid: process.pid, bootId: "boot_new" });
    // Broken rather than requiring a manual delete: a daemon that was SIGKILLed leaves this
    // behind, and a data dir nobody is using must not need an operator to unwedge it.
    expect(lock.brokeStaleLock).toBe(true);
    const body = JSON.parse(await readFile(join(dir, LOCK), "utf8")) as Record<string, unknown>;
    expect(body).toMatchObject({ pid: process.pid, bootId: "boot_new" });
    await lock.release();
  });

  it("breaks a lock it cannot parse — a half-written file names nobody to refuse for", async () => {
    await writeFile(join(dir, LOCK), "{ this is not json", "utf8");
    const lock = await acquireDataDirLock(dir, { pid: process.pid, bootId: "boot_new" });
    expect(lock.brokeStaleLock).toBe(true);
    await lock.release();
  });

  it("creates the data dir if it is not there yet", async () => {
    const nested = join(dir, "a", "b");
    const lock = await acquireDataDirLock(nested, { pid: process.pid, bootId: "boot_a" });
    await expect(readFile(join(nested, LOCK), "utf8")).resolves.toContain("boot_a");
    await lock.release();
  });

  it("release() is idempotent and never throws on a lock somebody else removed", async () => {
    const lock = await acquireDataDirLock(dir, { pid: process.pid, bootId: "boot_a" });
    await rm(join(dir, LOCK), { force: true });
    await expect(lock.release()).resolves.toBeUndefined();
    await expect(lock.release()).resolves.toBeUndefined();
  });
});

describe("the lock is SKIPPED entirely for the memory driver (§14.10)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "omni-acp-memlock-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("N memory logs over one data dir coexist, and nothing is written to it", async () => {
    // `OmniACP.local()` must stay able to run N instances side by side — the M0 integration
    // suite depends on it, and there is no file to contend for.
    const logs = [1, 2, 3].map((n) =>
      createMemoryEventLog({
        workerId: workerId(n),
        daemonId: `d_${"0".repeat(25)}7`,
        clock: fakeClock(),
        maxEvents: 16,
        subscriberQueueSize: 8,
      }),
    );
    for (const log of logs) {
      log.append({
        kind: "omni.error",
        payloadVersion: 2,
        payload: { code: "internal", message: "x" },
      });
      expect(log.head).toBe(1);
      expect(log.persistent).toBe(false);
      log.close();
    }
    await expect(readFile(join(dir, LOCK), "utf8")).rejects.toThrow();
    await expect(readFile(join(dir, "events.db"), "utf8")).rejects.toThrow();
  });

  it("openPersistence refuses the memory driver before it can take a lock or import", async () => {
    await expect(
      openPersistence({
        dataDir: dir,
        config: sqliteConfig({ driver: "memory" }),
        clock: fakeClock(),
        logger: nullLogger(),
      }),
    ).rejects.toThrow(/driver "sqlite"/);
    await expect(readFile(join(dir, LOCK), "utf8")).rejects.toThrow();
  });
});

describe("openPersistence and the lock together", () => {
  it("holds the data dir for the life of the handle and refuses a second open", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omni-acp-open-"));
    try {
      const handle = await openPersistence({
        dataDir: dir,
        config: sqliteConfig(),
        clock: fakeClock(),
        logger: nullLogger(),
      });
      await expect(readFile(join(dir, LOCK), "utf8")).resolves.toContain(String(process.pid));

      await expect(
        openPersistence({
          dataDir: dir,
          config: sqliteConfig(),
          clock: fakeClock(),
          logger: nullLogger(),
        }),
      ).rejects.toThrow(/already held by pid/);

      handle.close();
      // `close()` releases asynchronously (the handle's own close is synchronous by contract),
      // so the file goes away on its own — and even if it did not, the next start would break a
      // lock naming a pid that is gone.
      await waitForGone(join(dir, LOCK));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

async function waitForGone(file: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      await readFile(file, "utf8");
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`${file} was still there after 1 s`);
}
