import type {
  EventInput,
  InteractionActor,
  InteractionPayload,
  InteractionRequest,
  ParkTimeoutAction,
  PolicyAction,
  PolicyDecisionPayload,
  TokenId,
  TurnId,
} from "@omni-acp/protocol";

/**
 * The two (three, when it parks) envelopes an interaction leaves behind, in ONE place.
 *
 * `baselineInteractions` and the real strategy both build them here, which is what makes
 * acceptance 1's "identical modulo `payloadVersion` and the additive fields" a property of the
 * code rather than of two authors agreeing. §19.10 is the spelling, byte for byte.
 *
 * Ruling M2-R3 is why `payloadVersion` is 2 on BOTH kinds: `acp.interaction` now carries the
 * NORMALIZED `request` — `{title, subject, options}` for a permission, `{message, fields}` for an
 * elicitation — with the agent's bytes beside it in `raw`. `worker.ts` pre-announced exactly this
 * (F45), and `payloadVersion` is how a client tells the two shapes apart (M1-R10). The M1 path
 * still living inside the frozen `worker.ts` keeps stamping 1 with the verbatim request, and
 * `permission-responder.test.ts` runs unedited against it.
 *
 * Owned by M2-A-WP-I.
 */

/** Everything one settlement records. Assembled by the strategy, spelled out here. */
export interface SettlementRecord {
  readonly status: "answered" | "failed" | "expired" | "cancelled";
  readonly decision: PolicyDecisionPayload["decision"];
  readonly by: InteractionActor;
  readonly byToken: TokenId | null;
  readonly rule: string;
  readonly ruleSource: PolicyDecisionPayload["ruleSource"] | null;
  readonly clamped: { readonly from: PolicyAction; readonly by: string } | null;
  readonly optionId: string | null;
  /** elicitation only (F31: the outcome exists nowhere else). */
  readonly action: "accept" | "decline" | "cancel" | null;
  /** elicitation only, KEYS ONLY — a free-text answer is user content and never enters the log. */
  readonly contentKeys: readonly string[] | null;
  readonly parkedMs: number;
  /** F26, and only reachable under `interaction.allowAlways:"human"` (M2-R19). */
  readonly blindsPolicy: boolean;
}

/** The `park` block on a pending `acp.interaction`. Present exactly while `status === "pending"`. */
export interface ParkBlock {
  readonly parkedAt: string;
  /** null = parked forever (`parkTimeoutMs: 0`), which is a real configuration (M2-R7). */
  readonly expiresAt: string | null;
  readonly onTimeout: ParkTimeoutAction;
}

/**
 * The NORMALIZED view §5.8.3 names: `{title, subject, options}` for a permission, `{message,
 * fields}` for an elicitation. `raw` beside it is the audit (§7.5) — this is a view, and a view is
 * not evidence.
 */
function normalizedRequest(req: InteractionRequest): Record<string, unknown> {
  return req.kind === "permission"
    ? { title: req.title, subject: req.subject, options: req.options }
    : { message: req.message ?? "", fields: req.fields };
}

/** The `answer` block, derived from the record so the two can never disagree. */
export function answerFrom(s: SettlementRecord): NonNullable<InteractionPayload["answer"]> {
  return {
    optionId: s.optionId,
    by: s.by,
    ...(s.action === null ? {} : { action: s.action }),
    ...(s.contentKeys === null ? {} : { contentKeys: s.contentKeys }),
    ...(s.byToken === null ? {} : { byToken: s.byToken }),
    parkedMs: s.parkedMs,
  };
}

/**
 * §19.10's `n+0`: the park is ANNOUNCED before `omni.worker_state{interaction_parked}`, so an SSE
 * consumer that keys on `requestId` learns what is being asked before it learns the worker moved.
 *
 * There is deliberately no `omni.policy_decision` here (ruling M2-R4): a parked request has no
 * decision yet, and a row that must later be corrected is a fold row that was never true.
 */
export function pendingInteractionEvent(
  req: InteractionRequest,
  park: ParkBlock,
  turnId: TurnId | null,
): EventInput {
  const payload: InteractionPayload = {
    requestId: req.id,
    kind: req.kind,
    method: req.method,
    request: normalizedRequest(req),
    raw: req.raw,
    status: "pending",
    park,
    toolCallId: req.toolCallId,
  };
  return { kind: "acp.interaction", payloadVersion: 2, turnId, payload };
}

/**
 * The terminal `acp.interaction`.
 *
 * For ONE `requestId` this may be the SECOND frame where M1 emitted only one, which is precisely
 * why a consumer keys on `requestId` and never counts frames (§19.10). An auto-resolved
 * interaction produces this one alone.
 */
export function settledInteractionEvent(
  req: InteractionRequest,
  s: SettlementRecord,
  turnId: TurnId | null,
): EventInput {
  const payload: InteractionPayload = {
    requestId: req.id,
    kind: req.kind,
    method: req.method,
    request: normalizedRequest(req),
    raw: req.raw,
    status: s.status,
    toolCallId: req.toolCallId,
    answer: answerFrom(s),
  };
  return { kind: "acp.interaction", payloadVersion: 2, turnId, payload };
}

/**
 * The ONE `omni.policy_decision` per interaction, emitted at SETTLEMENT (ruling M2-R4).
 *
 * It carries `title` so `reduceTurn` folds an `InteractionRecord` from a single envelope kind
 * (review R9), and `toolCallId` so a denial is joinable to the tool call it blocked without
 * parsing the agent's English (§13.4).
 */
export function policyDecisionEvent(
  req: InteractionRequest,
  s: SettlementRecord,
  turnId: TurnId | null,
): EventInput {
  const payload: PolicyDecisionPayload = {
    requestId: req.id,
    kind: req.kind,
    method: req.method,
    title: req.title,
    decision: s.decision,
    by: s.by,
    rule: s.rule,
    ...(s.ruleSource === null || s.ruleSource === undefined ? {} : { ruleSource: s.ruleSource }),
    ...(s.clamped === null ? {} : { clamped: s.clamped }),
    parkedMs: s.parkedMs,
    optionId: s.optionId,
    // `[]` for an elicitation — an empty array is not a null, and a UI that showed "no options
    // offered" for a form would be reporting a permission that never happened.
    offered: req.options,
    toolCallId: req.toolCallId,
    ...(s.blindsPolicy ? { blindsPolicy: true as const } : {}),
  };
  return { kind: "omni.policy_decision", payloadVersion: 2, turnId, payload };
}

/** The pair, in §7.4's order, which is M1's order: interaction first, decision second. */
export function settlementEvents(
  req: InteractionRequest,
  s: SettlementRecord,
  turnId: TurnId | null,
): readonly EventInput[] {
  return [settledInteractionEvent(req, s, turnId), policyDecisionEvent(req, s, turnId)];
}
