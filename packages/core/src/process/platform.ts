import { OmniError, type PlatformOps, type RunUtility } from "@omni-acp/protocol";

/**
 * Chooses the platform implementation ONCE. Every call site downstream holds a `PlatformOps`
 * and never branches on `process.platform` again (CONTRACTS.md §6.1).
 *
 * Declared in CONTRACTS.md §5.3 as a `@omni-acp/core` factory rather than in
 * `protocol/src/contracts.ts`: that file is types-only (M0-PLAN.md §1.1) and platform behaviour
 * is core's job. The signature is otherwise unchanged.
 *
 * `deps.runUtility` is what `platform-windows.ts` uses for `taskkill` / `tasklist`. It is
 * injected instead of imported so that `spawn.ts` — which consumes `PlatformOps` — is not
 * imported by one of its own dependencies (review R8). It defaults to `spawn.ts`'s real
 * implementation; tests pass a recording double and spawn nothing.
 */
export function createPlatformOps(
  platform?: NodeJS.Platform,
  deps?: { runUtility: RunUtility },
): PlatformOps {
  throw new OmniError("internal", "unimplemented: WP-2 (process.createPlatformOps)");
}
