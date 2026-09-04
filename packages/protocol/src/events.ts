import { z } from "zod";
import type { NormalizedSessionUpdate, PermissionOption } from "./acp.js";
import { OMNI_ERROR_CODES, type OmniErrorBody } from "./errors.js";
import { ID_PATTERN } from "./ids.js";
import type { DaemonId, SessionId, Seq, TurnId, WorkerId } from "./ids.js";
import type { LeaseEventPayload } from "./lease.js";
import { RESUME_OUTCOMES, type ResumeReport } from "./resume.js";

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

/** Reachable in M1. `requires_action` stays wire-stable and unemitted until M2's policy engine. */
export const M1_WORKER_STATES = ["starting", "ready", "running", "hibernated", "closed"] as const;

export const EVENT_KINDS = [
  "acp.session_update",
  "acp.interaction",
  "omni.policy_decision",
  "omni.worker_state",
  /** D5's audit trail: acquire / release / steal / expire. M1 has no separate audit log (M2). */
  "omni.lease",
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
   *
   * M1 SHARPENS THIS (ruling M1-R10). `2` means the Normalizer landed the payload on a KNOWN v2
   * arm — mapped or already v2-shaped. `1` means the map has **no row** for this `sessionUpdate`
   * kind and the agent's object was forwarded by identity. A client can therefore tell
   * "normalized" from "vendor passthrough" with no second field, and adding a row later flips a
   * payload from 1 to 2 with no wire break. Non-`acp.*` kinds are always 2.
   */
  readonly payloadVersion: 1 | 2;
  /**
   * D6. Set on EVERY envelope appended between the `session/load|resume` request bytes reaching
   * stdin and its response resolving — the window F16 confirms is exact and uninterleaved.
   *
   * The literal `true` is deliberately KEPT rather than widened to an object: the envelope field
   * is a filter flag for consumers, and the audit (which method, how many, how many dropped)
   * belongs on `ResumeReport`, which is where an operator reads it (ruling M1-R5).
   *
   * Replay envelopes are STORED, consume a `seq`, AND are streamed. `reduceTurn` ignores them and
   * the SDK's `stream()` filters them by default.
   */
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
  | "not_resumable"
  /** Idle timer fired on a worker whose agent cannot resume AND `hibernate.whenNotResumable:"close"`. */
  | "idle_timeout"
  /** `hibernate.maxWakeFailures` consecutive transient wake failures; the pointer is abandoned. */
  | "wake_failed"
  /** A previous boot owned this row and the agent cannot resume, so the session is unrecoverable. */
  | "orphaned"
  /**
   * A wake re-ran the ACL against the CURRENT config and the worker no longer passes (§15.3
   * step 2, §15.5's 403 row). It is NOT `client_request`: nobody issued a DELETE, and reusing
   * that reason would make the audit log say an operator closed a worker the config closed
   * (review R6).
   */
  | "acl_revoked";

/** A process this daemon no longer owns, recorded so it is never silently forgotten (§15.7). */
export interface OrphanRecord {
  readonly pid: number;
  readonly groupId: number | null;
  readonly startedAt: string;
  /** `null` where this platform cannot fingerprint (win32) — then we NEVER signal the pid. */
  readonly fingerprint: string | null;
  readonly reaped: boolean;
  /** "fingerprint_mismatch" | "unsupported_platform" | "policy" | "gone" | null. */
  readonly reapSkipped: string | null;
}

export type WorkerStateReason =
  | WorkerCloseReason
  | "created"
  | "handshake_ok"
  | "prompt"
  | "turn_end"
  /** ready -> hibernated, idle timer or explicit request. */
  | "hibernate"
  /** hibernated -> starting. */
  | "wake"
  /** starting -> ready after a wake; `resume` is always present. */
  | "resumed"
  /** starting -> hibernated; transient failure, pointer KEPT. */
  | "wake_retry"
  /** a previous boot owned this row; `orphan` is present. */
  | "daemon_restart";

export interface WorkerStatePayload {
  readonly state: WorkerState;
  readonly previous: WorkerState | null;
  readonly reason: WorkerStateReason;
  readonly exit?: { code: number | null; signal: string | null };
  /** Honest process-ownership reporting; see CONTRACTS.md §6. Present on close only. */
  readonly leaderExited?: boolean;
  readonly treeGone?: boolean;
  readonly error?: OmniErrorBody;
  /** Present on `resumed` | `wake_retry` | `not_resumable`. */
  readonly resume?: ResumeReport;
  /** Present on `daemon_restart` | `orphaned`. */
  readonly orphan?: OrphanRecord;
  /** Sticky: set by any abnormal death, and it NEVER goes back to false (D2). */
  readonly crashed?: boolean;
  /** Processes this worker has had. 0 = it has never run. Increments on every wake. */
  readonly generation?: number;
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
  /**
   * `subject.toolCall.toolCallId` when the subject is a tool call, else null.
   *
   * This is what makes corpus finding 7 ("deny is invisible in `stopReason`") tractable WITHOUT
   * parsing English. The only agent-side signal is `rawOutput: "User refused permission to run
   * tool"`. We do not need it: we are the party that denied, so `reduceTurn` joins this id to the
   * tool call and reports it in `TurnResult.deniedToolCalls` (§13.4).
   */
  readonly toolCallId: string | null;
}

export type EventBody =
  | { readonly kind: "acp.session_update"; readonly payload: NormalizedSessionUpdate }
  | { readonly kind: "acp.interaction"; readonly payload: InteractionPayload }
  | { readonly kind: "omni.policy_decision"; readonly payload: PolicyDecisionPayload }
  | { readonly kind: "omni.worker_state"; readonly payload: WorkerStatePayload }
  | { readonly kind: "omni.lease"; readonly payload: LeaseEventPayload }
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

// ── the SSE parse schema ─────────────────────────────────────────────────────
//
// Two rules shape it:
//
//  1. The ENVELOPE is ours, so it is validated field by field — a frame whose `seq` is not a
//     positive integer, or whose `workerId` is not a `w_`-prefixed ULID, is not something a
//     client should reduce over.
//  2. The PAYLOAD of an `acp.*` kind is the agent's, and CONTRACTS.md §7.5 says it is forwarded
//     byte-for-byte, `_meta` included. So agent-authored payloads are checked shallowly with
//     `z.custom` (which returns the value untouched) rather than re-modelled with `z.object`
//     (which would rebuild it and drop every field this milestone has not enumerated).
//
// Daemon-authored payloads (`omni.*`) are fully specified here, because we are their author and
// an unknown key in one is a bug rather than a proxy-chain.

const id = <T extends string>(pattern: RegExp, what: string) =>
  z.custom<T>((v) => typeof v === "string" && pattern.test(v), { message: `invalid ${what}` });

const envelopeMetaShape = {
  seq: z.number().int().positive(),
  ts: z.string().min(1),
  daemonId: id<DaemonId>(ID_PATTERN.daemon, "daemonId"),
  workerId: id<WorkerId>(ID_PATTERN.worker, "workerId"),
  sessionId: z.string().nullable(),
  turnId: id<TurnId>(ID_PATTERN.turn, "turnId").nullable(),
  payloadVersion: z.union([z.literal(1), z.literal(2)]),
  replay: z.literal(true).optional(),
};

const sessionUpdatePayload = z.custom<NormalizedSessionUpdate>(
  (v) =>
    typeof v === "object" &&
    v !== null &&
    typeof (v as { sessionUpdate?: unknown }).sessionUpdate === "string",
  { message: "invalid session update payload" },
);

/**
 * `kind` is deliberately not re-modelled: it is `PermissionOptionKind` in the SDK's closed
 * union, but D4 rule 6 requires an UNKNOWN kind to survive the wire so the responder can treat
 * it as a non-grant. A `z.enum` here would reject exactly the frame that rule exists for.
 */
const permissionOptionSchema = z.custom<PermissionOption>(
  (v) =>
    typeof v === "object" &&
    v !== null &&
    typeof (v as { optionId?: unknown }).optionId === "string" &&
    typeof (v as { kind?: unknown }).kind === "string",
  { message: "invalid permission option" },
);

const acpErrorDetailSchema = z.object({
  code: z.number(),
  message: z.string(),
  data: z.unknown().optional(),
});

const omniErrorBodyShape = {
  code: z.enum(OMNI_ERROR_CODES),
  message: z.string(),
  acp: acpErrorDetailSchema.optional(),
};

/** The lifecycle reasons that are not close reasons; kept module-private (`WorkerCloseReason`
 *  is a type, and CONTRACTS.md §5.1 does not export a runtime table for it). */
const WORKER_STATE_REASONS = [
  "client_request",
  "daemon_shutdown",
  "spawn_failed",
  "handshake_error",
  "handshake_timeout",
  "agent_exited",
  "agent_crashed",
  "protocol_error",
  "cancel_timeout",
  "not_resumable",
  "idle_timeout",
  "wake_failed",
  "orphaned",
  "acl_revoked",
  "created",
  "handshake_ok",
  "prompt",
  "turn_end",
  "hibernate",
  "wake",
  "resumed",
  "wake_retry",
  "daemon_restart",
] as const;

/**
 * `omni.*` payloads are OURS, so they are modelled field by field — an unknown key in one is a
 * bug rather than a proxy-chain (the rule stated above `envelopeMetaShape`).
 */
const clientRefWireSchema = z.object({
  tokenId: z.string(),
  clientId: z.string().nullable(),
});

const leaseSnapshotSchema = z.object({
  workerId: id<WorkerId>(ID_PATTERN.worker, "workerId"),
  holder: clientRefWireSchema.nullable(),
  epoch: z.number().int().nonnegative(),
  expiresAt: z.string().nullable(),
  acquiredAt: z.string().nullable(),
  pinned: z.boolean(),
});

const resumeReportSchema = z.object({
  outcome: z.enum(RESUME_OUTCOMES),
  hint: z.enum([
    "ok",
    "cwd_mismatch",
    "not_found",
    "silently_created",
    "refusal_no_activity",
    "capability_absent",
    "method_not_found",
    "transport",
    "timeout",
    "rate_limited",
    "unclassified",
  ]),
  rule: z.string(),
  method: z.enum(["session/load", "session/resume"]).nullable(),
  requested: z.string().nullable(),
  landedOn: z.string().nullable(),
  historyLost: z.boolean(),
  acp: acpErrorDetailSchema.nullable(),
  replayedEvents: z.number().int().nonnegative(),
  replayDropped: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
  at: z.string(),
});

const orphanRecordSchema = z.object({
  pid: z.number().int(),
  groupId: z.number().int().nullable(),
  startedAt: z.string(),
  fingerprint: z.string().nullable(),
  reaped: z.boolean(),
  reapSkipped: z.string().nullable(),
});

/** Used by the client to parse SSE `data:` payloads. */
export const eventEnvelopeSchema: z.ZodType<EventEnvelope> = z.discriminatedUnion("kind", [
  z.object({
    ...envelopeMetaShape,
    kind: z.literal("acp.session_update"),
    payload: sessionUpdatePayload,
  }),
  z.object({
    ...envelopeMetaShape,
    kind: z.literal("acp.interaction"),
    payload: z.object({
      requestId: z.string(),
      method: z.literal("session/request_permission"),
      request: z.record(z.string(), z.unknown()),
      status: z.enum(["pending", "answered", "failed"]),
      answer: z
        .object({
          optionId: z.string().nullable(),
          by: z.enum(["baseline", "policy", "human"]),
        })
        .optional(),
    }),
  }),
  z.object({
    ...envelopeMetaShape,
    kind: z.literal("omni.policy_decision"),
    payload: z.object({
      requestId: z.string(),
      title: z.string(),
      decision: z.enum(["allow", "deny", "error"]),
      rule: z.string(),
      optionId: z.string().nullable(),
      offered: z.array(permissionOptionSchema),
      toolCallId: z.string().nullable(),
    }),
  }),
  z.object({
    ...envelopeMetaShape,
    kind: z.literal("omni.worker_state"),
    payload: z.object({
      state: z.enum(WORKER_STATES),
      previous: z.enum(WORKER_STATES).nullable(),
      reason: z.enum(WORKER_STATE_REASONS),
      exit: z.object({ code: z.number().nullable(), signal: z.string().nullable() }).optional(),
      leaderExited: z.boolean().optional(),
      treeGone: z.boolean().optional(),
      error: z.object(omniErrorBodyShape).optional(),
      resume: resumeReportSchema.optional(),
      orphan: orphanRecordSchema.optional(),
      crashed: z.boolean().optional(),
      generation: z.number().int().nonnegative().optional(),
    }),
  }),
  z.object({
    ...envelopeMetaShape,
    kind: z.literal("omni.lease"),
    payload: z.object({
      op: z.enum(["acquired", "released", "stolen", "expired"]),
      lease: leaseSnapshotSchema,
      previous: clientRefWireSchema.nullable(),
      by: clientRefWireSchema.nullable(),
      how: z.enum([
        "explicit",
        "implicit",
        "create",
        "steal",
        "hibernate",
        "timeout",
        "daemon_restart",
      ]),
      reason: z.string().nullable(),
    }),
  }),
  z.object({
    ...envelopeMetaShape,
    kind: z.literal("omni.error"),
    payload: z.object({ ...omniErrorBodyShape, stderrTail: z.string().optional() }),
  }),
]);
