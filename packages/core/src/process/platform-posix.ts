import {
  OmniError,
  type AgentProcess,
  type PlatformOps,
  type PlatformOwnership,
  type TerminationRung,
} from "@omni-acp/protocol";
import { constants, promises as fs } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * POSIX process ownership: `detached: true` at spawn gives the child `setsid()`, so
 * `pgid === pid` and the whole tree is addressable as `-pgid` (CONTRACTS.md §6.4).
 *
 * This file must never mention the Windows utility a tree kill needs there — a source guard
 * asserts it (WP-2 acceptance 1).
 */

const OWNERSHIP: PlatformOwnership = {
  kind: "posix-process-group",
  confirmsTreeGone: true,
  /**
   * `detached` puts the child in its OWN session, which is exactly what survives a SIGKILL of
   * the daemon (CONTRACTS.md §6.4, "daemon killed with SIGKILL"). Best-effort shutdown handlers
   * are M0; a pid-ledger startup reaper is M1.
   */
  survivesDaemonKill: true,
  caveat: null,
};

/** A signal number of 0 sends nothing and only probes for existence. */
type Probe = "alive" | "gone" | "unknown";

function errnoOf(e: unknown): string | undefined {
  return typeof e === "object" && e !== null
    ? (e as NodeJS.ErrnoException).code
    : /* istanbul ignore next */ undefined;
}

/**
 * `process.kill` with the three outcomes that matter kept apart.
 *
 * `EPERM` is "it exists and is not ours" — the one answer that must never be rounded up to
 * "gone", because rounding it up is how `treeGone: true` becomes a lie.
 */
function probe(target: number): Probe {
  try {
    process.kill(target, 0);
    return "alive";
  } catch (e) {
    const code = errnoOf(e);
    if (code === "ESRCH") return "gone";
    if (code === "EPERM") return "alive";
    return "unknown";
  }
}

/**
 * Refuses the two group ids that mean something else entirely to `kill(2)`: `0` is "every
 * process in MY group" — the daemon itself — and `-1` is "every process I am allowed to signal".
 * A `groupId` can only be one of those through a bug, and the blast radius of that bug is the
 * whole machine.
 */
function isAddressableGroup(groupId: number | null): groupId is number {
  return groupId !== null && Number.isInteger(groupId) && groupId > 1;
}

async function isExecutableFile(candidate: string): Promise<boolean> {
  try {
    const stat = await fs.stat(candidate);
    if (!stat.isFile()) return false;
    await fs.access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * PATH resolution, POSIX rules: a command containing a separator is a path and is used verbatim;
 * a bare name is searched along `PATH`.
 *
 * An unresolvable name is returned UNCHANGED rather than rejected. `execvp` reports it as
 * `ENOENT` on the child's `error` event, which is already classified as `agent_error` (§6.7),
 * and a resolver that fails first would turn every PATH quirk it does not model into a launch
 * failure the OS would have handled.
 */
async function resolveOnPath(command: string): Promise<string> {
  if (command.includes("/")) return command;
  const path = process.env["PATH"] ?? "";
  for (const dir of path.split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, command);
    if (await isExecutableFile(candidate)) return candidate;
  }
  return command;
}

export function createPosixPlatformOps(): PlatformOps {
  const groupOf = (p: AgentProcess): number | null => p.info.groupId;

  return {
    ownership: OWNERSHIP,

    spawnOptions: () => ({ detached: true, windowsHide: false }),

    async resolveLaunch(command, args, _allowShim) {
      return {
        file: await resolveOnPath(command),
        args: [...args],
        windowsVerbatimArguments: false,
      };
    },

    signalTree(p: AgentProcess, sig: "SIGTERM" | "SIGKILL"): Promise<TerminationRung> {
      const rung: TerminationRung = sig === "SIGTERM" ? "sigterm" : "sigkill";
      const group = groupOf(p);
      if (isAddressableGroup(group)) {
        try {
          process.kill(-group, sig);
          return Promise.resolve(rung);
        } catch {
          // Fall through: the group send fails once the last member is gone, and it fails for a
          // process that never made it into its own group (multica `proc_other.go`).
        }
      }
      try {
        process.kill(p.info.pid, sig);
      } catch {
        // Already gone. `terminate()` proves that separately; there is nothing to report here.
      }
      return Promise.resolve(rung);
    },

    isTreeGone(p: AgentProcess): Promise<boolean> {
      const group = groupOf(p);
      // No addressable group means no proof — and `treeGone` is never optimistic (contracts.ts).
      if (!isAddressableGroup(group)) return Promise.resolve(false);
      return Promise.resolve(probe(-group) === "gone");
    },

    isLeaderGone(p: AgentProcess): Promise<boolean> {
      if (p.pid === null) return Promise.resolve(true); // `exit` already delivered
      return Promise.resolve(probe(p.info.pid) === "gone");
    },

    // ── M1 (§15.7), owned by M1-WP-C ────────────────────────────────────────

    fingerprint(_pid: number): Promise<string | null> {
      throw new OmniError("internal", "unimplemented: M1-WP-C");
    },

    signalTreeByGroup(_groupId: number, _sig: "SIGTERM" | "SIGKILL"): Promise<TerminationRung> {
      throw new OmniError("internal", "unimplemented: M1-WP-C");
    },

    isGroupGone(_groupId: number): Promise<boolean> {
      throw new OmniError("internal", "unimplemented: M1-WP-C");
    },
  };
}
