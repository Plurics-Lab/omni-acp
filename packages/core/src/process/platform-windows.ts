import {
  OmniError,
  type AgentProcess,
  type PlatformOps,
  type PlatformOwnership,
  type RunUtility,
  type TerminationRung,
} from "@omni-acp/protocol";
import { promises as fs } from "node:fs";
import { extname, join } from "node:path";

/**
 * Windows process ownership, honestly weaker than POSIX (CONTRACTS.md §6.4, F9, D10):
 * `detached: false, windowsHide: true`; no addressable tree identity; force kill is
 * `taskkill /PID <pid> /T /F`; `isTreeGone()` always returns false because `/T` cannot
 * prove it.
 *
 * Both commands run through the INJECTED `runUtility` (review R8), never through a
 * `node:child_process` import here: `spawn.ts` is the only file allowed that import, and it
 * already depends on `PlatformOps`.
 *
 * This file must never contain the POSIX process-group signalling form — a source guard asserts
 * it (WP-2 acceptance 1).
 */

/** Long enough for a loaded machine, short enough that a hung utility cannot stall a shutdown. */
const UTILITY_TIMEOUT_MS = 10_000;

const OWNERSHIP: PlatformOwnership = {
  kind: "windows-taskkill-tree",
  /**
   * The honesty contract (§6.6). `taskkill /T` walks the LIVE parent chain, so a grandchild
   * whose parent already exited is missed — Windows does not reparent — and there is no job
   * object in M0 to account for one. Nothing here can prove a tree is gone, so nothing here
   * ever claims it.
   */
  confirmsTreeGone: false,
  survivesDaemonKill: true,
  caveat:
    "On Windows, omni-acp cannot prove an agent's whole process tree is gone: the tree is " +
    "reclaimed with `taskkill /T`, which walks the live parent chain, so a grandchild whose " +
    "parent has already exited is missed. `treeGone` is therefore always false here; " +
    "`leaderExited` is the fact that is actually verified.",
};

/** The shims `spawn()` refuses to launch since the CVE-2024-27980 fix (CONTRACTS.md §6.3). */
const SHIM_EXTENSIONS = new Set([".cmd", ".bat"]);

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

async function fileExists(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isFile();
  } catch {
    return false;
  }
}

/**
 * `cmd.exe` metacharacters plus whitespace. Anything containing one has to be quoted, and a
 * quote inside the token has to be escaped, or the `/c` line means something other than what the
 * caller wrote.
 */
