import { describe, expect, it } from "vitest";
import {
  ERROR_STATUS,
  OmniError,
  POLICY_ACTIONS,
  PolicyCeiling,
  PolicyRule,
  type PolicyAction,
  type PolicySubject,
  type PolicyVerdict,
  type ResolvedPolicy,
} from "@omni-acp/protocol";
import { assertWithinCeiling, clampVerdict } from "@omni-acp/core";
import { ACTION_RANK, dominates, policyClampWarning } from "../../src/policy/ceiling.js";
import { subject } from "./support.js";

/**
 * §20.5, both halves. The static check is decidable, total and names its offenders; the clamp
 * recovers the precision the static check provably cannot have, and it is never silent.
 *
 * Owned by M2-B-WP-P.
 */

const ceiling = (over: Record<string, unknown> = {}): PolicyCeiling => PolicyCeiling.parse(over);

const doc = (over: Partial<ResolvedPolicy> = {}): ResolvedPolicy => ({
  id: "p",
  sources: ["p"],
  default: "deny",
  rules: [],
  alertOnUnpoliced: [],
  ...over,
});

const rule = (
  id: string,
  match: Record<string, unknown>,
  action: PolicyAction = "allow",
): PolicyRule => PolicyRule.parse({ id, match, action });

const refusal = (d: ResolvedPolicy, c: PolicyCeiling, name?: string): OmniError => {
  try {
    assertWithinCeiling(d, c, name === undefined ? undefined : { name });
  } catch (e) {
    return e as OmniError;
  }
  throw new Error("assertWithinCeiling accepted a document it should have refused");
};

describe("the action lattice (§20.5)", () => {
  it("fail and deny rank EQUAL: neither grants anything", () => {
    expect(ACTION_RANK.fail).toBe(ACTION_RANK.deny);
    expect(ACTION_RANK.park).toBeGreaterThan(ACTION_RANK.deny);
    expect(ACTION_RANK.allow).toBeGreaterThan(ACTION_RANK.park);
  });

  it("dominates is a complete 4x4 table, and a TIE resolves to the policy", () => {
    const expected: Record<PolicyAction, Record<PolicyAction, boolean>> = {
      deny: { deny: true, fail: true, park: false, allow: false },
      fail: { deny: true, fail: true, park: false, allow: false },
      park: { deny: true, fail: true, park: true, allow: false },
      allow: { deny: true, fail: true, park: true, allow: true },
    };
    for (const c of POLICY_ACTIONS) {
      for (const a of POLICY_ACTIONS) {
        expect(dominates(c, a), `ceiling ${c} vs action ${a}`).toBe(expected[c][a]);
      }
    }
    // The tie, stated: a ceiling of `deny` accepts a policy that says `fail`, and a ceiling of
    // `fail` accepts a policy that says `deny`. Neither is lowered, because neither grants.
    expect(dominates("deny", "fail")).toBe(true);
    expect(dominates("fail", "deny")).toBe(true);
  });
});

