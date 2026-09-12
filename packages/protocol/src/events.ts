import { z } from "zod";
import type { NormalizedSessionUpdate, PermissionOption } from "./acp.js";
import { OMNI_ERROR_CODES, type OmniErrorBody } from "./errors.js";
import { ID_PATTERN } from "./ids.js";
import type {
  DaemonId,
  InteractionId,
  RunId,
  SessionId,
  Seq,
  TokenId,
  TurnId,
  WorkerId,
} from "./ids.js";
import type { LeaseEventPayload } from "./lease.js";
import { RESUME_OUTCOMES, type ResumeReport } from "./resume.js";
import { POLICY_ACTIONS, type PolicyAction } from "./config.js";

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

/**
 * M2-A: the full six. `requires_action` stops being wire-stable-and-unemitted (F43) the moment
 * `onUnresolved:"park"` has somewhere to park.
 */
export const M2_WORKER_STATES = WORKER_STATES;

export const EVENT_KINDS = [
  "acp.session_update",
  "acp.interaction",
  "omni.policy_decision",
  "omni.worker_state",
  /** D5's audit trail: acquire / release / steal / expire. M1 has no separate audit log (M2). */
  "omni.lease",
  "omni.error",
  /**
   * M2-B. One per Run state change, appended to the RUN'S WORKER'S log so `?since=` covers it
   * and `sse.ts` stays frozen — the Run API proxies the worker log rather than adding a second
   * stream writer (Land exit criterion 6).
   */
  "omni.run",
  /**
   * M3-WP1. One per credential operation on a worker — `set` today, `revoked` when the store
   * drops something a live worker was linked to.
   *
   * It carries a FINGERPRINT and never a secret, and it exists because a credential swap is
   * invisible in every other stream: the process does not restart on a `reload:"file"` agent, no
   * state changes, and an operator reading the log would see a turn start answering as somebody
   * else with nothing in between saying why (DESIGN §8's 审计 row, 凭据 line).
   */
  "omni.credential",
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

export type InteractionMethod = "session/request_permission" | "elicitation/create";
export type InteractionKind = "permission" | "elicitation";
/**
 * `pending` MEANS parked: an auto-resolved interaction is emitted once, already terminal, so
 * there is no second word for the same state (ruling M2-R5). M1's three are a strict prefix.
 */
export type InteractionStatus = "pending" | "answered" | "failed" | "expired" | "cancelled";
export type InteractionActor = "baseline" | "policy" | "human" | "timeout" | "daemon";
export type ParkTimeoutAction = "deny" | "fail";

export const INTERACTION_STATUSES = [
  "pending",
  "answered",
  "failed",
  "expired",
  "cancelled",
] as const;
export const INTERACTION_ACTORS = ["baseline", "policy", "human", "timeout", "daemon"] as const;
export const INTERACTION_METHODS = ["session/request_permission", "elicitation/create"] as const;
export const INTERACTION_KINDS = ["permission", "elicitation"] as const;

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
  | "daemon_restart"
  // ── M2 (§5.8.3) ────────────────────────────────────────────────────────────
  /** running → requires_action: an interaction could not be auto-decided and `onUnresolved:"park"`. */
  | "interaction_parked"
  /** requires_action → running: the LAST parked interaction settled. */
  | "interaction_resolved"
  /** requires_action → running: `parkTimeoutAction` fired instead of a human. */
  | "park_timeout"
  /** The idle watchdog sent `session/cancel`. NOT a close — the escalation into `cancel_timeout` is. */
  | "watchdog_idle"
  // ── M3-WP1 ─────────────────────────────────────────────────────────────────
  /**
   * `ready` | `requires_action` | `running` → `starting`: the process is being replaced while the
   * WORKER survives — same id, same lease, same home, `generation + 1`.
   *
   * It is deliberately NOT `wake`: a wake starts from `hibernated` and a restart does not, the
   * lease is RELEASED by a hibernate and KEPT by a restart, and `reduceTurn` treats this reason as
   * the one non-close way a turn can terminate (`TurnResult.error.code: "restarted"`). A reader
   * that could not tell the two apart could not tell "your worker went to sleep" from "your turn
   * was cut short on purpose".
   */
  | "restart";

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
  /**
   * M2. Present on `watchdog_idle` and on a `cancel_timeout` close the watchdog started, so an
   * operator can tell a silent stall from a stuck tool without reading the log.
   */
  readonly watchdog?: { budget: "silent" | "tool"; idleMs: number; openToolCalls: number };
  /** M2. Present on `interaction_parked` / `interaction_resolved` / `park_timeout`. */
  readonly interactions?: readonly InteractionId[];
}

