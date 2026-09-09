import type { StopReason, ToolCallContent, ToolCallStatus } from "./acp.js";
import type { PolicyAction } from "./config.js";
import type { OmniErrorBody, OmniErrorCode } from "./errors.js";
import type {
  EventEnvelope,
  InteractionActor,
  InteractionKind,
  InteractionMethod,
  WorkerCloseReason,
  WorkerStatePayload,
} from "./events.js";
import type { InteractionId, Seq, TurnId, WorkerId } from "./ids.js";

export interface FileChange {
  readonly path: string;
  /** v2 `DiffChange.operation`. Derived when the agent gives only v1 fields:
   *  `oldText == null ? "add" : "modify"`. */
  readonly operation: "add" | "modify" | "delete" | "move" | "copy" | string;
  readonly oldText: string | null;
  readonly newText: string;
  /**
   * TRUE when `oldText`/`newText` are the CHANGED FRAGMENT rather than whole-file content, from
   * the descriptor's `diffIsFragment` quirk — never guessed. F19: claude-acp widens the pair
   * between updates (`"mode = slow"→"mode = fast"`, then `"mode = slow\nretries = 3"→…`), so a
   * consumer that writes `newText` to `path` corrupts the file.
   *
   * The fold cannot know the quirk (it is pure over envelopes and holds no descriptor), so the
   * NORMALIZER stamps it onto the diff block it emits and this reads it back; absent ⇒ false.
   */
  readonly fragment: boolean;
}

/** DESIGN §6.2's "`end_turn` ≠ 成功", made machine-readable — with no new event kind (§13.4). */
export type TurnVerdict = "ok" | "partial" | "failed";

