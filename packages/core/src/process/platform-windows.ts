import { OmniError, type PlatformOps, type RunUtility } from "@omni-acp/protocol";

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
 * This file must never contain `kill(-` — a source guard asserts it (WP-2 acceptance 1).
 */
export function createWindowsPlatformOps(deps: { runUtility: RunUtility }): PlatformOps {
  throw new OmniError("internal", "unimplemented: WP-2 (process.createWindowsPlatformOps)");
}