export interface InteractionPayload {
  /**
   * DAEMON-MINTED (F33): `elicitation/create` and `session/request_permission` share ONE
   * agent→client JSON-RPC id counter, so the transport id is not an identity a route may
   * address. `eventEnvelopeSchema` keeps `z.string()` here so an M1-era persisted envelope
   * carrying `perm_1757…_3` still parses; new ids are always `x_<ULID>` (§5.8.1).
   */
  readonly requestId: InteractionId;
  /** M2. OPTIONAL for the M1-envelope reason `raw` is: an M1 daemon knew exactly one kind and
   *  never wrote the field, and a checked-in M1 `events.db` must still parse (Land criterion 3).
   *  Absent reads as `"permission"`. */
  readonly kind?: InteractionKind;
  readonly method: InteractionMethod;
  /**
   * M2: the NORMALIZED view — `{title, subject, options}` for a permission, `{message, fields}`
   * for an elicitation — and the reason `payloadVersion` flips 1 → 2 on this kind. `worker.ts`
   * pre-announced exactly this (F45). An M1-written envelope carries the verbatim v1
   * `RequestPermissionRequest` at `payloadVersion: 1`, and that flag is what tells the two
   * shapes apart (ruling M1-R10).
   */
  readonly request: Readonly<Record<string, unknown>>;
  /**
   * The agent's bytes, untouched, `_meta` included (§7.5). Kept BESIDE the mapped form rather
   * than replaced by it, because an audit of a reshaped object audits our reshaping — and
   * because `_meta._askUserQuestionCustomAnswer` (F30) is the field that decides which of two
   * properties the agent will actually read, and it exists nowhere else.
   *
   * OPTIONAL at the Land step: an M1-written `acp.interaction` has no `raw` (its `request` IS
   * the raw), so a required field would fail the golden that parses a checked-in M1 `events.db`.
   */
  readonly raw?: Readonly<Record<string, unknown>>;
  readonly status: InteractionStatus;
  /** Present exactly while `status === "pending"`. `expiresAt: null` = parked forever. */
  readonly park?: {
    readonly parkedAt: string;
    readonly expiresAt: string | null;
    readonly onTimeout: ParkTimeoutAction;
  };
  /**
   * `subject.toolCall.toolCallId`, or the elicitation's FLAT `params.toolCallId` (F29). The join
   * to the `AskUserQuestion` tool-call mirror (F32) — without it the same interaction counts
   * twice. Optional for the M1-envelope reason above.
   */
  readonly toolCallId?: string | null;
  readonly answer?: {
    /** permission only; null for every elicitation and for a `-32603`. */
    readonly optionId: string | null;
    readonly by: InteractionActor;
    /** elicitation only. F31: accept and decline are indistinguishable in the agent's stream, so
     *  this is the ONLY record the outcome has. */
    readonly action?: "accept" | "decline" | "cancel";
    /** elicitation only. **KEYS ONLY** — a free-text answer is user content and never enters the
     *  log. */
    readonly contentKeys?: readonly string[];
    /** The answering token, when `by === "human"`. DESIGN §8's audit. */
    readonly byToken?: TokenId;
    /** ms spent parked. 0 for an auto-resolved interaction. Optional: an M1 envelope has none. */
    readonly parkedMs?: number;
  };
}

