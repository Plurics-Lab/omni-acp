import { OmniError, type PlatformOps } from "@omni-acp/protocol";

/**
 * POSIX process ownership: `detached: true` at spawn gives the child `setsid()`, so
 * `pgid === pid` and the whole tree is addressable as `-pgid` (CONTRACTS.md §6.4).
 *
 * This file must never mention `taskkill` — a source guard asserts it (WP-2 acceptance 1).
 */
export function createPosixPlatformOps(): PlatformOps {
  throw new OmniError("internal", "unimplemented: WP-2 (process.createPosixPlatformOps)");
}
