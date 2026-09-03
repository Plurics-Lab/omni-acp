import type { AcpStream } from "@omni-acp/protocol";

/**
 * The message type an `acp.Stream` carries, recovered from the contract rather than imported:
 * CONTRACTS.md §5.1 makes `protocol/src/acp.ts` the ONE place the SDK is type-imported, and
 * `AnyMessage` is not among the names it re-exports.
 */
type AcpMessage = AcpStream["writable"] extends WritableStream<infer M> ? M : never;

/**
 * Two cross-wired TransformStreams satisfying acp.Stream (CONTRACTS.md F7).
 * No process, no framing — this is the Tier-1 fixture that drives a real `acp.agent()`
 * against a real `acp.client()` in-memory.
 *
 * Returns `[clientSide, agentSide]`: what the first one writes, the second one reads.
 */
export function memoryStreamPair(): [AcpStream, AcpStream] {
  const clientToAgent = new TransformStream<AcpMessage, AcpMessage>();
  const agentToClient = new TransformStream<AcpMessage, AcpMessage>();
  return [
    { writable: clientToAgent.writable, readable: agentToClient.readable },
    { writable: agentToClient.writable, readable: clientToAgent.readable },
  ];
}