export interface TurnWarning {
  /** "rate_limit" | "tool_denied" | "tool_failed" | "permission_not_offered" | … */
  readonly code: string;
  readonly message: string;
  /** Where it came from, so a consumer can weigh it. `stderr` is the weakest and is descriptor-gated.
   *  M2 adds `patch` (D8's honest nulls, §25) and `watchdog` (DESIGN §7's dual budget, §21). */
  readonly source: "usage_meta" | "stderr" | "policy" | "tool_status" | "patch" | "watchdog";
  readonly detail?: Readonly<Record<string, unknown>>;
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
  readonly requestId: InteractionId;
  /** M2. `permission` for every M1-written decision — an M1 daemon knew no other kind. */
  readonly kind: InteractionKind;
  readonly method: InteractionMethod;
  readonly title: string;
  /** M2 widens this: `answer` / `cancel` are the elicitation arms, and an accepted elicitation is
   *  not a granted permission (§5.8.3). */
  readonly decision: "allow" | "deny" | "answer" | "cancel" | "error";
  readonly by: InteractionActor;
  /** ms spent parked. 0 for an auto-resolved interaction, which is every M1 one. */
  readonly parkedMs: number;
  /** F32's join: the same interaction is ALSO a `tool_call` in the stream. `toolCalls` keeps the
   *  tool call, `interactions` keeps the decision, neither duplicates the other. */
  readonly toolCallId: string | null;
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
  /**
   * D8's disk truth, filled by the git provider (§25) and by nothing else. `null` outside a repo,
   * when no provider is wired, when `patchMode` skipped this turn, when git failed, or over
   * `diff.maxBytes` — and **every one of those nulls carries a `TurnWarning{source:"patch"}`
   * saying which**.
   *
   * It rides on `state_update{idle}._meta["omni/patch"]`, exactly as `vendorPatch` and `warnings`
   * already do, so this fold stays PURE and cannot spawn `git` — and the SDK's local
   * `reduceTurn()` and the daemon's `GET /turns/{id}` still cannot disagree (D7, DESIGN §5.5).
   */
  readonly patch: string | null;
  /** Present when a provider ran; `null` when no `omni/patch` key was on `idle` — which is every
   *  M1 turn, so every M1 golden asserting `patch: null` passes unchanged. */
  readonly patchInfo: {
    readonly source: "git" | null;
    readonly truncated: boolean;
    /** "shared_worktree" ⇒ another live worker shares this repo, so the patch may contain ITS
     *  edits and can even contain a half-written file. We report rather than misattribute (§25.4). */
    readonly quality: "exact" | "shared_worktree" | "unavailable";
  } | null;
  /**
   * A patch reconstructed from a descriptor-registered VENDOR `_meta` extension, clearly labelled
   * as such. For claude-acp that is `_meta.claudeCode.toolResponse.{structuredPatch, originalFile,
   * content}` (F19). `null` for any agent without a registered extractor, and `null` rather than
   * wrong when the reconstructed hunk line counts disagree with `oldLines`/`newLines`.
   */
  readonly vendorPatch: { format: "git_patch"; text: string; source: string } | null;
  readonly usage?: {
    used: number;
    size: number;
    cost?: { amount: number; currency: string };
  };
  /**
   * The v2 `Usage` block from the prompt RESPONSE (F21) — a different shape from `usage` above,
   * which stays sourced from the last `usage_update` (F4). Rides on `state_update{idle}.usage`,
   * which is where v2 puts it.
   */
  readonly tokens?: {
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    cachedReadTokens?: number;
    cachedWriteTokens?: number;
  };
  readonly interactions: readonly InteractionRecord[];
  readonly verdict: TurnVerdict;
  readonly warnings: readonly TurnWarning[];
  /** Tool calls whose FINAL status is "failed", in stream order. */
  readonly failedToolCalls: readonly string[];
  /**
   * PERMISSION denials only. F31: a declined elicitation leaves its tool call `completed`, so
   * joining it here would report a tool we blocked that in fact ran. The join is gated on
   * `method === "session/request_permission"` and there is a named table test for exactly that.
   */
  readonly deniedToolCalls: readonly string[];
  /**
   * M2. Tool calls whose LAST observed status is neither `completed` nor `failed` when the turn
   * ended — `null` counts, because "we were never told" is exactly the condition this reports.
   *
   * F36 is the same fact on both real agents: cancelling with a tool in flight produces **no
   * terminal `tool_call_update` at all**. Synthesizing `failed` would be a lie (the tool may well
   * have completed agent-side); blocking for a terminal update would hang forever. So we report,
   * and the turn is `partial` (ruling M2-R8). Computed only when the turn is TERMINAL — a running
   * turn strands nothing.
   */
  readonly strandedToolCalls: readonly string[];
  /** M2. requestIds that were `pending` when this fold ended. For a running turn this is "waiting
   *  for you"; for a finished one it is a bug report. */
  readonly pendingInteractions: readonly InteractionId[];
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

// ── the fold ─────────────────────────────────────────────────────────────────
//
// `reduceTurn` and `turnStatus` are two views of ONE pass, so the daemon's `GET /turns/{id}`
// and the client's `prompt()` cannot disagree even about `state` (DESIGN §5.5, D7).
//
// Note what is NOT read here: `messageId` (CONTRACTS.md F3 — backfill is M1) and
// `idle.usage` (F4 — `IdleStateUpdate.usage` is the v2 `Usage` shape `{totalTokens, …}`, while
// `TurnResult.usage` is the `usage_update` shape `{used, size, cost?}`; taking the former would
// be a type pun that happens to compile).

/**
 * The three `_meta` keys the Normalizer stamps and this fold reads back (§12.5, §13.2, §13.4).
 *
 * They are the ONLY channel between a descriptor-driven layer and this one. `reduceTurn` is pure
 * over envelopes and holds no descriptor, so it cannot know that a rate limit lives at one
 * vendor `_meta` pointer and a patch at another — and it must not: the moment it did, "the
 * descriptor is the only branch" (§17.1) would stop being true of the projection.
 */
const V1_DIFF_META = "omni/v1Diff";
const VENDOR_PATCH_META = "omni/vendorPatch";
const WARNINGS_META = "omni/warnings";
/**
 * M2, seam D (M2-PLAN §1.3). The git provider hands `PatchResult` to the WORKER, which puts it on
 * `TurnInput.prompt_result.meta`; `turn-lifecycle.ts` merges that record into `idle._meta`
 * without reading a single key of it, and this is the one place that knows what the key means.
 * That is what lets M2-WP-J's provider land with ZERO edits to the reducer (ruling M2-R9).
 */
const PATCH_META = "omni/patch";

/**
 * M2-B, §20.6. `{alertOnUnpoliced: string[]}` — the resolved watch list, stamped on `idle` by
 * `worker.ts` because the fold below holds no policy engine and no config.
 *
 * Review finding V9: `unpolicedToolCalls` had unit tests and ZERO production callers, so
 * `alertOnUnpoliced` was a config key that did nothing. Deriving the warning HERE — from an
 * envelope, in the one fold both the SDK and `GET /turns/{id}` run — is what keeps D7 true; a
 * daemon-side post-pass would have made the two disagree.
 */
const POLICY_META = "omni/policy";

/** Only reachable when `reduceTurn` is asked about a turn no envelope mentions. */
const UNKNOWN_WORKER_ID = "w_unknown" as WorkerId;

/** A close mid-turn is never a clean end; this is the code that failure reports as (§9). */
const CLOSE_REASON_CODE: { readonly [R in WorkerCloseReason]: OmniErrorCode } = {
  client_request: "worker_closed",
  daemon_shutdown: "worker_closed",
  not_resumable: "worker_closed",
  spawn_failed: "agent_error",
  handshake_error: "agent_error",
  agent_exited: "agent_error",
  agent_crashed: "agent_error",
  protocol_error: "agent_error",
  handshake_timeout: "agent_timeout",
  cancel_timeout: "agent_timeout",
  // M1's three new reasons. `idle_timeout` and `orphaned` are OUR decision to stop holding the
  // worker, so they read as `worker_closed`; `wake_failed` is a run of failed attempts against
  // the agent, so it reads as `agent_error`.
  idle_timeout: "worker_closed",
  orphaned: "worker_closed",
  wake_failed: "agent_error",
  // The current config forbids this worker, which is the same answer the request would have got
  // had it arrived one boot later (§15.5's 403 row, review R6).
  acl_revoked: "forbidden",
};

interface MutableToolCall {
  toolCallId: string;
  title: string | null;
  kind: string | null;
  status: string | null;
  locations: { path: string; line?: number }[];
  content: ToolCallContent[];
  hasRawInput: boolean;
  rawInput: unknown;
  hasRawOutput: boolean;
  rawOutput: unknown;
}

interface Fold {
  workerId: WorkerId | null;
  startSeq: Seq | null;
  endSeq: Seq | null;
  terminal: "idle" | "closed" | null;
  stopReason: StopReason | null;
  text: string;
  order: string[];
  calls: Map<string, MutableToolCall>;
  usage: { used: number; size: number; cost?: { amount: number; currency: string } } | null;
  interactions: InteractionRecord[];
  error: OmniErrorBody | null;
  /** M1 (§13.4). The v2 `Usage` block off `state_update{idle}.usage` — a DIFFERENT shape from
   *  `usage`, which stays sourced from the last `usage_update` (F4, F21). */
  tokens: TurnResult["tokens"] | null;
  /** M1 (§12.5). Reconstructed by the Normalizer from a descriptor-registered vendor extension
   *  and carried on `state_update{idle}._meta`, because this fold holds no descriptor. */
  vendorPatch: TurnResult["vendorPatch"];
  /** M1 (§13.4). The advisories the Normalizer stamped on `idle`, before this fold adds its own. */
  streamWarnings: TurnWarning[];
  /** M2 (§20.6). Read off `state_update{idle}._meta["omni/policy"]`; absent ⇒ nothing is watched. */
  alertOnUnpoliced: readonly string[];
  /** Tool calls THIS daemon denied, from our OWN `omni.policy_decision` — never from prose. */
  denied: string[];
  deniedTitles: Map<string, string>;
  /** M2 (§5.8.5). Read off `state_update{idle}._meta["omni/patch"]`; absent ⇒ M1's null. */
  patch: { text: string | null; info: NonNullable<TurnResult["patchInfo"]> } | null;
  /**
   * M2. The pending SET, keyed on `requestId`, so `InteractionRecord` is still built from ONE
   * envelope kind (review R9) and the fold gains no second source of truth: `acp.interaction` is
   * folded ONLY to add and remove members here.
   */
  pending: Set<InteractionId>;
}

function record(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function errorBody(b: OmniErrorBody): OmniErrorBody {
  // `omni.error` payloads also carry `stderrTail`, which is diagnostics rather than the wire
  // error body; the envelope keeps it, `TurnResult.error` is exactly OmniErrorBody (§9).
  return b.acp === undefined
    ? { code: b.code, message: b.message }
    : { code: b.code, message: b.message, acp: b.acp };
}

/** `state_update{idle}.usage` — the v2 `Usage` block, and only when it really is one (F21). */
function readTokens(raw: unknown): TurnResult["tokens"] | null {
  const u = record(raw);
  if (u === null) return null;
  const total = u["totalTokens"];
  const input = u["inputTokens"];
  const output = u["outputTokens"];
  if (typeof total !== "number" || typeof input !== "number" || typeof output !== "number") {
    return null;
  }
  const read = u["cachedReadTokens"];
  const write = u["cachedWriteTokens"];
  return {
    totalTokens: total,
    inputTokens: input,
    outputTokens: output,
    ...(typeof read === "number" ? { cachedReadTokens: read } : {}),
    ...(typeof write === "number" ? { cachedWriteTokens: write } : {}),
  };
}

function readVendorPatch(raw: unknown): TurnResult["vendorPatch"] {
  const p = record(raw);
  if (p === null) return null;
  const text = str(p["text"]);
  const source = str(p["source"]);
  if (text === null || source === null || p["format"] !== "git_patch") return null;
  return { format: "git_patch", text, source };
}

/**
 * M2 (§21.3, ruling M2-R8). The two statuses that END a tool call, and the same set the idle
 * watchdog's open-call fold uses — one definition of "terminal", so the tool budget and
 * `strandedToolCalls` can never describe different turns.
 *
 * `cancelled` is deliberately absent: F36 says neither real agent sends it for a stranded call,
 * and an agent that volunteered it would still be saying "this did not complete".
 */
const TERMINAL_TOOL_STATUS: ReadonlySet<string> = new Set(["completed", "failed"]);

const WARNING_SOURCES: ReadonlySet<string> = new Set([
  "usage_meta",
  "stderr",
  "policy",
  "tool_status",
  // M2 (§5.8.5).
  "patch",
  "watchdog",
]);

/**
 * `_meta["omni/patch"]` — a `PatchResult` as the provider produced it, read defensively because
 * this fold is pure over envelopes and the key arrives through a generic channel.
 *
 * A malformed block is `null`, never a throw and never a half-built `patchInfo`: D8's rule is
 * "never wrong", and a patch we cannot read is a patch we do not have.
 */
function readPatch(raw: unknown): Fold["patch"] {
  const p = record(raw);
  if (p === null) return null;
  const quality = str(p["quality"]);
  if (quality !== "exact" && quality !== "shared_worktree" && quality !== "unavailable") {
    return null;
  }
  const source = p["source"] === "git" ? "git" : null;
  const text = str(p["text"]);
  return { text, info: { source, truncated: p["truncated"] === true, quality } };
}

function readWarnings(raw: unknown): TurnWarning[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const w = record(item);
    if (w === null) return [];
    const code = str(w["code"]);
    const message = str(w["message"]);
    const source = str(w["source"]);
    if (code === null || message === null || source === null || !WARNING_SOURCES.has(source)) {
      return [];
    }
    const detail = record(w["detail"]);
    return [
      {
        code,
        message,
        source: source as TurnWarning["source"],
        ...(detail === null ? {} : { detail }),
      },
    ];
  });
}

