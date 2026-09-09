import { OmniError } from "@omni-acp/protocol";
import type {
  PolicyAction,
  PolicyCeiling,
  PolicySubject,
  PolicyVerdict,
  ResolvedPolicy,
  TurnWarning,
} from "@omni-acp/protocol";
import { globHead, isAbsolutePattern, normalizeSeparators, withinRoot } from "./glob.js";

/**
 * D4's ceiling, enforced TWICE (§20.5, ruling M2-R11): a decidable static refusal at create, and
 * a per-subject clamp at decision time that is never silent.
 *
 * The lattice, and the one non-obvious tie:
 *
 *   `fail` and `deny` rank EQUAL. Neither grants anything; `fail`'s extra effect - cancelling the
 *   turn - is a denial of service to the caller's OWN run, not a privilege. A tie resolves to the
 *   POLICY's action and never the ceiling's, so a ceiling can lower an action and can never
 *   change one it already permits.
 *
 * Owned by M2-B-WP-P.
 */
export const ACTION_RANK: { readonly [A in PolicyAction]: number } = {
  deny: 0,
  fail: 0,
  park: 1,
  allow: 2,
};

/** True when the ceiling's action is at least as wide as `action`. Ties resolve to the policy. */
export function dominates(ceiling: PolicyAction, action: PolicyAction): boolean {
  return ACTION_RANK[action] <= ACTION_RANK[ceiling];
}

/** The default name an unnamed ceiling reports itself under. */
const DEFAULT_CEILING_NAME = "policyCeiling";

export interface CeilingCheckOptions {
  /**
   * Which ceiling refused. `OmniErrorBody.policy.ceiling` carries a NAME rather than the
   * document, so an operator reading a 403 can say WHICH ceiling refused without being handed a
   * rule set to compare by eye. The daemon passes the token's name; the default is for a direct
   * call.
   */
  readonly name?: string;
  /**
   * `CreateWorkerRequest.onUnresolved`, when the caller has one.
   *
   * §20.5 refuses THREE things under `park: false` and only two of them live in a policy
   * document; the third is on the create request. It is optional here because
   * `assertWithinCeiling`'s §5.8.9 signature takes a document and a ceiling, and because a
   * caller checking a document alone (the compat and unit paths) has no request to quote.
   */
  readonly onUnresolved?: "park" | "deny" | "fail";
}

/**
 * The STATIC half, and it is deliberately INCOMPLETE (§20.5, ruling M2-R11).
 *
 * A ceiling is written in a coarser language than a rule - `maxAction`, `allowKinds`,
 * `denyKinds`, `pathRoots`, `commands`, `park` - because glob-intersect-glob and
 * regex-intersect-regex containment is undecidable, and a ceiling that LOOKS precise while being
 * checked approximately is worse than one that is honestly coarse. What this check IS: total,
 * decidable, and refusing at CREATE time with `403 policy_exceeds_ceiling` naming
 * `{ceiling, offending}`, so the operator sees it where they can act on it.
 *
 * `park: false` refuses THREE things, not one (review R6): `onUnresolved:"park"`, any RULE whose
 * `action` is `park`, and a `default` of `park`. Checking only the create request was a hole -
 * the shipped `src-edit` preset has `default: "park"`, so a token whose operator wrote
 * `park: false` could still be driven into `requires_action` by a preset, holding a `maxWorkers`
 * slot indefinitely under `parkTimeoutMs: 0`. Each offender is named in `body.policy.offending`.
 *
 * ── WHAT "LEXICALLY INSIDE" MEANS, AND WHERE IT STOPS ───────────────────────────────────────
 *
 * The `pathRoots` test is a literal prefix test on `globHead` - decidable and total, and coarse
 * on purpose. It refuses `**` (whose head is empty) and it ACCEPTS `src*` (whose head is `src`),
 * which is precisely the gap `clampVerdict` closes: `src*` reaches `src-secrets/` at runtime and
 * the clamp sees the actual path. §20.5 names `path: "**"` as the illustration of that gap; this
 * implementation refuses that one statically because failing closed is strictly better, and the
 * clamp is then proved on `src*`, a case the head test PROVABLY cannot see.
 *
 * Owned by M2-B-WP-P.
 */
