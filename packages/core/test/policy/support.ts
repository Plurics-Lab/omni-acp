import {
  AcpRequestError,
  type EventInput,
  type InteractionId,
  type InteractionRequest,
  type InteractionStrategy,
  type MappedPermissionRequest,
  type PermissionOption,
  type PolicyEngine,
  type PolicySubject,
  type PolicyVerdict,
  type RequestPermissionResponse,
} from "@omni-acp/protocol";
import { createBaselineResponder, selectOption } from "@omni-acp/core";
import { fakeClock } from "@omni-acp/testkit";
import { policyClampWarning } from "../../src/policy/ceiling.js";

/**
 * The shared fixtures for `core/test/policy/**`.
 *
 * Two of them are load-bearing rather than convenient, and both exist because §20.1's diagram has
 * a box this work package does not own:
 *
 *   InteractionRequest -> toPolicySubject -> PolicyEngine.decide -> selectOption -> the answer
 *
 * The last two arrows are M2-A-WP-I's `InteractionStrategy`, and at the time this file was
 * written that file is a Land stub that throws. So the conformance suite is run against the two
 * strategies spelled out below: `enginePermissionStrategy`, which is the seam-A body with the
 * engine injected, and `baselinePermissionStrategy`, which is M2-PLAN §1.3's published
 * `baselineInteractions` body over M1's real responder. When WP-I lands, both are replaced by the
 * shipped factories and the suite is unchanged — `conformance.test.ts` says so out loud and
 * proves the substitution is pending rather than forgotten.
 *
 * Owned by M2-B-WP-P.
 */

export const OPTION = (optionId: string, kind: string, name = optionId): PermissionOption =>
  ({ optionId, kind, name }) as unknown as PermissionOption;

export const ALLOW_ONCE = OPTION("allow", "allow_once");
export const REJECT_ONCE = OPTION("reject", "reject_once");
export const ALLOW_ALWAYS = OPTION("always", "allow_always");

/** A realpath that resolves nothing: the identity, for the tests that hold no filesystem. */
export const identityRealpath = (p: string): Promise<string> => Promise.resolve(p);

export function subject(over: Partial<PolicySubject> = {}): PolicySubject {
  return {
    method: "session/request_permission",
    type: "tool_call",
    kind: "edit",
    paths: [],
    command: null,
    title: "Write src/main.ts",
    agentId: "fixture",
    cwd: "/repo",
    ...over,
  };
}

export function interactionRequest(over: Partial<InteractionRequest> = {}): InteractionRequest {
  return {
    id: "x_00000000000000000000000001" as InteractionId,
    kind: "permission",
    method: "session/request_permission",
    title: "Write src/main.ts",
    message: null,
    subject: { type: "tool_call", toolCall: { toolCallId: "call_1", kind: "edit", locations: [] } },
    options: [ALLOW_ONCE, REJECT_ONCE],
    fields: [],
    toolCallId: "call_1",
    turnId: null,
    raw: {},
    ...over,
  };
}

/** The v2-mapped permission request the strategies below are handed (ruling M1-R14). */
export function mappedRequest(
  offered: readonly PermissionOption[],
  over: { kind?: string | null; paths?: readonly string[]; title?: string } = {},
): MappedPermissionRequest {
  const kind = over.kind === undefined ? "edit" : over.kind;
  return {
    sessionId: "sess_1",
    title: over.title ?? "Write src/main.ts",
    subject: {
      type: "tool_call",
      toolCall: {
        toolCallId: "call_1",
        title: over.title ?? "Write src/main.ts",
        ...(kind === null ? {} : { kind }),
        locations: (over.paths ?? []).map((path) => ({ path })),
      },
    },
    options: [...offered],
    toolCallId: "call_1",
    raw: {},
  };
}

/** The strategy members that are M2-A-WP-I's lifecycle and not D4's rule set. */
const lifecycleStub = {
  answer(): never {
    throw new Error("not part of D4's rule set");
  },
  get(): null {
    return null;
  },
  get pending(): readonly [] {
    return [];
  },
  settleAll(): Promise<void> {
    return Promise.resolve();
  },
  close(): void {
    /* no timers here */
  },
  elicitation(): Promise<unknown> {
    return Promise.resolve({ action: "decline" });
  },
};

/**
 * M2-PLAN §1.3 seam A, verbatim: M1's responder wrapped, the same two envelopes in the same
 * order, the same `-32603` on rule 4, `clientCapabilities: {}` because this one never parks.
 */
