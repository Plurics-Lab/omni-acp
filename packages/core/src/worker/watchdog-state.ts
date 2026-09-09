import type {
  EventEnvelope,
  ResolvedWatchdogConfig,
  WatchdogSignal,
  WatchdogState,
  WatchdogVerdict,
} from "@omni-acp/protocol";

/**
 * DESIGN §7's dual budget, as a PURE FOLD. No clock, no process, no `setTimeout` in this file —
 * `createWatchdog` supplies the one timer, exactly as `HibernateTimer` is split.
 *
 * The two budgets exist because one number cannot express both facts:
 *
 *  - **Budget A, silent.** Nothing appended at all while a turn runs. The window is anchored on
 *    the LAST ENVELOPE APPENDED and never on the prompt response — F25 makes that 7/7 on
 *    claude-acp (a `session_info_update` lands ~20 ms AFTER the response), and codex emits
 *    `threadStatus:idle` BEFORE its response. Replayed envelopes are NOT activity.
 *  - **Budget B, tool.** At least one tool call is OPEN. `npm install` silent for twenty minutes
 *    is normal, so this is the larger; F36 says an open call can be a PERMANENT condition, which
 *    is why it is a budget and not a suspension.
 *
 * The open set opens on `tool_call`, closes on a TERMINAL `tool_call_update`, and is emptied only
 * by `turn_end`. A SPARSE update carrying no `status` neither opens a closed call nor closes an
 * open one — absent means unchanged, the same rule `reduceTurn` folds by.
 *
 * A park DISARMS both budgets and an unpark RE-BASES from the unpark instant (ruling M2-R21): a
 * twenty-minute park followed by one update must not immediately cancel.
 *
 * Owned by M2-A-WP-W.
 */

/**
 * §21.3, verbatim: "Only `completed` and `failed` are terminal."
 *
 * `cancelled` is deliberately NOT here. F36 is that neither real agent ever sends it for a
 * stranded call, and the one place it could appear is an agent that volunteers it — at which
 * point the call is over but we were never told it succeeded, which is precisely the condition
 * `TurnResult.strandedToolCalls` reports rather than resolves.
 */
const TERMINAL_TOOL_STATUS: ReadonlySet<string> = new Set(["completed", "failed"]);

/** Shared because nothing here ever mutates a set in place; every transition builds a new one. */
const NO_OPEN_CALLS: ReadonlySet<string> = new Set<string>();