export function assertWithinCeiling(
  doc: ResolvedPolicy,
  c: PolicyCeiling,
  opts?: CeilingCheckOptions,
): void {
  const offending: string[] = [];
  const name = opts?.name ?? DEFAULT_CEILING_NAME;
  const scoped = c.pathRoots !== undefined || c.allowKinds !== undefined || c.denyKinds.length > 0;

  const grants = (a: PolicyAction): boolean => ACTION_RANK[a] > ACTION_RANK.deny;

  // -- the document's default ------------------------------------------------
  if (!dominates(c.maxAction, doc.default)) {
    offending.push(`${doc.id}#default: action "${doc.default}" exceeds maxAction "${c.maxAction}"`);
  }
  if (doc.default === "park" && !c.park) {
    offending.push(`${doc.id}#default: a default of "park" is refused by park:false`);
  }
  if (doc.default === "allow" && scoped) {
    // An unscoped grant, in the one place that cannot carry a clause: the fallthrough. Refusing
    // it is the same rule an unscoped `allow` RULE gets, for the same reason.
    offending.push(
      `${doc.id}#default: a default of "allow" is unscoped, and this ceiling scopes what may be allowed`,
    );
  }

  // -- the rules -------------------------------------------------------------
  for (const rule of doc.rules) {
    const at = `${doc.id}#${rule.id}`;
    const m = rule.match;

    if (!dominates(c.maxAction, rule.action)) {
      offending.push(`${at}: action "${rule.action}" exceeds maxAction "${c.maxAction}"`);
    }
    if (rule.action === "park" && !c.park) {
      offending.push(`${at}: a rule action of "park" is refused by park:false`);
    }
    if (!c.commands && (m.subject === "command" || m.cmd !== undefined)) {
      offending.push(`${at}: matches a command subject, and this ceiling sets commands:false`);
    }

    if (rule.action === "allow" && c.allowKinds !== undefined) {
      const allowed = new Set(c.allowKinds);
      if (m.kind === undefined) {
        offending.push(
          `${at}: an allow rule with no kind clause is unbounded, and this ceiling lists allowKinds`,
        );
      } else if (m.kind.length === 1 && m.kind[0] === "*") {
        offending.push(`${at}: an allow rule on every kind exceeds allowKinds`);
      } else {
        for (const k of m.kind) {
          if (!allowed.has(k)) offending.push(`${at}: kind "${k}" is not in allowKinds`);
        }
      }
    }

    if (grants(rule.action) && c.denyKinds.length > 0) {
      const denied = new Set(c.denyKinds);
      if (m.kind === undefined || (m.kind.length === 1 && m.kind[0] === "*")) {
        offending.push(
          `${at}: an unbounded "${rule.action}" rule can reach denyKinds ${JSON.stringify(c.denyKinds)}`,
        );
      } else {
        for (const k of m.kind) {
          if (denied.has(k)) offending.push(`${at}: kind "${k}" is a denyKind`);
        }
      }
    }

    if (c.pathRoots !== undefined) {
      if (m.path === undefined) {
        // §20.5, verbatim: an UNSCOPED allow rule is contained only when the ceiling has no
        // `pathRoots` at all. A `park` / `deny` / `fail` rule grants nothing, so it may stay
        // unscoped - refusing it would refuse configurations strictly safer than the ceiling.
        if (rule.action === "allow") {
          offending.push(
            `${at}: an allow rule with no path clause is unscoped, and this ceiling lists pathRoots ${JSON.stringify(c.pathRoots)}`,
          );
        }
      } else {
        for (const pattern of m.path) {
          const head = globHead(pattern);
          if (!c.pathRoots.some((root) => withinRoot(head, root))) {
            offending.push(
              `${at}: path glob "${pattern}" has head "${head}", which is not inside any of ${JSON.stringify(c.pathRoots)}`,
            );
          }
        }
      }
    }
  }

  // -- the create request ----------------------------------------------------
  if (opts?.onUnresolved === "park" && !c.park) {
    offending.push(`request#onUnresolved: "park" is refused by park:false`);
  }

  if (offending.length === 0) return;
  throw new OmniError(
    "policy_exceeds_ceiling",
    `policy "${doc.id}" exceeds the token's ceiling in ${String(offending.length)} place(s)`,
    { policy: { ceiling: name, offending } },
  );
}

