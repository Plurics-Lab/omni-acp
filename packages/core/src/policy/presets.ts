import { OmniError, PolicyPreset } from "@omni-acp/protocol";
import type { PolicyRule, ResolvedPolicy, PolicySelection } from "@omni-acp/protocol";

/**
 * D4's four named presets, as DATA.
 *
 * They are written below exactly as §20.4 writes them in YAML and then passed through
 * `PolicyPreset.parse` - the SAME schema an operator's `policy.presets:` block goes through - so
 * "data, not code" is a property of the value rather than a claim about it. A YAML file carrying
 * the identical four documents parses to the identical objects, and
 * `tests/integration/src/policy-ceiling.itest.ts` proves that through the ONE YAML door the
 * architecture has (D15 constraint 3: YAML exists only in `@omni-acp/cli`).
 *
 * `readonly` never allows `edit` / `delete` / `execute` - a property test over 10 000 generated
 * subjects, not four examples.
 *
 * **The hazard, documented here because it is not obvious and cannot be fixed by a rule.** F37:
 * claude-acp expanded an out-of-cwd `resource_link` into a `Read` whose only containment marker
 * was a vendor `_meta` STRING, we answered a one-shot grant, and it echoed `OUTSIDE-SECRET-BETA`.
 * F40 is the other half: a read-only `ls -A` ran with NO permission request at all while
 * `python3 -c ...` in the same cwd raised one, and the split is invisible in the frame. So
 * `readonly` is not "cannot exfiltrate": a `kind:"read"` tool call the agent never asks about
 * reads whatever it likes.
 *
 * The mitigation is NOT in the policy file - it is §26's prompt-content containment, which
 * rejects the link before the prompt is sent. `alertOnUnpoliced` is the answer we have for the
 * calls that never reach the engine (§20.6), and `READONLY_CONTAINED` is the second layer for a
 * deployment that wants one: it adds `path: ["**"]` to every allow rule, which makes `paths`
 * REQUIRED and therefore contained after realpath.
 *
 * Owned by M2-B-WP-P.
 */
const READONLY: PolicyPreset = PolicyPreset.parse({
  default: "deny",
  rules: [{ id: "r1", match: { kind: ["read", "search", "think", "fetch"] }, action: "allow" }],
});

/**
 * §20.4's second layer, spelled out rather than described.
 *
 * `path: ["**"]` matches every absolute path, so it grants nothing new; what it does is make
 * `paths` NON-EMPTY a precondition of the grant (§20.3's all-must-match row). A call whose
 * `locations[]` under-reports to nothing therefore falls to `default: deny` instead of being
 * auto-allowed - which is the whole of F37's read hazard, closed at the policy layer.
 *
 * It is DERIVED from `readonly` rather than copied, so the two cannot drift: a kind added to the
 * read-only grant is contained by construction.
 */
export const READONLY_CONTAINED: PolicyPreset = PolicyPreset.parse({
  default: READONLY.default,
  rules: READONLY.rules.map((r) => ({
    id: r.id,
    action: r.action,
    match: r.action === "allow" ? { ...r.match, path: ["**"] } : { ...r.match },
  })),
});

export const BUILTIN_POLICIES: Readonly<
  Record<"readonly" | "src-edit" | "full" | "deny-all" | "readonly-contained", PolicyPreset>
> = Object.freeze({
  "deny-all": PolicyPreset.parse({ default: "deny" }),
  readonly: READONLY,
  "readonly-contained": READONLY_CONTAINED,
  "src-edit": PolicyPreset.parse({
    extends: "readonly",
    default: "park",
    rules: [
      {
        id: "e1",
        match: { kind: ["edit"], path: ["src/**", "test/**", "tests/**"] },
        action: "allow",
      },
      { id: "d1", match: { kind: ["delete"] }, action: "deny" },
      {
        id: "c1",
        match: { subject: "command", cmd: "(pnpm|npm) (test|run build)" },
        action: "allow",
      },
    ],
  }),
  full: PolicyPreset.parse({
    default: "allow",
    rules: [{ id: "p1", match: { kind: ["delete"] }, action: "park" }],
  }),
});

// -- resolution ---------------------------------------------------------------

interface Layer {
  readonly name: string;
  readonly preset: PolicyPreset;
}

