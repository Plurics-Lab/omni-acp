import {
  OmniError,
  type AcpErrorDetail,
  type ErrorClass,
  type MappedPermissionRequest,
  type MappedUpdate,
  type Normalizer,
  type OutboundCall,
  type RuntimeDescriptor,
  type TurnInput,
  type TurnOutput,
} from "@omni-acp/protocol";
import { DEFAULT_V1_PROFILE } from "../runtime/known.js";
import { mapPermissionRequest } from "./map/permission.js";
import {
  initialTurnLifecycleState,
  stepTurnLifecycle,
  type TurnLifecycleConfig,
  type TurnLifecycleState,
} from "./turn-lifecycle.js";

/**
 * CONTRACTS.md §5.7's factory signature, with the M1 additions OPTIONAL so that every M0 call
 * site — which knows only `quietMs` / `hardMs` — still compiles against the Land step. A caller
 * written against the document passes all six and is unaffected; M1-WP-B tightens the defaults
 * away as it fills the map in.
 */
export interface NormalizerOptions {
  readonly quietMs: number;
  readonly hardMs: number;
  /** Forced close-out rung 3 (§13.2). Defaults to `TurnConfig.drainGraceMs`'s own default. */
  readonly drainGraceMs?: number;
  /** Forced close-out rung 4 (§13.2). Defaults to `TurnConfig.cancelGraceMs`'s own default. */
  readonly cancelGraceMs?: number;
  /** The ONLY thing the map may branch on (§17). Defaults to the generic v1 profile. */
  readonly descriptor?: RuntimeDescriptor;
  /** For `messageId` synthesis and plan ids. Deterministic per worker; injected so the map stays pure. */
  readonly ids?: { synth(prefix: string): string };
}

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
export function createNormalizer(o: NormalizerOptions): Normalizer {
  const cfg: TurnLifecycleConfig = {
    quietMs: nonNegativeInt(o.quietMs, "quietMs"),
    hardMs: positiveInt(o.hardMs, "hardMs"),
  };

  // The ONLY mutable cell in the normalizer, and it is the reducer's carried state — never a
  // timer, never a promise. The Worker's whole coupling to this object is
  // `log.appendAll(out.emit)` + `rescheduleTick(out.scheduleTickAt)` (§7.6).
  let state: TurnLifecycleState = initialTurnLifecycleState();

  const descriptor = o.descriptor ?? DEFAULT_V1_PROFILE;

  return {
    // Reporting only. NO mapping rule reads it (F24): claude-acp answers `protocolVersion: 1`
    // while already emitting v2 fields, so a version number is not a switch.
    sourceProtocolVersion: descriptor.protocolVersion,
    slice: "m1-full",
    descriptor,

    step(input: TurnInput): TurnOutput {
      const stepped = stepTurnLifecycle(state, input, cfg);
      state = stepped.state;
      return stepped.output;
    },

    // ── the v1→v2 map (§12), owned by M1-WP-B ───────────────────────────────

    mapUpdate(_update: unknown): MappedUpdate {
      throw new OmniError("internal", "unimplemented: M1-WP-B");
    },

    /**
     * The one map row the Land step wires rather than stubs. Ruling M1-R14 routes every
     * permission request through the v2 map before the responder sees it, and F1's agent asks
     * mid-turn and waits forever — so a throwing stub here would hang the acceptance fixture,
     * not fail it. M1-WP-B owns the rest of `map/permission.ts`.
     */
    mapPermissionRequest(req: unknown): MappedPermissionRequest {
      return mapPermissionRequest(req, descriptor);
    },

    mapRequest(_method: string, _params: Record<string, unknown>): OutboundCall {
      throw new OmniError("internal", "unimplemented: M1-WP-B");
    },

    noteUnsupported(_method: string): void {
      throw new OmniError("internal", "unimplemented: M1-WP-B");
    },

    classifyError(_e: AcpErrorDetail): ErrorClass {
      throw new OmniError("internal", "unimplemented: M1-WP-B");
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
