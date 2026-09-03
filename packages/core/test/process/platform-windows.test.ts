import { OmniError } from "@omni-acp/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWindowsPlatformOps } from "../../src/process/platform-windows.js";
import { spawnAgentProcess } from "../../src/process/spawn.js";
import {
  finishFakeChild,
  processHandle,
  realClock,
  recordingLogger,
  recordingSpawn,
  recordingUtility,
  type UtilityRecorder,
} from "./support.js";

/**
 * The Windows half of CONTRACTS.md §6.3 / §6.4, exercised ON LINUX.
 *
 * Everything here is reachable off-Windows because the two OS-specific mechanisms are injected
 * rather than imported: `taskkill` / `tasklist` arrive as a `RunUtility` (review R8), and
 * PATH/PATHEXT resolution reads an injected environment over a real temporary directory — so the
 * resolver's actual filesystem probing runs, with Windows' rules, against files that exist.
 *
 * What cannot be observed here is listed in the work package's `skipped`: whether Windows itself
 * honours `windowsHide`, and whether `taskkill /T` reaches a particular grandchild. Those are
 * Windows-CI observations, and this file deliberately does not pretend otherwise.
 */

const WINDOWS_ENV = (dir: string): NodeJS.ProcessEnv => ({
  PATH: dir,
  PATHEXT: ".COM;.EXE;.BAT;.CMD",
  ComSpec: "C:\\Windows\\system32\\cmd.exe",
});