export function baselinePermissionStrategy(mode: "allow" | "deny"): InteractionStrategy {
  const responder = createBaselineResponder(mode, fakeClock());
  return {
    clientCapabilities: {},
    ...lifecycleStub,
    permission(req, ctx): Promise<RequestPermissionResponse> {
      const decided = responder.decide(req);
      const inputs: EventInput[] = [
        {
          kind: "acp.interaction",
          payloadVersion: 2,
          payload: {
            requestId: decided.record.requestId,
            method: "session/request_permission",
            request: { title: req.title, subject: req.subject, options: req.options },
            status: decided.response === null ? "failed" : "answered",
            answer: { optionId: decided.record.optionId, by: "baseline" },
          },
        },
        { kind: "omni.policy_decision", payloadVersion: 2, payload: decided.record },
      ];
      ctx.emit(inputs);
      if (decided.response === null) {
        return Promise.reject(
          AcpRequestError.internalError(
            { offered: decided.record.offered },
            "no acceptable permission option was offered",
          ),
        );
      }
      return Promise.resolve(decided.response);
    },
  };
}

/**
 * The seam-A strategy with the ENGINE injected: `decide(subject)` decides WHAT, `selectOption`
 * decides WHICH, and rule 4's `-32603` is what happens when the menu has nothing selectable.
 *
 * `park` and `fail` verdicts are answered as `deny` here, because this file tests D4's rule set
 * and not WP-I's park lifecycle; the conformance suite never parks and says so.
 */
export function enginePermissionStrategy(
  engine: PolicyEngine,
  o: { readonly cwd?: string; readonly agentId?: string } = {},
): InteractionStrategy & { readonly clampedVerdicts: readonly PolicyVerdict[] } {
  let counter = 0;
  const clamped: PolicyVerdict[] = [];
  return {
    clientCapabilities: {},
    ...lifecycleStub,
    /** The clamped verdicts this strategy saw, so a test can assert the clamp was not silent. */
    get clampedVerdicts(): readonly PolicyVerdict[] {
      return clamped;
    },
    permission(req, ctx): Promise<RequestPermissionResponse> {
      counter += 1;
      const toolCall = ((req.subject ?? {}) as { toolCall?: Record<string, unknown> }).toolCall;
      const locations = Array.isArray(toolCall?.["locations"]) ? toolCall["locations"] : [];
      const s = subject({
        method: "session/request_permission",
        type: "tool_call",
        kind: typeof toolCall?.["kind"] === "string" ? (toolCall["kind"] as string) : null,
        paths: (locations as { path?: unknown }[])
          .map((l) => l.path)
          .filter((p): p is string => typeof p === "string"),
        title: req.title,
        cwd: o.cwd ?? "/repo",
        agentId: o.agentId ?? "fixture",
      });
      const verdict: PolicyVerdict = engine.decide(s);
      const action = verdict.action === "allow" ? "allow" : "deny";
      const offered = Array.isArray(req.options) ? req.options : [];
      const choice = selectOption(action, offered, { allowSessionGrants: true });
      const chosen = offered.find((x) => x.optionId === choice.optionId) ?? null;
      // The clamp's `TurnWarning` is `policyClampWarning`'s and rides on the turn's `_meta`
      // channel, which is `turn-lifecycle.ts`'s business and not a strategy's; `ceiling.test.ts`
      // asserts it directly. What belongs on the DECISION is `clamped`, and it is below.
      if (policyClampWarning(verdict) !== null) clamped.push(verdict);

      ctx.emit([
        {
          kind: "omni.policy_decision",
          payloadVersion: 2,
          payload: {
            requestId: `x_${String(counter)}` as InteractionId,
            kind: "permission",
            method: "session/request_permission",
            title: req.title,
            decision: chosen === null ? "error" : chosen.kind === "reject_once" ? "deny" : "allow",
            by: "policy",
            rule: verdict.rule,
            ruleSource: verdict.source,
            ...(verdict.clamped === null ? {} : { clamped: verdict.clamped }),
            optionId: chosen === null ? null : chosen.optionId,
            offered,
            toolCallId: req.toolCallId,
          },
        },
      ]);

      if (chosen === null) {
        return Promise.reject(
          AcpRequestError.internalError({ offered }, "no acceptable permission option was offered"),
        );
      }
      return Promise.resolve({ outcome: { outcome: "selected", optionId: chosen.optionId } });
    },
  };
}
