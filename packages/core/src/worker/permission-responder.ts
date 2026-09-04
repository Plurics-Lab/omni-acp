import {
  type Clock,
  type MappedPermissionRequest,
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

/** The one kind that is never selected, whatever else is true about the option (D4 rule 3). */
const FORBIDDEN_KIND = "allow_always";

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
function offeredOptions(req: MappedPermissionRequest): readonly PermissionOption[] {
  const raw: unknown = req.options;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (o): o is PermissionOption =>
      typeof o === "object" &&
      o !== null &&
      typeof (o as { optionId?: unknown }).optionId === "string" &&
      typeof (o as { kind?: unknown }).kind === "string",
  );
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
function pickAllow(options: readonly PermissionOption[]): PermissionOption | null {
  const sessionGrant = options.find(
    (o) => SESSION_GRANT_OPTION_IDS.has(o.optionId) && selectableGrant(o),
  );
  if (sessionGrant !== undefined) return sessionGrant;
  return options.find((o) => o.kind === ALLOW_ONCE_KIND) ?? null;
}

/** D4 rule 4's first half: deny means the offered `reject_once`, and nothing else. */
function pickDeny(options: readonly PermissionOption[]): PermissionOption | null {
  return options.find((o) => o.kind === REJECT_ONCE_KIND) ?? null;
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
      const requestId = `perm_${String(clock.now())}_${String(counter)}`;
      const offered = offeredOptions(req);
      const title = titleOf(req);

      // Rule 2 downgrades to deny when no acceptable grant is offered — never to "cancelled"
      // (rule 5), which would cancel the whole prompt turn rather than this one action.
      const chosen =
        mode === "allow" ? (pickAllow(offered) ?? pickDeny(offered)) : pickDeny(offered);

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
