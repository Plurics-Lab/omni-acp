import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The three architecture guards §27.4 assigns to M2-B-WP-P:
 *
 *   `policy-never-names-an-option`      — `core/src/policy/**` may not contain `optionId`,
 *                                         `allow_always`, `allow_once`, `reject_once` or
 *                                         `outcome`, and may not import `PermissionOption`.
 *                                         BYTE-WISE over the raw file, COMMENTS INCLUDED — no
 *                                         comment-stripping pass (M2-R16, review follow-up 7).
 *   `no-agent-prose` (extended)         — nothing under `core/src/{worker/interaction,policy}/**`
 *                                         may read `rawOutput`, `rawInput.description`, an
 *                                         option's `name`, or any `_meta.*description` to decide
 *                                         a result. F27 and F31 are the two recordings of what
 *                                         that costs.
 *   `descriptor-is-the-only-branch` (extended)
 *                                       — no agent-id string literal under the same two trees.
 *
 * Each is demonstrated FAILING on a planted violation, per §10.2's rule: a guard nobody has
 * watched fail is a guard that might be scanning the wrong thing.
 *
 * The scanner is local rather than imported from `testkit/test/arch` or from
 * `normalizer/guards.test.ts`: a package's test tree is not importable from another package, and
 * the two guards here scan DIFFERENTLY from the normalizer's — one is byte-wise over the raw
 * file, the other blanks comments — so a shared helper would have to be parameterized into
 * something less obvious than forty lines.
 *
 * Owned by M2-B-WP-P.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..", "..");

interface Source {
  readonly path: string;
  /** The file EXACTLY as it is on disk. `policy-never-names-an-option` reads this one. */
  readonly text: string;
  /** `text` with comment bodies blanked. `no-agent-prose` reads this one. */
  readonly code: string;
}

/** Blanks COMMENT bodies only — never string literals. (Same technique as the M1 guards.) */
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
  const dir = join(REPO_ROOT, ...parts);
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  walk(dir, files);
  return files.sort().map((absolute) => {
    const text = readFileSync(absolute, "utf8");
    return {
      path: relative(REPO_ROOT, absolute).split(sep).join("/"),
      text,
      code: blankComments(text),
    };
  });
}

