import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The two M1 guards CONTRACTS.md §10.2 assigns to this work package:
 *
 *   `no-agent-prose`                — no source file outside the descriptor dialect module
 *                                     matches an English agent string. Classification keys on
 *                                     codes and JSON pointers or it does not exist (§13.4).
 *   `descriptor-is-the-only-branch` — nothing under `packages/core/src/normalizer/**` contains
 *                                     an agent-id string literal. A compatible fork is a YAML
 *                                     entry, not a commit (§17.1).
 *
 * Both are shown FAILING on a planted violation, because a guard nobody has watched fail is a
 * guard that might be scanning the wrong thing. `normalizer-is-pure` lives in `purity.test.ts`,
 * next to the reducer it is about.
 *
 * The scanner is local rather than imported from `testkit/test/arch`: a package's test tree is
 * not importable from another package, and re-implementing 40 lines is cheaper than making one
 * more thing cross a package boundary (§4).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..", "..");

interface Source {
  readonly path: string;
  readonly text: string;
  /** `text` with comment bodies blanked, lengths and line breaks preserved. */
  readonly code: string;
}

/**
 * Blanks COMMENT bodies only — not string literals.
 *
 * That is the opposite choice from `testkit`'s scanner, and it is deliberate: both guards here
 * are about STRING LITERALS ("an agent-id string literal", "an English agent string"), so a
 * scanner that blanked them would find nothing, forever. Comments still have to go, or the guard
 * would punish the documentation that explains why the rule exists — including this file's own.
 */
function blankComments(source: string): string {
  const out = source.split("");
  const blank = (from: number, to: number): void => {
    for (let i = from; i < to && i < out.length; i++) if (out[i] !== "\n") out[i] = " ";
  };
  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === "//") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (two === "/*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    // Skip over a string literal WITHOUT blanking it, so an apostrophe inside a doc comment
    // cannot desynchronize the scan and a quote inside a string cannot start a comment.
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        if (source[j] === ch) break;
        if (ch !== "`" && source[j] === "\n") break;
        j += 1;
      }
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return out.join("");
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(full);
  }
}

function sourcesUnder(...parts: string[]): Source[] {
  const files: string[] = [];
  walk(join(REPO_ROOT, ...parts), files);
  return files.sort().map((absolute) => {
    const text = readFileSync(absolute, "utf8");
    return {
      path: relative(REPO_ROOT, absolute).split(sep).join("/"),
      text,
      code: blankComments(text),
    };
  });
}

function packageSources(): Source[] {
  return readdirSync(join(REPO_ROOT, "packages")).flatMap((pkg) => {
    try {
      if (!statSync(join(REPO_ROOT, "packages", pkg, "src")).isDirectory()) return [];
    } catch {
      return [];
    }
    return sourcesUnder("packages", pkg, "src");
  });
}

