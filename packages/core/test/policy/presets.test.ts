import { describe, expect, it } from "vitest";
import { OmniError, PolicyPreset, PolicySelection } from "@omni-acp/protocol";
import { BUILTIN_POLICIES, createPolicyEngine, resolvePolicySelection } from "@omni-acp/core";
import { READONLY_CONTAINED } from "../../src/policy/presets.js";
import { subject } from "./support.js";

/**
 * §20.4's shipped presets, and §20.2's merge.
 *
 * "Data, not code" is asserted rather than described: every preset round-trips through JSON and
 * back through `PolicyPreset` — the SAME schema an operator's `policy.presets:` block goes
 * through — so nothing in them is reachable only from TypeScript. The YAML door itself is
 * exercised in `tests/integration/src/policy-ceiling.itest.ts`, because D15 constraint 3 puts
 * YAML in `@omni-acp/cli` and nowhere else.
 *
 * Owned by M2-B-WP-P.
 */

const PRESETS = { ...BUILTIN_POLICIES };

/**
 * The selection goes through `PolicySelection.parse` on the way in, because that is the ONLY way
 * one ever arrives: `CreateWorkerRequest.policy` is parsed at the route, and the parse is what
 * applies `PolicyMatch`'s own `subject:"any"` / `method:"any"` defaults. A test that handed the
 * resolver a raw object would be testing a shape production never produces.
 */
const resolve = (sel: unknown, fallback = "deny-all") =>
  resolvePolicySelection(
    sel === undefined ? undefined : (PolicySelection.parse(sel) as PolicySelection),
    PRESETS,
    fallback,
  );
const engineFor = (sel: unknown) => {
  const policy = resolve(sel);
  return createPolicyEngine({ policy, ceiling: null, id: policy.id });
};

describe("BUILTIN_POLICIES — data, not code (§20.4)", () => {
  it("is exactly §20.4's four documents, plus the contained variant it names", () => {
    expect(Object.keys(PRESETS).sort()).toEqual([
      "deny-all",
      "full",
      "readonly",
      "readonly-contained",
      "src-edit",
    ]);

    expect(PRESETS["deny-all"]).toEqual(PolicyPreset.parse({ default: "deny" }));
    expect(PRESETS.readonly.default).toBe("deny");
    expect(PRESETS.readonly.rules.map((r) => [r.id, r.action, r.match.kind])).toEqual([
      ["r1", "allow", ["read", "search", "think", "fetch"]],
    ]);
    expect(PRESETS["src-edit"].extends).toBe("readonly");
    expect(PRESETS["src-edit"].default).toBe("park");
    expect(PRESETS["src-edit"].rules.map((r) => [r.id, r.action])).toEqual([
      ["e1", "allow"],
      ["d1", "deny"],
      ["c1", "allow"],
    ]);
    expect(PRESETS["src-edit"].rules[0]?.match.path).toEqual(["src/**", "test/**", "tests/**"]);
    expect(PRESETS["src-edit"].rules[2]?.match.cmd).toBe("(pnpm|npm) (test|run build)");
    expect(PRESETS.full.default).toBe("allow");
    expect(PRESETS.full.rules.map((r) => [r.id, r.action, r.match.kind])).toEqual([
      ["p1", "park", ["delete"]],
    ]);
  });

  it("is DATA: every preset survives a JSON round trip through the operator's own schema", () => {
    for (const [name, preset] of Object.entries(PRESETS)) {
      const throughJson: unknown = JSON.parse(JSON.stringify(preset));
      expect(PolicyPreset.parse(throughJson), name).toEqual(preset);
    }
  });

  it("is frozen, so a caller cannot mutate the shipped documents out from under another worker", () => {
    expect(Object.isFrozen(PRESETS === BUILTIN_POLICIES ? PRESETS : BUILTIN_POLICIES)).toBe(true);
  });

  it("readonly-contained is DERIVED from readonly, so the two cannot drift", () => {
    expect(READONLY_CONTAINED.rules.map((r) => r.id)).toEqual(
      PRESETS.readonly.rules.map((r) => r.id),
    );
    for (const r of READONLY_CONTAINED.rules) {
      if (r.action !== "allow") continue;
      expect(r.match.path, "every allow rule is path-scoped").toEqual(["**"]);
    }
  });
});

