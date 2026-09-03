import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createPosixPlatformOps } from "../../src/process/platform-posix.js";
import { processHandle } from "./support.js";

/**
 * The POSIX half of CONTRACTS.md §6.4.
 *
 * `detached: true` is the whole mechanism: it gives the child `setsid()`, which makes
 * `pgid === pid` and the entire tree addressable as one negative pid. Everything else here is a
 * consequence of that one flag.
 */

const ops = createPosixPlatformOps();

describe("createPosixPlatformOps", () => {
  it("owns the tree through its process group, and can prove it", () => {
    expect(ops.ownership).toEqual({
      kind: "posix-process-group",
      confirmsTreeGone: true,
      // `detached` means a session of its own, which is exactly what outlives a SIGKILL of the
      // daemon. M0 accepts that with best-effort shutdown handlers; the reaper is M1 (§6.4).
      survivesDaemonKill: true,
      caveat: null,
    });
  });

  it("always spawns detached, and never asks Windows to hide a window", () => {
    expect(ops.spawnOptions({ windowsHide: true })).toEqual({
      detached: true,
      windowsHide: false,
    });
    expect(ops.spawnOptions({ windowsHide: false })).toEqual({
      detached: true,
      windowsHide: false,
    });
  });

  it("cannot prove anything about a tree with no addressable group", async () => {
    expect(await ops.isTreeGone(processHandle({ pid: 4242, groupId: null }))).toBe(false);
  });

  it("takes `pid: null` — the delivered exit event — as proof the leader is gone", async () => {
    expect(await ops.isLeaderGone(processHandle({ pid: null, groupId: 4242 }))).toBe(true);
  });

  it("reports a live process as alive", async () => {
    const self = processHandle({ pid: process.pid, groupId: null, infoPid: process.pid });
    expect(await ops.isLeaderGone(self)).toBe(false);
  });
});

// PATH lookup semantics — POSIX rules, on a POSIX host. `describe.skipIf` rather than a workflow
// branch, so the reason sits next to the code (CONTRACTS.md §10.3).
describe.skipIf(process.platform === "win32")("resolveLaunch on PATH", () => {
  let dir: string;
  let savedPath: string | undefined;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "omni-acp-posix-"));
    await writeFile(join(dir, "runnable"), "#!/bin/sh\nexit 0\n");
    await chmod(join(dir, "runnable"), 0o755);
    await writeFile(join(dir, "readable"), "not executable\n");
    await chmod(join(dir, "readable"), 0o644);
    savedPath = process.env["PATH"];
    process.env["PATH"] = `${dir}${delimiter}${savedPath ?? ""}`;
  });

  afterAll(async () => {
    if (savedPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = savedPath;
    await rm(dir, { recursive: true, force: true });
  });

  it("resolves a bare name to the first executable file on PATH", async () => {
    const launch = await ops.resolveLaunch("runnable", ["--x"], false);
    expect(launch).toEqual({
      file: join(dir, "runnable"),
      args: ["--x"],
      windowsVerbatimArguments: false,
    });
  });

  it("skips a file that is not executable", async () => {
    const launch = await ops.resolveLaunch("readable", [], false);
    expect(launch.file).toBe("readable"); // unresolved, handed to the OS as-is
  });

  it("uses a command containing a separator verbatim", async () => {
    const absolute = join(dir, "runnable");
    expect((await ops.resolveLaunch(absolute, [], false)).file).toBe(absolute);
  });

  it("hands an unresolvable name to the OS rather than inventing a failure", async () => {
    // `execvp` reports ENOENT on the child's `error` event, which §6.7 already classifies as
    // agent_error — a resolver that rejects first turns every PATH quirk it does not model into
    // a launch failure the kernel would have handled correctly.
    const launch = await ops.resolveLaunch("definitely-not-on-this-path", ["a"], false);
    expect(launch).toEqual({
      file: "definitely-not-on-this-path",
      args: ["a"],
      windowsVerbatimArguments: false,
    });
  });

  it("never asks for the Windows shim form, whatever allowShim says", async () => {
    const launch = await ops.resolveLaunch("runnable", [], true);
    expect(launch.windowsVerbatimArguments).toBe(false);
    expect(launch.file).toBe(join(dir, "runnable"));
  });
});
