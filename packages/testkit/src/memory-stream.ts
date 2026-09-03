import { OmniError, type AcpStream } from "@omni-acp/protocol";

/**
 * Two cross-wired TransformStreams satisfying acp.Stream (CONTRACTS.md F7).
 * No process, no framing — this is the Tier-1 fixture that drives a real `acp.agent()`
 * against a real `acp.client()` in-memory.
 *
 * Returns `[clientSide, agentSide]`.
 */
export function memoryStreamPair(): [AcpStream, AcpStream] {
  throw new OmniError("internal", "unimplemented: WP-1 (testkit.memoryStreamPair)");
}
