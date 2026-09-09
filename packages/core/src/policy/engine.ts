import type {
  PolicyCeiling,
  PolicyEngine,
  PolicySnapshot,
  PolicySubject,
  PolicyVerdict,
  ResolvedPolicy,
} from "@omni-acp/protocol";
import { assertWithinCeiling, clampVerdict } from "./ceiling.js";
import { compileRule, matchCompiled, type CompiledRule } from "./match.js";

/**
 * D4's rule engine. PURE and TOTAL: the same subject in yields a deep-equal verdict out, a
 * thousand times over, with no clock and no I/O.
 *
 * It decides WHAT, never WHICH option id. Option selection stays in `permission-responder.ts`'s
 * `selectOption`, the one place D4 rules 1-6 live, and that separation is what makes it
 * structurally impossible for this package to break rule 3 (never select a persisted "always"
 * grant) by editing the engine.
 *
 * The `policy-never-names-an-option` guard enforces it BYTE-WISE over this whole directory -
 * comments included, with no comment-stripping pass - which is why the paragraph above spells
 * none of the five forbidden words (ruling M2-R16, settled by review follow-up 7). It is
 * demonstrated FAILING on a planted literal.
 *
 * There is deliberately no `title` / `name` matcher anywhere below it (F27): an agent's prose is
 * not a security predicate, and `no-agent-prose` forbids adding one.
 *
 * ── WHERE THE CEILING SITS ──────────────────────────────────────────────────────────────────
 *
 * Both halves of §20.5 are wired here, which is why they cannot be forgotten by a caller: the
 * static check runs ONCE at construction, so an engine that exceeds its ceiling cannot be built;
 * and every verdict is clamped for the ACTUAL subject on the way out, because the static half is
 * explicitly incomplete. A clamp is never silent - it lands as `clamped {from, by}` on the
 * verdict and `policyClampWarning` turns it into the `TurnWarning` the turn carries.
 *
 * Owned by M2-B-WP-P.
 */
export interface PolicyEngineOptions {
  readonly policy: ResolvedPolicy;
  readonly ceiling: PolicyCeiling | null;
  readonly id: string;
  /**
   * The ceiling's NAME, for `PolicySnapshot.ceiling` and for the `403` body. Optional because
   * §5.8.9's signature is `{policy, ceiling, id}`; the daemon passes the token's name.
   */
  readonly ceilingName?: string;
  /**
   * `CreateWorkerRequest.onUnresolved`, recorded on the snapshot and checked against
   * `PolicyCeiling.park` (review R6's third refusal). Optional for the same reason.
   */
  readonly onUnresolved?: "park" | "deny" | "fail";
}

export function createPolicyEngine(o: PolicyEngineOptions): PolicyEngine {
  const { policy, ceiling, id } = o;
  const ceilingName = o.ceilingName ?? null;
  const onUnresolved = o.onUnresolved ?? "deny";

  // Compile FIRST: a rule that can never fire is dead policy an operator will plan around, and
  // §20.3 puts both refusals (M2-R17's path-only rule, M2-R18's cmd on a tool call) at load.
  const compiled: readonly CompiledRule[] = policy.rules.map((r) => compileRule(r));

  if (ceiling !== null) {
    assertWithinCeiling(policy, ceiling, {
      ...(ceilingName === null ? {} : { name: ceilingName }),
      onUnresolved,
    });
  }

  const snapshot: PolicySnapshot = Object.freeze({
    sources: Object.freeze([...policy.sources]),
    default: policy.default,
    onUnresolved,
    ruleCount: policy.rules.length,
    ceiling: ceiling === null ? null : (ceilingName ?? "policyCeiling"),
  });

  /** Which layer wrote a rule, read back off the prefix `resolvePolicySelection` stamped. */
  const sourceOf = (ruleId: string): PolicyVerdict["source"] =>
    ruleId.startsWith("inline:") ? "inline" : "preset";

  return {
    id,
    snapshot,
    decide(s: PolicySubject): PolicyVerdict {
      // FIRST MATCH WINS, over rules already ordered last-applied-first by
      // `resolvePolicySelection` - which is what lets an inline rule narrow a preset (§20.2).
      let verdict: PolicyVerdict | null = null;
      for (const c of compiled) {
        if (!matchCompiled(c, s)) continue;
        verdict = {
          action: c.rule.action,
          rule: `${id}#${c.rule.id}`,
          source: sourceOf(c.rule.id),
          clamped: null,
        };
        break;
      }
      verdict ??= {
        action: policy.default,
        rule: `${id}#default`,
        source: "default",
        clamped: null,
      };
      if (ceiling === null) return verdict;
      return clampVerdict(verdict, ceiling, s, {
        ...(ceilingName === null ? {} : { name: ceilingName }),
      });
    },
  };
}
