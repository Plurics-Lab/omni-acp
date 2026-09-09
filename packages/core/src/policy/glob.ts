import { OmniError } from "@omni-acp/protocol";

/**
 * A path glob, compiled once. PURE, and with NO new dependency — Land exit criterion 7.
 *
 * `**` crosses separators, `*` does not, and a RELATIVE pattern is a load error: a rule written
 * against `src/**` and matched against a realpath'd absolute would match nothing and look like it
 * worked, which is the failure mode a security rule can least afford.
 *
 * ── WHY THE SHIPPED PRESETS ARE STILL WRITTEN RELATIVE (§20.4 vs §5.8.7) ────────────────────
 *
 * `src-edit` ships with `path: ["src/**","test/**","tests/**"]` and the schema says a relative
 * pattern is a load error. Both are true, and they meet in `match.ts`: a preset is daemon-wide
 * and a worker's cwd is not knowable when it loads, so a relative pattern is ANCHORED to
 * `PolicySubject.cwd` at match time and only the resulting ABSOLUTE pattern reaches this
 * function. This function is the primitive, and the primitive refuses a relative pattern —
 * which is what stops a caller that forgot to anchor from silently matching nothing.
 *
 * ── SEPARATORS ──────────────────────────────────────────────────────────────────────────────
 *
 * Both the pattern and the candidate are normalized to `/` before matching, so one rule file
 * works on all three OSes. A Windows realpath (`C:\repo\src\a.ts`) and a POSIX one are the same
 * shape after normalization, and `C:/repo/**` is a legal absolute pattern.
 *
 * Owned by M2-B-WP-P.
 */

/** The schema's own cap (`PolicyMatch.path` is `.max(512)`), re-checked for a hand-built rule. */
const MAX_PATTERN = 512;

export interface GlobOptions {
  /**
   * §20.3's action-directional case folding: `allow` rules match case-SENSITIVELY, and
   * `deny` / `park` / `fail` rules match case-INSENSITIVELY. On a case-insensitive volume one
   * file has many spellings, so making the grant harder to satisfy and the restriction easier is
   * the only assignment that fails closed in both directions.
   *
   * It is an OPTION rather than a second exported function so that §5.8.9's declared signature
   * — `compileGlob(pattern: string): (abs: string) => boolean` — still calls this verbatim.
   */
  readonly caseInsensitive?: boolean;
}

/** `\` → `/`, and a trailing separator dropped (but never from a bare root). */
export function normalizeSeparators(p: string): string {
  const slashed = p.replace(/\\/g, "/");
  if (slashed.length > 1 && slashed.endsWith("/")) return slashed.slice(0, -1);
  return slashed;
}

/** POSIX `/x`, Windows `C:/x`, and a UNC `//server/share`. Tested on both spellings. */
export function isAbsolutePattern(normalized: string): boolean {
  return (
    normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//")
  );
}

const REGEX_SPECIAL = /[.+^$(){}|\\]/g;

/**
 * The translation, segment-aware, and the three rows that carry it:
 *
 *   `**` + `/`   → `(?:[^/]+/)*`   zero or more WHOLE segments
 *   `/` + `**$`  → `(?:/.*)?`      the directory itself and everything under it
 *   `**`         → `.*`            crosses separators (the general case)
 *   `*`          → `[^/]*`         never crosses one
 *   `?`          → `[^/]`
 *   `[...]`      → a character class, with `!` read as `^`
 */
function toRegExpSource(pattern: string): string {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i] as string;

    if (ch === "*") {
      const doubled = pattern[i + 1] === "*";
      if (doubled) {
        const atSegmentStart = i === 0 || pattern[i - 1] === "/";
        const after = pattern[i + 2];
        if (atSegmentStart && after === "/") {
          out += "(?:[^/]+/)*";
          i += 3;
          continue;
        }
        if (atSegmentStart && after === undefined) {
          // `/**` at the end: drop the `/` we already emitted and make the tail optional, so
          // `src/**` names the directory AND everything under it rather than only its children.
          if (out.endsWith("/")) {
            out = `${out.slice(0, -1)}(?:/.*)?`;
          } else {
            out += ".*";
          }
          i += 2;
          continue;
        }
        out += ".*";
        i += 2;
        continue;
      }
      out += "[^/]*";
      i += 1;
      continue;
    }

    if (ch === "?") {
      out += "[^/]";
      i += 1;
      continue;
    }

    if (ch === "[") {
      const close = pattern.indexOf("]", i + 1);
      if (close === -1) {
        // An unterminated class is a literal `[`, not a silently different rule.
        out += "\\[";
        i += 1;
        continue;
      }
      let body = pattern.slice(i + 1, close);
      if (body.startsWith("!")) body = `^${body.slice(1)}`;
      // `\` and `]` are the only two that can break out of a class.
      out += `[${body.replace(/\\/g, "\\\\")}]`;
      i = close + 1;
      continue;
    }

    out += ch.replace(REGEX_SPECIAL, "\\$&");
    i += 1;
  }
  return out;
}

export function compileGlob(pattern: string, opts?: GlobOptions): (abs: string) => boolean {
  if (pattern.length === 0) {
    throw new OmniError("bad_request", "policy path glob is empty");
  }
  if (pattern.length > MAX_PATTERN) {
    throw new OmniError(
      "bad_request",
      `policy path glob is longer than ${String(MAX_PATTERN)} characters`,
    );
  }
  const normalized = normalizeSeparators(pattern);
  if (!isAbsolutePattern(normalized)) {
    throw new OmniError(
      "bad_request",
      `policy path glob must be absolute, got "${pattern}" — a relative pattern matched against a realpath'd absolute would match nothing and look like it worked`,
    );
  }
  const re = new RegExp(
    `^${toRegExpSource(normalized)}$`,
    opts?.caseInsensitive === true ? "i" : "",
  );
  return (abs: string): boolean => re.test(normalizeSeparators(abs));
}

/**
 * The non-wildcard HEAD of a pattern — everything before the first `*`, `?` or `[`.
 *
 * It is what makes `policyCeiling.pathRoots` decidable: glob∩glob containment is undecidable in
 * general, so the ceiling is checked by a literal prefix test on this, which is total and
 * honestly coarse rather than precise-looking and approximate (ruling M2-R11).
 *
 * Deliberately NOT truncated to the last separator. A pattern beginning `src*` keeps the head
 * `src`, which is what lets `assertWithinCeiling` accept it — and `clampVerdict` is what then
 * catches that same pattern reaching `src-secrets/`, the incompleteness §20.5 says the pair
 * exists to close.
 *
 * Owned by M2-B-WP-P.
 */
export function globHead(pattern: string): string {
  const normalized = normalizeSeparators(pattern);
  const at = normalized.search(/[*?[]/);
  return at === -1 ? normalized : normalized.slice(0, at);
}

/**
 * `head` is lexically inside `root`: equal, or a path-segment prefix of it.
 *
 * The `/` in the prefix test is the whole point — without it `src-secrets` would be "inside"
 * `src`, which is the classic prefix bug in exactly the place it costs the most.
 */
export function withinRoot(head: string, root: string): boolean {
  const h = normalizeSeparators(head);
  const r = normalizeSeparators(root);
  if (r.length === 0) return true;
  return h === r || h.startsWith(`${r}/`);
}
