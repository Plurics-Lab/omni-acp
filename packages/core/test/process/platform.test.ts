import { describe, expect, it } from "vitest";
import { packageSources } from "../../../testkit/test/arch/source-scan.js";
import { createPlatformOps } from "../../src/process/platform.js";
import { createSupervisor } from "../../src/process/supervisor.js";
import {
  processHandle,
  realClock,
  recordingLogger,
  recordingUtility,
  stubPlatform,
  supervisorConfig,
} from "./support.js";

/**
 * WP-2 acceptance 1: the platform is chosen ONCE, at construction, and neither implementation
 * contains the other's mechanism (CONTRACTS.md §6.1).
 *
 * The source assertions are the cheap half of that rule and the half that survives a refactor:
 * a `taskkill` inside `platform-posix.ts` is a copy-paste that no behavioural test would catch on
 * Linux, and a POSIX process-group signal inside `platform-windows.ts` is one that no test would
 * catch anywhere, because it can only run where it is already wrong.
 */

const sourceAt = (path: string): string => {
  const file = packageSources().find((f) => f.path === path);
  if (file === undefined) throw new Error(`missing source file: ${path}`);
  return file.text;
};

describe("platform selection", () => {
  it("returns the Windows implementation for win32 and the POSIX one otherwise", () => {
    const utility = recordingUtility();
    const windows = createPlatformOps("win32", { runUtility: utility.fn });
    expect(windows.ownership.kind).toBe("windows-taskkill-tree");
    expect(windows.ownership.confirmsTreeGone).toBe(false);

    for (const platform of ["linux", "darwin", "freebsd", "aix"] as const) {
      const posix = createPlatformOps(platform, { runUtility: utility.fn });
      expect(posix.ownership.kind, platform).toBe("posix-process-group");
      expect(posix.ownership.confirmsTreeGone, platform).toBe(true);
    }
  });

  it("defaults to THIS machine's platform", () => {
    const expected = process.platform === "win32" ? "windows-taskkill-tree" : "posix-process-group";
    expect(createPlatformOps().ownership.kind).toBe(expected);
  });

  it("says out loud, on Windows, what it cannot prove (§6.6 honesty contract)", () => {
    const windows = createPlatformOps("win32", { runUtility: recordingUtility().fn });
    expect(windows.ownership.caveat).toBeTypeOf("string");
    expect(windows.ownership.caveat).toContain("taskkill");
    // POSIX proves it, so it has nothing to warn about.
    expect(createPlatformOps("linux").ownership.caveat).toBeNull();
  });

  it("createSupervisor() picks the PlatformOps at CONSTRUCTION, not at kill time", () => {
    const injected = stubPlatform();
    const supervisor = createSupervisor({
      config: supervisorConfig(),
      clock: realClock(),
      logger: recordingLogger(),
      platform: injected,
    });
    expect(supervisor.platform).toBe(injected);
    // Same object every read: nothing downstream can be handed a different platform mid-flight.
    expect(supervisor.platform).toBe(supervisor.platform);
  });

  it("builds its own PlatformOps when none is injected, and keeps that one", () => {
    const supervisor = createSupervisor({
      config: supervisorConfig(),
      clock: realClock(),
      logger: recordingLogger(),
    });
    const first = supervisor.platform;
    expect(first.ownership.kind).toBe(
      process.platform === "win32" ? "windows-taskkill-tree" : "posix-process-group",
    );
    expect(supervisor.platform).toBe(first);
  });
});

describe("guard: neither platform file carries the other's mechanism", () => {
  it("platform-windows.ts contains no POSIX process-group signal", () => {
    expect(sourceAt("packages/core/src/process/platform-windows.ts")).not.toContain("kill(-");
  });

  it("platform-posix.ts contains no taskkill", () => {
    expect(sourceAt("packages/core/src/process/platform-posix.ts")).not.toContain("taskkill");
  });

  it("only the chooser reads process.platform", () => {
    const offenders = packageSources()
      .filter((f) => f.path.startsWith("packages/core/src/process/"))
      .filter((f) => f.path !== "packages/core/src/process/platform.ts")
      .filter((f) => /\bprocess\s*\.\s*platform\b/.test(f.code))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("platform-windows.ts reaches taskkill/tasklist only through the injected runUtility", () => {
    const source = sourceAt("packages/core/src/process/platform-windows.ts");
    expect(source).toContain("taskkill");
    expect(source).toContain("tasklist");
    // Never by importing the module that owns the spawn (review R8) — the `no-direct-spawn`
    // guard covers `node:child_process`; this covers the cycle it would create.
    expect(source).not.toMatch(/from\s+["']\.\/spawn\.js["']/);
  });
});

describe("PlatformOps probes with no process behind them", () => {
  it("POSIX cannot prove a tree is gone without an addressable group id", async () => {
    const posix = createPlatformOps("linux");
    expect(await posix.isTreeGone(processHandle({ pid: 1234, groupId: null }))).toBe(false);
    // 0 is "my own group" and 1 is "everything I may signal": neither is a tree we own, and
    // treating either as addressable is a machine-wide accident waiting for a bug upstream.
    expect(await posix.isTreeGone(processHandle({ pid: 1234, groupId: 0 }))).toBe(false);
    expect(await posix.isTreeGone(processHandle({ pid: 1234, groupId: 1 }))).toBe(false);
  });

  it("POSIX reports a live leader as not gone, and a reaped one as gone", async () => {
    const posix = createPlatformOps("linux");
    const alive = processHandle({ pid: process.pid, groupId: process.pid });
    expect(await posix.isLeaderGone(alive)).toBe(false);
    // `pid: null` is what `spawn.ts` sets the moment `exit` is delivered — the free, authoritative
    // answer, taken before any syscall.
    expect(await posix.isLeaderGone(processHandle({ pid: null, groupId: 4242 }))).toBe(true);
  });

  it("Windows never claims a tree is gone, whatever the utility says", async () => {
    const utility = recordingUtility();
    const windows = createPlatformOps("win32", { runUtility: utility.fn });
    expect(await windows.isTreeGone(processHandle({ pid: 4242, groupId: null }))).toBe(false);
    expect(utility.calls).toEqual([]);
  });
});