export interface PolicyDecisionPayload {
  readonly requestId: InteractionId;
  /** M2. Optional at the Land step: an M1-written decision names neither, and both are
   *  recoverable from `method`'s M1 default (`session/request_permission`). */
  readonly kind?: InteractionKind;
  readonly method?: InteractionMethod;
  /**
   * The human-readable title of what was asked, taken from
   * `request.toolCall.title ?? ""` when the decision is recorded. It is carried here — and not
   * joined in later from `acp.interaction` — so that `reduceTurn` stays a fold over ONE envelope
   * kind while still producing a well-typed `InteractionRecord` (review R9). v1
   * `RequestPermissionRequest` has no top-level `title`, so this is the only place it is
   * recoverable, and the responder already holds the request when it decides.
   */
  readonly title: string;
  /**
   * WIDENED, and there is exactly ONE of these per interaction, emitted at SETTLEMENT (ruling
   * M2-R4). `answer` / `cancel` are the elicitation arms: an accepted elicitation is not a
   * granted permission and must never be counted as one. There is deliberately no `"park"` arm —
   * a park is not a decision, and a row that must later be corrected is a fold row that was never
   * true.
   */
  readonly decision: "allow" | "deny" | "answer" | "cancel" | "error";
  /** M2. Optional at the Land step; an M1-written decision is always `"baseline"`. */
  readonly by?: InteractionActor;
  /** M0 is always "m0:auto-deny". */
  readonly rule: string;
  /** M2. Where `rule` came from, so an operator tells a ceiling clamp from an author's intent. */
  readonly ruleSource?: "baseline" | "default" | "preset" | "inline" | "ceiling";
  /** M2. Set when the token's `policyCeiling` narrowed the resolved action. NEVER silent (§20.5). */
  readonly clamped?: { readonly from: PolicyAction; readonly by: string };
  /** M2. ms spent parked; 0 for an auto-resolved interaction. */
  readonly parkedMs?: number;
  readonly optionId: string | null;
  /** `[]` for an elicitation — an empty array is not a null. */
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
  /**
   * M2. F26: after ONE `allow_always` the engine is never consulted again for that session and
   * nothing on the wire says so. Only reachable under `interaction.allowAlways:"human"`; it is
   * how WE announce what the agent will not, and it makes `WorkerSnapshot.policyBlinded` sticky.
   */
  readonly blindsPolicy?: true;
}

export type RunState =
  | "queued"
  | "starting"
  | "running"
  | "requires_action"
  | "succeeded"
  | "failed"
  | "cancelled"
  /** A previous boot owned this run; its worker died with that boot (§24.4). */
  | "abandoned";

export const RUN_STATES = [
  "queued",
  "starting",
  "running",
  "requires_action",
  "succeeded",
  "failed",
  "cancelled",
  "abandoned",
] as const;

export interface RunEventPayload {
  readonly runId: RunId;
  readonly state: RunState;
  readonly previous: RunState | null;
  readonly reason: string;
  readonly error?: OmniErrorBody;
}

/**
 * M3-WP1's audit envelope. NO SECRET, EVER — the whole payload is metadata.
 *
 * `fingerprint` is the first 12 hex characters of the sha256 over the credential's content, which
 * is enough to say "this is a different credential than before" and useless for authenticating
 * anything. `applied` is what actually happened, which is not always what was asked for: a
 * `reload:"restart"` agent mid-turn answers `on-next-start`, and an operator who read only the
 * request would believe the swap had taken effect.
 */
export interface CredentialEventPayload {
  readonly op: "set" | "revoked";
  /** The credential NAME (`"default"`), never its content. */
  readonly credential: string | null;
  /** `"files"` | `"token"` | `"apiKey"` | `"inherit"` | `"none"`. */
  readonly method: string;
  /** sha256 prefix, 12 hex characters. `null` for `inherit` / `none`, which hash nothing. */
  readonly fingerprint: string | null;
  readonly applied: "immediate" | "restarted" | "on-next-start" | "deferred";
  /** The worker's generation AFTER this operation, so a restart is visible in the audit line. */
  readonly generation: number;
  /** The fingerprint this replaced, or null when the worker had none. */
  readonly previous: string | null;
}

export type EventBody =
  | { readonly kind: "acp.session_update"; readonly payload: NormalizedSessionUpdate }
  | { readonly kind: "acp.interaction"; readonly payload: InteractionPayload }
  | { readonly kind: "omni.policy_decision"; readonly payload: PolicyDecisionPayload }
  | { readonly kind: "omni.worker_state"; readonly payload: WorkerStatePayload }
  | { readonly kind: "omni.lease"; readonly payload: LeaseEventPayload }
  | { readonly kind: "omni.error"; readonly payload: OmniErrorBody & { stderrTail?: string } }
  | { readonly kind: "omni.run"; readonly payload: RunEventPayload }
  | { readonly kind: "omni.credential"; readonly payload: CredentialEventPayload };

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

/**
 * An id field that is TYPED as a branded id but PARSED as a bare string.
 *
 * `InteractionPayload.requestId` is an `InteractionId` from M2 on, and every id this daemon mints
 * from now on is `x_<ULID>` — but an M1-era persisted envelope carries `perm_1757…_3`, and Land
 * exit criterion 3 requires a checked-in M1 `events.db` to parse under the M2 schema. Narrowing
 * the pattern here would fail exactly that golden, so the migration lives in the TYPE and the
 * schema stays permissive (§5.8.1's migration note).
 */
