import { OmniError, type PlatformOps } from "@omni-acp/protocol";

/**
 * Chooses the platform implementation ONCE. Every call site downstream holds a `PlatformOps`
 * and never branches on `process.platform` again (CONTRACTS.md §6.1).
 *
 * Declared in CONTRACTS.md §5.1 under `protocol/src/contracts.ts`, but implemented here:
 * `contracts.ts` is types-only (M0-PLAN.md §1.1) and platform behaviour is core's job. The
 * signature is unchanged.
 */
export function createPlatformOps(platform?: NodeJS.Platform): PlatformOps {
  throw new OmniError("internal", "unimplemented: WP-2 (process.createPlatformOps)");
}
