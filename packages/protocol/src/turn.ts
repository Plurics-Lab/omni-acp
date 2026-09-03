import type { StopReason, ToolCallContent, ToolCallStatus } from "./acp.js";
import type { OmniErrorBody, OmniErrorCode } from "./errors.js";
import type { EventEnvelope, WorkerCloseReason, WorkerStatePayload } from "./events.js";
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

// ── the fold ─────────────────────────────────────────────────────────────────
//
// `reduceTurn` and `turnStatus` are two views of ONE pass, so the daemon's `GET /turns/{id}`
// and the client's `prompt()` cannot disagree even about `state` (DESIGN §5.5, D7).
//
// Note what is NOT read here: `messageId` (CONTRACTS.md F3 — backfill is M1) and
// `idle.usage` (F4 — `IdleStateUpdate.usage` is the v2 `Usage` shape `{totalTokens, …}`, while
// `TurnResult.usage` is the `usage_update` shape `{used, size, cost?}`; taking the former would
// be a type pun that happens to compile).

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
  };

  // Seq order, always — the caller may hand us a replay union or an out-of-order buffer, and
  // text concatenation and tool-call status are both order-dependent.
  const ordered = [...envelopes].sort((a, b) => a.seq - b.seq);

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
      case "omni.policy_decision":
        // ONE envelope kind carries the whole record: `title` rides on the policy decision
        // (review R9) and `at` is the envelope's `ts`.
        f.interactions.push({
          requestId: e.payload.requestId,
          title: e.payload.title,
          decision: e.payload.decision,
          optionId: e.payload.optionId,
          rule: e.payload.rule,
          at: e.ts,
        });
        break;
      case "omni.error":
        f.error = errorBody(e.payload);
        break;
      case "acp.interaction":
      case "omni.worker_state":
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

  // F5: the 12-line deterministic extraction, over the FINAL content of each tool call —
  // `ToolCallUpdate.content` replaces the collection, so folding intermediate copies in would
  // double-count a re-sent diff.
  const changes: FileChange[] = [];
  for (const call of toolCalls) {
    for (const item of call.content) {
      if (item.type !== "diff") continue;
      const d = item as unknown as Record<string, unknown>;
      const path = str(d["path"]);
      const newText = str(d["newText"]);
      if (path === null || newText === null) continue;
      changes.push({ path, oldText: str(d["oldText"]), newText });
    }
  }

  return {
    turnId,
    workerId: f.workerId ?? UNKNOWN_WORKER_ID,
    stopReason: f.stopReason,
    text: f.text,
    toolCalls,
    changes,
    patch: null,
    ...(f.usage === null ? {} : { usage: f.usage }),
    interactions: f.interactions,
    error: f.error,
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
