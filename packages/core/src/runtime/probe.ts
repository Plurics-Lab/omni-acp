import {
  OmniError,
  type Clock,
  type Logger,
  type ProbeSummary,
  type ResolvedProbeConfig,
  type RuntimeDescriptor,
  type SpawnSpec,
  type Supervisor,
} from "@omni-acp/protocol";

export interface ProbeOptions {
  readonly agentId: string;
  readonly spec: SpawnSpec;
  readonly descriptor: RuntimeDescriptor;
  readonly config: ResolvedProbeConfig;
  /**
   * The ONE spawn site a probe may use (F10): `Supervisor.spawn`, never `node:child_process`.
   * The `no-direct-spawn` guard is extended to this file by M1-WP-C.
   */
  readonly supervisor: Supervisor;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly signal?: AbortSignal;
}

/**
 * ONE throwaway process: `initialize`, and when `deep` also `session/new` in a `mkdtemp` cwd plus
 * the side-effect-free method battery (CONTRACTS.md §17.5, H16). Reclaims the tree on every edge
 * and leaves no temp directory behind. Costs ~0 tokens — corpus `08` ran 11 probes and no prompt.
 *
 * Owned by M1-WP-E.
 */
export function probeAgent(_o: ProbeOptions): Promise<ProbeSummary> {
  throw new OmniError("internal", "unimplemented: M1-WP-E");
}
