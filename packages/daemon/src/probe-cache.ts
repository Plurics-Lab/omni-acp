import { OmniError, type ProbeSummary } from "@omni-acp/protocol";

/**
 * `<dataDir>/probes/<id>.json`, mode `0600`, invalidated by the DESCRIPTOR FINGERPRINT
 * (CONTRACTS.md §17.5, H16).
 *
 * The fingerprint is the invalidation key rather than a TTL alone, because the thing a cached
 * probe describes is a specific command ⊕ args ⊕ agent version — change any of them and the
 * cached capabilities are a claim about a program that is no longer there.
 *
 * Owned by M1-WP-E.
 */
export interface ProbeCache {
  read(agentId: string): Promise<ProbeSummary | null>;
  write(agentId: string, p: ProbeSummary): Promise<void>;
}

export function createProbeCache(_o: { dataDir: string }): ProbeCache {
  throw new OmniError("internal", "unimplemented: M1-WP-E");
}
