import { z } from "zod";
import type { NormalizedSessionUpdate, PermissionOption } from "./acp.js";
import { OmniError, type OmniErrorBody } from "./errors.js";
import type { DaemonId, SessionId, Seq, TurnId, WorkerId } from "./ids.js";

export const WORKER_STATES = [
  "starting",
  "ready",
  "running",
  "requires_action",
  "hibernated",
  "closed",
] as const;
export type WorkerState = (typeof WORKER_STATES)[number];

/** Reachable in M0. The other two are wire-stable but never emitted, so M1 is additive. */
export const M0_WORKER_STATES = ["starting", "ready", "running", "closed"] as const;

export const EVENT_KINDS = [
  "acp.session_update",
  "acp.interaction",
  "omni.policy_decision",
  "omni.worker_state",
  "omni.error",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export interface EnvelopeMeta {
  readonly seq: Seq;
  /** ISO-8601 with milliseconds, from Clock. */
  readonly ts: string;
  readonly daemonId: DaemonId;
  readonly workerId: WorkerId;
  /** null before session/new lands. */
  readonly sessionId: SessionId | null;
  /** null outside a turn. */
  readonly turnId: TurnId | null;
  /**
   * ACP version of `payload` AS WRITTEN.
   * M0: daemon-synthesized state_update = 2; agent-forwarded updates = 1.
   * M1: every acp.* payload becomes 2. Clients branch on this instead of guessing,
   * which is what makes the M1 normalizer a non-breaking change.
   * Non-acp kinds are always 2.
   */
  readonly payloadVersion: 1 | 2;
  /** Set while draining a session/load|resume replay window (M1). Absent in M0. */
  readonly replay?: true;
}

export type WorkerCloseReason =
  | "client_request"
  | "daemon_shutdown"
  | "spawn_failed"
  | "handshake_error"
  | "handshake_timeout"
  | "agent_exited"
  | "agent_crashed"
  | "protocol_error"
  | "cancel_timeout"
  /** Reserved for M1. */
  | "not_resumable";

export interface WorkerStatePayload {
  readonly state: WorkerState;
  readonly previous: WorkerState | null;
  readonly reason: WorkerCloseReason | "created" | "handshake_ok" | "prompt" | "turn_end";
  readonly exit?: { code: number | null; signal: string | null };
  /** Honest process-ownership reporting; see CONTRACTS.md §6. Present on close only. */
  readonly leaderExited?: boolean;
  readonly treeGone?: boolean;
  readonly error?: OmniErrorBody;
}

export interface InteractionPayload {
  readonly requestId: string;
  /** M2 adds "elicitation/create". */
  readonly method: "session/request_permission";
  /** Verbatim v1 shape in M0. */
  readonly request: Readonly<Record<string, unknown>>;
  readonly status: "pending" | "answered" | "failed";
  /** M0: always present and immediate — the baseline responder answers inline. */
  readonly answer?: {
    readonly optionId: string | null;
    readonly by: "baseline" | "policy" | "human";
  };
}

export interface PolicyDecisionPayload {
  readonly requestId: string;
  /**
   * The human-readable title of what was asked, taken from
   * `request.toolCall.title ?? ""` when the decision is recorded. It is carried here — and not
   * joined in later from `acp.interaction` — so that `reduceTurn` stays a fold over ONE envelope
   * kind while still producing a well-typed `InteractionRecord` (review R9). v1
   * `RequestPermissionRequest` has no top-level `title`, so this is the only place it is
   * recoverable, and the responder already holds the request when it decides.
   */
  readonly title: string;
  readonly decision: "allow" | "deny" | "error";
  /** M0 is always "m0:auto-deny". */
  readonly rule: string;
  readonly optionId: string | null;
  readonly offered: readonly PermissionOption[];
}

export type EventBody =
  | { readonly kind: "acp.session_update"; readonly payload: NormalizedSessionUpdate }
  | { readonly kind: "acp.interaction"; readonly payload: InteractionPayload }
  | { readonly kind: "omni.policy_decision"; readonly payload: PolicyDecisionPayload }
  | { readonly kind: "omni.worker_state"; readonly payload: WorkerStatePayload }
  | { readonly kind: "omni.error"; readonly payload: OmniErrorBody & { stderrTail?: string } };

export type EventEnvelope = EnvelopeMeta & EventBody;

/**
 * What producers hand to EventLog.append(). seq / ts / daemonId / workerId / sessionId are
 * the log's job and are not expressible here — an attempt to stamp one is a compile error
 * (CONTRACTS.md §7.6).
 */
export type EventInput = EventBody & {
  readonly payloadVersion: 1 | 2;
  readonly turnId?: TurnId | null;
  readonly replay?: true;
};

/** Used by the client to parse SSE `data:` payloads. */
export const eventEnvelopeSchema: z.ZodType<EventEnvelope> = z.custom<EventEnvelope>(() => {
  throw new OmniError("internal", "unimplemented: WP-1 (events.eventEnvelopeSchema)");
});
