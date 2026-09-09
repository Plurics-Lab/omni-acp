import {
  type Clock,
  type InteractionId,
  type MappedPermissionRequest,
  type OptionChoice,
  type PermissionDecision,
  type PermissionOption,
  type PermissionResponder,
  type PolicyDecisionPayload,
  type RequestPermissionResponse,
} from "@omni-acp/protocol";

/**
 * Option ids that runtimes use for a session-scoped grant. D4's allow ordering puts these ahead
 * of a plain `allow_once` because they are the answer a human would give, and they die with the
 * session — unlike `allow_always`, which some runtimes persist to the runtime owner's disk
 * allowlist and which rule 3 therefore forbids outright.
 *
 * Matching is on the OPTION ID, because `kind` cannot express "for this session" in v1.
 */
const SESSION_GRANT_OPTION_IDS: ReadonlySet<string> = new Set([
  "allow_session",
  "approve_for_session",
]);

/**
 * The one kind that is never selected, whatever else is true about the option (D4 rule 3).
 *
 * EXPORTED, because §19.6 requires the human path's `400` to "quote rule 3", and a message that
 * spelled the word itself would put a second copy of D4's vocabulary in a second file — which is
 * the thing ruling M2-R16 and the `policy-never-names-an-option` guard exist to prevent. This
 * file owns the word; everybody else interpolates it.
 */
export const SESSION_WIDE_GRANT_KIND = "allow_always";
const FORBIDDEN_KIND = SESSION_WIDE_GRANT_KIND;

/** The kinds this responder understands. Anything else is a non-grant (D4 rule 6). */
const ALLOW_ONCE_KIND = "allow_once";
const REJECT_ONCE_KIND = "reject_once";

/**
 * The offered options, defensively narrowed.
 *
 * `options` arrives from the agent over a wire the SDK is deliberately NOT allowed to validate
 * for us: `PermissionOptionKind` is a closed enum in the schema, and D4 rule 6 requires an
 * unknown kind to survive far enough to be treated as a non-grant. So the shape check is here.
 */
function narrowOptions(raw: unknown): readonly PermissionOption[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (o): o is PermissionOption =>
      typeof o === "object" &&
      o !== null &&
      typeof (o as { optionId?: unknown }).optionId === "string" &&
      typeof (o as { kind?: unknown }).kind === "string",
  );
}

function offeredOptions(req: MappedPermissionRequest): readonly PermissionOption[] {
  return narrowOptions(req.options);
}

/**
 * v2's top-level `title`, which the map already derived from `toolCall.title ?? ""`
 * (CONTRACTS.md §7.4, §12.6, review R9). v1 has no top-level title, which is why the mapper is
 * the one that recovers it and the responder never reaches into `toolCall` itself.
 */
function titleOf(req: MappedPermissionRequest): string {
  // Defensive for the same reason `offeredOptions` is: the responder must be TOTAL. The mapper
  // always sets a string, but a decision that throws is a permission request that hangs forever
  // (F1), so a malformed input must still produce a record.
  const title: unknown = req.title;
  return typeof title === "string" ? title : "";
}

/** Rule 3 is absolute: an `allow_always` option is never selectable, by any path. */
function selectableGrant(o: PermissionOption): boolean {
  return o.kind !== FORBIDDEN_KIND;
}

/** D4 rule 2's ordering: a known session-grant id first, then any `allow_once`. */
function pickAllow(
  options: readonly PermissionOption[],
  allowSessionGrants: boolean,
): { option: PermissionOption; rule: string } | null {
  if (allowSessionGrants) {
    const sessionGrant = options.find(
      (o) => SESSION_GRANT_OPTION_IDS.has(o.optionId) && selectableGrant(o),
    );
    if (sessionGrant !== undefined) return { option: sessionGrant, rule: "d4:2-session-grant" };
  }
  const once = options.find((o) => o.kind === ALLOW_ONCE_KIND);
  return once === undefined ? null : { option: once, rule: "d4:2-allow-once" };
}