/**
 * The clamp's other half: it is announced on the TURN as well as on the decision (§20.5).
 *
 * A policy that is quietly narrower than it reads is how an operator plans around a rule that
 * never fires, so §20.5 requires both records and this is the one that reaches `TurnResult`.
 * `null` when nothing was clamped, so a caller can append it unconditionally.
 *
 * It takes the three fields it reads rather than a `PolicyVerdict`, which is what lets BOTH
 * callers use it: `reduceTurn` folds it out of `omni.policy_decision` (review finding V9 — it had
 * no production caller at all before), and a verdict is still structurally assignable, so
 * `@omni-acp/core`'s `policyClampWarning(verdict)` is unchanged.
 *
 * Owned by M2-B-WP-P.
 */
export function policyClampWarning(v: {
  readonly clamped: { readonly from: PolicyAction; readonly by: string } | null;
  readonly action: string;
  readonly rule: string;
}): TurnWarning | null {
  if (v.clamped === null) return null;
  return {
    code: "policy_clamped",
    message: `"${v.clamped.from}" was narrowed to "${v.action}" by ${v.clamped.by}`,
    source: "policy",
    detail: { from: v.clamped.from, to: v.action, by: v.clamped.by, rule: v.rule },
  };
}

/** `omni/policy.alertOnUnpoliced`, read as data: anything that is not a list of strings is `[]`. */
function readStringList(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === "string");
}

