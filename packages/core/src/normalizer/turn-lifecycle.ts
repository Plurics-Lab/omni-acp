import {
  OmniError,
  type CloseOutAction,
  type EventInput,
  type MappedUpdate,
  type NormalizedSessionUpdate,
  type OmniErrorBody,
  type RuntimeDescriptor,
  type SettleReason,
  type StopReason,
  type TurnId,
  type TurnInput,
  type TurnOutput,
  type TurnWarning,
} from "@omni-acp/protocol";
import { num, record, resolvePointer, str } from "./map/json.js";
import { mapUpdate, type MapContext } from "./map/update.js";
import { readRateLimit, readStructuredPatch, type VendorPatch } from "./vendor/dialects.js";

/**
 * L2 of CONTRACTS.md §12.1: the turn boundary, the close-out ladder and the replay copy.
 *
 * PURE, and carrying state. No timers, no I/O, no async — the Worker owns the clock and delivers
 * `{type:"tick"}` (D15). Its ENTIRE coupling to this file is four lines (§13.2):
 *
 *   const out = norm.step(input);
 *   log.appendAll(out.emit);          // seq assigned here, synchronously, in array order
 *   rescheduleTick(out.scheduleTickAt);
 *   perform(out.action);              // the ONE side effect the reducer requests
 */

/** The `_meta` keys the reducer stamps on `state_update{idle}`, and `reduceTurn` reads back. */
export const WARNINGS_META = "omni/warnings";
export const VENDOR_PATCH_META = "omni/vendorPatch";

/**
 * §13.4's fourth signal is "a COMPLETE stderr line matching the descriptor's `fatalStderr`".
 *
 * `RuntimeDescriptor` has no `fatalStderr` field — `packages/protocol/src/runtime.ts` is frozen
 * for the whole of M1 — so the patterns are carried as `errorRules` entries whose `id` begins
 * with this prefix and whose `messageMatches` is the pattern. That is still THE DESCRIPTOR (the
 * only thing the normalizer may branch on, §17.1) and an operator can add one in a YAML overlay
 * with no code change; it is a spelling compromise, not a design one, and the field it wants is
 * recorded in M1-WP-B's hand-off notes.
 */
export const FATAL_STDERR_RULE_PREFIX = "fatalStderr";

/** The rung the ladder is on. `0` = the ladder is not running (§13.2). */
type Rung = 0 | 1 | 2 | 3 | 4 | 5;

/** The reducer's carried state. Internal to M1-WP-B; not part of CONTRACTS.md §5. */
export interface TurnLifecycleState {
  readonly state: "idle" | "running" | "settling" | "closing";
  readonly turnId: TurnId | null;
  /** Absolute epoch-ms; the quiet window's moving deadline (CONTRACTS.md §7.2). */
  readonly deadline: number | null;
  /** Absolute epoch-ms; `promptResultAt + hardMs`, which the deadline may never exceed. */
  readonly hardCutoff: number | null;
  readonly stopReason: string | null;
  /** v1 `PromptResponse.usage` (F21), verbatim. Rides on `state_update{idle}.usage`. */
  readonly usage: unknown;
  /** §13.4's advisories, accumulated for THIS turn and emitted on `idle`. */
  readonly warnings: readonly TurnWarning[];
  /** The descriptor-registered vendor patch reconstruction, accumulated for THIS turn. */
  readonly vendorPatch: VendorPatch | null;
  readonly rung: Rung;
  /** Why the ladder will report `settled` when it reaches rung 5. */
  readonly ladderReason: SettleReason | null;
}

export interface TurnLifecycleConfig {
  readonly quietMs: number;
  readonly hardMs: number;
  readonly drainGraceMs: number;
  readonly cancelGraceMs: number;
  readonly descriptor: RuntimeDescriptor;
  readonly ids: { synth(prefix: string): string };
  /** The session cwd, so a vendor patch names paths a git repository can apply. */
  readonly baseDir: string | null;
  /** v1 `NewSessionResponse.modes`, for §12.3 row 11. Absent ⇒ `options: []`. */
  modes(): Readonly<Record<string, unknown>> | null;
}

