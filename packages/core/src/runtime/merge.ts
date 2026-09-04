import {
  OmniError,
  type ErrorRule,
  type MethodPreference,
  type MethodPreferences,
  type ProbeSummary,
  type Quirks,
  type RuntimeDescriptor,
  type RuntimeOverlay,
  type UpdateRule,
} from "@omni-acp/protocol";
import { assertDescriptorLegal } from "./descriptor.js";
import { DEFAULT_V1_PROFILE } from "./known.js";

/**
 * The quirk table's field types, so an operator's partial overlay is checked rather than
 * shovelled in. `RuntimeOverlay.quirks` is `Record<string, boolean | string | number>` — zod
 * cannot express "a partial of THIS interface" without restating it, so the check lives here,
 * beside the merge that consumes it (CONTRACTS.md §17.2).
 *
 * `enum` entries carry their legal values: a typo in `permissionRequestShape` must be a startup
 * failure, not a quirk table with a value no consumer will ever match.
 */
const QUIRK_TYPES: Readonly<Record<keyof Quirks, "boolean" | "number" | readonly string[]>> = {
  resumeSilentlyCreates: "boolean",
  resumeRequiresSameCwd: "boolean",
  loadReturnsBody: "boolean",
  messageIdPresent: "boolean",
  toolCallUpdateIsSparse: "boolean",
  diffIsFragment: "boolean",
  permissionRequestShape: ["v1_tool_call", "v2_subject"],
  sessionGrantKind: ["none", "allow_session"],
  emitsUsageUpdateOnV1: "boolean",
  emitsStateUpdate: "boolean",
  configIdField: ["configId", "optionId"],
  toleratesOmittedMcpCapabilities: "boolean",
  unknownMethodErrorCode: "number",
};

/** Was anything actually written in this overlay block? `{}` must not count as a layer. */
function overlayIsEmpty(o: RuntimeOverlay): boolean {
  return (
    o.prefer === undefined &&
    o.inboundAliases === undefined &&
    o.updates === undefined &&
    o.extensions === undefined &&
    o.errorRules === undefined &&
    o.quirks === undefined &&
    o.budgets === undefined &&
    o.unverified === undefined
  );
}

function mergeQuirks(base: Quirks, overlay: RuntimeOverlay["quirks"]): Quirks {
  if (overlay === undefined) return base;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const expected = QUIRK_TYPES[key as keyof Quirks];
    if (expected === undefined) {
      // NOT silently ignored. A quirk key that does not exist is a typo, and a typo'd quirk that
      // is quietly dropped is how an operator comes to believe a knob is on. This throws at
      // daemon start, where the config is read, and never on a request path.
      throw new OmniError(
        "bad_request",
        `runtime.quirks."${key}" is not a known quirk (CONTRACTS.md §17.2)`,
      );
    }
    if (Array.isArray(expected)) {
      if (typeof value !== "string" || !expected.includes(value)) {
        throw new OmniError(
          "bad_request",
          `runtime.quirks.${key} must be one of ${expected.join(" | ")}`,
        );
      }
    } else if (typeof value !== expected) {
      throw new OmniError("bad_request", `runtime.quirks.${key} must be a ${expected}`);
    }
    out[key] = value;
  }
  return out as unknown as Quirks;
}

function mergePrefer(
  base: MethodPreferences,
  overlay: RuntimeOverlay["prefer"],
): MethodPreferences {
  if (overlay === undefined) return base;
  const out: Record<string, MethodPreference> = { ...base };
  for (const [capability, preference] of Object.entries(overlay)) {
    // Per CAPABILITY, not per spelling: an operator who writes a `spellings` list is stating the
    // whole order for that capability, and merging the two lists would produce an order nobody
    // wrote. Capabilities the overlay does not name keep the builtin's entry untouched.
    out[capability] = {
      spellings: [...preference.spellings],
      onFailure: preference.onFailure,
    };
  }
  return out;
}