/**
 * §20.6 - the thing that is invisible in the frame.
 *
 * F40: a read-only `ls -A <cwd>` (`kind:"execute"`) ran to `completed` with NO permission request,
 * while `python3 -c ...` in the same cwd raised one. The split is decided inside the host and is
 * not visible anywhere in the `tool_call` frame, so the daemon CANNOT predict which calls will
 * reach the engine.
 *
 * Two consequences, both binding: policy is evaluated on what actually ARRIVES, never on what we
 * expected to arrive; and "no permission request" must never be read as "no tool ran".
 * `PolicyPreset.alertOnUnpoliced` lists the kinds that must never pass unnoticed, and a tool call
 * of a listed kind that never reached the engine becomes
 * `TurnWarning{code:"unpoliced_tool_call", source:"policy"}` on the turn.
 *
 * PURE, and deliberately a fold over what the turn already has: the tool calls it saw and the
 * interactions it recorded. It invents nothing about the agent - it reports a gap between two
 * things we watched.
 *
 * It lives in `protocol` rather than in `core/policy` (where it was written, and where
 * `@omni-acp/core` still re-exports it from) for ONE reason: `reduceTurn` is the only caller that
 * can keep D7 - the SDK's local fold and `GET /turns/{id}` must not disagree - and `protocol` may
 * not import `core`. Review finding V9 is what moved it: it had unit tests and no caller at all.
 *
 * Owned by M2-B-WP-P.
 */
export function unpolicedToolCalls(o: {
  readonly alertOnUnpoliced: readonly string[];
  readonly toolCalls: readonly Pick<ToolCallView, "toolCallId" | "kind">[];
  readonly interactions: readonly Pick<InteractionRecord, "toolCallId">[];
}): readonly TurnWarning[] {
  if (o.alertOnUnpoliced.length === 0) return [];
  const watched = new Set(o.alertOnUnpoliced);
  const policed = new Set(
    o.interactions.map((i) => i.toolCallId).filter((id): id is string => id !== null),
  );

  const out: TurnWarning[] = [];
  const seen = new Set<string>();
  for (const call of o.toolCalls) {
    const kind = call.kind;
    if (kind === null || !watched.has(kind)) continue;
    if (policed.has(call.toolCallId)) continue;
    if (seen.has(call.toolCallId)) continue;
    seen.add(call.toolCallId);
    out.push({
      code: "unpoliced_tool_call",
      message: `a "${kind}" tool call ran without reaching the policy engine`,
      source: "policy",
      detail: { toolCallId: call.toolCallId, kind },
    });
  }
  return out;
}

function upsertToolCall(f: Fold, payload: Record<string, unknown>): void {
  const id = str(payload["toolCallId"]);
  if (id === null) return;

  let call = f.calls.get(id);
  if (call === undefined) {
    call = {
      toolCallId: id,
      title: null,
      kind: null,
      status: null,
      locations: [],
      content: [],
      hasRawInput: false,
      rawInput: undefined,
      hasRawOutput: false,
      rawOutput: undefined,
    };
    f.calls.set(id, call);
    f.order.push(id);
  }

  // ToolCallUpdate semantics: an absent or null field means "unchanged"; a present one replaces.
  const title = str(payload["title"]);
  if (title !== null) call.title = title;
  const kind = str(payload["kind"]);
  if (kind !== null) call.kind = kind;
  const status = str(payload["status"]);
  if (status !== null) call.status = status;

  const locations = payload["locations"];
  if (Array.isArray(locations)) {
    call.locations = locations.flatMap((raw) => {
      const loc = record(raw);
      const path = loc === null ? null : str(loc["path"]);
      if (path === null) return [];
      const line = loc === null ? undefined : loc["line"];
      return typeof line === "number" ? [{ path, line }] : [{ path }];
    });
  }

  const content = payload["content"];
  if (Array.isArray(content)) call.content = [...(content as ToolCallContent[])];

  if ("rawInput" in payload) {
    call.hasRawInput = true;
    call.rawInput = payload["rawInput"];
  }
  if ("rawOutput" in payload) {
    call.hasRawOutput = true;
    call.rawOutput = payload["rawOutput"];
  }
}