const IDLE: TurnLifecycleState = Object.freeze({
  state: "idle",
  turnId: null,
  deadline: null,
  hardCutoff: null,
  stopReason: null,
  usage: null,
  warnings: Object.freeze([]),
  vendorPatch: null,
  rung: 0,
  ladderReason: null,
});

export function initialTurnLifecycleState(): TurnLifecycleState {
  return IDLE;
}

// ── the two synthesized events (§7.1, extended by §13.2 and §13.4) ───────────

const running = (turnId: TurnId): EventInput => ({
  kind: "acp.session_update",
  payloadVersion: 2,
  turnId,
  payload: { sessionUpdate: "state_update", state: "running" },
});

/**
 * `state_update{idle}` — M0's shape, plus M1's two additions and nothing else.
 *
 * `usage` is the v2 `Usage` block from the prompt RESPONSE (F21), which is where v2 puts it and
 * a DIFFERENT shape from `usage_update`'s `{used, size}`. It is included only when it really is
 * that shape: a type pun that happens to compile is exactly what §5.1's note warns against.
 *
 * `_meta` carries the turn's advisories and its vendor patch. Absent when there are none, so a
 * turn with nothing to say produces byte-for-byte M0's payload.
 */
function idle(state: TurnLifecycleState, turnId: TurnId): EventInput {
  const usage = v2Usage(state.usage);
  const meta: Record<string, unknown> = {};
  if (state.warnings.length > 0) meta[WARNINGS_META] = state.warnings;
  if (state.vendorPatch !== null) meta[VENDOR_PATCH_META] = state.vendorPatch;
  return {
    kind: "acp.session_update",
    payloadVersion: 2,
    turnId,
    payload: {
      sessionUpdate: "state_update",
      state: "idle",
      // `IdleStateUpdate.stopReason` is `StopReason | null`; null is the honest value for a turn
      // the agent ended with an error rather than a stop reason (§7.3), and for one the forced
      // ladder ended before the agent answered (§13.3 — never an invented "cancelled").
      stopReason: state.stopReason as StopReason | null,
      ...(usage === null ? {} : { usage }),
      ...(Object.keys(meta).length === 0 ? {} : { _meta: meta }),
    },
  };
}

function v2Usage(raw: unknown): Record<string, unknown> | null {
  const usage = record(raw);
  if (usage === null) return null;
  if (
    num(usage["totalTokens"]) === null ||
    num(usage["inputTokens"]) === null ||
    num(usage["outputTokens"]) === null
  ) {
    return null;
  }
  return usage as Record<string, unknown>;
}

const errorEvent = (
  turnId: TurnId | null,
  body: OmniErrorBody,
  stderrTail?: string,
): EventInput => ({
  kind: "omni.error",
  payloadVersion: 2,
  turnId,
  payload: stderrTail === undefined ? body : { ...body, stderrTail },
});

/** D6: every envelope emitted for a REPLAYED update is marked, and nothing else is (M1-R5). */
function markReplay(events: readonly EventInput[], replay: boolean): readonly EventInput[] {
  return replay ? events.map((e) => ({ ...e, replay: true as const })) : events;
}

function output(
  emit: readonly EventInput[],
  state: TurnLifecycleState,
  scheduleTickAt: number | null,
  settled: SettleReason | null,
  action: CloseOutAction | null = null,
): TurnOutput {
  return {
    emit,
    scheduleTickAt,
    state: state.state,
    turnId: state.turnId,
    settled,
    action,
  };
}

/** `min(U + quietMs, hardCutoff)` — the moving deadline of §7.2, with the hard cap applied. */
const nextDeadline = (at: number, cfg: TurnLifecycleConfig, hardCutoff: number): number =>
  Math.min(at + cfg.quietMs, hardCutoff);

/**
 * The whole prompt lifecycle as one pure transition.
 *
 * Total over `TurnInput` × state: every cell below is reachable from a buggy caller even where
 * the daemon's `409 worker_busy` makes it unreachable from the wire, and a reducer that threw
 * on one of them would take the worker down instead of the request.
 */