function mergeUpdates(
  base: Readonly<Record<string, UpdateRule>>,
  overlay: RuntimeOverlay["updates"],
): Readonly<Record<string, UpdateRule>> {
  if (overlay === undefined) return base;
  const out: Record<string, UpdateRule> = { ...base };
  for (const [kind, rule] of Object.entries(overlay)) {
    out[kind] = { map: rule.map, stream: rule.stream, store: rule.store, digest: rule.digest };
  }
  return out;
}

function mergeErrorRules(
  base: readonly ErrorRule[],
  overlay: RuntimeOverlay["errorRules"],
): readonly ErrorRule[] {
  if (overlay === undefined) return base;
  // PREPENDED, not replaced: `classifyAcpError` is first-match-wins, so an operator's rule takes
  // precedence over the builtin's without deleting the rows they did not think about. An id that
  // collides with a builtin's therefore SHADOWS it, which is the useful reading of "override".
  const shadowed = new Set(overlay.map((r) => r.id));
  return [...overlay.map(toErrorRule), ...base.filter((r) => !shadowed.has(r.id))];
}

/**
 * A budget the operator did not write must keep the builtin's value.
 *
 * A plain spread would be wrong the moment zod hands back a key whose value is `undefined`
 * (`exactOptionalPropertyTypes` is off for the whole of M1, ruling M1-R20), and a budget of
 * `undefined` is a timeout that never fires.
 */
function mergeBudgets(
  base: RuntimeDescriptor["budgets"],
  overlay: RuntimeOverlay["budgets"],
): RuntimeDescriptor["budgets"] {
  if (overlay === undefined) return base;
  return {
    initializeMs: overlay.initializeMs ?? base.initializeMs,
    sessionNewMs: overlay.sessionNewMs ?? base.sessionNewMs,
    resumeMs: overlay.resumeMs ?? base.resumeMs,
    turnMs: overlay.turnMs ?? base.turnMs,
  };
}

function toErrorRule(r: NonNullable<RuntimeOverlay["errorRules"]>[number]): ErrorRule {
  return {
    id: r.id,
    ...(r.code === undefined ? {} : { code: r.code }),
    ...(r.dataPointer === undefined ? {} : { dataPointer: r.dataPointer }),
    ...(r.dataMatches === undefined ? {} : { dataMatches: r.dataMatches }),
    ...(r.messageMatches === undefined ? {} : { messageMatches: r.messageMatches }),
    classify: r.classify,
  };
}

/**
 * Reorder one capability's spellings by what the probe PROVED, without discarding any.
 *
 * Discarding is wrong twice over: `ProbeSummary.unsupportedMethods` is a claim about the process
 * that answered, and a version bump may add the method back (§17.3); and a probe that never ran
 * the battery (`deep:false`) knows nothing about most spellings. So a proven spelling moves to
 * the front, a proven-absent one moves to the back, and an unmentioned one keeps its declared
 * rank in between. The registry still SKIPS the known-unsupported ones at call time — this only
 * decides which one it reaches for first.
 */
function reorderByProbe(prefer: MethodPreferences, probe: ProbeSummary): MethodPreferences {
  const supported = new Set(probe.supportedMethods);
  const unsupported = new Set(probe.unsupportedMethods);
  if (supported.size === 0 && unsupported.size === 0) return prefer;

  const rank = (method: string): number =>
    supported.has(method) ? 0 : unsupported.has(method) ? 2 : 1;
  const out: Record<string, MethodPreference> = {};
  for (const [capability, preference] of Object.entries(prefer)) {
    const spellings = preference.spellings
      .map((spelling, index) => ({ spelling, index, rank: rank(spelling) }))
      // A stable sort on (rank, declared index): equal ranks keep the descriptor's order, so the
      // result is a function of the inputs and not of V8's sort implementation.
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
      .map((entry) => entry.spelling);
    out[capability] = { spellings, onFailure: preference.onFailure };
  }
  return out;
}

/**
 * What the probe learned about parameter NAMES, folded into the quirk table.
 *
 * Exactly one row today, and it is the row §17.4 exists for: `-32602` with
 * `data.configId._errors` proves the field is `configId` and not `optionId` (F17). The map is
 * keyed by METHOD so a second row can be added without guessing which method a bare field name
 * belonged to.
 */
