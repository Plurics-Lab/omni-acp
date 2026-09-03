import {
  OmniError,
  type AgentCatalogEntry,
  type DaemonId,
  type DaemonInfo,
  type WhoAmIResponse,
  type WorkerSnapshot,
} from "@omni-acp/protocol";
import type { Transport } from "./transport.js";
import type { Worker } from "./worker.js";

export interface CreateAgentOptions {
  readonly cwd: string;
  readonly label?: string;
  readonly timeoutMs?: number;
  /** M0: only the empty tuple type-checks. MCP presets are M2. */
  readonly mcp?: readonly [];
  readonly onUnresolved?: "deny";
}

export interface Server {
  readonly url: string;
  readonly daemonId: DaemonId;
  /** From connect()'s single GET /v1/whoami. */
  readonly me: WhoAmIResponse;
  info(): Promise<DaemonInfo>;
  agents(): Promise<readonly AgentCatalogEntry[]>;
  createAgent(agentId: string, opts: CreateAgentOptions): Promise<Worker>;
  /** Snapshots, not live handles — a listing must not open N SSE streams (D31). */
  workers(): Promise<readonly WorkerSnapshot[]>;
  attach(workerId: string): Promise<Worker>;
  /** Closes local streams. For local(), also stops the embedded daemon. Remote workers survive. */
  close(): Promise<void>;
}

export function createServer(
  transport: Transport,
  me: WhoAmIResponse,
  url: string,
  onClose?: () => Promise<void>,
): Server {
  throw new OmniError("internal", "unimplemented: WP-6 (client.createServer)");
}