/** The disarmed start state: no turn, nothing open, nothing parked. */
export function initialWatchdogState(): WatchdogState {
  return { lastAt: 0, open: NO_OPEN_CALLS, parked: false, running: false, cancelSentAt: null };
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/**
 * The budget in force and its deadline, derived from state alone.
 *
 * PURE, and it takes no `now`: a fold cannot know whether a deadline has already passed, and it
 * must not pretend to. "Has it elapsed?" is the timer's question and `createWatchdog` is the only
 * thing that answers it — which is why `phase: "spent"` is produced there and never here.
 *
 * Exported for `watchdog.ts` alone (it needs the verdict for the START state, where there is no
 * signal to step on). It is NOT on `@omni-acp/core`'s barrel, which §5.8.9 pins to
 * `watchdogStep` and `createWatchdog`.
 */
export function watchdogVerdict(s: WatchdogState, cfg: ResolvedWatchdogConfig): WatchdogVerdict {
  const openToolCalls = [...s.open];

  // `enabled:false` disarms BOTH budgets, and so does "no turn is live": the two are the same
  // fact from the watchdog's side — nothing will cancel anything on a timer. `worker.ts` reports
  // the first of them as `WorkerSnapshot.watchdog: null` (§5.8.4).
  if (!cfg.enabled || !s.running) {
    return { deadlineAt: null, budget: null, phase: "idle", openToolCalls };
  }

  // §21.4, M2's single cross-work-package invariant. A human thinking is not a hung agent, and
  // the park timer (`parkTimeoutMs`) owns that deadline. Note that during a claude-acp
  // elicitation the `AskUserQuestion` tool call is OPEN (F32), so without this the TOOL budget
  // would be the one running against a human.
  if (s.parked) {
    return { deadlineAt: null, budget: null, phase: "paused", openToolCalls };
  }

  // The cancel has gone out. No BUDGET is running any more — what is running is the settle
  // grace, and `watchdog.cancelTimeoutMs > turn.cancelGraceMs` (a config LOAD error otherwise,
  // §21.5) is what guarantees M1's existing `cancelGraceMs` escalation reaches
  // `close("cancel_timeout")` first. This deadline is therefore a BACKSTOP and is reported so an
  // operator reading `WorkerSnapshot.watchdog.armedAt` sees when the worker stops being given
  // the benefit of the doubt.
  if (s.cancelSentAt !== null) {
    return {
      deadlineAt: cfg.cancelTimeoutMs > 0 ? s.cancelSentAt + cfg.cancelTimeoutMs : null,
      budget: null,
      phase: "cancelling",
      openToolCalls,
    };
  }

  // §21.2's table. One open call is enough to switch to the larger budget, because the small one
  // measures "is the agent alive?" and an agent waiting on `npm install` is alive and silent.
  const budget = s.open.size > 0 ? "tool" : "silent";
  const ms = budget === "tool" ? cfg.toolMs : cfg.silentMs;
  // "0 disables that budget only, and disabled means NEVER FIRES — never FIRES NOW."
  if (ms <= 0) {
    return { deadlineAt: null, budget: null, phase: "idle", openToolCalls };
  }
  return { deadlineAt: s.lastAt + ms, budget, phase: budget, openToolCalls };
}

/**
 * The open set's whole rule (§21.3), applied to the NORMALIZED stream.
 *
 * One wrinkle the wire-level statement of the rule does not show: M1's mapper RENAMES
 * `tool_call` to `tool_call_update` and merges nothing (F23, §12.3 row 4), so by the time an
 * envelope reaches this fold an opening frame usually arrives spelled `tool_call_update`. What
 * survives the rename is its `status` — `"pending"` on claude `16`, `"in_progress"` on codex
 * `08` — and a PRESENT non-terminal status is exactly "this call is not finished", which is what
 * opens it. The `tool_call` arm below is still live: a `sessionUpdate` kind with no map row is
 * forwarded by identity at `payloadVersion: 1` (ruling M1-R10), so the un-renamed spelling is
 * reachable and must not be a hole.
 *
 * `status` is read with the SAME predicate `reduceTurn.upsertToolCall` uses — a non-string is
 * "absent", so `null` means unchanged rather than "open now". Two folds that disagreed about
 * what a status is would let `strandedToolCalls` and the tool budget describe different turns.
 */
function applyToolCall(
  open: ReadonlySet<string>,
  payload: Record<string, unknown>,
): ReadonlySet<string> {
  const kind = payload["sessionUpdate"];
  if (kind !== "tool_call" && kind !== "tool_call_update") return open;

  const id = str(payload["toolCallId"]);
  if (id === null) return open;

  // `tool_call` always (re)opens — it is the announcement of a call, not an update to one.
  if (kind === "tool_call") {
    if (open.has(id)) return open;
    return new Set([...open, id]);
  }

  const status = str(payload["status"]);
  // The SPARSE update: only `content`, no `status`. 8 of the 36 recorded `tool_call_update`s
  // have exactly that shape, and claude `16` sends three of them in a row for the very call the
  // tool budget is measuring. It neither opens a closed call nor closes an open one.
  if (status === null) return open;

  if (TERMINAL_TOOL_STATUS.has(status)) {
    if (!open.has(id)) return open;
    const next = new Set(open);
    next.delete(id);
    return next;
  }
  if (open.has(id)) return open;
  return new Set([...open, id]);
}

function applyEnvelope(s: WatchdogState, at: number, envelope: EventEnvelope): WatchdogState {
  // D6, ruling M1-R5. A REPLAYED envelope is history the agent re-emitted while resuming a
  // session. Counting it as activity would let a `session/load` replay hold a DEAD turn's budget
  // open — and counting its tool calls would open calls that finished in a previous session.
  if (envelope.replay === true) return s;

  const open =
    envelope.kind === "acp.session_update"
      ? applyToolCall(s.open, envelope.payload as unknown as Record<string, unknown>)
      : s.open;

  // THE ANCHOR (F25, §21.2). Every appended envelope re-bases the quiet window, whatever its
  // kind: a host banner with no `messageId` (F41) is still a host that is alive, which is exactly
  // what the silent budget measures, and excluding chrome would need a vendor branch in a timing
  // path (§11.9's accepted risk).
  return open === s.open ? { ...s, lastAt: at } : { ...s, lastAt: at, open };
}

export function watchdogStep(
  s: WatchdogState,
  sig: WatchdogSignal,
  cfg: ResolvedWatchdogConfig,
): { state: WatchdogState; verdict: WatchdogVerdict } {
  let next: WatchdogState;
  switch (sig.kind) {
    case "turn_start":
      // A new turn starts from a clean slate. This is NOT the "emptied by hope" §21.3 forbids:
      // within a turn nothing but `turn_end` empties the set, and `turn_end` always precedes the
      // next `turn_start` — but a turn that inherited a phantom open call from a turn whose end
      // was missed would run on the large budget forever, and that is the failure this closes.
      next = {
        lastAt: sig.at,
        open: NO_OPEN_CALLS,
        parked: false,
        running: true,
        cancelSentAt: null,
      };
      break;
    case "envelope":
      next = applyEnvelope(s, sig.at, sig.envelope);
      break;
    case "parked":
      // The park instant is deliberately NOT an anchor: the clock is stopped, not re-based, and
      // re-basing here would be indistinguishable from re-basing at the unpark for a park that
      // lasted no time at all.
      next = s.parked ? s : { ...s, parked: true };
      break;
    case "unparked":
      // RE-BASE, never resume (M2-R21). A human who took twenty minutes must not hand the agent
      // a budget that is already spent, which would cancel the very turn they just unblocked.
      next = { ...s, parked: false, lastAt: sig.at };
      break;
    case "cancel_sent":
      // `lastAt` moves too, so that a park DURING the cancel window and the unpark after it
      // re-base from something that happened rather than from the last frame before the stall.
      // The budget it feeds is not in force while `cancelSentAt` is set, so this is only ever
      // read after a `turn_end` has cleared the cancel — which resets it anyway.
      next = { ...s, cancelSentAt: sig.at, lastAt: sig.at };
      break;
    case "turn_end":
      next = {
        lastAt: sig.at,
        open: NO_OPEN_CALLS,
        parked: false,
        running: false,
        cancelSentAt: null,
      };
      break;
  }
  return { state: next, verdict: watchdogVerdict(next, cfg) };
}
