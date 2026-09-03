import { OmniError, type Normalizer, type TurnInput, type TurnOutput } from "@omni-acp/protocol";
import {
  initialTurnLifecycleState,
  stepTurnLifecycle,
  type TurnLifecycleConfig,
  type TurnLifecycleState,
} from "./turn-lifecycle.js";

/**
 * The M0 normalization slice, and nothing more (CONTRACTS.md §7.1): it synthesizes exactly two
 * events — `state_update{running}` before the prompt bytes reach stdin, and
 * `state_update{idle, stopReason}` after the prompt response AND the quiet window. Every other
 * `session/update` is forwarded verbatim with `payloadVersion: 1`.
 *
 * Two rules that look like omissions and are not:
 *  - A dead agent NEVER produces a fabricated `idle` (§7.3). On `process_gone` this emits
 *    `omni.error` only; the Worker appends the `closed` state. `stopReason` stays null rather
 *    than becoming a lie that flows into every downstream consumer.
 *  - `step()` is pure. It returns `EventInput[]` with no `seq`, no `ts`, no ids — the type makes
 *    stamping one a compile error, because `EventLog.append()` is the only assigner (§7.6).
 */
export function createNormalizer(o: { quietMs: number; hardMs: number }): Normalizer {
  const cfg: TurnLifecycleConfig = {
    quietMs: nonNegativeInt(o.quietMs, "quietMs"),
    hardMs: positiveInt(o.hardMs, "hardMs"),
  };

  // The ONLY mutable cell in the normalizer, and it is the reducer's carried state — never a
  // timer, never a promise. The Worker's whole coupling to this object is
  // `log.appendAll(out.emit)` + `rescheduleTick(out.scheduleTickAt)` (§7.6).
  let state: TurnLifecycleState = initialTurnLifecycleState();

  return {
    sourceProtocolVersion: 1,
    slice: "m0-lifecycle",
    step(input: TurnInput): TurnOutput {
      const stepped = stepTurnLifecycle(state, input, cfg);
      state = stepped.state;
      return stepped.output;
    },
  };
}

function nonNegativeInt(value: number, what: string): number {
  if (!Number.isInteger(value) || value < 0) {
    // `internal`: `TurnConfig` already parses these through zod, so a bad value here is a
    // caller inside the process rather than a request (CONTRACTS.md §9).
    throw new OmniError("internal", `normalizer ${what} must be a non-negative integer`, {
      detail: { [what]: value },
    });
  }
  return value;
}

function positiveInt(value: number, what: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new OmniError("internal", `normalizer ${what} must be a positive integer`, {
      detail: { [what]: value },
    });
  }
  return value;
}
