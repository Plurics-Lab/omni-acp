import { type PlatformOps, type RunUtility } from "@omni-acp/protocol";
import { createPosixPlatformOps } from "./platform-posix.js";
import { createWindowsPlatformOps } from "./platform-windows.js";
import { runUtility as defaultRunUtility } from "./spawn.js";

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
 *
 * This module imports `spawn.ts` for that default, which is the ONE edge in the other
 * direction and is not a cycle: `spawn.ts` receives its `PlatformOps` as a parameter and imports
 * nothing from here.
 */
export function createPlatformOps(
  platform?: NodeJS.Platform,
  deps?: { runUtility: RunUtility },
): PlatformOps {
  const target = platform ?? process.platform;
  return target === "win32"
    ? createWindowsPlatformOps({ runUtility: deps?.runUtility ?? defaultRunUtility })
    : createPosixPlatformOps();
}