/** D4 rule 4's first half: deny means the offered `reject_once`, and nothing else. */
function pickDeny(options: readonly PermissionOption[]): PermissionOption | null {
  return options.find((o) => o.kind === REJECT_ONCE_KIND) ?? null;
}

/**
 * The ONE place in the repository an `optionId` may be chosen (§5.8.9, ruling M2-R16).
 *
 * The policy engine's whole vocabulary is `PolicyAction`; it never sees and never produces an
 * option id, and the `policy-never-names-an-option` guard makes that structural rather than
 * promised. This function is the other half of that split: everything below the engine that has
 * to turn an "allow" or a "deny" into one of the ids the agent actually offered lives here, and
 * D4's six hard rules are enforced in exactly this file.
 *
 * `cfg.allowSessionGrants` is the knob D4 rule 2's ordering needs once there is an operator
 * policy: `false` makes a session-scoped grant no better than a plain `allow_once`, which is what
 * an operator who does not want an approval to outlive one call is asking for. Rule 3 is NOT a
 * knob — an `allow_always` is never selectable by any value of any field.
 *
 * `OptionChoice.optionId === null` is rule 4's "nothing acceptable was offered", and the caller
 * answers JSON-RPC `-32603`. It never means cancel (rule 5).
 *
 * The body is `pickAllow` / `pickDeny` / `selectableGrant` above, unchanged — the extraction that
 * WP-P acceptance 2 requires, after which `permission-responder.test.ts` passes UNEDITED.
 * `createBaselineResponder` now calls THIS rather than keeping a second copy, which is the point:
 * two copies of D4 is how one of them quietly stops enforcing it.
 *
 * Owned by M2-B-WP-P.
 */
export function selectOption(
  action: "allow" | "deny",
  offered: readonly PermissionOption[],
  cfg: { allowSessionGrants: boolean },
): OptionChoice {
  // TOTAL over any input, for the reason `offeredOptions` exists: this is called from the
  // permission path, and a throw there is an agent waiting forever on a JSON-RPC id (F1).
  const options = narrowOptions(offered);

  if (action === "allow") {
    const grant = pickAllow(options, cfg.allowSessionGrants);
    // Rule 2 downgrades to deny when no acceptable grant is offered — never to "cancelled"
    // (rule 5), which would cancel the whole prompt turn rather than this one action.
    if (grant !== null) return { optionId: grant.option.optionId, rule: grant.rule };
    const fallback = pickDeny(options);
    if (fallback !== null) return { optionId: fallback.optionId, rule: "d4:2-downgraded-to-deny" };
    return { optionId: null, rule: "d4:4-nothing-acceptable" };
  }

  const rejection = pickDeny(options);
  if (rejection !== null) return { optionId: rejection.optionId, rule: "d4:4-reject-once" };
  return { optionId: null, rule: "d4:4-nothing-acceptable" };
}

/**
 * D4 rule 3's predicate, so that the ONE comparison against the forbidden kind lives here.
 *
 * `InteractionStrategy` has to recognise a session-wide grant twice — to refuse one under
 * `interaction.allowAlways:"never"`, and to stamp `blindsPolicy` on the record when an operator
 * has opted in (M2-R19) — and neither is a SELECTION, so neither belongs in `selectOption`.
 * Exporting the predicate rather than the rule keeps `permission-responder.ts` the only shipped
 * source that names a grant kind in code, which is what makes M2-R16 structural.
 */
export function isSessionWideGrant(option: PermissionOption): boolean {
  return !selectableGrant(option);
}

/**
 * Rule 2's ordering ALONE — a grant, or nothing.
 *
 * `selectOption("allow", …)` is the POLICY path's door, and its downgrade to the offered
 * rejection is part of that contract: an engine `allow` that cannot be honoured must still put a
 * real answer on the wire rather than hang the agent (F1). A HUMAN `allow` is a different caller
 * with a different answer — §19.6's `400`, because recording `decision:"allow"` beside an option
 * that in fact denies would make the audit trail say the opposite of what happened — so it asks
 * this instead. Both walk the SAME `pickAllow`, which is all §19.7 rule 2's "one implementation"
 * has ever meant.
 */