function hits(source: Source, patterns: readonly RegExp[]): string[] {
  const found: string[] = [];
  for (const pattern of patterns) {
    const re = new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`);
    for (const m of source.code.matchAll(re)) {
      const line = source.code.slice(0, m.index).split("\n").length;
      found.push(`${source.path}:${String(line)} ${m[0]}`);
    }
  }
  return found;
}

// ── guard: no-agent-prose ────────────────────────────────────────────────────

/**
 * The three English strings §13.4 names, verbatim from the corpus.
 *
 * They are the ONLY machine-readable-looking signals the agent gives for a denial, an unknown
 * method and a missing session — and every one of them is prose that a version bump may reword.
 * The rule is not "avoid these strings", it is "classification keys on codes and pointers".
 */
const AGENT_PROSE: readonly RegExp[] = [
  /User refused permission/,
  /Method not found/,
  /Resource not found/,
];

/**
 * §13.4 exempts "the descriptor dialect module". In THIS tree that is
 * `normalizer/vendor/dialects.ts` — and it does not in fact need the exemption, because the
 * dialects read a value the DESCRIPTOR's pointer resolved and interpret its shape, never its
 * text. The allowlist is kept anyway, empty, so that a future dialect that genuinely needs a
 * string has a place to declare it rather than a reason to delete the guard.
 */
const PROSE_ALLOWED: ReadonlySet<string> = new Set<string>([]);

describe("guard: no-agent-prose (§10.2, §13.4)", () => {
  const sources = packageSources();

  it("scans a real corpus", () => {
    expect(sources.length).toBeGreaterThan(20);
    expect(sources.map((s) => s.path)).toContain("packages/protocol/src/turn.ts");
    expect(sources.map((s) => s.path)).toContain("packages/core/src/normalizer/turn-lifecycle.ts");
  });

  it("no source file matches an English agent string", () => {
    const offenders = sources
      .filter((s) => !PROSE_ALLOWED.has(s.path))
      .flatMap((s) => hits(s, AGENT_PROSE));
    expect(offenders).toEqual([]);
  });

  it("FAILS on a planted violation, and ignores the same words in a comment", () => {
    const planted: Source = {
      path: "<planted>",
      text: "",
      code: blankComments(
        [
          '// the agent says "User refused permission to run tool", and we ignore it',
          "/* Method not found */",
          'if (e.message.includes("User refused permission")) return "denied";',
        ].join("\n"),
      ),
    };
    expect(hits(planted, AGENT_PROSE)).toEqual(["<planted>:3 User refused permission"]);
  });

  it("…and `verdict` is computed with none of them: the fold reads codes and our own envelopes", () => {
    // The positive statement behind the negative guard. `reduceTurn`'s verdict comes from
    // `omni.error` (an envelope we wrote), `tool_call_update.status` (a schema'd enum) and
    // `omni.policy_decision.decision` (our own decision) — and from nothing the agent wrote in
    // English.
    const fold = sources.find((s) => s.path === "packages/protocol/src/turn.ts");
    expect(fold).toBeDefined();
    expect(fold?.code).toContain('status === "failed"');
    expect(fold?.code).toContain('decision === "deny"');
    // `rawOutput` is CARRIED (it is part of `ToolCallView`) and never READ for a decision.
    const rawOutputReads = (fold?.code.match(/rawOutput/g) ?? []).length;
    expect(rawOutputReads).toBeGreaterThan(0);
    expect(fold?.code).not.toMatch(/rawOutput[^\n]*includes/);
  });
});

// ── guard: descriptor-is-the-only-branch ─────────────────────────────────────

/**
 * Agent ids, and the vendor `_meta` keys that are the same thing wearing a different hat.
 *
 * The rule (§17.1) is that a compatible fork is a YAML entry rather than a commit, so anything
 * in the mapping path that names ONE agent breaks it — an id, a package name, or the vendor
 * namespace its `_meta` uses, because a pointer hard-coded in the map is an agent id spelled as
 * a path. Every one of these lives in the DESCRIPTOR instead: `extensions[].pointer`,
 * `prefer[].spellings`, `errorRules[].dataPointer`.
 */
const AGENT_IDS: readonly RegExp[] = [
  /claude-acp/,
  /claude-agent-acp/,
  /claudeCode/,
  /_claude\//,
  /codex/i,
  /gemini/i,
  /opencode/i,
  /\bkimi\b/i,
  /anthropic/i,
];

describe("guard: descriptor-is-the-only-branch (§10.2, §17.1)", () => {
  const normalizer = sourcesUnder("packages", "core", "src", "normalizer");

  it("scans the whole mapping path, RECURSIVELY", () => {
    const paths = normalizer.map((s) => s.path);
    expect(paths).toContain("packages/core/src/normalizer/normalizer.ts");
    expect(paths).toContain("packages/core/src/normalizer/turn-lifecycle.ts");
    expect(paths).toContain("packages/core/src/normalizer/map/update.ts");
    expect(paths).toContain("packages/core/src/normalizer/vendor/dialects.ts");
    expect(paths.length).toBeGreaterThanOrEqual(10);
  });

  it("contains no agent-id string literal anywhere under normalizer/**", () => {
    expect(normalizer.flatMap((s) => hits(s, AGENT_IDS))).toEqual([]);
  });

  it("FAILS on a planted violation — an id, a vendor pointer, or an `if` on the agent", () => {
    const plant = (code: string): string[] =>
      hits({ path: "<planted>", text: "", code: blankComments(code) }, AGENT_IDS);

    expect(plant('if (descriptor.id === "claude-acp") return true;\n')).toEqual([
      "<planted>:1 claude-acp",
    ]);
    expect(plant('const p = meta["claudeCode"]?.toolResponse;\n')).toEqual([
      "<planted>:1 claudeCode",
    ]);
    expect(plant('const r = meta["_claude/rateLimit"];\n')).toEqual(["<planted>:1 _claude/"]);
    // …and the same words in a COMMENT are legal, because the guard would otherwise forbid
    // explaining itself.
    expect(plant("// claude-acp puts the patch under claudeCode.toolResponse\n")).toEqual([]);
  });

  it("the pointers really do live in the descriptor, which is what makes the guard satisfiable", () => {
    // The positive statement: the map resolves `extensions[].pointer` and never a literal.
    const lifecycle = normalizer.find(
      (s) => s.path === "packages/core/src/normalizer/turn-lifecycle.ts",
    );
    expect(lifecycle?.code).toContain("cfg.descriptor.extensions");
    expect(lifecycle?.code).toContain("resolvePointer(meta, extension.pointer)");
  });
});
