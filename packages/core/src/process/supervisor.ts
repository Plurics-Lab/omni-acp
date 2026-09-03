import {
  OmniError,
  type Clock,
  type Logger,
  type PlatformOps,
  type ResolvedSupervisorConfig,
  type Supervisor,
} from "@omni-acp/protocol";

export interface SupervisorOptions {
  /** `z.output<typeof SupervisorConfig>` — named through protocol so core stays zod-free. */
  readonly config: ResolvedSupervisorConfig;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Injectable for tests. */
  readonly platform?: PlatformOps;
  /**
   * Injected only by unit tests that observe argv without spawning.
   *
   * NOTE for the `no-direct-spawn` guard: this is a TYPE position — `typeof import(...)` emits
   * nothing and calls nothing. The guard must exempt type-only references and fail on value
   * imports and call sites, which is the rule it is actually there to enforce.
   */
  readonly spawnFn?: typeof import("node:child_process").spawn;
}

/**
 * The single spawn entry point. `PlatformOps` is chosen HERE, at construction — never at kill
 * time, and never by a call site branching on `process.platform` (CONTRACTS.md §6.1).
 */
export function createSupervisor(o: SupervisorOptions): Supervisor {
  throw new OmniError("internal", "unimplemented: WP-2 (process.createSupervisor)");
}