export function stepTurnLifecycle(
  state: TurnLifecycleState,
  input: TurnInput,
  cfg: TurnLifecycleConfig,
): { readonly state: TurnLifecycleState; readonly output: TurnOutput } {
  switch (input.type) {
    case "prompt_sent": {
      const emit: EventInput[] = [];
      // A prompt while the previous turn is still SETTLING can only arrive from a caller that
      // skipped the busy check. Its `stopReason` is already known and real — the quiet window
      // is latency, not doubt — so the pending `idle` is flushed rather than dropped, and the
      // previous turn ends in the log instead of hanging at `running` forever. A turn still
      // RUNNING has no stop reason, and inventing one is exactly what §7.3 forbids.
      if (state.state === "settling" && state.turnId !== null) {
        emit.push(idle(state, state.turnId));
      }
      // Appended BEFORE the request bytes reach stdin, which is what makes
      // `PromptAccepted.seq - 1` a sound subscription cursor (§7.1).
      emit.push(running(input.turnId));
      const next: TurnLifecycleState = {
        ...IDLE,
        state: "running",
        turnId: input.turnId,
        // A new turn starts with no advisories and no patch: they are per-turn aggregates and
        // carrying one across would attribute the last turn's rate-limit warning to this one.
        rung: state.rung,
        ladderReason: state.ladderReason,
      };
      // `settled` describes the turn this step LEAVES live, and this step leaves a new turn
      // live — the flushed idle above is visible in `emit`, which is where the log reads it.
      return { state: next, output: output(emit, next, ladderDeadline(next), null) };
    }

    case "agent_update":
      return agentUpdate(state, input, cfg);

    case "prompt_result": {
      if (state.turnId === null) {
        // No live turn: there is nothing to settle and nothing truthful to emit.
        return { state, output: output([], state, state.deadline, null) };
      }
      const withUsage: TurnLifecycleState = { ...state, usage: input.usage ?? state.usage };
      // A second response for the same turn re-arms the window but never extends the hard cap.
      const hardCutoff =
        state.state === "settling" && state.hardCutoff !== null
          ? state.hardCutoff
          : input.at + cfg.hardMs;
      const deadline = nextDeadline(input.at, cfg, hardCutoff);

      // The CLOSE_OUT ladder outranks the settle: rung 1 IS a quiet window, and letting the
      // settle path fire here would end the ladder's first rung early and emit `idle` twice.
      if (state.rung > 0) {
        const next: TurnLifecycleState = { ...withUsage, stopReason: input.stopReason };
        return { state: next, output: output([], next, state.deadline, null) };
      }

      if (deadline <= input.at) {
        // `quietMs: 0` (or a cap already spent): settle now rather than asking the Worker for a
        // tick in the past.
        const settling = { ...withUsage, stopReason: input.stopReason };
        const emit = [idle(settling, state.turnId)];
        return {
          state: IDLE,
          output: output(emit, IDLE, null, deadline >= hardCutoff ? "hard" : "quiet"),
        };
      }
      const next: TurnLifecycleState = {
        ...withUsage,
        state: "settling",
        turnId: state.turnId,
        deadline,
        hardCutoff,
        stopReason: input.stopReason,
      };
      return { state: next, output: output([], next, deadline, null) };
    }

    case "prompt_error": {
      // The agent answered with a JSON-RPC error and is STILL ALIVE, so the turn ends cleanly:
      // the error, then `idle` with a null stop reason (§7.3). The worker returns to `ready`.
      const turnId = state.turnId;
      const emit = [errorEvent(turnId, input.error)];
      if (turnId !== null) emit.push(idle({ ...state, stopReason: null }, turnId));
      const next = carryLadder(IDLE, state);
      return {
        state: next,
        output: output(emit, next, ladderDeadline(next), turnId === null ? null : "error"),
      };
    }

    case "process_gone": {
      // §7.3, the crash rule: a dead agent NEVER produces a fabricated `idle`. Only the error
      // is emitted; the Worker appends `omni.worker_state{closed,…}` next, and that is what
      // makes the turn terminal for `reduceTurn`, `turnStatus`, `prompt()` and `stream()`.
      const turnId = state.turnId;
      const emit = [errorEvent(turnId, input.error, input.stderrTail)];
      const next = carryLadder(IDLE, state);
      return {
        state: next,
        output: output(emit, next, ladderDeadline(next), turnId === null ? null : "gone"),
      };
    }

    // ── SEAM 1: the three CLOSE_OUT inputs (§13.2) ───────────────────────────

    case "close_requested":
      return closeRequested(state, input.at, cfg);

    case "drained": {
      // stdout EOF. Nothing more can arrive, so rung 3's whole purpose is served and §13.2
      // short-circuits to `terminate`. Outside the ladder it is an observation with no meaning
      // of its own: M0's exit-grace path owns that case, and this must not disturb its timer.
      if (state.rung === 0 || state.rung >= 5) {
        return { state, output: output([], state, state.deadline, null) };
      }
      return terminate({ ...state, ladderReason: "drained" }, input.at);
    }

    case "stderr_line":
      return stderrLine(state, input.line, input.at, cfg);

    case "tick": {
      if (state.rung > 0) return ladderTick(state, input.at, cfg);
      if (state.state !== "settling" || state.turnId === null || state.deadline === null) {
        return { state, output: output([], state, null, null) };
      }
      if (input.at < state.deadline) {
        // An early tick — the deadline moved out from under a timer that was already armed.
        // Re-arm at the current deadline; emitting `idle` here would truncate the answer.
        return { state, output: output([], state, state.deadline, null) };
      }
      const settled: SettleReason =
        state.hardCutoff !== null && state.deadline >= state.hardCutoff ? "hard" : "quiet";
      const emit = [idle(state, state.turnId)];
      return { state: IDLE, output: output(emit, IDLE, null, settled) };
    }
  }
  // `TurnInput` is a closed union, so this is unreachable through the type system — but the
  // reducer sits behind a JSON boundary, and a silently ignored input would look like a hung
  // turn rather than a bug.
  throw new OmniError("internal", "unknown turn input", {
    detail: { type: (input as { type?: unknown }).type },
  });
}