describe("createWindowsPlatformOps", () => {
  let dir: string;
  let utility: UtilityRecorder;
  let ops: ReturnType<typeof createWindowsPlatformOps>;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "omni-acp-win-"));
    await writeFile(join(dir, "realagent.exe"), "MZ");
    await writeFile(join(dir, "shimagent.cmd"), "@echo off");
    await writeFile(join(dir, "batagent.bat"), "@echo off");
    await writeFile(join(dir, "my agent.cmd"), "@echo off");
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  beforeAll(() => {
    utility = recordingUtility();
    ops = createWindowsPlatformOps({ runUtility: utility.fn, env: WINDOWS_ENV(dir) });
  });

  // ── ownership ─────────────────────────────────────────────────────────────
  it("owns the tree only as far as taskkill can, and says so", () => {
    expect(ops.ownership).toMatchObject({
      kind: "windows-taskkill-tree",
      confirmsTreeGone: false,
      survivesDaemonKill: true,
    });
    expect(ops.ownership.caveat).toContain("treeGone");
  });

  // ── spawn options (WP-2 acceptance 3, the win32 row) ──────────────────────
  it("never sets detached, and passes windowsHide through", () => {
    expect(ops.spawnOptions({ windowsHide: true })).toEqual({
      detached: false,
      windowsHide: true,
    });
    // The knob exists because CREATE_NO_WINDOW is a trade-off, not a constant (F9, §6.4).
    expect(ops.spawnOptions({ windowsHide: false })).toEqual({
      detached: false,
      windowsHide: false,
    });
  });

  // ── resolveLaunch (WP-2 acceptance 8, CONTRACTS.md §6.3) ──────────────────
  describe("resolveLaunch", () => {
    it("resolves a bare name through PATH and PATHEXT", async () => {
      const launch = await ops.resolveLaunch("realagent", ["--flag"], false);
      expect(launch).toEqual({
        file: join(dir, "realagent.exe"),
        args: ["--flag"],
        windowsVerbatimArguments: false,
      });
    });

    it("REFUSES a .cmd shim and names the fix in the message", async () => {
      const error = await ops.resolveLaunch("shimagent", [], false).catch((e: unknown) => e);
      expect(OmniError.is(error, "bad_request")).toBe(true);
      const message = (error as OmniError).message;
      expect(message).toContain("process.execPath");
      expect(message).toContain("<path-to-agent.js>");
      expect(message).toContain("shimagent.cmd");
      expect((error as OmniError).status).toBe(400);
    });

    it("refuses a .bat the same way", async () => {
      await expect(ops.resolveLaunch("batagent", [], false)).rejects.toThrow(OmniError);
    });

    it("spawns the %ComSpec% /d /s /c form when allowShimLaunch is on", async () => {
      const launch = await ops.resolveLaunch("shimagent", ["--model", "x"], true);
      expect(launch.file).toBe("C:\\Windows\\system32\\cmd.exe");
      expect(launch.windowsVerbatimArguments).toBe(true);
      expect(launch.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
      expect(launch.args[3]).toBe(`"${join(dir, "shimagent.cmd")} --model x"`);
    });

    it("quotes a shim path containing spaces, or cmd.exe reads two commands", async () => {
      const launch = await ops.resolveLaunch("my agent", ["a b"], true);
      expect(launch.args[3]).toBe(`""${join(dir, "my agent.cmd")}" "a b""`);
    });

    it("leaves the sanctioned direct-module form alone", async () => {
      // `process.execPath <module>` is what every M0 fixture uses: no shim, no wrapper process,
      // and therefore nothing for the .cmd refusal to fire on (F8, D11).
      const launch = await ops.resolveLaunch(process.execPath, ["C:\\agents\\agent.js"], false);
      expect(launch.file).toBe(process.execPath);
      expect(launch.args).toEqual(["C:\\agents\\agent.js"]);
      expect(launch.windowsVerbatimArguments).toBe(false);
    });

    it("hands an unresolvable name to the OS unchanged rather than inventing a failure", async () => {
      const launch = await ops.resolveLaunch("definitely-not-installed", ["x"], false);
      expect(launch.file).toBe("definitely-not-installed");
      expect(launch.args).toEqual(["x"]);
    });

    it("honours an explicit extension over the PATHEXT search order", async () => {
      const launch = await ops.resolveLaunch(join(dir, "realagent.exe"), [], false);
      expect(launch.file).toBe(join(dir, "realagent.exe"));
    });
  });

  // ── the escalation rungs (WP-2 acceptance 6, the win32 row) ───────────────
  describe("signalTree", () => {
    it("has NO cooperative rung: SIGTERM sends nothing and stays on stdin_eof", async () => {
      const local = recordingUtility();
      const win = createWindowsPlatformOps({ runUtility: local.fn, env: WINDOWS_ENV(dir) });
      const rung = await win.signalTree(processHandle({ pid: 4242, groupId: null }), "SIGTERM");
      expect(rung).toBe("stdin_eof");
      expect(local.calls).toEqual([]);
    });

    it("force is exactly `taskkill /PID <pid> /T /F`", async () => {
      const local = recordingUtility();
      const win = createWindowsPlatformOps({ runUtility: local.fn, env: WINDOWS_ENV(dir) });
      const rung = await win.signalTree(processHandle({ pid: 4242, groupId: null }), "SIGKILL");
      expect(rung).toBe("taskkill");
      expect(local.calls).toEqual([{ file: "taskkill", args: ["/PID", "4242", "/T", "/F"] }]);
    });

    it("still reports the rung when taskkill itself cannot be run", async () => {
      const local = recordingUtility();
      local.failWith = new Error("ENOENT");
      const win = createWindowsPlatformOps({ runUtility: local.fn, env: WINDOWS_ENV(dir) });
      // A diagnostic tool that is missing must not turn teardown into an exception; the ladder
      // proves what happened with its own probes.
      await expect(
        win.signalTree(processHandle({ pid: 7, groupId: null }), "SIGKILL"),
      ).resolves.toBe("taskkill");
    });
  });

  // ── liveness (WP-2 acceptance 6: leaderExited === true per tasklist) ──────
  describe("isLeaderGone", () => {
    const handle = processHandle({ pid: 4242, groupId: null });

    it("asks tasklist with the documented filter", async () => {
      const local = recordingUtility();
      local.tasklistStdout = "";
      const win = createWindowsPlatformOps({ runUtility: local.fn, env: WINDOWS_ENV(dir) });
      await win.isLeaderGone(handle);
      expect(local.calls).toEqual([{ file: "tasklist", args: ["/FI", "PID eq 4242", "/NH"] }]);
    });

    it("reads a matching row as ALIVE", async () => {
      const local = recordingUtility();
      local.tasklistStdout = "node.exe                      4242 Console      1     52,180 K\r\n";
      const win = createWindowsPlatformOps({ runUtility: local.fn, env: WINDOWS_ENV(dir) });
      expect(await win.isLeaderGone(handle)).toBe(false);
    });

    it("reads the no-match banner as GONE", async () => {
      const local = recordingUtility();
      local.tasklistStdout = "INFO: No tasks are running which match the specified criteria.\r\n";
      const win = createWindowsPlatformOps({ runUtility: local.fn, env: WINDOWS_ENV(dir) });
      expect(await win.isLeaderGone(handle)).toBe(true);
    });

    it("does not mistake a substring of another column for the pid", async () => {
      const local = recordingUtility();
      // 424242 contains "4242" — a naive `includes` would call this process alive.
      local.tasklistStdout = "other.exe                   424242 Console      1      1,024 K\r\n";
      const win = createWindowsPlatformOps({ runUtility: local.fn, env: WINDOWS_ENV(dir) });
      expect(await win.isLeaderGone(handle)).toBe(true);
    });

    it("answers from the exit event when there is one, without running anything", async () => {
      const local = recordingUtility();
      const win = createWindowsPlatformOps({ runUtility: local.fn, env: WINDOWS_ENV(dir) });
      expect(await win.isLeaderGone(processHandle({ pid: null, groupId: null, infoPid: 9 }))).toBe(
        true,
      );
      expect(local.calls).toEqual([]);
    });

    it("reports 'not gone' when it could not ask — never the optimistic answer", async () => {
      const local = recordingUtility();
      local.failWith = new Error("tasklist unavailable");
      const win = createWindowsPlatformOps({ runUtility: local.fn, env: WINDOWS_ENV(dir) });
      expect(await win.isLeaderGone(handle)).toBe(false);
    });
  });

  // ── acceptance 8, the second half: the shim form actually reaches spawn() ──
  describe("the shim launch, end to end through spawnAgentProcess", () => {
    const spec = (command: string) => ({
      command,
      args: ["--serve"],
      cwd: process.cwd(),
      env: { PATH: "C:\\Windows\\system32" },
    });

    it("refuses before anything is spawned when allowShimLaunch is off", async () => {
      const recorder = recordingSpawn();
      const error = await spawnAgentProcess(
        spec("shimagent"),
        createWindowsPlatformOps({ runUtility: utility.fn, env: WINDOWS_ENV(dir) }),
        {
          clock: realClock(),
          logger: recordingLogger(),
          allowShimLaunch: false,
          spawnFn: recorder.fn,
        },
      ).catch((e: unknown) => e);

      expect(OmniError.is(error, "bad_request")).toBe(true);
      expect(recorder.calls).toEqual([]);
    });

    it("spawns %ComSpec% /d /s /c with verbatim arguments when it is on", async () => {
      const recorder = recordingSpawn();
      const p = await spawnAgentProcess(
        spec("shimagent"),
        createWindowsPlatformOps({ runUtility: utility.fn, env: WINDOWS_ENV(dir) }),
        {
          clock: realClock(),
          logger: recordingLogger(),
          allowShimLaunch: true,
          spawnFn: recorder.fn,
        },
      );

      const call = recorder.calls[0];
      expect(call?.file).toBe("C:\\Windows\\system32\\cmd.exe");
      expect(call?.args).toEqual(["/d", "/s", "/c", `"${join(dir, "shimagent.cmd")} --serve"`]);
      expect(call?.options["windowsVerbatimArguments"]).toBe(true);
      expect(call?.options["shell"]).toBe(false); // still never a shell: cmd.exe is the ARGUMENT
      expect(call?.options["detached"]).toBe(false);

      const child = recorder.children[0];
      if (child !== undefined) finishFakeChild(child);
      await p.exited;
    });
  });

  it("isTreeGone is false unconditionally, and costs nothing to ask", async () => {
    const local = recordingUtility();
    const win = createWindowsPlatformOps({ runUtility: local.fn, env: WINDOWS_ENV(dir) });
    expect(await win.isTreeGone(processHandle({ pid: null, groupId: null }))).toBe(false);
    expect(local.calls).toEqual([]);
  });
});