function quirksFromProbe(quirks: Quirks, probe: ProbeSummary): Quirks {
  const learned = probe.learnedParams["session/set_config_option"];
  if (learned !== "configId" && learned !== "optionId") return quirks;
  if (learned === quirks.configIdField) return quirks;
  return { ...quirks, configIdField: learned };
}

/**
 * builtin ⊕ config overlay ⊕ probe, in that order, with `source` recording which layers ran
 * (CONTRACTS.md §17.2). Falls back to `DEFAULT_V1_PROFILE` when `builtin` is null; NEVER throws
 * for a missing layer, and rejects an illegal merged result (`stream:false, store:true`).
 *
 * PURE and total in its three arguments: same inputs, same descriptor, forever. That is what
 * makes §17.2's "table-tested merge" a table rather than a fixture, and it is why the fingerprint
 * is TAKEN from the probe rather than recomputed here — recomputing needs the `AgentDescriptor`,
 * which is the Agent Catalog's business, not the merge's.
 *
 * The probe is applied LAST and therefore wins, which is §17.2's stated precedence. It never
 * DELETES anything an operator wrote: it reorders spellings by what it proved and sharpens the
 * two quirks it has evidence for. An operator's list survives a probe; only its order changes.
 *
 * Owned by M1-WP-E.
 */
export function resolveDescriptor(
  builtin: RuntimeDescriptor | null,
  overlay: RuntimeOverlay,
  probe: ProbeSummary | null,
): RuntimeDescriptor {
  const base = builtin ?? DEFAULT_V1_PROFILE;
  const hasConfig = !overlayIsEmpty(overlay);
  const hasProbe = probe !== null;

  let prefer = mergePrefer(base.prefer, overlay.prefer);
  let quirks = mergeQuirks(base.quirks, overlay.quirks);
  let protocolVersion = base.protocolVersion;
  let fingerprint = base.fingerprint;

  if (probe !== null) {
    prefer = reorderByProbe(prefer, probe);
    quirks = quirksFromProbe(quirks, probe);
    // The probe is the only layer that has spoken to the process. `protocolVersion` outside
    // {1,2} is a runtime we cannot model, so the declared value stands rather than being
    // widened — the descriptor type has two arms and inventing a third is not available.
    if (probe.protocolVersion === 1 || probe.protocolVersion === 2) {
      protocolVersion = probe.protocolVersion;
    }
    fingerprint = probe.descriptorFingerprint;
  }

  const layers = (builtin !== null ? 1 : 0) + (hasConfig ? 1 : 0) + (hasProbe ? 1 : 0);
  const source: RuntimeDescriptor["source"] =
    layers >= 2
      ? "merged"
      : hasProbe
        ? "probe"
        : hasConfig
          ? "config"
          : // Zero layers is still the builtin v1 profile — "we know nothing" is a builtin answer.
            "builtin";

  const resolved: RuntimeDescriptor = {
    id: base.id,
    fingerprint,
    protocolVersion,
    source,
    prefer,
    updates: mergeUpdates(base.updates, overlay.updates),
    extensions:
      overlay.extensions === undefined
        ? base.extensions
        : { ...base.extensions, ...overlay.extensions },
    errorRules: mergeErrorRules(base.errorRules, overlay.errorRules),
    quirks,
    inboundAliases:
      overlay.inboundAliases === undefined
        ? base.inboundAliases
        : { ...base.inboundAliases, ...overlay.inboundAliases },
    clientHost: base.clientHost,
    budgets: mergeBudgets(base.budgets, overlay.budgets),
    // `unverified` is a claim about what a corpus has NOT exercised, so an operator who writes
    // one is replacing the claim, not adding to it (§18.3 makes the compat suite refuse to
    // assert these rows).
    unverified: overlay.unverified === undefined ? base.unverified : [...overlay.unverified],
  };

  // §14.6's forbidden shape can be introduced by the overlay, so the check is on the MERGED
  // result — validating the overlay alone would pass a rule that only becomes illegal once it
  // lands on top of a builtin row.
  assertDescriptorLegal(resolved);
  return resolved;
}