/**
 * The tick a terminal turn input leaves armed.
 *
 * `null` outside the ladder — that is M0's contract and `#rescheduleTick` CANCELS on null, so
 * returning a stale deadline here would re-arm a timer for a turn that just ended. Inside the
 * ladder it is the current rung's deadline: `prompt_error` during a close must not disarm the
 * rung that is going to terminate the process.
 */
function ladderDeadline(state: TurnLifecycleState): number | null {
  return state.rung > 0 ? state.deadline : null;
}

/** A terminal turn input must not abandon a ladder that is mid-rung. */
function carryLadder(base: TurnLifecycleState, from: TurnLifecycleState): TurnLifecycleState {
  if (from.rung === 0) return base;
  return {
    ...base,
    state: "closing",
    rung: from.rung,
    ladderReason: from.ladderReason,
    deadline: from.deadline,
  };
}

// ── agent_update: L1's map, then the turn boundary ──────────────────────────

function agentUpdate(
  state: TurnLifecycleState,
  input: Extract<TurnInput, { type: "agent_update" }>,
  cfg: TurnLifecycleConfig,
): { state: TurnLifecycleState; output: TurnOutput } {
  const mapped: MappedUpdate = mapUpdate(
    input.update,
    cfg.descriptor,
    cfg.ids,
    mapContext(state, cfg),
  );

  // §13.4's third signal and §12.5's vendor patch: both are read through the DESCRIPTOR's
  // extension pointers, so no agent's `_meta` spelling appears in this file.
  const extensions = readExtensions(mapped.payload, cfg);

  const emit: EventInput[] = [];
  // A terminal rate-limit status is an `omni.error{agent_error}` BEFORE `idle` (§13.4). It is
  // emitted the moment it is seen: it arrives before the failure, which is the whole reason it
  // is a better signal than the failure itself.
  if (extensions.error !== null) emit.push(errorEvent(state.turnId, extensions.error));

  // `keep: false` is the descriptor's drop hatch (§14.6): decided HERE, before `append()` is
  // ever called, so the log stays gap-free by construction and no `seq` is spent on it.
  if (mapped.keep) {
    emit.push({
      kind: "acp.session_update",
      payloadVersion: mapped.payloadVersion,
      turnId: state.turnId,
      payload: mapped.payload,
    });
  }

  const next: TurnLifecycleState = {
    ...state,
    warnings: addWarnings(state.warnings, extensions.warnings),
    vendorPatch: extensions.vendorPatch ?? state.vendorPatch,
  };
  const marked = markReplay(emit, input.replay === true);

  // The quiet window tracks AGENT ACTIVITY, not log entries: a dropped kind still means the
  // agent is talking, and ending the turn on it would truncate what comes next.
  if (next.rung === 1 && next.deadline !== null && next.hardCutoff !== null) {
    const deadline = nextDeadline(input.at, cfg, next.hardCutoff);
    const pushed = { ...next, deadline };
    return { state: pushed, output: output(marked, pushed, deadline, null) };
  }
  if (next.state !== "settling" || next.hardCutoff === null) {
    return { state: next, output: output(marked, next, next.deadline, null) };
  }
  // §7.2: forward it, THEN push the deadline out. The `chatty.mjs` fixture's chunk 400 ms
  // after `{stopReason:"end_turn"}` is the case this exists for.
  const deadline = nextDeadline(input.at, cfg, next.hardCutoff);
  const pushed: TurnLifecycleState = { ...next, deadline };
  return { state: pushed, output: output(marked, pushed, deadline, null) };
}

