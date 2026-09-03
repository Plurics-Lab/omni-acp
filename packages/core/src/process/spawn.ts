import {
  OmniError,
  type AgentProcess,
  type Clock,
  type Logger,
  type PlatformOps,
  type SpawnSpec,
} from "@omni-acp/protocol";

/**
 * THE ONLY file in this repository allowed to import `node:child_process`.
 *
 * A vitest guard (`no-direct-spawn`, WP-2) walks every TypeScript source file under `packages/` and fails on any other
 * import of that module, and separately on any `spawn(` / `exec(` / `execFile(` / `fork(` call
 * site outside this file. It is multica's `TestOnlyLaunchGoSpawnsRuntimeProcesses`, ported,
 * and it exists because per-backend opt-in left 19 of 27 spawn sites without a process group
 * (multica GH #7522, CONTRACTS.md F10).
 *
 * The launch sequence is CONTRACTS.md §6.2. Two details that a reader will otherwise get wrong:
 *
 *  - `stdio: ["pipe","pipe","pipe"]` — never "inherit", because stderr must stay sniffable, and
 *    `shell: false` — never true, because a shell is both an injection surface and an extra
 *    process layer that breaks tree kill.
 *  - `acp.ndJsonStream(output, input)` takes what WE WRITE first (the child's stdin) and what we
 *    READ second (the child's stdout). The SDK's own example names these locals misleadingly
 *    (CONTRACTS.md F6); a test pins the order.
 */
export function spawnAgentProcess(
  spec: SpawnSpec,
  platform: PlatformOps,
  deps: { clock: Clock; logger: Logger; allowShimLaunch: boolean },
  signal?: AbortSignal,
): Promise<AgentProcess> {
  throw new OmniError("internal", "unimplemented: WP-2 (process.spawnAgentProcess)");
}