// -- the runtime half ---------------------------------------------------------

/** Which clause of the ceiling refused this action for this subject, or null when none did. */
function refusal(action: PolicyAction, c: PolicyCeiling, s: PolicySubject): string | null {
  if (!dominates(c.maxAction, action)) return "maxAction";
  if (action === "park") return c.park ? null : "park";
  if (action !== "allow") return null;

  if (!c.commands && s.type === "command") return "commands";
  if (c.allowKinds !== undefined && (s.kind === null || !c.allowKinds.includes(s.kind))) {
    return "allowKinds";
  }
  if (s.kind !== null && c.denyKinds.includes(s.kind)) return "denyKinds";
  if (c.pathRoots !== undefined) {
    // F38 again: an EMPTY `paths` is not "no files touched". A grant that names no path cannot be
    // shown to be inside the roots, so it is not.
    if (s.paths.length === 0) return "pathRoots";
    const roots = c.pathRoots.map((root) =>
      isAbsolutePattern(normalizeSeparators(root))
        ? normalizeSeparators(root)
        : `${normalizeSeparators(s.cwd)}/${normalizeSeparators(root)}`,
    );
    for (const p of s.paths) {
      if (!roots.some((root) => withinRoot(p, root))) return "pathRoots";
    }
  }
  return null;
}

/**
 * The RUNTIME half, and what makes the pair SOUND rather than merely strict.
 *
 * `assertWithinCeiling` provably cannot catch every case - a `path` head that is lexically inside
 * a root while the glob it heads reaches outside one is the named example - so the verdict is
 * clamped as it is produced, and the clamp is NEVER SILENT: `PolicyVerdict.clamped` records
 * `{from, by}` and a `TurnWarning` says so on the turn. A ceiling that quietly narrowed an
 * author's rule would be indistinguishable from a rule that never fired.
 *
 * `deny` and `fail` rank EQUAL in `dominates`: neither grants, and a tie resolves to the policy.
 * Under `park: false` a runtime `park` verdict clamps to `deny` - the next action down the
 * lattice the ceiling permits - so the static refusal and the clamp agree about what
 * `park: false` means.
 *
 * Owned by M2-B-WP-P.
 */
export function clampVerdict(
  v: PolicyVerdict,
  c: PolicyCeiling,
  s: PolicySubject,
  opts?: { readonly name?: string },
): PolicyVerdict {
  const why = refusal(v.action, c, s);
  if (why === null) return v;

  const name = opts?.name ?? DEFAULT_CEILING_NAME;
  // Walk DOWN the lattice to the first action this ceiling permits for this subject. `deny`
  // grants nothing, so the walk always terminates - which is what makes the clamp total.
  const ladder: readonly PolicyAction[] = v.action === "allow" ? ["park", "deny"] : ["deny"];
  const target: PolicyAction = ladder.find((a) => refusal(a, c, s) === null) ?? "deny";

  return {
    action: target,
    rule: v.rule,
    // The layer that produced the ACTION is now the ceiling, which is exactly how an operator
    // tells a clamp from an author's intent (§20.2). `rule` still names the rule that fired, so
    // the audit row says both what was written and what was enforced.
    source: "ceiling",
    clamped: { from: v.action, by: `${name}:${why}` },
  };
}

/**
 * The clamp's other half: it is announced on the TURN as well as on the decision.
 *
 * A policy that is quietly narrower than it reads is how an operator plans around a rule that
 * never fires, so §20.5 requires both records and this is the one that reaches `TurnResult`.
 * `null` when nothing was clamped, so a caller can append it unconditionally.
 *
 * Owned by M2-B-WP-P.
 */
export function policyClampWarning(v: PolicyVerdict): TurnWarning | null {
  if (v.clamped === null) return null;
  return {
    code: "policy_clamped",
    message: `"${v.clamped.from}" was narrowed to "${v.action}" by ${v.clamped.by}`,
    source: "policy",
    detail: { from: v.clamped.from, to: v.action, by: v.clamped.by, rule: v.rule },
  };
}