export function selectGrant(
  offered: readonly PermissionOption[],
  cfg: { allowSessionGrants: boolean },
): OptionChoice {
  const grant = pickAllow(narrowOptions(offered), cfg.allowSessionGrants);
  return grant === null
    ? { optionId: null, rule: "d4:2-nothing-acceptable" }
    : { optionId: grant.option.optionId, rule: grant.rule };
}

/**
 * D4's hard rules, no rule engine:
 *  1. only ever selects an optionId the agent actually offered
 *  2. allow: session-grant id -> any kind === "allow_once"; NEVER "allow_always"
 *  3. deny: offered kind === "reject_once"
 *  4. nothing acceptable offered => response: null => the caller replies -32603
 *  5. NEVER returns outcome: "cancelled"
 *  6. unknown `kind` is treated as non-grant (fail closed)
 *
 * M0 wires only mode "deny"; "allow" is implemented and unit-tested but unreachable from the
 * wire. Shipping the first remote-execution surface fail-closed is the point, and it leaves M2's
 * policy engine nothing to invent.
 *
 * Required, not optional: the M0 acceptance fixture issues `session/request_permission` mid-turn
 * and awaits it forever, so without a responder `session/prompt` never returns (CONTRACTS.md F1).
 *
 * `clock` is what makes the synthesized `requestId` unique and ordered: v1's
 * `RequestPermissionRequest` carries no request id of its own, and the JSON-RPC id is not visible
 * to a `PermissionResponder`, yet `acp.interaction` and `omni.policy_decision` must agree on one
 * (CONTRACTS.md §7.4).
 */
export function createBaselineResponder(mode: "allow" | "deny", clock: Clock): PermissionResponder {
  const rule = `m0:auto-${mode}`;
  let counter = 0;

  return {
    decide(req: MappedPermissionRequest): PermissionDecision {
      counter += 1;
      // M2 (§5.8.1): the FIELD is an `InteractionId` from now on and every id the daemon MINTS
      // is `x_<ULID>` from `IdGen.interaction()`. This spelling is kept, and cast, on purpose:
      // `baselineInteractions` must produce envelopes BYTE-IDENTICAL to M1's (M2-PLAN §1.3 seam
      // A, WP-I acceptance 1), and `eventEnvelopeSchema` keeps `z.string()` for the field so an
      // M1-era persisted `perm_1757…_3` still parses. M2-A-WP-I mints the real ids in the
      // strategy that WRAPS this responder; this file stays M1.
      const requestId = `perm_${String(clock.now())}_${String(counter)}` as InteractionId;
      const offered = offeredOptions(req);
      const title = titleOf(req);

      // The M1 decision, now expressed through the ONE selector (§20.1). `allowSessionGrants` is
      // `true` because that IS M1's ordering, and this responder must stay byte-identical to it.
      const choice = selectOption(mode, offered, { allowSessionGrants: true });
      const chosen =
        choice.optionId === null
          ? null
          : (offered.find((o) => o.optionId === choice.optionId) ?? null);

      const record: PolicyDecisionPayload = {
        requestId,
        title,
        decision: chosen === null ? "error" : chosen.kind === REJECT_ONCE_KIND ? "deny" : "allow",
        rule,
        optionId: chosen === null ? null : chosen.optionId,
        offered,
        // §13.4: we are the party that denied, so the join back to the tool call is ours to
        // record — never recovered from the agent's English (`rawOutput: "User refused
        // permission to run tool"`). The mapper puts it on the request; M1-WP-B fills it in.
        toolCallId: req.toolCallId,
      };

      // Rule 4: nothing acceptable was offered. `null` is the instruction to the caller to reply
      // with JSON-RPC -32603 — not to invent an option id (rule 1) and not to cancel (rule 5).
      if (chosen === null) return { response: null, record };

      const response: RequestPermissionResponse = {
        outcome: { outcome: "selected", optionId: chosen.optionId },
      };
      return { response, record };
    },
  };
}