describe("assertWithinCeiling — total, decidable, and it NAMES the offenders", () => {
  it("accepts a document that fits, and the widest ceiling accepts everything", () => {
    expect(() =>
      assertWithinCeiling(
        doc({ default: "allow", rules: [rule("r1", { kind: ["edit"] })] }),
        ceiling(),
      ),
    ).not.toThrow();
  });

  it("throws 403 policy_exceeds_ceiling carrying body.policy.{ceiling, offending}", () => {
    const e = refusal(
      doc({ rules: [rule("r1", { kind: ["edit"] }, "allow")] }),
      ceiling({ maxAction: "deny" }),
      "token:tok_a",
    );
    expect(e.code).toBe("policy_exceeds_ceiling");
    expect(e.status).toBe(403);
    expect(ERROR_STATUS.policy_exceeds_ceiling).toBe(403);
    expect(e.toBody().policy).toEqual({
      ceiling: "token:tok_a",
      offending: ['p#r1: action "allow" exceeds maxAction "deny"'],
    });
  });

  it("maxAction is checked per RULE and for the DEFAULT", () => {
    expect(
      refusal(doc({ default: "allow" }), ceiling({ maxAction: "park" })).policy?.offending,
    ).toEqual(['p#default: action "allow" exceeds maxAction "park"']);
    const both = refusal(
      doc({ default: "allow", rules: [rule("r1", { kind: ["edit"] }, "park")] }),
      ceiling({ maxAction: "deny" }),
    );
    expect(both.policy?.offending).toHaveLength(2);
  });

  it("every allow rule's kinds must be a SUBSET of allowKinds", () => {
    const c = ceiling({ allowKinds: ["read", "search"] });
    expect(() =>
      assertWithinCeiling(doc({ rules: [rule("r1", { kind: ["read"] })] }), c),
    ).not.toThrow();
    expect(
      refusal(doc({ rules: [rule("r1", { kind: ["read", "edit"] })] }), c).policy?.offending,
    ).toEqual(['p#r1: kind "edit" is not in allowKinds']);
    // An allow rule with NO kind clause, and one on `["*"]`, are both unbounded.
    expect(
      refusal(doc({ rules: [rule("r1", { path: ["src/**"], subject: "tool_call" })] }), c).policy
        ?.offending[0],
    ).toContain("no kind clause is unbounded");
    expect(
      refusal(doc({ rules: [rule("r1", { kind: ["*"] })] }), c).policy?.offending[0],
    ).toContain("every kind exceeds allowKinds");
    // A DENY rule may name any kind it likes: it grants nothing.
    expect(() =>
      assertWithinCeiling(doc({ rules: [rule("r1", { kind: ["edit"] }, "deny")] }), c),
    ).not.toThrow();
  });

  it("no rule ABOVE deny may touch a denyKind", () => {
    const c = ceiling({ denyKinds: ["delete"] });
    expect(
      refusal(doc({ rules: [rule("r1", { kind: ["delete"] }, "allow")] }), c).policy?.offending,
    ).toEqual(['p#r1: kind "delete" is a denyKind']);
    expect(
      refusal(doc({ rules: [rule("r1", { kind: ["delete"] }, "park")] }), c).policy?.offending,
    ).toEqual(['p#r1: kind "delete" is a denyKind']);
    // `deny` and `fail` are AT the floor, so they may name it.
    for (const action of ["deny", "fail"] as const) {
      expect(() =>
        assertWithinCeiling(doc({ rules: [rule("r1", { kind: ["delete"] }, action)] }), c),
      ).not.toThrow();
    }
    // An unbounded grant reaches every kind, including the denied one.
    expect(
      refusal(doc({ rules: [rule("r1", { kind: ["*"] }, "allow")] }), c).policy?.offending[0],
    ).toContain("can reach denyKinds");
  });

  it("every path glob's non-wildcard HEAD must be lexically inside a pathRoot", () => {
    const c = ceiling({ pathRoots: ["src"] });
    expect(() =>
      assertWithinCeiling(doc({ rules: [rule("r1", { kind: ["edit"], path: ["src/**"] })] }), c),
    ).not.toThrow();
    expect(
      refusal(doc({ rules: [rule("r1", { kind: ["edit"], path: ["test/**"] })] }), c).policy
        ?.offending[0],
    ).toContain('path glob "test/**" has head "test/"');
    // The doc's own illustration: `**` has an EMPTY head, so it is refused statically. Failing
    // closed here is strictly better than leaving it to the clamp, and the clamp still proves
    // itself on a pattern the head test provably cannot see (below).
    expect(
      refusal(doc({ rules: [rule("r1", { kind: ["edit"], path: ["**"] })] }), c).policy
        ?.offending[0],
    ).toContain('head ""');
  });

  it("an UNSCOPED allow rule is contained only when the ceiling has NO pathRoots at all", () => {
    const scoped = ceiling({ pathRoots: ["src"] });
    expect(
      refusal(doc({ rules: [rule("r1", { kind: ["edit"] }, "allow")] }), scoped).policy
        ?.offending[0],
    ).toContain("no path clause is unscoped");
    // A park/deny rule may stay unscoped: refusing it would refuse a document strictly safer
    // than the ceiling.
    for (const action of ["park", "deny", "fail"] as const) {
      expect(() =>
        assertWithinCeiling(doc({ rules: [rule("r1", { kind: ["edit"] }, action)] }), scoped),
      ).not.toThrow();
    }
    expect(() =>
      assertWithinCeiling(doc({ rules: [rule("r1", { kind: ["edit"] }, "allow")] }), ceiling()),
    ).not.toThrow();
  });

  it("a DEFAULT of allow is unscoped too — the fallthrough cannot carry a clause", () => {
    for (const c of [
      ceiling({ pathRoots: ["src"] }),
      ceiling({ allowKinds: ["read"] }),
      ceiling({ denyKinds: ["delete"] }),
    ]) {
      expect(refusal(doc({ default: "allow" }), c).policy?.offending[0]).toContain(
        'default of "allow" is unscoped',
      );
    }
    expect(() => assertWithinCeiling(doc({ default: "allow" }), ceiling())).not.toThrow();
  });

  it("subject:command is refused when commands:false — through either spelling", () => {
    const c = ceiling({ commands: false });
    expect(
      refusal(doc({ rules: [rule("r1", { subject: "command", kind: ["*"] })] }), c).policy
        ?.offending[0],
    ).toContain("commands:false");
    expect(
      refusal(doc({ rules: [rule("r1", { cmd: "pnpm test" })] }), c).policy?.offending[0],
    ).toContain("commands:false");
  });

  it("park:false refuses ALL THREE of §20.5's things, each named (review R6)", () => {
    const c = ceiling({ park: false });
    const e = refusal(
      doc({ default: "park", rules: [rule("r1", { kind: ["delete"] }, "park")] }),
      c,
    );
    // Only two of the three live in a document; the third is on the create request.
    expect(e.policy?.offending).toEqual([
      'p#default: a default of "park" is refused by park:false',
      'p#r1: a rule action of "park" is refused by park:false',
    ]);

    let withRequest: OmniError | null = null;
    try {
      assertWithinCeiling(doc(), c, { onUnresolved: "park" });
    } catch (err) {
      withRequest = err as OmniError;
    }
    expect(withRequest?.policy?.offending).toEqual([
      'request#onUnresolved: "park" is refused by park:false',
    ]);

    // ...and the hole review R6 records: the SHIPPED `src-edit` preset has `default: "park"`, so
    // checking only the create request would have let a preset drive a `park:false` token into
    // `requires_action` and hold a maxWorkers slot indefinitely.
    expect(() =>
      assertWithinCeiling(doc({ default: "park" }), c, { onUnresolved: "deny" }),
    ).toThrow();
  });

  it("names EVERY offender, not the first — an operator fixes one round trip, not five", () => {
    const e = refusal(
      doc({
        default: "allow",
        rules: [
          rule("r1", { kind: ["edit", "delete"], path: ["test/**"] }, "allow"),
          rule("r2", { subject: "command", kind: ["*"] }, "allow"),
        ],
      }),
      ceiling({ allowKinds: ["read"], denyKinds: ["delete"], pathRoots: ["src"], commands: false }),
    );
    expect(e.policy?.offending.length).toBeGreaterThanOrEqual(5);
    expect(e.message).toContain("exceeds the token's ceiling");
  });

  it("is TOTAL over every action, both defaults and an empty rule set", () => {
    for (const maxAction of POLICY_ACTIONS) {
      for (const def of POLICY_ACTIONS) {
        const run = (): void => {
          assertWithinCeiling(doc({ default: def }), ceiling({ maxAction }));
        };
        // It either returns or throws `policy_exceeds_ceiling`. It never throws anything else,
        // which is what "decidable and total" has to mean at the boundary.
        try {
          run();
        } catch (e) {
          expect(OmniError.is(e, "policy_exceeds_ceiling"), `${maxAction}/${def}`).toBe(true);
        }
      }
    }
  });
});

