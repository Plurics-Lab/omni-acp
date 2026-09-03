import type { PromptCapabilities } from "./acp.js";
import type { WorkerCloseReason, WorkerState } from "./events.js";
import type { DaemonId, SessionId, Seq, TokenId, TurnId, WorkerId, WorkerRef } from "./ids.js";

export interface ProcessInfo {
  readonly pid: number;
  /** POSIX process-group id (== pid). `null` on Windows: no addressable group. */
  readonly groupId: number | null;
  readonly startedAt: string;
  readonly command: string;
  readonly argsRedacted: readonly string[];
}

export interface AgentCapabilitiesSnapshot {
  /** M0 negotiates 1 only. */
  readonly protocolVersion: 1;
  /** Verbatim `agentCapabilities` from initialize. Never reshaped, never cached. */
  readonly raw: Readonly<Record<string, unknown>>;
  readonly loadSession: boolean;
  readonly promptCapabilities: PromptCapabilities | null;
  /** sessionCapabilities?.close */
  readonly supportsSessionClose: boolean;
}

export interface WorkerSnapshot {
  readonly workerId: WorkerId;
  readonly daemonId: DaemonId;
  readonly ref: WorkerRef;
  /** null while `starting`. */
  readonly sessionId: SessionId | null;
  readonly agentId: string;
  readonly state: WorkerState;
  /** realpath'd. */
  readonly cwd: string;
  readonly label: string | null;
  readonly ownerTokenId: TokenId;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly headSeq: Seq;
  readonly currentTurnId: TurnId | null;
  readonly capabilities: AgentCapabilitiesSnapshot | null;
  /** null once closed. */
  readonly process: ProcessInfo | null;
  readonly closeReason: WorkerCloseReason | null;
}

export interface CloseResult {
  readonly workerId: WorkerId;
  readonly state: "closed";
  readonly reason: WorkerCloseReason;
  readonly leaderExited: boolean;
  /**
   * true ONLY when the whole tree is provably gone.
   * Always false on Windows in M0 (CONTRACTS.md §6.4, D10).
   */
  readonly treeGone: boolean;
}