/**
 * Advisories are DE-DUPLICATED by `(code, message)`.
 *
 * The rate-limit block rides on `usage_update._meta`, and there are 60 `usage_update`s in the
 * corpus for 10 turns: without this, one throttled turn would carry nine identical warnings and
 * `TurnResult.warnings` would be a counter rather than a report.
 */
function addWarnings(
  existing: readonly TurnWarning[],
  incoming: readonly TurnWarning[],
): readonly TurnWarning[] {
  if (incoming.length === 0) return existing;
  const seen = new Set(existing.map((w) => `${w.code}\u0000${w.message}`));
  const added = incoming.filter((w) => {
    const key = `${w.code}\u0000${w.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return added.length === 0 ? existing : [...existing, ...added];
}

function mapContext(state: TurnLifecycleState, cfg: TurnLifecycleConfig): MapContext {
  return {
    // `plan_<turnId>`, stable across the turn, so successive `plan` updates upsert ONE plan.
    planId: `plan_${state.turnId ?? "no-turn"}`,
    modes: cfg.modes(),
  };
}

interface ExtensionReadout {
  readonly warnings: readonly TurnWarning[];
  readonly vendorPatch: VendorPatch | null;
  readonly error: OmniErrorBody | null;
}

const NO_EXTENSIONS: ExtensionReadout = { warnings: [], vendorPatch: null, error: null };

/**
 * The descriptor's registered `_meta` promotions (§17.3), and NOTHING agent-specific.
 *
 * Both pointers live in `RuntimeDescriptor.extensions`; the DIALECT that interprets the value
 * lives in `vendor/dialects.ts`. That split is what lets a compatible fork register the same
 * dialect under a different `_meta` spelling with a YAML entry rather than a commit.
 */
function readExtensions(payload: unknown, cfg: TurnLifecycleConfig): ExtensionReadout {
  const meta = record(record(payload)?.["_meta"]);
  if (meta === null) return NO_EXTENSIONS;

  const warnings: TurnWarning[] = [];
  let vendorPatch: VendorPatch | null = null;
  let error: OmniErrorBody | null = null;

  for (const extension of Object.values(cfg.descriptor.extensions)) {
    const value = resolvePointer(meta, extension.pointer);
    if (value === undefined) continue;

    if (extension.as === "patch" && extension.dialect === "claude_structured_patch") {
      vendorPatch = mergePatch(vendorPatch, readStructuredPatch(value, cfg.baseDir ?? undefined));
      continue;
    }

    if (extension.as === "rate_limit" && extension.dialect === "claude_rate_limit") {
      const signal = readRateLimit(value);
      if (signal === null) continue;
      if (signal.terminal) {
        // An ENUMERATED terminal status, and only those four. Everything else — including the
        // only status ever observed, `allowed_warning` at 0.78 — is an advisory: guessing that
        // an unknown status means failure would fail turns that succeeded (§13.4).
        error = {
          code: "agent_error",
          message: `the agent reported rate-limit status ${signal.status}`,
        };
      } else if (signal.status !== "allowed") {
        warnings.push({
          code: "rate_limit",
          message: `rate-limit status ${signal.status}`,
          source: "usage_meta",
          detail: signal.raw,
        });
      }
    }
  }

  return warnings.length === 0 && vendorPatch === null && error === null
    ? NO_EXTENSIONS
    : { warnings, vendorPatch, error };
}

/**
 * One turn can edit several files, and a git patch may name several. Later hunks are appended
 * rather than replacing what came before, and an identical reconstruction (the same tool call
 * re-reporting itself) is not appended twice.
 */
function mergePatch(existing: VendorPatch | null, next: VendorPatch | null): VendorPatch | null {
  if (next === null) return existing;
  if (existing === null) return next;
  if (existing.text.includes(next.text)) return existing;
  return { ...existing, text: `${existing.text}${next.text}` };
}

// ── §13.4's fourth signal: a COMPLETE stderr line ───────────────────────────

function stderrLine(
  state: TurnLifecycleState,
  line: string,
  _at: number,
  cfg: TurnLifecycleConfig,
): { state: TurnLifecycleState; output: TurnOutput } {
  const matched = cfg.descriptor.errorRules.find(
    (rule) =>
      rule.id.startsWith(FATAL_STDERR_RULE_PREFIX) &&
      rule.messageMatches !== undefined &&
      safeTest(rule.messageMatches, line),
  );
  // The weakest of the four signals, and it does nothing at all unless the descriptor named a
  // pattern. An agent that writes a stack trace to stderr and recovers has not failed.
  if (matched === undefined) {
    return { state, output: output([], state, state.deadline, null) };
  }
  const emit = [
    errorEvent(state.turnId, {
      code: "agent_error",
      // The rule ID, not the line: the line is the agent's prose, and putting it in the message
      // is how `no-agent-prose` starts being true of the LOG instead of the code.
      message: `the agent's stderr matched ${matched.id}`,
      // Diagnostics ride on `stderrTail`, which is where §7.3 already puts a stderr excerpt.
    }),
  ];
  const next: TurnLifecycleState = {
    ...state,
    warnings: addWarnings(state.warnings, [
      { code: "fatal_stderr", message: `stderr matched ${matched.id}`, source: "stderr" },
    ]),
  };
  return { state: next, output: output(emit, next, state.deadline, null) };
}