describe("readonly never allows edit / delete / execute — a property, not four examples", () => {
  const engine = engineFor("readonly");
  const KINDS = [
    "read",
    "search",
    "think",
    "fetch",
    "edit",
    "delete",
    "execute",
    "move",
    "switch_mode",
    "other",
    "mcp__vendor__thing",
    "Edit",
    "EDIT",
    "eDiT",
    " edit",
    "edit ",
  ];
  const WRITEISH = new Set(["edit", "delete", "execute"]);
  const TYPES = ["tool_call", "command", "elicitation", "terminal"];
  const PATHS = [
    [],
    ["/repo/src/main.ts"],
    ["/etc/passwd"],
    ["/repo/src/a.ts", "/etc/shadow"],
    ["/repo/README.md"],
  ];

  it("over 10 000 generated subjects, no write-ish kind is ever allowed", () => {
    let state = 0x1234_5678;
    const next = (n: number): number => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state % n;
    };
    let allowed = 0;
    for (let i = 0; i < 10_000; i++) {
      const kind = KINDS[next(KINDS.length)] as string;
      const s = subject({
        type: TYPES[next(TYPES.length)] as string,
        kind,
        paths: PATHS[next(PATHS.length)] as string[],
        command: next(2) === 0 ? null : "rm -rf /",
        method: next(2) === 0 ? "session/request_permission" : "elicitation/create",
      });
      const action = engine.decide(s).action;
      if (action === "allow") {
        allowed += 1;
        expect(WRITEISH.has(kind), `readonly allowed a "${kind}"`).toBe(false);
      }
    }
    // ...and the run is not vacuous: `readonly` DOES allow the four read-ish kinds, so a
    // permanently-denying engine could not pass this test by accident.
    expect(allowed).toBeGreaterThan(0);
  });

  it("the exfiltration hazard is documented WITH its citation, in presets.ts", async () => {
    // Acceptance 7's other half: the hazard cannot be fixed by a rule, so the requirement is that
    // the file SAYS so and names the recording. A comment nobody checks is a comment that rots.
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const source = await readFile(join(here, "..", "..", "src", "policy", "presets.ts"), "utf8");
    expect(source).toContain("F37");
    expect(source).toContain("F40");
    expect(source).toContain("OUTSIDE-SECRET-BETA");
    expect(source).toContain("READONLY_CONTAINED");
  });

  it("readonly-contained closes the half a rule CAN close: a read naming no path is denied", () => {
    const contained = createPolicyEngine({
      policy: resolvePolicySelection("readonly-contained", PRESETS, "deny-all"),
      ceiling: null,
      id: "rc",
    });
    const noPaths = subject({ kind: "read", paths: [] });
    const withPath = subject({ kind: "read", paths: ["/repo/src/main.ts"] });

    expect(engine.decide(noPaths).action, "plain readonly auto-allows it").toBe("allow");
    expect(contained.decide(noPaths).action, "contained does not").toBe("deny");
    expect(contained.decide(withPath).action).toBe("allow");
  });
});

