import {
  OmniError,
  type EventInput,
  type NormalizedSessionUpdate,
  type OmniErrorBody,
  type SettleReason,
  type StopReason,
  type TurnId,
  type TurnInput,
  type TurnOutput,
} from "@omni-acp/protocol";

/** The reducer's carried state. Internal to WP-3; not part of CONTRACTS.md §5. */
export interface TurnLifecycleState {
  readonly state: "idle" | "running" | "settling";
  readonly turnId: TurnId | null;
  /** Absolute epoch-ms; the quiet window's moving deadline (CONTRACTS.md §7.2). */
  readonly deadline: number | null;
  /** Absolute epoch-ms; `promptResultAt + hardMs`, which the deadline may never exceed. */
  readonly hardCutoff: number | null;
  readonly stopReason: string | null;
}

export interface TurnLifecycleConfig {
  readonly quietMs: number;
  readonly hardMs: number;
}

const IDLE: TurnLifecycleState = Object.freeze({
  state: "idle",
  turnId: null,
  deadline: null,
  hardCutoff: null,
  stopReason: null,
});

export function initialTurnLifecycleState(): TurnLifecycleState {
  return IDLE;
}

/**
 * The two synthesized events of CONTRACTS.md §7.1, and nothing else.
 *
 * `payloadVersion: 2` is load-bearing: these payloads are taken verbatim from the SDK's v2
 * `RunningStateUpdate` / `IdleStateUpdate`, so M1 does not reshape them and a client that
 * branches on `payloadVersion === 2` today keeps working when M1 flips the forwarded updates.
 */
const running = (turnId: TurnId): EventInput => ({
  kind: "acp.session_update",
  payloadVersion: 2,
  turnId,
  payload: { sessionUpdate: "state_update", state: "running" },
});

const idle = (turnId: TurnId, stopReason: string | null): EventInput => ({
  kind: "acp.session_update",
  payloadVersion: 2,
  turnId,
  payload: {
    sessionUpdate: "state_update",
    state: "idle",
    // `IdleStateUpdate.stopReason` is `StopReason | null`; null is the honest value for a turn
    // the agent ended with an error rather than a stop reason (§7.3).
    stopReason: stopReason as StopReason | null,
  },
});

/**
 * §7.5: forwarded byte-for-byte. The agent's object is passed BY IDENTITY — never rebuilt —
 * because rebuilding it drops `_meta` and every field this milestone has not enumerated. The
 * cast is the whole of the "normalization" M0 performs on it, and `payloadVersion: 1` is what
 * tells a client that it is holding a v1 shape.
 */
const passThrough = (turnId: TurnId | null, update: unknown): EventInput => ({
  kind: "acp.session_update",
  payloadVersion: 1,
  turnId,
  payload: update as NormalizedSessionUpdate,
});

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

const output = (
  emit: readonly EventInput[],
  state: TurnLifecycleState,
  scheduleTickAt: number | null,
  settled: SettleReason | null,
): TurnOutput => ({
  emit,
  scheduleTickAt,
  state: state.state,
  turnId: state.turnId,
  settled,
});

/** `min(U + quietMs, hardCutoff)` — the moving deadline of §7.2, with the hard cap applied. */
const nextDeadline = (at: number, cfg: TurnLifecycleConfig, hardCutoff: number): number =>
  Math.min(at + cfg.quietMs, hardCutoff);

/**
 * The whole prompt lifecycle as one pure transition. No timers, no I/O, no async — the Worker
 * owns the clock and delivers `{type:"tick"}` (D15).
 *
 * Total over `TurnInput` × state: every cell below is reachable from a buggy caller even where
 * the daemon's `409 worker_busy` makes it unreachable from the wire, and a reducer that throws
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
        emit.push(idle(state.turnId, state.stopReason));
      }
      // Appended BEFORE the request bytes reach stdin, which is what makes
      // `PromptAccepted.seq - 1` a sound subscription cursor (§7.1).
      emit.push(running(input.turnId));
      const next: TurnLifecycleState = {
        state: "running",
        turnId: input.turnId,
        deadline: null,
        hardCutoff: null,
        stopReason: null,
      };
      // `settled` describes the turn this step LEAVES live, and this step leaves a new turn
      // live — the flushed idle above is visible in `emit`, which is where the log reads it.
      return { state: next, output: output(emit, next, null, null) };
    }

    case "agent_update": {
      const emit = [passThrough(state.turnId, input.update)];
      if (state.state !== "settling" || state.hardCutoff === null) {
        return { state, output: output(emit, state, null, null) };
      }
      // §7.2: forward it, THEN push the deadline out. The `chatty.mjs` fixture's chunk 400 ms
      // after `{stopReason:"end_turn"}` is the case this exists for.
      const deadline = nextDeadline(input.at, cfg, state.hardCutoff);
      const next: TurnLifecycleState = { ...state, deadline };
      return { state: next, output: output(emit, next, deadline, null) };
    }

    case "prompt_result": {
      if (state.turnId === null) {
        // No live turn: there is nothing to settle and nothing truthful to emit.
        return { state, output: output([], state, state.deadline, null) };
      }
      // A second response for the same turn re-arms the window but never extends the hard cap.
      const hardCutoff =
        state.state === "settling" && state.hardCutoff !== null
          ? state.hardCutoff
          : input.at + cfg.hardMs;
      const deadline = nextDeadline(input.at, cfg, hardCutoff);
      if (deadline <= input.at) {
        // `quietMs: 0` (or a cap already spent): settle now rather than asking the Worker for a
        // tick in the past.
        const emit = [idle(state.turnId, input.stopReason)];
        return {
          state: IDLE,
          output: output(emit, IDLE, null, deadline >= hardCutoff ? "hard" : "quiet"),
        };
      }
      const next: TurnLifecycleState = {
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
      if (turnId !== null) emit.push(idle(turnId, null));
      return {
        state: IDLE,
        output: output(emit, IDLE, null, turnId === null ? null : "error"),
      };
    }

    case "process_gone": {
      // §7.3, the crash rule: a dead agent NEVER produces a fabricated `idle`. Only the error
      // is emitted; the Worker appends `omni.worker_state{closed,…}` next, and that is what
      // makes the turn terminal for `reduceTurn`, `turnStatus`, `prompt()` and `stream()`.
      // Fabricating `{state:"idle", stopReason:"cancelled"}` here would put a falsehood into
      // `TurnResult.stopReason` and flow it into every downstream consumer.
      const turnId = state.turnId;
      const emit = [errorEvent(turnId, input.error, input.stderrTail)];
      return {
        state: IDLE,
        output: output(emit, IDLE, null, turnId === null ? null : "gone"),
      };
    }

    case "tick": {
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
      const emit = [idle(state.turnId, state.stopReason)];
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
