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
import { classifyError } from "./map/errors.js";
import { synthesizedIds } from "./map/message-id.js";
import { mapRequest } from "./map/methods.js";
import { mapPermissionRequest } from "./map/permission.js";
import { mapUpdate } from "./map/update.js";
import {
  currentTurnId,
  initialTurnLifecycleState,
  stepTurnLifecycle,
  type TurnLifecycleConfig,
  type TurnLifecycleState,
} from "./turn-lifecycle.js";

/**
 * CONTRACTS.md §5.7's factory signature, with the M1 additions OPTIONAL as the Land step landed
 * them. §5.7 types `ids` as REQUIRED; it stays optional here because two frozen call sites pass
 * neither it nor a descriptor (`daemon/src/registry.ts` and M0's own `turn-lifecycle.test.ts`,
 * whose passing unmodified is a WP-B acceptance bullet). A caller written against the document
 * passes all six and is unaffected; the defaults below are real values, not stubs.
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
  /**
   * The handshake's `AgentCapabilitiesSnapshot.modes`, read lazily because the handshake
   * completes AFTER the normalizer is constructed. §12.3 row 11 cannot build the mode config
   * option without the catalogue, and with no catalogue it emits `options: []` — honest, not
   * invented.
   */
  readonly modes?: () => Readonly<Record<string, unknown>> | null;
  /** The session cwd, so a reconstructed vendor patch names paths git can apply (§12.5). */
  readonly cwd?: string;
}

/** `TurnConfig`'s own zod defaults, restated for a caller that has no config (§5.7). */
const DEFAULT_DRAIN_GRACE_MS = 2_000;
const DEFAULT_CANCEL_GRACE_MS = 10_000;

/**
 * The M1 normalization slice: CONTRACTS.md §12's full v1→v2 map, §13's two close-out ladders and
 * §13.4's four "end_turn ≠ success" signals.
 *
 * Three layers, deliberately not fused (§12.1):
 *
 *   L1 `mapUpdate`   pure, stateless per call   one v1 update → one v2 update
 *   L2 `step`        pure, carries state        turn boundary, close-out ladder, replay copy
 *   L3 `reduceTurn`  pure, stateless            tool-call merge, `changes`, `verdict`
 *
 * **The stream is a log of events, not a materialized view.** L1 renames `tool_call` to
 * `tool_call_update`; it does NOT merge. Merging happens in L3, where F23 shows it is already
 * implemented with exactly the right "absent means unchanged" semantics — and if L1 merged,
 * `?since=N` would hand a reconnecting client post-merge snapshots and a DIFFERENT history than
 * an observer who never dropped, which breaks D6's whole promise.
 *
 * Two rules that look like omissions and are not:
 *  - A dead agent NEVER produces a fabricated `idle` (§7.3). On `process_gone` this emits
 *    `omni.error` only; the Worker appends the `closed` state. `stopReason` stays null rather
 *    than becoming a lie that flows into every downstream consumer.
 *  - `step()` is pure. It returns `EventInput[]` with no `seq`, no `ts`, no ids — the type makes
 *    stamping one a compile error, because `EventLog.append()` is the only assigner (§7.6).
 */
export function createNormalizer(o: NormalizerOptions): Normalizer {
  const descriptor = o.descriptor ?? DEFAULT_V1_PROFILE;

  // The ONLY mutable cell in the normalizer, and it is the reducer's carried state — never a
  // timer, never a promise. The Worker's whole coupling to this object is
  // `log.appendAll(out.emit)` + `rescheduleTick(out.scheduleTickAt)` + `perform(out.action)`.
  let state: TurnLifecycleState = initialTurnLifecycleState();

  const cfg: TurnLifecycleConfig = {
    quietMs: nonNegativeInt(o.quietMs, "quietMs"),
    hardMs: positiveInt(o.hardMs, "hardMs"),
    drainGraceMs: nonNegativeInt(o.drainGraceMs ?? DEFAULT_DRAIN_GRACE_MS, "drainGraceMs"),
    cancelGraceMs: positiveInt(o.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS, "cancelGraceMs"),
    descriptor,
    // Deterministic per instance: two normalizers fed the same script produce byte-identical
    // ids, which is what makes the reducer's purity test meaningful rather than incidental.
    ids: o.ids ?? synthesizedIds(() => currentTurnId(state)),
    baseDir: o.cwd ?? null,
    modes: o.modes ?? (() => null),
  };

  // A `-32601` is learned PER PROCESS and never persisted: a version bump may add the method
  // back, and a cached "unsupported" would be a permanent downgrade earned once (§17.3).
  const unsupported = new Set<string>();

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

    mapUpdate(update: unknown): MappedUpdate {
      return mapUpdate(update, descriptor, cfg.ids, {
        planId: `plan_${currentTurnId(state) ?? "no-turn"}`,
        modes: cfg.modes(),
      });
    },

    /**
     * Ruling M1-R14 routes every permission request through the v2 map before the responder
     * sees it: D4's rules are written against v2's tagged `subject`, and mapping FIRST is what
     * lets M2's rule engine match `kind` / `path` / `cmd` with no per-agent branch.
     */
    mapPermissionRequest(req: unknown): MappedPermissionRequest {
      return mapPermissionRequest(req, descriptor);
    },

    mapRequest(method: string, params: Record<string, unknown>): OutboundCall {
      return mapRequest(method, params, descriptor, unsupported);
    },

    noteUnsupported(method: string): void {
      unsupported.add(method);
    },

    classifyError(e: AcpErrorDetail): ErrorClass {
      return classifyError(e, descriptor);
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