function safeTest(pattern: string, subject: string): boolean {
  try {
    return new RegExp(pattern).test(subject);
  } catch {
    return false;
  }
}

// ── §13.2's CLOSE_OUT ladder ────────────────────────────────────────────────

function closeRequested(
  state: TurnLifecycleState,
  at: number,
  cfg: TurnLifecycleConfig,
): { state: TurnLifecycleState; output: TurnOutput } {
  // Idempotent: DELETE, hibernate, daemon shutdown and the cancel escalation can all fire at
  // once, and restarting the ladder from rung 1 would reopen a quiet window rung 4 already
  // spent.
  if (state.rung > 0) {
    return { state, output: output([], state, state.deadline, null) };
  }

  // NO LIVE TURN, NO LADDER.
  //
  // Every rung of §13.2 exists to protect output that is still coming: rung 1 lets the last
  // chunk land, rung 3 drains what the agent is still writing, rung 4 cancels the work in
  // flight. With no turn open there is none of that, and running the ladder anyway would add
  // `quietMs + drainGraceMs + cancelGraceMs` to every `DELETE` of an idle worker — which §13.3
  // is explicitly trying to prevent ("a hung agent cannot hold `DELETE` open").
  //
  // It is also what keeps the teardown CORRECT with the Worker as it stands: §6.5's own ladder
  // opens with `closeStdin()` and then escalates through SIGTERM/SIGKILL to the whole GROUP, so
  // an agent that exits politely on stdin EOF still has its tree reclaimed. Closing stdin from
  // rung 2 first lets the leader exit on its own, and `terminate()`'s rung 0 then reports a
  // surviving tree (`treeGone: false`) instead of reclaiming it — §6.7's zombie, exactly. See
  // M1-WP-B's hand-off note: the mid-turn path needs `#doClose` to pass `force: true` after the
  // ladder has run, which is a `worker.ts` edit this work package may not make.
  //
  // `action: null` + `scheduleTickAt: null` is the Worker's documented "there is no rung to wait
  // for" answer, so `#runCloseOut` returns in the same tick and M0's proven close runs unchanged.
  if (state.turnId === null) {
    return { state, output: output([], state, null, null) };
  }

  // Rung 1: the quiet window, capped at `hardMs` so a hung agent cannot hold `DELETE` open
  // (§13.3). A turn already settling keeps its own, later deadline — cutting it short here
  // would truncate the answer the ladder exists to let land.
  const hardCutoff = at + cfg.hardMs;
  const deadline = Math.min(Math.max(at + cfg.quietMs, state.deadline ?? at), hardCutoff);
  const entered: TurnLifecycleState = {
    ...state,
    state: "closing",
    rung: 1,
    ladderReason: "cancelled",
    deadline,
    hardCutoff,
  };
  if (deadline <= at) return advance(entered, at, cfg);
  return { state: entered, output: output([], entered, deadline, null) };
}

