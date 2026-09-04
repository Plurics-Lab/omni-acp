import { OmniError } from "@omni-acp/protocol";

/**
 * A tier-2 fixture agent that REPLAYS a recorded transcript over a REAL pipe, so the corpus also
 * exercises the Supervisor, the frame limiter and the AcpLink — not only the mapper
 * (CONTRACTS.md §5.7).
 *
 * Owned by M1-WP-B.
 */
export function wireAgentPath(): string {
  throw new OmniError("internal", "unimplemented: M1-WP-B");
}