function hits(text: string, path: string, patterns: readonly RegExp[]): string[] {
  const found: string[] = [];
  for (const pattern of patterns) {
    const re = new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`);
    for (const m of text.matchAll(re)) {
      found.push(`${path}:${String(text.slice(0, m.index).split("\n").length)} ${m[0]}`);
    }
  }
  return found;
}

// ── guard: policy-never-names-an-option (§20.1, M2-R16) ──────────────────────

/**
 * The five forbidden strings, and the import.
 *
 * They are not a style rule. The engine's whole vocabulary is `PolicyAction`; the moment it can
 * name one of these it can also break D4 rule 3 without anybody having to edit the file that
 * enforces rule 3. Keeping the two vocabularies disjoint is what makes "D4's six hard rules
 * preserved" a structural property instead of a promise.
 */
const FORBIDDEN: readonly RegExp[] = [
  /optionId/,
  /allow_always/,
  /allow_once/,
  /reject_once/,
  /outcome/,
  /\bPermissionOption\b/,
];

describe("guard: policy-never-names-an-option (§20.1, §27.4, M2-R16)", () => {
  const policy = sourcesUnder("packages", "core", "src", "policy");

  it("scans a real directory, and every file this work package owns is in it", () => {
    const paths = policy.map((s) => s.path);
    for (const file of ["engine", "match", "glob", "subject", "ceiling", "presets", "alert"]) {
      expect(paths, file).toContain(`packages/core/src/policy/${file}.ts`);
    }
    expect(policy.length).toBeGreaterThanOrEqual(7);
  });

  it("no file under core/src/policy/** contains any of the five, or imports PermissionOption", () => {
    // BYTE-WISE over the RAW text, comments included: a guard that skipped comments would let the
    // next author write the selection rule as prose and then implement it (review follow-up 7).
    expect(policy.flatMap((s) => hits(s.text, s.path, FORBIDDEN))).toEqual([]);
  });

  it("FAILS on a planted literal — including one inside a comment", () => {
    const plant = (code: string): string[] => hits(code, "<planted>", FORBIDDEN);

    expect(plant('return { optionId: chosen, rule: "x" };\n')).toEqual(["<planted>:1 optionId"]);
    expect(plant('if (o.kind === "allow_always") return false;\n')).toEqual([
      "<planted>:1 allow_always",
    ]);
    expect(plant('const grant = "allow_once";\n')).toEqual(["<planted>:1 allow_once"]);
    expect(plant('const no = "reject_once";\n')).toEqual(["<planted>:1 reject_once"]);
    expect(plant("return response.outcome;\n")).toEqual(["<planted>:1 outcome"]);
    expect(plant('import type { PermissionOption } from "@omni-acp/protocol";\n')).toEqual([
      "<planted>:1 PermissionOption",
    ]);

    // ...and the comment case, which is the one the ruling settled: prose is NOT exempt.
    expect(plant("// never select an allow_always, whatever the outcome\n")).toEqual([
      "<planted>:1 allow_always",
      "<planted>:1 outcome",
    ]);
  });

  it("the OTHER side of the split really does exist — selectOption is where an id is chosen", () => {
    const responder = readFileSync(
      join(REPO_ROOT, "packages", "core", "src", "worker", "permission-responder.ts"),
      "utf8",
    );
    expect(responder).toContain("export function selectOption");
    expect(responder).toContain("allow_always");
    // ...and it is the ONLY place: in the SHIPPED packages, no other source file so much as names
    // a grant kind in code. `@omni-acp/testkit` is excluded because a test double's whole job is
    // to send menus no real agent sends, including the three degenerate ones.
    const shipped = ["protocol", "core", "daemon", "client", "cli"].flatMap((pkg) =>
      sourcesUnder("packages", pkg, "src"),
    );
    expect(shipped.length).toBeGreaterThan(40);
    const namers = shipped
      .filter((s) => /allow_once|reject_once|allow_always/.test(s.code))
      .map((s) => s.path);
    expect(namers).toEqual(["packages/core/src/worker/permission-responder.ts"]);
  });
});

// ── guard: no-agent-prose, EXTENDED to the two M2 trees (§27.4) ──────────────

/**
 * The prose reads §27.4 names, spelled as patterns.
 *
 * `rawOutput` is forbidden outright under these trees: F31 is the recording of what reading it
 * costs — a DECLINED elicitation leaves its tool call `completed` and its `rawOutput` says
 * nothing about the refusal, so a decision keyed on it reports a tool we blocked that in fact
 * ran. `rawInput` goes with it: F38 shows codex's read-classified call carries none at all, so a
 * rule that matched on one would be a rule that can never fire on that agent.
 */
const AGENT_PROSE: readonly RegExp[] = [
  /rawOutput/,
  /rawInput\s*(?:\.|\[)/,
  /\.description\b/,
  /_meta[^\n]*description/,
  /\b(?:option|opt|o|choice)\s*\.\s*name\b/,
  /\[\s*"name"\s*\]/,
];

/** Agent ids, and the vendor `_meta` namespaces that are the same thing wearing a hat. */
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

const M2_TREES: readonly (readonly string[])[] = [
  ["packages", "core", "src", "policy"],
  ["packages", "core", "src", "worker", "interaction"],
];

describe("guard: no-agent-prose, extended to core/src/{worker/interaction,policy}/** (§27.4)", () => {
  const sources = M2_TREES.flatMap((parts) => sourcesUnder(...parts));

  it("scans both trees", () => {
    const paths = sources.map((s) => s.path);
    expect(paths).toContain("packages/core/src/policy/match.ts");
    expect(paths.some((p) => p.startsWith("packages/core/src/worker/interaction/"))).toBe(true);
  });

  it("nothing under either tree reads an agent's prose to decide anything", () => {
    expect(sources.flatMap((s) => hits(s.code, s.path, AGENT_PROSE))).toEqual([]);
  });

  it("FAILS on a planted read, and ignores the same words in a comment", () => {
    const plant = (code: string): string[] => hits(blankComments(code), "<planted>", AGENT_PROSE);
    expect(plant('if (call.rawOutput.includes("refused")) return "deny";\n')).toEqual([
      "<planted>:1 rawOutput",
    ]);
    expect(plant("const what = subject.rawInput.description;\n")).toEqual([
      "<planted>:1 rawInput.",
      "<planted>:1 .description",
    ]);
    expect(plant('if (option.name === "Allow") return option;\n')).toEqual([
      "<planted>:1 option.name",
    ]);
    expect(plant('const label = meta["name"];\n')).toEqual(['<planted>:1 ["name"]']);
    expect(plant("// we never read rawOutput.description or an option.name\n")).toEqual([]);
  });

  it("...and the POSITIVE statement: the matcher keys on the tagged subject, not on a title", () => {
    const match = sources.find((s) => s.path === "packages/core/src/policy/match.ts");
    expect(match?.code).toContain("SUBJECT_TAGS.has(s.type)");
    expect(match?.code).toContain("c.kind.set.has(s.kind)");
    // `PolicySubject.title` is carried for the audit record and read by NOTHING in the matcher.
    expect(match?.code).not.toMatch(/s\.title/);
  });
});

describe("guard: descriptor-is-the-only-branch, extended (§27.4)", () => {
  const sources = M2_TREES.flatMap((parts) => sourcesUnder(...parts));

  it("contains no agent-id string literal anywhere under either tree", () => {
    expect(sources.flatMap((s) => hits(s.code, s.path, AGENT_IDS))).toEqual([]);
  });

  it("FAILS on a planted id, and ignores one in a comment", () => {
    const plant = (code: string): string[] => hits(blankComments(code), "<planted>", AGENT_IDS);
    expect(plant('if (s.agentId === "claude-acp") return "allow";\n')).toEqual([
      "<planted>:1 claude-acp",
    ]);
    expect(plant('const q = meta["claudeCode"];\n')).toEqual(["<planted>:1 claudeCode"]);
    expect(plant("// claude-acp asks for permission and codex does not\n")).toEqual([]);
  });

  it("...and the POSITIVE statement: an agent clause matches a CONFIG array, never a literal", () => {
    const match = sources.find((s) => s.path === "packages/core/src/policy/match.ts");
    expect(match?.code).toContain("m.agent !== undefined && !m.agent.includes(s.agentId)");
  });
});
