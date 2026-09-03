import {
  OmniError,
  type AgentCapabilitiesSnapshot,
  type Clock,
  type SessionId,
} from "@omni-acp/protocol";
import type { AcpLink } from "../acp/link.js";

export interface HandshakeResult {
  readonly capabilities: AgentCapabilitiesSnapshot;
  readonly sessionId: SessionId;
}

/**
 * `initialize{protocolVersion: 1, clientCapabilities: {}}` then
 * `session/new{cwd, mcpServers: []}` — always the empty array in M0; MCP presets are M2
 * (DESIGN §8).
 *
 * Internal to WP-4; not part of CONTRACTS.md §5. The budget and the tree reclamation on every
 * failure edge belong to `createWorker`, which is the only caller.
 */
export function runHandshake(
  link: AcpLink,
  o: { cwd: string; timeoutMs: number; clock: Clock; signal?: AbortSignal },
): Promise<HandshakeResult> {
  throw new OmniError("internal", "unimplemented: WP-4 (worker.runHandshake)");
}
