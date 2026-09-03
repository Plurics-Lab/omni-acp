import type { StopReason, ToolCallContent, ToolCallStatus } from "./acp.js";
import { OmniError, type OmniErrorBody } from "./errors.js";
import type { EventEnvelope } from "./events.js";
import type { Seq, TurnId, WorkerId } from "./ids.js";

export interface FileChange {
  readonly path: string;
  readonly oldText: string | null;
  readonly newText: string;
}

export interface ToolCallView {
  readonly toolCallId: string;
  readonly title: string | null;
  readonly kind: string | null;
  readonly status: ToolCallStatus | string | null;
  readonly locations: readonly { path: string; line?: number }[];
  readonly content: readonly ToolCallContent[];
  readonly rawInput?: unknown;
  readonly rawOutput?: unknown;
}

export interface InteractionRecord {
  readonly requestId: string;
  readonly title: string;
  readonly decision: "allow" | "deny" | "error";
  readonly optionId: string | null;
  readonly rule: string;
  readonly at: string;
}

/** DESIGN §9.1, with M0's honest nulls. */
export interface TurnResult {
  readonly turnId: TurnId;
  readonly workerId: WorkerId;
  /** null when the turn ended by worker close rather than by `idle` — never faked (§7.3). */
  readonly stopReason: StopReason | null;
  readonly text: string;
  readonly toolCalls: readonly ToolCallView[];
  /** From ToolCallContent{type:"diff"} (CONTRACTS.md F5). */
  readonly changes: readonly FileChange[];
  /** M0: always null (D8, the git provider is M2). */
  readonly patch: string | null;
  readonly usage?: {
    used: number;
    size: number;
    cost?: { amount: number; currency: string };
  };
  readonly interactions: readonly InteractionRecord[];
  readonly error: OmniErrorBody | null;
}

export type TurnState = "running" | "completed" | "failed" | "unknown";

export interface TurnStatus {
  readonly turnId: TurnId;
  readonly state: TurnState;
  readonly startSeq: Seq | null;
  readonly endSeq: Seq | null;
  readonly stopReason: StopReason | null;
  /** null only when state === "unknown". For "running" it is the partial aggregate so far. */
  readonly result: TurnResult | null;
}

/**
 * Pure, dependency-free, deterministic. Same envelopes in => deep-equal result out, always.
 * Called by the daemon for GET /turns/{id} AND by the client SDK for prompt().
 * One implementation => polling and streaming cannot disagree (DESIGN §5.5).
 *
 * A turn is terminal on `state_update{idle}` for that turnId OR on any
 * `omni.worker_state{state:"closed"}` — see CONTRACTS.md §7.3.
 *
 * MUST NOT read `messageId` (CONTRACTS.md F3).
 */
export function reduceTurn(turnId: TurnId, envelopes: readonly EventEnvelope[]): TurnResult {
  throw new OmniError("internal", "unimplemented: WP-1 (turn.reduceTurn)");
}

export function turnStatus(turnId: TurnId, envelopes: readonly EventEnvelope[]): TurnStatus {
  throw new OmniError("internal", "unimplemented: WP-1 (turn.turnStatus)");
}
