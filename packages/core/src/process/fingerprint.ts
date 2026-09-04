import type { RunUtility } from "@omni-acp/protocol";
import { readFile } from "node:fs/promises";

/**
 * The incarnation token for a live pid — CONTRACTS.md §15.7, L18.
 *
 * Linux `"linux:<btime>:<starttime-ticks>"` (`/proc/stat` btime ⊕ `/proc/<pid>/stat` field 22),
 * darwin `"darwin:<lstart-epoch>"` (`ps -o lstart=`), `null` on win32 and on ANY failure.
 *
 * A null fingerprint is load-bearing: it is the signal that a restarted daemon must NEVER signal
 * this pid, because pid reuse would make the kill a coin flip on somebody else's process.
 *
 * Owned by M1-WP-C.
 */

/** Long enough for a loaded machine, short enough that `ps` cannot stall a spawn. */
const PS_TIMEOUT_MS = 5_000;

/**
 * `/proc/<pid>/stat` field 22, `starttime`: the process's start time in clock ticks since boot.
 *
 * The fields are taken after the **last** `)` and not by splitting the whole line, because
 * field 2 is `comm` — the executable's basename, wrapped in parentheses, and it may itself
 * contain spaces AND parentheses. A naive `split(" ")[21]` reads the wrong field for
 * `(my agent (v2))`, which is a fingerprint that silently never matches.
 *
 * After the last `)` the remaining whitespace-separated tokens begin at field 3 (`state`), so
 * field 22 is index 19.
 */
const STARTTIME_INDEX_AFTER_COMM = 19;

function parseStarttime(stat: string): string | null {
  const close = stat.lastIndexOf(")");
  if (close === -1) return null;
  const fields = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const starttime = fields[STARTTIME_INDEX_AFTER_COMM];
  if (starttime === undefined || !/^\d+$/.test(starttime)) return null;
  return starttime;
}

/**
 * `btime` from `/proc/stat`: the boot time, in seconds since the epoch.
 *
 * It is half of the token because `starttime` alone is only unique WITHIN one boot — a machine
 * that rebooted and handed the same pid the same tick offset would match, and killing that
 * process is exactly the coin flip §15.7 forbids. Both halves are kernel state and both survive
 * a daemon restart, which is the property the whole mechanism rests on.
 */
function parseBtime(procStat: string): string | null {
  const match = /^btime\s+(\d+)$/m.exec(procStat);
  return match?.[1] ?? null;
}

async function linuxFingerprint(pid: number): Promise<string | null> {
  const [system, own] = await Promise.all([
    readFile("/proc/stat", "utf8"),
    readFile(`/proc/${String(pid)}/stat`, "utf8"),
  ]);
  const btime = parseBtime(system);
  const starttime = parseStarttime(own);
  if (btime === null || starttime === null) return null;
  return `linux:${btime}:${starttime}`;
}

/**
 * darwin: `ps -o lstart= -p <pid>` through the INJECTED `RunUtility`.
 *
 * No new spawn entry point (§6.1, F10): `spawn.ts` is the only file in this repository allowed
 * to call `node:child_process`, and it already exports the utility runner that
 * `platform-windows.ts` uses for `taskkill` / `tasklist` for exactly the same reason.
 */
async function darwinFingerprint(pid: number, run: RunUtility): Promise<string | null> {
  const { code, stdout } = await run("ps", ["-o", "lstart=", "-p", String(pid)], {
    timeoutMs: PS_TIMEOUT_MS,
  });
  // A non-zero exit is `ps` saying the pid does not exist. There is nothing to fingerprint, and
  // an empty string is not a token — both mean null, which forbids signalling it later.
  if (code !== 0) return null;
  const lstart = stdout.trim().replace(/\s+/g, " ");
  if (lstart === "") return null;
  const epoch = Date.parse(lstart);
  if (!Number.isFinite(epoch)) return null;
  return `darwin:${String(epoch)}`;
}

export async function fingerprintOf(
  pid: number,
  platform: NodeJS.Platform,
  run: RunUtility,
): Promise<string | null> {
  // A pid we cannot address is a pid we must never signal, so it gets the value that says so.
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (platform === "linux") return await linuxFingerprint(pid);
    if (platform === "darwin") return await darwinFingerprint(pid, run);
    // win32 is `null` DELIBERATELY and finally (§15.7): there is no cheap, dependency-free
    // incarnation token there, and M0's Windows platform already refuses to claim `treeGone`
    // for the same reason. Every other platform is one we have not verified, and an unverified
    // fingerprint is worse than none — it would authorise a kill.
    return null;
  } catch {
    // NEVER throws. A fingerprint is an optimisation on top of "record the orphan"; failing to
    // take one costs a reap, while throwing here would cost the spawn that called us.
    return null;
  }
}