describe("resolvePolicySelection — extends, cycles and the merge order (§20.2)", () => {
  it("extends resolves transitively, BASE FIRST, and sources names every layer in order", () => {
    const resolved = resolve("src-edit");
    expect(resolved.sources).toEqual(["readonly", "src-edit"]);
    expect(resolved.default, "the extending preset's own default wins").toBe("park");
    expect(resolved.rules.map((r) => r.id)).toEqual([
      "src-edit:e1",
      "src-edit:d1",
      "src-edit:c1",
      "readonly:r1",
    ]);
  });

  it("a cycle is a LOAD error naming the chain, never a hang", () => {
    const cyclic = {
      a: PolicyPreset.parse({ extends: "b", default: "deny" }),
      b: PolicyPreset.parse({ extends: "a", default: "deny" }),
      self: PolicyPreset.parse({ extends: "self", default: "deny" }),
    };
    for (const name of ["a", "self"]) {
      expect(() => resolvePolicySelection(name, cyclic, "a"), name).toThrowError(OmniError);
    }
    try {
      resolvePolicySelection("a", cyclic, "a");
    } catch (e) {
      expect(OmniError.is(e, "bad_request")).toBe(true);
      expect((e as OmniError).message).toContain("a -> b -> a");
    }
  });

  it("an unknown preset name is a bad_request NAMING it — including through extends", () => {
    expect(() => resolve("nope")).toThrowError(OmniError);
    try {
      resolve("nope");
    } catch (e) {
      expect((e as OmniError).message).toContain('"nope"');
    }
    const dangling = { x: PolicyPreset.parse({ extends: "missing", default: "deny" }) };
    expect(() => resolvePolicySelection("x", dangling, "x")).toThrowError(OmniError);
  });

  it("preset (+) inline is INLINE LAST-WINS, which means inline is consulted FIRST", () => {
    const resolved = resolve({
      presets: ["src-edit"],
      rules: [{ id: "x1", match: { kind: ["edit"], path: ["src/**"] }, action: "deny" }],
    });
    expect(resolved.sources).toEqual(["readonly", "src-edit", "inline"]);
    expect(resolved.rules[0]?.id, "the last-applied layer is the first consulted").toBe(
      "inline:x1",
    );

    // And the point of the ordering: inline NARROWS the preset's grant.
    const engine = createPolicyEngine({ policy: resolved, ceiling: null, id: resolved.id });
    const write = subject({ kind: "edit", paths: ["/repo/src/main.ts"] });
    expect(engine.decide(write).action).toBe("deny");
    expect(engineFor("src-edit").decide(write).action, "which the preset alone allowed").toBe(
      "allow",
    );
  });

  it("an inline default overrides the preset's; an absent one keeps it", () => {
    expect(resolve({ presets: ["src-edit"], default: "fail" }).default).toBe("fail");
    expect(resolve({ presets: ["src-edit"], rules: [] }).default).toBe("park");
  });

  it("a LIST of presets applies left to right, so the last one named wins", () => {
    const resolved = resolve(["readonly", "full"]);
    expect(resolved.sources).toEqual(["readonly", "full"]);
    expect(resolved.default).toBe("allow");
    expect(resolved.rules.map((r) => r.id)).toEqual(["full:p1", "readonly:r1"]);
  });

  it("a repeated layer is applied ONCE, at its LAST position", () => {
    const resolved = resolve(["readonly", "src-edit"]);
    // `src-edit` extends `readonly`, so `readonly` appears twice in the expansion; keeping the
    // later one is what makes "later wins" true for a preset that is also somebody's base.
    expect(resolved.sources).toEqual(["readonly", "src-edit"]);
    expect(resolved.rules.filter((r) => r.id === "readonly:r1")).toHaveLength(1);
  });

  it("rule ids are PREFIXED by their layer, which is what lets a verdict name its source", () => {
    const resolved = resolve({
      presets: ["readonly"],
      rules: [{ id: "r1", match: { kind: ["edit"] }, action: "deny" }],
    });
    expect(resolved.rules.map((r) => r.id)).toEqual(["inline:r1", "readonly:r1"]);
    const engine = createPolicyEngine({ policy: resolved, ceiling: null, id: "p" });
    expect(engine.decide(subject({ kind: "edit" })).source).toBe("inline");
    expect(engine.decide(subject({ kind: "read" })).source).toBe("preset");
  });

  it("a duplicate rule id WITHIN one layer is a load error, not a silent shadow", () => {
    expect(() =>
      resolve({
        rules: [
          { id: "x", match: { kind: ["edit"] }, action: "allow" },
          { id: "x", match: { kind: ["read"] }, action: "deny" },
        ],
      }),
    ).toThrowError(OmniError);
  });

  it("an absent or EMPTY selection falls to the daemon's configured default preset", () => {
    expect(resolve(undefined).sources).toEqual(["deny-all"]);
    expect(resolve([]).sources).toEqual(["deny-all"]);
    expect(resolve({ rules: [] }).sources, "an inline doc with nothing in it").toEqual([
      "deny-all",
    ]);
    // An inline-only document still gets the configured base, so it NARROWS something rather
    // than starting from nowhere.
    const inlineOnly = resolve({
      rules: [{ id: "x", match: { kind: ["read"] }, action: "allow" }],
    });
    expect(inlineOnly.sources).toEqual(["deny-all", "inline"]);
    expect(inlineOnly.default).toBe("deny");
  });

  it("alertOnUnpoliced is a UNION over the layers, so a later one cannot silence an earlier", () => {
    const custom = {
      ...PRESETS,
      base: PolicyPreset.parse({ default: "deny", alertOnUnpoliced: ["execute"] }),
      quiet: PolicyPreset.parse({ extends: "base", default: "deny", alertOnUnpoliced: ["delete"] }),
    };
    const resolved = resolvePolicySelection("quiet", custom, "deny-all");
    expect([...resolved.alertOnUnpoliced].sort()).toEqual(["delete", "execute"]);
  });

  it("the id names the layers, so two workers on the same document share one engine id", () => {
    expect(resolve("src-edit").id).toBe("readonly+src-edit");
    expect(
      resolve({
        presets: ["readonly"],
        rules: [{ id: "x", match: { kind: ["*"] }, action: "deny" }],
      }).id,
    ).toBe("readonly+inline");
  });
});