describe("clampVerdict — the half that makes the pair SOUND (§20.5)", () => {
  const verdict = (action: PolicyAction, over: Partial<PolicyVerdict> = {}): PolicyVerdict => ({
    action,
    rule: "p#r1",
    source: "inline",
    clamped: null,
    ...over,
  });

  const inSrc = (over: Partial<PolicySubject> = {}): PolicySubject =>
    subject({ kind: "edit", paths: ["/repo/src/main.ts"], ...over });

  it("returns the verdict UNCHANGED, by identity, when the ceiling permits it", () => {
    const v = verdict("allow");
    expect(clampVerdict(v, ceiling(), inSrc())).toBe(v);
  });

  it("catches the case the static check PROVABLY cannot: a head inside the root, a glob outside", () => {
    // `src*/**` has head `src`, which IS lexically inside pathRoot `src`, so `assertWithinCeiling`
    // accepts it — and it matches `/repo/src-secrets/keys.txt`, which is not under `/repo/src`.
    const c = ceiling({ pathRoots: ["src"] });
    const escaping = doc({
      rules: [
        PolicyRule.parse({
          id: "r1",
          match: { kind: ["edit"], path: ["src*/**"] },
          action: "allow",
        }),
      ],
    });
    expect(() => assertWithinCeiling(escaping, c), "the static check accepts it").not.toThrow();

    const clamped = clampVerdict(
      verdict("allow"),
      c,
      inSrc({ paths: ["/repo/src-secrets/keys.txt"] }),
    );
    expect(clamped.action).toBe("park");
    expect(clamped.clamped).toEqual({ from: "allow", by: "policyCeiling:pathRoots" });
    expect(clamped.source).toBe("ceiling");
    expect(clamped.rule, "the rule that fired is still named").toBe("p#r1");
  });

  it("and it catches §20.5's own illustration too, when a document like it reaches decide()", () => {
    // `path: ["**"]` under `pathRoots: ["src"]`, as the doc writes it: refused statically here,
    // and clamped at runtime for the actual subject either way.
    const clamped = clampVerdict(
      verdict("allow"),
      ceiling({ pathRoots: ["src"] }),
      inSrc({ paths: ["/etc/passwd"] }),
    );
    expect(clamped.action).not.toBe("allow");
    expect(clamped.clamped?.from).toBe("allow");
  });

  it("is NEVER silent: the clamp is on the verdict AND on the turn", () => {
    const clamped = clampVerdict(
      verdict("allow"),
      ceiling({ pathRoots: ["src"] }),
      inSrc({ paths: ["/etc/passwd"] }),
    );
    const warning = policyClampWarning(clamped);
    expect(warning).not.toBeNull();
    expect(warning?.code).toBe("policy_clamped");
    expect(warning?.source).toBe("policy");
    expect(warning?.detail).toEqual({
      from: "allow",
      to: "park",
      by: "policyCeiling:pathRoots",
      rule: "p#r1",
    });
    expect(policyClampWarning(verdict("allow")), "nothing clamped, nothing said").toBeNull();
  });

  it("park:false clamps a runtime park to DENY — the static refusal and the clamp agree", () => {
    const clamped = clampVerdict(verdict("park"), ceiling({ park: false }), inSrc());
    expect(clamped.action).toBe("deny");
    expect(clamped.clamped).toEqual({ from: "park", by: "policyCeiling:park" });
  });

  it("walks DOWN the lattice one rung at a time, and stops at the first permitted action", () => {
    const scoped = ceiling({ pathRoots: ["src"] });
    const outside = inSrc({ paths: ["/etc/passwd"] });
    expect(clampVerdict(verdict("allow"), scoped, outside).action).toBe("park");
    // ...and when park is ALSO refused, the walk continues to deny rather than stopping.
    expect(
      clampVerdict(verdict("allow"), ceiling({ pathRoots: ["src"], park: false }), outside).action,
    ).toBe("deny");
  });

  it("a ceiling can LOWER an action and can never raise one — deny stays deny under any ceiling", () => {
    for (const c of [ceiling(), ceiling({ maxAction: "allow" }), ceiling({ park: false })]) {
      expect(clampVerdict(verdict("deny"), c, inSrc()).action).toBe("deny");
      expect(clampVerdict(verdict("fail"), c, inSrc()).action, "fail is not lowered either").toBe(
        "fail",
      );
    }
  });

  it("allowKinds, denyKinds and commands each clamp for the ACTUAL subject", () => {
    expect(
      clampVerdict(verdict("allow"), ceiling({ allowKinds: ["read"] }), inSrc()).clamped?.by,
    ).toBe("policyCeiling:allowKinds");
    expect(
      clampVerdict(verdict("allow"), ceiling({ denyKinds: ["edit"] }), inSrc()).clamped?.by,
    ).toBe("policyCeiling:denyKinds");
    expect(
      clampVerdict(
        verdict("allow"),
        ceiling({ commands: false }),
        subject({ type: "command", kind: null, command: "rm -rf /" }),
      ).clamped?.by,
      "a subject:any rule reaching a command is the other case the static check cannot see",
    ).toBe("policyCeiling:commands");
  });

  it("an EMPTY paths under pathRoots is not 'no files touched' — it cannot be shown contained", () => {
    // F38 again, at the clamp: a grant that names no path cannot be proved inside the roots.
    const clamped = clampVerdict(
      verdict("allow"),
      ceiling({ pathRoots: ["src"] }),
      inSrc({ paths: [] }),
    );
    expect(clamped.action).not.toBe("allow");
  });

  it("resolves a RELATIVE pathRoot against the subject's cwd", () => {
    const c = ceiling({ pathRoots: ["src"] });
    expect(clampVerdict(verdict("allow"), c, inSrc({ cwd: "/repo" })).action).toBe("allow");
    expect(clampVerdict(verdict("allow"), c, inSrc({ cwd: "/elsewhere" })).action).not.toBe(
      "allow",
    );
  });

  it("names the ceiling when it is given one", () => {
    const clamped = clampVerdict(
      verdict("allow"),
      ceiling({ park: false, maxAction: "deny" }),
      inSrc(),
      { name: "token:tok_a" },
    );
    expect(clamped.clamped?.by).toBe("token:tok_a:maxAction");
  });

  it("is TOTAL: every action against every ceiling shape yields a permitted action", () => {
    const shapes: readonly PolicyCeiling[] = [
      ceiling(),
      ceiling({ maxAction: "deny" }),
      ceiling({ maxAction: "fail" }),
      ceiling({ maxAction: "park" }),
      ceiling({ park: false }),
      ceiling({ pathRoots: ["src"], allowKinds: ["read"], denyKinds: ["edit"], commands: false }),
    ];
    for (const action of POLICY_ACTIONS) {
      for (const c of shapes) {
        for (const s of [inSrc(), inSrc({ paths: [] }), subject({ type: "command", kind: null })]) {
          const out = clampVerdict(verdict(action), c, s);
          expect(POLICY_ACTIONS).toContain(out.action);
          expect(ACTION_RANK[out.action], "a clamp never widens").toBeLessThanOrEqual(
            ACTION_RANK[action],
          );
        }
      }
    }
  });
});
