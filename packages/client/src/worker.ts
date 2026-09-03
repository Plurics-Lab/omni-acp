import {
  OmniError,
  type ContentBlock,
  type EventEnvelope,
  type OmniError as OmniErrorType,
  type Seq,
  type SessionId,
  type StopReason,
  type ToolCallView,
  type TurnResult,
  type TurnStatus,
  type WorkerId,
  type WorkerRef,
  type WorkerSnapshot,
  type WorkerState,
  type CloseResult,
  type DaemonId,
} from "@omni-acp/protocol";
import type { Transport } from "./transport.js";

export type PromptInput = string | ContentBlock | readonly ContentBlock[];

export interface PromptOptions {
  /** DESIGN §9.1: one turn at a time per worker. Default true (SDK-side serialization, D30). */
  readonly queue?: boolean;
  readonly signal?: AbortSignal;
}

export type StreamEvent =
  | { readonly type: "text"; readonly delta: string }
  | { readonly type: "thought"; readonly delta: string }
  | { readonly type: "tool_call"; readonly toolCall: ToolCallView }
  | { readonly type: "state"; readonly state: "running" | "idle"; readonly stopReason?: StopReason }
  | { readonly type: "raw"; readonly envelope: EventEnvelope }
  | { readonly type: "done"; readonly result: TurnResult };

export interface WorkerEventMap {
  state: (s: WorkerState, e: EventEnvelope) => void;
  event: (e: EventEnvelope) => void;
  error: (e: OmniErrorType) => void;
  closed: (s: WorkerSnapshot) => void;
}

export interface Worker {
  readonly id: WorkerId;
  readonly ref: WorkerRef;
  readonly daemonId: DaemonId;
  readonly sessionId: SessionId | null;
  readonly agentId: string;
  readonly state: WorkerState;
  readonly snapshot: WorkerSnapshot;
  /**
   * POST /prompt -> subscribe with `since = accepted.seq - 1` -> collect until this turnId's
   * `state_update{idle}` OR any `worker_state{closed}` -> `reduceTurn()` locally.
   *
   * The same pure reducer the daemon uses for GET /turns/{id}, so there is no extra round trip
   * and no possible disagreement (DESIGN §5.5, D7). `accepted.seq - 1` is what removes the
   * subscribe/prompt race without a pre-existing subscription.
   */
  prompt(input: PromptInput, opts?: PromptOptions): Promise<TurnResult>;
  stream(input: PromptInput, opts?: PromptOptions): AsyncIterable<StreamEvent>;
  /** Raw envelope tail; auto-reconnects with the last seen seq. */
  events(opts?: { since?: Seq; signal?: AbortSignal }): AsyncIterable<EventEnvelope>;
  turn(turnId: string): Promise<TurnStatus>;
  cancel(): Promise<void>;
  close(): Promise<CloseResult>;
  on<K extends keyof WorkerEventMap>(event: K, cb: WorkerEventMap[K]): () => void;
  readonly closed: Promise<WorkerSnapshot>;
}

export function createWorkerHandle(transport: Transport, snapshot: WorkerSnapshot): Worker {
  throw new OmniError("internal", "unimplemented: WP-6 (client.createWorkerHandle)");
}
