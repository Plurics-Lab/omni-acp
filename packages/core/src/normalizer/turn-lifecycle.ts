import { OmniError, type TurnInput, type TurnOutput } from "@omni-acp/protocol";

/** The reducer's carried state. Internal to WP-3; not part of CONTRACTS.md §5. */
export interface TurnLifecycleState {
  readonly state: "idle" | "running" | "settling";
  readonly turnId: string | null;
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

export function initialTurnLifecycleState(): TurnLifecycleState {
  throw new OmniError("internal", "unimplemented: WP-3 (normalizer.initialTurnLifecycleState)");
}

/**
 * The whole prompt lifecycle as one pure transition. No timers, no I/O, no async — the Worker
 * owns the clock and delivers `{type:"tick"}` (D15).
 */
export function stepTurnLifecycle(
  state: TurnLifecycleState,
  input: TurnInput,
  cfg: TurnLifecycleConfig,
): { readonly state: TurnLifecycleState; readonly output: TurnOutput } {
  throw new OmniError("internal", "unimplemented: WP-3 (normalizer.stepTurnLifecycle)");
}
