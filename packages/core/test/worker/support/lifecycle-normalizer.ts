import { fakeRuntime } from "@omni-acp/testkit";
import type {
  AcpErrorDetail,
  ErrorClass,
  EventInput,
  MappedPermissionRequest,
  MappedUpdate,
  OutboundCall,
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
  /** Every input VERBATIM — D6's `replay` flag arrives on the input and nowhere else. */
  readonly seen: readonly TurnInput[];
}

const running = (): NormalizedSessionUpdate =>
  ({ sessionUpdate: "state_update", state: "running" }) as unknown as NormalizedSessionUpdate;

const idle = (
  stopReason: StopReason | null,
  meta?: Readonly<Record<string, unknown>> | null,
): NormalizedSessionUpdate =>
  ({
    sessionUpdate: "state_update",
    state: "idle",
    stopReason,
    // Seam D (§5.8.5, ruling M2-R9): `TurnInput.prompt_result.meta` is merged into
    // `state_update{idle}._meta` WITHOUT reading a single key of it. The real reducer does this
    // and so must the double, or the two keys that ride it — `omni/patch` and `omni/policy` —
    // are unobservable in every unit test that uses this harness.
    ...(meta === null || meta === undefined || Object.keys(meta).length === 0
      ? {}
      : { _meta: meta }),
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
  /** `prompt_result.meta`, held until the settle emits `idle` — seam D's whole mechanism. */
  let settleMeta: Readonly<Record<string, unknown>> | null = null;
  const inputs: TurnInput["type"][] = [];
  const seen: TurnInput[] = [];

  const out = (
    emit: readonly EventInput[],
    scheduleTickAt: number | null,
    settled: SettleReason | null,
    // M1's `TurnOutput` carries the close-out rung the Worker must perform (seam 1). The M0
    // lifecycle requests none, which is exactly what the real reducer does today.
  ): TurnOutput => ({ emit, scheduleTickAt, state, turnId, settled, action: null });

  const reset = (): void => {
    state = "idle";
    turnId = null;
    deadline = null;
    hardCutoff = null;
    stopReason = null;
    settleMeta = null;
  };

  return {
    sourceProtocolVersion: 1,
    slice: "m1-full",
    descriptor: fakeRuntime(),
    inputs,
    seen,
    step(input: TurnInput): TurnOutput {
      inputs.push(input.type);
      seen.push(input);
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
          //
          // D6 / §15.3: "The Normalizer's only job is to COPY the flag onto every `EventInput` it
          // emits for that update; it carries no window state, and stays pure." That is this one
          // spread — the Worker owns the window, the reducer owns the copy.
          const emit: EventInput[] = [
            {
              kind: "acp.session_update",
              payloadVersion: 1,
              turnId,
              payload: input.update as NormalizedSessionUpdate,
              ...(input.replay === true ? { replay: true as const } : {}),
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
          settleMeta = input.meta ?? null;
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
            {
              kind: "acp.session_update",
              payloadVersion: 2,
              turnId,
              payload: idle(stopReason, settleMeta),
            },
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

        default:
          // M1 widened `TurnInput` with the forced close-out ladder's inputs
          // (`close_requested` / `drained` / `stderr_line`). The M0 lifecycle this double models
          // has no ladder, so they are inert here — and inert must mean "no emit, no rung",
          // never "fall off the end and return undefined".
          return out([], null, null);
      }
    },

    // ── the v1->v2 map (M1-WP-B) ────────────────────────────────────────────
    //
    // This double models the LIFECYCLE, which is all `worker.ts` needs from a Normalizer, with
    // one exception: ruling M1-R14 routes every permission request through the map before the
    // responder sees it, so that one row is modelled and the rest refuse loudly.

    mapUpdate(_update: unknown): MappedUpdate {
      throw new Error("mapUpdate is M1-WP-B");
    },

    mapPermissionRequest(req: unknown): MappedPermissionRequest {
      const r = (typeof req === "object" && req !== null ? req : {}) as Record<string, unknown>;
      const toolCall = (
        typeof r["toolCall"] === "object" && r["toolCall"] !== null ? r["toolCall"] : null
      ) as Record<string, unknown> | null;
      const options = Array.isArray(r["options"])
        ? (r["options"] as MappedPermissionRequest["options"])
        : [];
      return {
        sessionId: typeof r["sessionId"] === "string" ? r["sessionId"] : "",
        title: toolCall !== null && typeof toolCall["title"] === "string" ? toolCall["title"] : "",
        subject: toolCall === null ? null : { type: "tool_call", toolCall },
        options,
        toolCallId:
          toolCall !== null && typeof toolCall["toolCallId"] === "string"
            ? toolCall["toolCallId"]
            : null,
      };
    },

    mapRequest(_method: string, _params: Record<string, unknown>): OutboundCall {
      throw new Error("mapRequest is M1-WP-B");
    },

    noteUnsupported(_method: string): void {
      throw new Error("noteUnsupported is M1-WP-B");
    },

    classifyError(_e: AcpErrorDetail): ErrorClass {
      throw new Error("classifyError is M1-WP-B");
    },
  };
}
