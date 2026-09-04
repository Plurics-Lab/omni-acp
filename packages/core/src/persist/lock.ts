import { OmniError } from "@omni-acp/protocol";

/**
 * ONE daemon per data dir, lock-enforced (§14.10).
 *
 * Two daemons over one `events.db` is not a sharing problem, it is a `seq` problem: both would
 * assign from their own head. The lock names the holder's pid and bootId so a refusal can say
 * WHO, and a stale lock (holder gone) is broken rather than requiring a manual delete.
 *
 * Skipped entirely for the memory driver — there is no file to contend for.
 *
 * Owned by M1-WP-A.
 */
export function acquireDataDirLock(
  _dir: string,
  _self: { pid: number; bootId: string },
): Promise<{ release(): Promise<void>; brokeStaleLock: boolean }> {
  throw new OmniError("internal", "unimplemented: M1-WP-A");
}