function ladderTick(
  state: TurnLifecycleState,
  at: number,
  cfg: TurnLifecycleConfig,
): { state: TurnLifecycleState; output: TurnOutput } {
  if (state.deadline !== null && at < state.deadline) {
    // Early — the rung's deadline moved (rung 1's quiet window is still moving). Re-arm.
    return { state, output: output([], state, state.deadline, null) };
  }
  return advance(state, at, cfg);
}

/** One rung, and exactly one `CloseOutAction`. The Worker performs it and adds no judgement. */
function advance(
  state: TurnLifecycleState,
  at: number,
  cfg: TurnLifecycleConfig,
): { state: TurnLifecycleState; output: TurnOutput } {
  switch (state.rung) {
    case 1: {
      // The quiet window closed. A turn that already has its stop reason settles here, exactly
      // as it would have without the ladder — and `settled` stays NULL, because the LADDER is
      // not finished and the Worker is waiting on that flag to start killing.
      const emit: EventInput[] = [];
      let next: TurnLifecycleState = state;
      if (state.stopReason !== null && state.turnId !== null) {
        emit.push(idle(state, state.turnId));
        next = {
          ...state,
          turnId: null,
          stopReason: null,
          usage: null,
          warnings: [],
          vendorPatch: null,
        };
      }
      // Rung 2: `session/cancel`, then its own grace.
      //
      // §13.2 SPELLS THIS RUNG FOURTH, AFTER `close_stdin`, AND IT CANNOT BE. `session/cancel`
      // travels on the agent's stdin, and rung `close_stdin` closes it — so a cancel sent after
      // it reaches nobody, which the e2e ladder test asserts from the AGENT's side, and the
      // write rejects into a floating promise in `worker.ts`'s `#perform`, which used to make
      // the whole suite exit non-zero on an unhandled rejection. §13.2's own comment on the
      // stdin rung says "EOF: no more requests are coming", and a later rung that sends one
      // contradicts it in the document.
      //
      // Transposing the two keeps every rung, every grace and every deadline, keeps corpus
      // finding 14's reason intact (the quiet window still comes FIRST, so a `usage_update` that
      // arrives after our cancel still lands before `idle`), and makes each rung deliverable.
      // AMENDED, not merely reported: CONTRACTS ruling M1-R4a records the transposition, §13.2's
      // CLOSE_OUT block and its L23 row now spell `quiet -> cancel -> close_stdin -> drain ->
      // terminate`, and DESIGN §6.2's 收尾顺序 bullet carries the same correction — so the
      // documents and this file agree, and the evidence cited is a test rather than an argument.
      const cancelDeadline = at + cfg.cancelGraceMs;
      const rung2: TurnLifecycleState = { ...next, rung: 2, deadline: cancelDeadline };
      return { state: rung2, output: output(emit, rung2, cancelDeadline, null, "cancel") };
    }
    case 2: {
      // Rung 3: EOF on stdin — no more requests are coming, and now that is TRUE. NEVER at turn
      // end (§6.5, ruling M1-R4); this is the forced ladder and nothing else.
      const rung3: TurnLifecycleState = { ...state, rung: 3, deadline: at };
      return { state: rung3, output: output([], rung3, at, null, "close_stdin") };
    }
    case 3: {
      // Rung 4: wait `drainGraceMs` for stdout EOF, FORWARDING everything that arrives.
      const deadline = at + cfg.drainGraceMs;
      const rung4: TurnLifecycleState = { ...state, rung: 4, deadline };
      return { state: rung4, output: output([], rung4, deadline, null, "drain") };
    }
    default:
      return terminate(state, at);
  }
}

