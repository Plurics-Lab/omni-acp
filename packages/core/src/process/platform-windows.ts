import { OmniError, type PlatformOps } from "@omni-acp/protocol";

/**
 * Windows process ownership, honestly weaker than POSIX (CONTRACTS.md §6.4, F9, D10):
 * `detached: false, windowsHide: true`; no addressable tree identity; force kill is
 * `taskkill /PID <pid> /T /F`; `isTreeGone()` always returns false because `/T` cannot
 * prove it.
 *
 * This file must never contain `kill(-` — a source guard asserts it (WP-2 acceptance 1).
 */
export function createWindowsPlatformOps(): PlatformOps {
  throw new OmniError("internal", "unimplemented: WP-2 (process.createWindowsPlatformOps)");
}