/** `extends`, transitively, BASE FIRST - and a cycle is a config LOAD error, never a hang. */
function expand(
  name: string,
  available: Readonly<Record<string, PolicyPreset>>,
  seen: readonly string[],
): Layer[] {
  if (seen.includes(name)) {
    throw new OmniError(
      "bad_request",
      `policy preset "${name}" extends itself: ${[...seen, name].join(" -> ")}`,
    );
  }
  const preset = available[name];
  if (preset === undefined) {
    throw new OmniError("bad_request", `unknown policy preset "${name}"`);
  }
  const base =
    preset.extends === undefined ? [] : expand(preset.extends, available, [...seen, name]);
  return [...base, { name, preset }];
}

/** Later wins, so an earlier duplicate of the same layer is dropped rather than re-applied. */
function dedupeKeepingLast(layers: readonly Layer[]): Layer[] {
  const out: Layer[] = [];
  for (let i = 0; i < layers.length; i++) {
    const name = (layers[i] as Layer).name;
    if (layers.slice(i + 1).some((l) => l.name === name)) continue;
    out.push(layers[i] as Layer);
  }
  return out;
}

/**
 * `presets ⊕ inline`, inline LAST-WINS, with `extends` resolved and a cycle a LOAD error.
 *
 * ── THE ONE THING TO GET RIGHT ABOUT THE ORDER ──────────────────────────────────────────────
 *
 * §20.2 says two things that only fit together one way: layers are applied left to right with
 * INLINE LAST, and the engine takes the FIRST MATCH. So the last-applied layer has to come FIRST
 * in `rules`, and `rules` is emitted in reverse application order: inline, then the last named
 * preset, then the one before it, and within a preset its own rules before the ones it extends.
 * That is what makes "inline rules can narrow a preset and can never widen it" true - if inline
 * came last in a first-match list it could never narrow anything at all.
 *
 * Rule ids are PREFIXED with the layer that wrote them (`"readonly:r1"`, `"inline:x1"`), which is
 * how `PolicyVerdict.source` can say which layer a verdict came from: `ResolvedPolicy` carries no
 * per-rule provenance and it is a frozen protocol type. It also makes two presets that both call
 * a rule `r1` unambiguous instead of silently shadowed.
 *
 * `PolicySnapshot.sources` then names every layer in APPLICATION order, so an operator reads what
 * was actually in force rather than reconstructing it.
 *
 * Owned by M2-B-WP-P.
 */
export function resolvePolicySelection(
  sel: PolicySelection | undefined,
  available: Readonly<Record<string, PolicyPreset>>,
  fallback: string,
): ResolvedPolicy {
  let names: readonly string[];
  let inlineDefault: ResolvedPolicy["default"] | undefined;
  let inlineRules: readonly PolicyRule[] = [];

  if (sel === undefined) {
    names = [fallback];
  } else if (typeof sel === "string") {
    names = [sel];
  } else if (Array.isArray(sel)) {
    // An explicitly EMPTY list cannot mean "no policy at all": a worker with no document has no
    // default to fall to, so it falls to the daemon's configured one. Fail closed.
    names = sel.length === 0 ? [fallback] : sel;
  } else {
    const doc = sel;
    names = doc.presets === undefined || doc.presets.length === 0 ? [fallback] : doc.presets;
    inlineDefault = doc.default;
    inlineRules = doc.rules ?? [];
  }

  const applied = dedupeKeepingLast(names.flatMap((n) => expand(n, available, [])));
  const hasInline = inlineDefault !== undefined || inlineRules.length > 0;

  const prefix = (layer: string, rules: readonly PolicyRule[]): PolicyRule[] => {
    const seen = new Set<string>();
    return rules.map((r) => {
      if (seen.has(r.id)) {
        throw new OmniError(
          "bad_request",
          `policy layer "${layer}" declares rule id "${r.id}" twice`,
        );
      }
      seen.add(r.id);
      return { ...r, id: `${layer}:${r.id}` };
    });
  };

  // Reverse application order: the layer applied LAST is consulted FIRST.
  const rules: PolicyRule[] = [
    ...(hasInline ? prefix("inline", inlineRules) : []),
    ...[...applied].reverse().flatMap((l) => prefix(l.name, l.preset.rules)),
  ];

  const last = applied.at(-1);
  const sources = [...applied.map((l) => l.name), ...(hasInline ? ["inline"] : [])];

  return {
    id: sources.join("+"),
    sources,
    default: inlineDefault ?? last?.preset.default ?? "deny",
    rules,
    // A UNION rather than a last-wins override: `alertOnUnpoliced` only ever adds a warning, and
    // a layer that asked to be told about a kind should not be silenced by a later one.
    alertOnUnpoliced: [...new Set(applied.flatMap((l) => l.preset.alertOnUnpoliced))],
  };
}