const NEEDS_QUOTING = /[\s"^&|<>()%!]/;

function quoteForCmd(token: string): string {
  if (token !== "" && !NEEDS_QUOTING.test(token)) return token;
  return `"${token.replace(/"/g, '\\"')}"`;
}

export interface WindowsPlatformDeps {
  /** `spawn.ts`'s `runUtility`, injected rather than imported (review R8). */
  readonly runUtility: RunUtility;
  /**
   * Injected only by tests, which run this file on Linux: PATH/PATHEXT resolution is the half of
   * the Windows contract that CAN be exercised off-Windows, given an environment to read.
   */
  readonly env?: NodeJS.ProcessEnv;
}

export function createWindowsPlatformOps(deps: WindowsPlatformDeps): PlatformOps {
  const env = deps.env ?? process.env;

  const pathExtensions = (): string[] =>
    (env["PATHEXT"] ?? DEFAULT_PATHEXT)
      .split(";")
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.startsWith("."));

  /** PATH + PATHEXT, Windows rules. `null` when nothing on disk matches. */
  const resolveOnPath = async (command: string): Promise<string | null> => {
    const extensions = pathExtensions();
    const candidatesFor = (base: string): string[] => {
      const named = extname(base) !== "";
      return named
        ? [base, ...extensions.map((ext) => base + ext)]
        : [...extensions.map((ext) => base + ext), base];
    };

    const bases = /[\\/]/.test(command)
      ? [command]
      : (env["PATH"] ?? env["Path"] ?? "")
          .split(";")
          .filter((dir) => dir !== "")
          .map((dir) => join(dir, command));

    for (const base of bases) {
      for (const candidate of candidatesFor(base)) {
        if (await fileExists(candidate)) return candidate;
      }
    }
    return null;
  };

  const leaderPid = (p: AgentProcess): number => p.info.pid;

  return {
    ownership: OWNERSHIP,

    /**
     * NOT `detached`. libuv maps it to `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP`, and
     * `DETACHED_PROCESS` means "no console" — so every console-subsystem grandchild allocates its
     * own VISIBLE window (multica #1521) and `windowsHide` is defeated (CONTRACTS.md §6.4).
     */
    spawnOptions: ({ windowsHide }) => ({ detached: false, windowsHide }),

    async resolveLaunch(command, args, allowShim) {
      const resolved = await resolveOnPath(command);
      // Unresolvable: hand the name to the OS unchanged and let `spawn` report ENOENT, which
      // §6.7 already classifies. A resolver that rejects first turns every PATH quirk it does
      // not model into a launch failure Windows would have handled.
      const file = resolved ?? command;

      if (!SHIM_EXTENSIONS.has(extname(file).toLowerCase())) {
        return { file, args: [...args], windowsVerbatimArguments: false };
      }

      if (!allowShim) {
        throw new OmniError(
          "bad_request",
          `refusing to launch "${file}": since the CVE-2024-27980 fix (Node >= 18.20.2), ` +
            `spawn() rejects .cmd/.bat without a shell, and npm-distributed agents ship one on ` +
            `Windows. Launch the module directly instead — command: process.execPath, ` +
            `args: ["<path-to-agent.js>", ...] — which also removes the wrapper process that ` +
            `makes tree kill unreliable. Set supervisor.allowShimLaunch to override.`,
          { detail: { file, command } },
        );
      }

      // The sanctioned shim form: %ComSpec% /d /s /c "<one fully quoted command line>", passed
      // verbatim so cmd.exe — not libuv's quoter — sees exactly these bytes (§6.3).
      const line = [file, ...args].map(quoteForCmd).join(" ");
      return {
        file: env["ComSpec"] ?? env["COMSPEC"] ?? "cmd.exe",
        args: ["/d", "/s", "/c", `"${line}"`],
        windowsVerbatimArguments: true,
      };
    },

    async signalTree(p: AgentProcess, sig: "SIGTERM" | "SIGKILL"): Promise<TerminationRung> {
      if (sig === "SIGTERM") {
        // There is no cooperative rung here: Node cannot send GenerateConsoleCtrlEvent, and a
        // Windows "SIGTERM" through libuv is an immediate TerminateProcess of the leader alone,
        // which is strictly worse than the force rung below. So the ladder stays where it was.
        return "stdin_eof";
      }
      try {
        await deps.runUtility("taskkill", ["/PID", String(leaderPid(p)), "/T", "/F"], {
          timeoutMs: UTILITY_TIMEOUT_MS,
        });
      } catch {
        // A non-zero exit already comes back in the result rather than as a throw; this is the
        // "could not start taskkill at all" case. `terminate()` proves what happened separately,
        // and it must never fail because a diagnostic tool did.
      }
      return "taskkill";
    },

    /** Unprovable in M0, so `false`, always — never optimistic (contracts.ts, D10). */
    isTreeGone(): Promise<boolean> {
      return Promise.resolve(false);
    },

    async isLeaderGone(p: AgentProcess): Promise<boolean> {
      if (p.pid === null) return true; // `exit` already delivered: authoritative and free
      const pid = leaderPid(p);
      try {
        const { stdout } = await deps.runUtility(
          "tasklist",
          ["/FI", `PID eq ${String(pid)}`, "/NH"],
          { timeoutMs: UTILITY_TIMEOUT_MS },
        );
        // With /NH and a PID filter, a match is one row containing that pid. No match prints
        // only "INFO: No tasks are running which match the specified criteria." — no digits.
        return !new RegExp(`(^|\\s)${String(pid)}(\\s|$)`, "m").test(stdout);
      } catch {
        // Could not ask. "I do not know" is reported as "not gone": the weaker fact is the one
        // that is allowed to be wrong in the safe direction.
        return false;
      }
    },

    // ── M1 (§15.7), owned by M1-WP-C ────────────────────────────────────────

    /**
     * ALWAYS null on win32, and that is the FINAL behaviour, not a stub: there is no cheap,
     * dependency-free incarnation token here, and §15.7's rule is that a null fingerprint
     * forbids signalling the pid after a restart. `reapSkipped:"unsupported_platform"` and
     * `GET /v1/info.orphansAtStart.skipped` are what say so out loud.
     */
    fingerprint(_pid: number): Promise<string | null> {
      return Promise.resolve(null);
    },

    signalTreeByGroup(_groupId: number, _sig: "SIGTERM" | "SIGKILL"): Promise<TerminationRung> {
      throw new OmniError("internal", "unimplemented: M1-WP-C");
    },

    isGroupGone(_groupId: number): Promise<boolean> {
      throw new OmniError("internal", "unimplemented: M1-WP-C");
    },
  };
}