const looseId = <T extends string>(): z.ZodType<T> => z.string() as unknown as z.ZodType<T>;

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
  // ── M3-WP1 ────────────────────────────────────────────────────────────────
  "restart",
  // ── M2 (§5.8.3) ───────────────────────────────────────────────────────────
  "interaction_parked",
  "interaction_resolved",
  "park_timeout",
  "watchdog_idle",
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
    // `requestId` stays a bare `z.string()`: the TYPE is `InteractionId` from M2 on, but an
    // M1-era persisted envelope carries `perm_1757…_3` and must still parse (§5.8.1's migration
    // note). `request` stays a shallow `z.record` for the reason §5.8.3 gives — `payloadVersion`
    // (1 vs 2) is what tells the v1-verbatim shape from M2's mapped view apart, and that is the
    // field's entire job (ruling M1-R10).
    payload: z.object({
      requestId: looseId<InteractionId>(),
      kind: z.enum(INTERACTION_KINDS).optional(),
      method: z.enum(INTERACTION_METHODS),
      request: z.record(z.string(), z.unknown()),
      raw: z.record(z.string(), z.unknown()).optional(),
      status: z.enum(INTERACTION_STATUSES),
      park: z
        .object({
          parkedAt: z.string(),
          expiresAt: z.string().nullable(),
          onTimeout: z.enum(["deny", "fail"]),
        })
        .optional(),
      toolCallId: z.string().nullable().optional(),
      answer: z
        .object({
          optionId: z.string().nullable(),
          by: z.enum(INTERACTION_ACTORS),
          action: z.enum(["accept", "decline", "cancel"]).optional(),
          contentKeys: z.array(z.string()).optional(),
          byToken: z.string().optional(),
          parkedMs: z.number().nonnegative().optional(),
        })
        .optional(),
    }),
  }),
  z.object({
    ...envelopeMetaShape,
    kind: z.literal("omni.policy_decision"),
    payload: z.object({
      requestId: looseId<InteractionId>(),
      kind: z.enum(INTERACTION_KINDS).optional(),
      method: z.enum(INTERACTION_METHODS).optional(),
      title: z.string(),
      decision: z.enum(["allow", "deny", "answer", "cancel", "error"]),
      by: z.enum(INTERACTION_ACTORS).optional(),
      rule: z.string(),
      ruleSource: z.enum(["baseline", "default", "preset", "inline", "ceiling"]).optional(),
      clamped: z.object({ from: z.enum(POLICY_ACTIONS), by: z.string() }).optional(),
      parkedMs: z.number().nonnegative().optional(),
      optionId: z.string().nullable(),
      offered: z.array(permissionOptionSchema),
      toolCallId: z.string().nullable(),
      blindsPolicy: z.literal(true).optional(),
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
      watchdog: z
        .object({
          budget: z.enum(["silent", "tool"]),
          idleMs: z.number().nonnegative(),
          openToolCalls: z.number().int().nonnegative(),
        })
        .optional(),
      interactions: z.array(looseId<InteractionId>()).optional(),
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
  z.object({
    ...envelopeMetaShape,
    kind: z.literal("omni.run"),
    payload: z.object({
      runId: id<RunId>(ID_PATTERN.run, "runId"),
      state: z.enum(RUN_STATES),
      previous: z.enum(RUN_STATES).nullable(),
      reason: z.string(),
      error: z.object(omniErrorBodyShape).optional(),
    }),
  }),
  z.object({
    ...envelopeMetaShape,
    kind: z.literal("omni.credential"),
    // Fully specified, because we are its author (the rule above the schema). There is no
    // `z.unknown()` anywhere in this arm ON PURPOSE: a `passthrough` here is how a secret would
    // one day arrive in an envelope nobody re-read, and `secret-never-leaks` greps the wire.
    payload: z.object({
      op: z.enum(["set", "revoked"]),
      credential: z.string().nullable(),
      method: z.string(),
      fingerprint: z
        .string()
        .regex(/^[0-9a-f]{12}$/)
        .nullable(),
      applied: z.enum(["immediate", "restarted", "on-next-start", "deferred"]),
      generation: z.number().int().nonnegative(),
      previous: z
        .string()
        .regex(/^[0-9a-f]{12}$/)
        .nullable(),
    }),
  }),
]);