function applySessionUpdate(f: Fold, seq: Seq, payload: Record<string, unknown>): void {
  switch (payload["sessionUpdate"]) {
    case "state_update": {
      const state = payload["state"];
      if (state === "idle") {
        f.terminal = "idle";
        f.endSeq = seq;
        f.stopReason = str(payload["stopReason"]);
        // §13.2's SETTLE, M1's two additions. Both are DAEMON-authored: `idle` is synthesized by
        // the Normalizer, which is the only layer that holds a descriptor, so this fold can read
        // a vendor extension's result without knowing any vendor's `_meta` spelling (§13.4).
        f.tokens = readTokens(payload["usage"]) ?? f.tokens;
        const meta = record(payload["_meta"]);
        if (meta !== null) {
          f.vendorPatch = readVendorPatch(meta[VENDOR_PATCH_META]) ?? f.vendorPatch;
          f.streamWarnings.push(...readWarnings(meta[WARNINGS_META]));
          // §20.6's watch list, read as data and never trusted as shape (the same defensive
          // reading `readPatch` gets, and for the same reason: this key crosses a wire).
          f.alertOnUnpoliced = readStringList(record(meta[POLICY_META])?.["alertOnUnpoliced"]);
          // M2, seam D. The reducer that stamped this key does not know what it means; this
          // does, and it is the only place that does (ruling M2-R9).
          if (PATCH_META in meta) {
            f.patch = readPatch(meta[PATCH_META]);
            // D8's "`null` is an answer, and it is always explained" (§25.3). Every warning the
            // provider produced — `patch_not_a_repo`, `patch_timeout`, `patch_truncated`, … —
            // rides INSIDE the `PatchResult`, because §25.1 says that block "is the only one a
            // pure fold can read it from": `omni/warnings` is the REDUCER's own key and a
            // provider must never be able to write it.
            const block = record(meta[PATCH_META]);
            if (block !== null) f.streamWarnings.push(...readWarnings(block["warnings"]));
          }
        }
      }
      return;
    }
    case "agent_message_chunk": {
      const content = record(payload["content"]);
      if (content !== null && content["type"] === "text") {
        const text = str(content["text"]);
        if (text !== null) f.text += text;
      }
      return;
    }
    case "tool_call":
    case "tool_call_update":
      upsertToolCall(f, payload);
      return;
    case "usage_update": {
      const used = payload["used"];
      const size = payload["size"];
      if (typeof used !== "number" || typeof size !== "number") return;
      const cost = record(payload["cost"]);
      const amount = cost === null ? null : cost["amount"];
      const currency = cost === null ? null : str(cost["currency"]);
      f.usage =
        typeof amount === "number" && currency !== null
          ? { used, size, cost: { amount, currency } }
          : { used, size };
      return;
    }
    default:
      // agent_thought_chunk, plan, available_commands_update, … are forwarded to consumers
      // verbatim on the event stream and contribute nothing to the aggregate (§7.5).
      return;
  }
}

function closeError(payload: WorkerStatePayload): OmniErrorBody {
  if (payload.error !== undefined) return errorBody(payload.error);
  const reason = payload.reason;
  const code =
    reason in CLOSE_REASON_CODE ? CLOSE_REASON_CODE[reason as WorkerCloseReason] : "internal";
  return { code, message: `worker closed during turn (${String(reason)})` };
}