/**
 * Rung 5: §6.5's escalation ladder — SIGTERM → grace → SIGKILL / taskkill.
 *
 * It reports `settled`, which is the Worker's signal that the ladder is finished, and requests
 * NO action. The `"terminate"` member of `CloseOutAction` is deliberately not used, and this is
 * the one place §13.2 is not implemented literally:
 *
 *   `worker.ts`'s `#perform("terminate")` is `#closeWith("cancel_timeout", {force: true})`, and
 *   `#closeWith` is first-caller-wins. On a `DELETE` a close is already in flight, so it is a
 *   no-op; on the OTHER two live triggers it is actively wrong — it would start a close during
 *   `#doHibernate` (turning a hibernate into a close) and it would win the race against the
 *   cancel escalation's own `#closeWith(..., {error})`, dropping the `agent_timeout` error that
 *   `POST /cancel`'s timeout is required to report.
 *
 * Every one of §13.2's four triggers already performs §6.5's ladder itself in the very next
 * statement after `#runCloseOut` resolves — `#doClose` through `proc.terminate()`, `#doHibernate`
 * through `#reclaimProcess()`, the cancel escalation through `#closeWith(..., {force: true})` —
 * with its OWN reason and error intact. Reporting `settled` and letting the caller do it is
 * therefore behaviourally identical where `#perform` is safe and correct where it is not.
 * M1-WP-B's hand-off note carries the `worker.ts` guard that would let the reducer request it.
 */
function terminate(
  state: TurnLifecycleState,
  _at: number,
): { state: TurnLifecycleState; output: TurnOutput } {
  const emit: EventInput[] = [];
  // §13.3: when the ladder terminates a live turn, `idle` carries WHATEVER THE PROMPT RESPONSE
  // GAVE US — never an invented `"cancelled"`. So it is emitted exactly when there is something
  // to carry: the response landed during rungs 2–4, after rung 1's window had already closed.
  //
  // And when the response never came, NO `idle` at all. §7.3 is unchanged and still binding: a
  // turn the agent never finished is terminal on `omni.worker_state{closed}`, and synthesizing
  // `idle{stopReason: null}` here would make it terminal one envelope EARLIER — before the
  // `omni.error` the close appends — so `POST /cancel`'s escalation would report a turn that
  // "completed" with no error instead of one that timed out. That is precisely the falsehood
  // §7.3 exists to keep out of `TurnResult`, and `cancel.itest`'s `agent_timeout` assertion is
  // the regression lock on it.
  if (state.turnId !== null && state.stopReason !== null) emit.push(idle(state, state.turnId));
  const settled = state.ladderReason ?? "cancelled";
  const next: TurnLifecycleState = { ...IDLE, state: "closing", rung: 5, ladderReason: settled };
  return { state: next, output: output(emit, next, null, settled, null) };
}

/** The reducer's own view of the ladder, for tests and for the Worker's logging. */
export function ladderRung(state: TurnLifecycleState): Rung {
  return state.rung;
}

/** Exposed so `normalizer.ts` can report the id in force without re-deriving it. */
export function currentTurnId(state: TurnLifecycleState): TurnId | null {
  return state.turnId;
}

/** Only used by the golden generator, which needs a payload's kind without a full map. */
export function updateKind(payload: NormalizedSessionUpdate): string | null {
  return str(record(payload)?.["sessionUpdate"]);
}
