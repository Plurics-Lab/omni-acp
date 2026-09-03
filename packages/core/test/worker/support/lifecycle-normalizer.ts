import type {
  EventInput,
  NormalizedSessionUpdate,
  Normalizer,
  SettleReason,
  StopReason,
  TurnId,
  TurnInput,
  TurnOutput,
} from "@omni-acp/protocol";

export interface RecordingNormalizer extends Normalizer {
  readonly inputs: readonly TurnInput["type"][];
}

const running = (): NormalizedSessionUpdate =>
  ({ sessionUpdate: "state_update", state: "running" }) as unknown as NormalizedSessionUpdate;

const idle = (stopReason: StopReason | null): NormalizedSessionUpdate =>
  ({
    sessionUpdate: "state_update",
    state: "idle",
    stopReason,
  }) as unknown as NormalizedSessionUpdate;

/**
 * WP-3's `createNormalizer` re-implemented, in WP-4's test tree, from CONTRACTS.md §7.
 *
 * This is not duplication for its own sake: M0-PLAN §2 makes WP-4 depend on `Normalizer` as an
 * INTERFACE so the two work packages merge independently, and `normalizer.ts` is a stub that
 * throws until WP-3 lands. What the Worker actually needs from a Normalizer is small and fully
 * specified — two synthesized events, a moving quiet-window deadline, and the rule that a dead
 * agent never produces a fabricated `idle` — so it is written out here rather than mocked, which
 * would prove nothing about the tick scheduler.
 *
 * It is deliberately pure and timer-free (D15), exactly like the real one.
 */
export function lifecycleNormalizer(o: { quietMs: number; hardMs: number }): RecordingNormalizer {
  let state: "idle" | "running" | "settling" = "idle";
  let turnId: TurnId | null = null;
  let deadline: number | null = null;
  let hardCutoff: number | null = null;
  let stopReason: StopReason | null = null;
  const inputs: TurnInput["type"][] = [];

  const out = (
    emit: readonly EventInput[],
    scheduleTickAt: number | null,
    settled: SettleReason | null,
  ): TurnOutput => ({ emit, scheduleTickAt, state, turnId, settled });

  const reset = (): void => {
    state = "idle";
    turnId = null;
    deadline = null;
    hardCutoff = null;
    stopReason = null;
  };

  return {
    sourceProtocolVersion: 1,
    slice: "m0-lifecycle",
    inputs,
    step(input: TurnInput): TurnOutput {
      inputs.push(input.type);
      switch (input.type) {
        case "prompt_sent": {
          state = "running";
          turnId = input.turnId;
          deadline = null;
          hardCutoff = null;
          stopReason = null;
          return out(
            [
              {
                kind: "acp.session_update",
                payloadVersion: 2,
                turnId: input.turnId,
                payload: running(),
              },
            ],
            null,
            null,
          );
        }

        case "agent_update": {
          // §7.5: forwarded verbatim, `payloadVersion: 1`, `_meta` preserved by forwarding the
          // object rather than rebuilding it.
          const emit: EventInput[] = [
            {
              kind: "acp.session_update",
              payloadVersion: 1,
              turnId,
              payload: input.update as NormalizedSessionUpdate,
            },
          ];
          if (state !== "settling") return out(emit, null, null);
          // §7.2: the deadline moves with every late update, but never past the hard cutoff.
          deadline = Math.min(input.at + o.quietMs, hardCutoff ?? Number.POSITIVE_INFINITY);
          return out(emit, deadline, null);
        }

        case "prompt_result": {
          state = "settling";
          stopReason = input.stopReason;
          hardCutoff = input.at + o.hardMs;
          deadline = Math.min(input.at + o.quietMs, hardCutoff);
          return out([], deadline, null);
        }

        case "tick": {
          if (state !== "settling" || deadline === null) return out([], null, null);
          if (input.at < deadline) return out([], deadline, null);
          const settled: SettleReason =
            hardCutoff !== null && input.at >= hardCutoff ? "hard" : "quiet";
          const emit: EventInput[] = [
            { kind: "acp.session_update", payloadVersion: 2, turnId, payload: idle(stopReason) },
          ];
          reset();
          return out(emit, null, settled);
        }

        case "prompt_error": {
          // Still alive, so the turn ends CLEANLY: the error, then idle with a null stopReason.
          const emit: EventInput[] = [
            { kind: "omni.error", payloadVersion: 2, turnId, payload: input.error },
            { kind: "acp.session_update", payloadVersion: 2, turnId, payload: idle(null) },
          ];
          reset();
          return out(emit, null, "error");
        }

        case "process_gone": {
          // §7.3: `omni.error` and NOTHING else. A dead agent never produces a fabricated idle.
          const emit: EventInput[] = [
            {
              kind: "omni.error",
              payloadVersion: 2,
              turnId,
              payload: { ...input.error, stderrTail: input.stderrTail },
            },
          ];
          reset();
          return out(emit, null, "gone");
        }
      }
    },
  };
}