function fold(turnId: TurnId, envelopes: readonly EventEnvelope[]): Fold {
  const f: Fold = {
    workerId: null,
    startSeq: null,
    endSeq: null,
    terminal: null,
    stopReason: null,
    text: "",
    order: [],
    calls: new Map(),
    usage: null,
    interactions: [],
    error: null,
    tokens: null,
    vendorPatch: null,
    streamWarnings: [],
    alertOnUnpoliced: [],
    denied: [],
    deniedTitles: new Map(),
    patch: null,
    pending: new Set<InteractionId>(),
  };

  // Identity first, then order.
  //
  // An envelope IS its `(workerId, seq)` pair: `seq` is 1-based, gap-free and strictly
  // increasing PER WORKER (ids.ts), so the number alone is not an identity once a replay union
  // carries two workers' logs in one buffer. Everything else — `ts`, `payload` — is derived.
  //
  // De-duplication is not defensive tidying, it is required for the "same envelopes in ⇒
  // deep-equal result out" contract to survive the way callers actually build a buffer: a
  // client that concatenates a `?since=` replay onto the live tail it was already holding
  // overlaps by construction, and a twice-folded buffer concatenates `text` twice and grows a
  // phantom `interactions` row. FIRST occurrence wins, so the fold is stable under any amount
  // of re-delivery.
  const seen = new Set<string>();
  const unique: EventEnvelope[] = [];
  for (const e of envelopes) {
    // M1, ruling M1-R5: a REPLAYED envelope is history the agent re-emitted while resuming a
    // session, not something that happened in this turn. It is stored and streamed (marked), so
    // every consumer can see it — but folding it would concatenate a previous conversation into
    // `text` and count its tool calls as this turn's. F16 confirms the window is exactly
    // request-to-response, so the mark is reliable; the SDK filters on the same field.
    if (e.replay === true) continue;
    const identity = `${e.workerId}\u0000${e.seq}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    unique.push(e);
  }

  // Seq order, always — the caller may hand us a replay union or an out-of-order buffer, and
  // text concatenation and tool-call status are both order-dependent.
  const ordered = unique.sort((a, b) => a.seq - b.seq);

  for (const e of ordered) {
    const mine = e.turnId === turnId;
    if (mine) {
      if (f.startSeq === null) f.startSeq = e.seq;
      if (f.workerId === null) f.workerId = e.workerId;
    }

    // §7.3: a turn is terminal on `state_update{idle}` for that turnId OR on ANY
    // `omni.worker_state{closed}` — a dead agent never produces a fabricated `idle`, so this
    // is what stops `prompt()` hanging forever.
    if (e.kind === "omni.worker_state" && e.payload.state === "closed") {
      if (f.startSeq === null) continue; // the close precedes this turn entirely
      // ANY close from THIS turn's worker — but a replay union can carry another worker's log
      // into the same buffer, and that worker's death says nothing about this turn.
      if (f.workerId !== null && e.workerId !== f.workerId) continue;
      f.terminal = "closed";
      f.endSeq = e.seq;
      f.stopReason = null;
      if (f.error === null) f.error = closeError(e.payload);
      if (f.workerId === null) f.workerId = e.workerId;
      break;
    }

    if (!mine) continue;

    switch (e.kind) {
      case "acp.session_update":
        applySessionUpdate(f, e.seq, e.payload as unknown as Record<string, unknown>);
        break;
      case "omni.policy_decision": {
        // ONE envelope kind carries the whole record: `title` rides on the policy decision
        // (review R9) and `at` is the envelope's `ts`.
        // M2 widens the row. Every added field has an M1 reading that is the truth rather than a
        // guess: an M1 daemon knew exactly one kind, answered inline, and parked nothing.
        f.interactions.push({
          requestId: e.payload.requestId,
          kind: e.payload.kind ?? "permission",
          method: e.payload.method ?? "session/request_permission",
          title: e.payload.title,
          decision: e.payload.decision,
          by: e.payload.by ?? "baseline",
          parkedMs: e.payload.parkedMs ?? 0,
          // `?? null` rather than the field: an M1-era envelope written before the mapper filled
          // `toolCallId` in has no key at all, and `undefined` on a record typed `string | null`
          // is the kind of hole a `toStrictEqual` golden is exactly right to refuse.
          toolCallId: e.payload.toolCallId ?? null,
          optionId: e.payload.optionId,
          rule: e.payload.rule,
          at: e.ts,
        });
        // §13.4's FIRST signal, and the one we trust totally: we are the party that denied. The
        // join is by `toolCallId`, which the mapper lifted off the request — never from the
        // agent's English `rawOutput`, which is what `no-agent-prose` exists to forbid.
        //
        // M2 gates the join on the METHOD (F31): a DECLINED elicitation leaves its tool call
        // `completed`, so joining it here would report a tool we blocked that in fact ran. An
        // M1-written decision carries no `method` and is a permission by construction.
        const toolCallId = e.payload.toolCallId;
        const isPermission =
          (e.payload.method ?? "session/request_permission") === "session/request_permission";
        if (
          isPermission &&
          e.payload.decision === "deny" &&
          toolCallId !== null &&
          toolCallId !== undefined
        ) {
          if (!f.denied.includes(toolCallId)) f.denied.push(toolCallId);
        }
        // D4 rule 4: nothing acceptable was offered, so the daemon answered `-32603`. That is a
        // policy outcome rather than a tool failure, and it is an advisory on the turn.
        if (e.payload.decision === "error") {
          f.streamWarnings.push({
            code: "permission_not_offered",
            message: "no acceptable permission option was offered",
            source: "policy",
          });
        }
        /**
         * §20.5's OTHER half, and review finding V9's first item: a ceiling clamp is announced on
         * the DECISION and on the TURN, and only the first of the two was ever built.
         *
         * "A policy that is quietly narrower than it reads is how an operator plans around a rule
         * that never fires" — so the warning is derived here, from the envelope the clamp is
         * already recorded on, rather than by a caller who has to remember to ask for it.
         */
        const clamp = policyClampWarning({
          clamped: e.payload.clamped ?? null,
          action: e.payload.decision,
          rule: e.payload.rule,
        });
        if (clamp !== null) f.streamWarnings.push(clamp);
        /**
         * M2-R19's third announcement (review finding V9's last item). F26: after ONE
         * `allow_always` the host never consults us again for that session and NOTHING on the
         * wire says so, which is precisely why `interaction.allowAlways:"human"` costs three
         * announcements — the strategy's log line, `blindsPolicy` on the decision, and this.
         */
        if (e.payload.blindsPolicy === true) {
          f.streamWarnings.push({
            code: "policy_blinded",
            message:
              `a session-wide grant was selected for interaction ${e.payload.requestId}; ` +
              "the policy engine will not be consulted again for this session",
            source: "policy",
            detail: { requestId: e.payload.requestId, optionId: e.payload.optionId },
          });
        }
        break;
      }
      case "omni.error":
        f.error = errorBody(e.payload);
        break;
      case "acp.interaction": {
        // Folded ONLY for the pending set (§5.8.5): `pending` MEANS parked (ruling M2-R5), so a
        // `pending` envelope adds and any other status removes. The RECORD still comes from
        // `omni.policy_decision` alone, so this fold keeps one source of truth per field.
        if (e.payload.status === "pending") {
          f.pending.add(e.payload.requestId);
          break;
        }
        f.pending.delete(e.payload.requestId);
        /**
         * §19.9's two advisories, and review finding V9 found neither of them anywhere in the
         * repository outside CONTRACTS.md.
         *
         * They are derived HERE and not from `omni.policy_decision`, because this is the envelope
         * that carries `status` and the elicitation's `action` — F31 says accept and decline are
         * indistinguishable in the agent's own stream, so this record is the ONLY place the
         * outcome exists at all.
         */
        if (e.payload.status === "expired") {
          f.streamWarnings.push({
            code: "interaction_expired",
            message: `interaction ${e.payload.requestId} expired with no answer`,
            source: "policy",
            detail: { requestId: e.payload.requestId, method: e.payload.method },
          });
        }
        const action = e.payload.answer?.action;
        if (action === "decline" || action === "cancel") {
          f.streamWarnings.push({
            code: "interaction_declined",
            message: `interaction ${e.payload.requestId} was ${action}d`,
            source: "policy",
            detail: { requestId: e.payload.requestId, action, method: e.payload.method },
          });
        }
        break;
      }
      case "omni.worker_state":
      case "omni.run":
        break;
    }

    if (f.terminal === "idle") break;
  }

  return f;
}

function materialize(turnId: TurnId, f: Fold): TurnResult {
  const toolCalls: ToolCallView[] = f.order.flatMap((id) => {
    const c = f.calls.get(id);
    if (c === undefined) return [];
    const view: ToolCallView = {
      toolCallId: c.toolCallId,
      title: c.title,
      kind: c.kind,
      status: c.status,
      locations: c.locations,
      content: c.content,
      ...(c.hasRawInput ? { rawInput: c.rawInput } : {}),
      ...(c.hasRawOutput ? { rawOutput: c.rawOutput } : {}),
    };
    return [view];
  });

  // F5: the deterministic extraction, over the FINAL content of each tool call —
  // `ToolCallUpdate.content` replaces the collection, so folding intermediate copies in would
  // double-count a re-sent diff. §12.5: the v2 shape is read FIRST and the v1 shape second,
  // because a client may fold a buffer that spans an upgrade and a persisted log can hold both.
  const changes: FileChange[] = [];
  for (const call of toolCalls) {
    for (const item of call.content) {
      if (item.type !== "diff") continue;
      const change = readDiffBlock(item as unknown as Record<string, unknown>);
      if (change !== null) changes.push(change);
    }
  }

  // §13.4's SECOND signal: a schema'd enum, so it is trusted totally. "Final" means the status
  // after the fold, which is what `tool_call_update`'s absent-means-unchanged semantics produce.
  const failedToolCalls = toolCalls.filter((c) => c.status === "failed").map((c) => c.toolCallId);
  // Only ids this turn actually mentions: a policy decision whose tool call never appeared is
  // still a real denial, so it is kept — dropping it would under-report what we refused.
  const deniedToolCalls = f.denied;

  // M2-A-WP-W, ruling M2-R8. Tool calls whose LAST observed status is neither `completed` nor
  // `failed` when the turn ENDED — `null` counts, because "we were never told" is exactly the
  // condition this reports — and ONLY for a TERMINAL turn, because a running turn strands
  // nothing (`f.terminal === null` is the "still going" reading, which `running-partial` is).
  //
  // F36 is the same fact on both real agents: cancelling with a tool genuinely in flight
  // produces NO terminal `tool_call_update` at all (claude `16` leaves `"pending"`, codex `08`
  // leaves `"in_progress"`). Synthesizing `failed` would assert something about the agent that
  // is not true — the tool may well have completed agent-side — and blocking for a terminal
  // update would hang the aggregate forever. So we report, in stream order, and the turn is
  // `partial`.
  //
  // This is the ONE place the M2 fold can change an M1 verdict, and it does: a turn that ended
  // holding a tool call nobody terminalized was never "ok", and two of the twelve golden
  // transcripts say so (`permission-deny`'s denied write and `tool-call-upsert`'s second call,
  // both left `pending` at `idle`). M2-PLAN §1.6 deviation 6 is the record that the Land step
  // saw this coming and left the rule here to be implemented rather than inferred.
  const strandedToolCalls: readonly string[] =
    f.terminal === null
      ? []
      : toolCalls
          .filter((c) => c.status === null || !TERMINAL_TOOL_STATUS.has(c.status))
          .map((c) => c.toolCallId);
  const pendingInteractions = [...f.pending];

  const warnings: TurnWarning[] = [...f.streamWarnings];
  // §20.6, F40: a tool call of a WATCHED kind that never reached the policy engine. The list
  // came off `idle._meta["omni/policy"]`, which is what lets this stay a pure fold — and what
  // makes `alertOnUnpoliced` a config key that finally does something (review finding V9).
  warnings.push(
    ...unpolicedToolCalls({
      alertOnUnpoliced: f.alertOnUnpoliced,
      toolCalls,
      interactions: f.interactions,
    }),
  );
  for (const id of deniedToolCalls) {
    warnings.push({
      code: "tool_denied",
      message: `tool call ${id} was denied by policy`,
      source: "policy",
      detail: { toolCallId: id },
    });
  }
  for (const id of failedToolCalls) {
    warnings.push({
      code: "tool_failed",
      message: `tool call ${id} ended with status failed`,
      source: "tool_status",
      detail: { toolCallId: id },
    });
  }

  return {
    turnId,
    workerId: f.workerId ?? UNKNOWN_WORKER_ID,
    stopReason: f.stopReason,
    text: f.text,
    toolCalls,
    changes,
    // D8. `null` unless a provider stamped `_meta["omni/patch"]` on this turn's `idle`, which is
    // every M1 turn — so every M1 golden asserting `patch: null` passes unchanged (§5.8.5).
    patch: f.patch?.text ?? null,
    patchInfo: f.patch?.info ?? null,
    vendorPatch: f.vendorPatch,
    ...(f.usage === null ? {} : { usage: f.usage }),
    ...(f.tokens === null ? {} : { tokens: f.tokens }),
    interactions: f.interactions,
    // §13.4, with NO AGENT PROSE anywhere: a denial is our own `omni.policy_decision`, a failure
    // is a schema'd enum, and an error is an envelope we wrote. `end_turn` is not consulted, and
    // could not be: corpus findings 6 and 7 show a denied tool call and an invented `optionId`
    // both ending `stopReason: "end_turn"`.
    // M2 adds two arms to the ladder and reorders nothing: `failed` still outranks `partial`,
    // and a turn with a stranded tool call or an unanswered interaction is honestly incomplete.
    verdict:
      f.error !== null
        ? "failed"
        : failedToolCalls.length > 0 ||
            deniedToolCalls.length > 0 ||
            strandedToolCalls.length > 0 ||
            pendingInteractions.length > 0
          ? "partial"
          : "ok",
    warnings,
    failedToolCalls,
    deniedToolCalls,
    strandedToolCalls,
    pendingInteractions,
    error: f.error,
  };
}

/**
 * One `ToolCallContent{type:"diff"}` → one `FileChange`, or null.
 *
 * The v2 shape is `{changes:[{operation, path}], patch?}` and has NO `oldText`/`newText` at all,
 * so the Normalizer carries the v1 text under `_meta["omni/v1Diff"]` (§12.5) and this reads it
 * back. That is the ONLY source of the text `FileChange` requires: a genuinely-v2 diff carrying
 * no text contributes no `FileChange`, exactly as M0 skipped a diff block with no `newText`,
 * because inventing `newText: ""` would tell a consumer the file is now empty.
 */
function readDiffBlock(d: Record<string, unknown>): FileChange | null {
  const v1 = record(record(d["_meta"])?.[V1_DIFF_META]);
  const v2Changes = Array.isArray(d["changes"]) ? (d["changes"] as unknown[]) : null;

  if (v2Changes !== null) {
    const first = record(v2Changes[0]);
    const path = first === null ? null : str(first["path"]);
    if (first === null || path === null || v1 === null) return null;
    const newText = str(v1["newText"]);
    if (newText === null) return null;
    return {
      path,
      operation: str(first["operation"]) ?? (str(v1["oldText"]) === null ? "add" : "modify"),
      oldText: str(v1["oldText"]),
      newText,
      // From the DESCRIPTOR, stamped by the Normalizer. A consumer that writes a FRAGMENT to
      // `path` corrupts the file (F19), so this is never derived and never defaulted to true.
      fragment: v1["fragment"] === true,
    };
  }

  // The v1 shape, still legal on a persisted log written before the map landed.
  const path = str(d["path"]);
  const newText = str(d["newText"]);
  if (path === null || newText === null) return null;
  const oldText = str(d["oldText"]);
  return {
    path,
    operation: str(d["operation"]) ?? (oldText === null ? "add" : "modify"),
    oldText,
    newText,
    fragment: d["fragment"] === true,
  };
}

/**
 * Pure, dependency-free, deterministic. Same envelopes in => deep-equal result out, always.
 * Called by the daemon for GET /turns/{id} AND by the client SDK for prompt().
 * One implementation => polling and streaming cannot disagree (DESIGN §5.5).
 *
 * A turn is terminal on `state_update{idle}` for that turnId OR on any
 * `omni.worker_state{state:"closed"}` — see CONTRACTS.md §7.3.
 *
 * An envelope's identity is its `(workerId, seq)` pair, and repeats fold ONCE: handing in a
 * `?since=` replay that overlaps a tail already held is a normal thing for a caller to do.
 *
 * MUST NOT read `messageId` (CONTRACTS.md F3).
 */
export function reduceTurn(turnId: TurnId, envelopes: readonly EventEnvelope[]): TurnResult {
  return materialize(turnId, fold(turnId, envelopes));
}

export function turnStatus(turnId: TurnId, envelopes: readonly EventEnvelope[]): TurnStatus {
  const f = fold(turnId, envelopes);
  if (f.startSeq === null) {
    // Not a 404: turn state is derived from the log, and after ring eviction "unknown" is the
    // honest answer (D29).
    return {
      turnId,
      state: "unknown",
      startSeq: null,
      endSeq: null,
      stopReason: null,
      result: null,
    };
  }
  const result = materialize(turnId, f);
  const state: TurnState =
    f.terminal === null ? "running" : result.error === null ? "completed" : "failed";
  return {
    turnId,
    state,
    startSeq: f.startSeq,
    endSeq: f.endSeq,
    stopReason: result.stopReason,
    result,
  };
}
