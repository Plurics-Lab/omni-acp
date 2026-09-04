import { OmniError, type RunUtility } from "@omni-acp/protocol";

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
export function fingerprintOf(
  _pid: number,
  _platform: NodeJS.Platform,
  _run: RunUtility,
): Promise<string | null> {
  throw new OmniError("internal", "unimplemented: M1-WP-C");
}
