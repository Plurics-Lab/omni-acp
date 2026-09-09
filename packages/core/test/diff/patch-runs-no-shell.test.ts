import { describe, expect, it } from "vitest";
import {
  packageSources,
  sourceFile,
  locate,
  type SourceFile,
} from "../../../testkit/test/arch/source-scan.js";

/**
 * Architecture guard: `patch-runs-no-shell` (CONTRACTS.md §27.4, §25.2).
 *
 * "Nothing under `core/src/diff/**` uses `shell:true` or a command string; git is reached only
 * through `RunUtility`."
 *
 * The rule is one sentence and its cost is a remote-execution hole: the provider runs git in a
 * directory a CLIENT chose, on every turn, and a repository can put arbitrary text in a path. A
 * command STRING handed to a shell turns `cwd = "/tmp/x; rm -rf ~"` into two commands; an argv
 * array cannot, whatever the path contains. `--no-ext-diff` / `--no-textconv` are the same rule
 * applied to git's own config, so they are checked here too — a diff that ran the repository's
 * `diff.external` would be executing the repository's code inside the daemon.
 *
 * Every clause is demonstrated FAILING on a planted violation (§10.2's rule), and each planted
 * source is the exact line a future commit would add, run through the same scanner.
 *
 * Owned by M2-WP-J.
 */

const DIFF_DIR = "packages/core/src/diff/";

/** `shell: true`, in any spacing, and the `execSync`-shaped "one string" call it enables. */
const SHELL_OPTION = /\bshell\s*:\s*true\b/g;
/** A command handed over as ONE string: `run("git add -A")`, `sh -c "…"`, a template argv. */
const COMMAND_STRING = /\brun\s*\(\s*[`"'][^`"']*\s[^`"']*[`"']/g;
/** `-c` as a bare argv element is `sh -c <script>` — a shell by another name. */
const DASH_C = /["']-c["']/g;

function hits(file: SourceFile, pattern: RegExp): string[] {
  const found: string[] = [];
  // Scanned over `code` (string literals blanked, comments blanked) EXCEPT for the two patterns
  // whose whole subject is a string literal, which are scanned over `text` and then filtered by
  // whether the quote survived blanking — the same technique `no-direct-spawn` uses.
  for (const m of file.code.matchAll(pattern)) {
    found.push(locate(file, m.index, file.text.slice(0, m.index).split("\n").length));
  }
  return found;
}

function literalHits(file: SourceFile, pattern: RegExp): string[] {
  const found: string[] = [];
  for (const m of file.text.matchAll(pattern)) {
    // A delimiter survives blanking; a comment does not. This is the test for "the match is real
    // code and not prose about the rule".
    if (file.code[m.index] === " ") continue;
    found.push(locate(file, m.index, file.text.slice(0, m.index).split("\n").length));
  }
  return found;
}

export function violations(files: readonly SourceFile[]): string[] {
  return files
    .filter((f) => f.path.startsWith(DIFF_DIR))
    .flatMap((f) => [
      ...hits(f, SHELL_OPTION),
      ...literalHits(f, COMMAND_STRING),
      ...literalHits(f, DASH_C),
    ])
    .sort();
}

const plant = (path: string, text: string): SourceFile =>
  sourceFile({ path, absolute: path, text });

describe("guard: patch-runs-no-shell", () => {
  const files = packageSources();
  const diff = files.filter((f) => f.path.startsWith(DIFF_DIR));

  it("scans a tree that actually contains the provider", () => {
    expect(diff.map((f) => f.path)).toContain("packages/core/src/diff/git-provider.ts");
    expect(diff.length).toBeGreaterThanOrEqual(3);
  });

  it("finds no shell, no command string and no `-c` under core/src/diff", () => {
    expect(violations(files)).toEqual([]);
  });

  it("the provider reaches git through the injected RunUtility and names no other program", () => {
    const provider = files.find((f) => f.path === "packages/core/src/diff/git-provider.ts");
    expect(provider).toBeDefined();
    // Over `text`, because `code` blanks string literals and the program NAME is one.
    const source = (provider as SourceFile).text;
    // ONE program, spelled once, and resolved through PATH by the utility rather than by a shell.
    expect(source).toContain('run("git"');
    expect(source).toContain("RunUtility");
  });

  it("the diff invocation carries the two security flags (§25.2)", () => {
    const provider = files.find((f) => f.path === "packages/core/src/diff/git-provider.ts");
    const text = (provider as SourceFile).text;
    expect(text).toContain('"--no-ext-diff"');
    expect(text).toContain('"--no-textconv"');
    // Never `--binary`: no blob content is smuggled into a patch.
    expect(text).not.toContain('"--binary"');
  });

  describe("fails on a planted violation", () => {
    const planted: [string, string][] = [
      ["shell: true", `const r = await run("git", args, { timeoutMs, shell: true });\nvoid r;\n`],
      ["a command string", `const r = await run("git add -A && git write-tree");\nvoid r;\n`],
      ["sh -c", `const r = await run("sh", ["-c", script], { timeoutMs });\nvoid r;\n`],
    ];
    for (const [name, source] of planted) {
      it(name, () => {
        expect(violations([plant(`${DIFF_DIR}planted.ts`, source)])).not.toEqual([]);
      });
    }

    it("would NOT have fired on the same source outside core/src/diff", () => {
      const outside = plant(
        "packages/daemon/src/planted.ts",
        `const r = await run("sh", ["-c", script], { shell: true });\nvoid r;\n`,
      );
      expect(violations([outside])).toEqual([]);
    });

    it("does not fire on PROSE about the rule", () => {
      const prose = plant(
        `${DIFF_DIR}planted.ts`,
        `/** Never shell: true, never "sh" "-c", never "git add -A && git write-tree". */\nexport const x = 1;\n`,
      );
      expect(violations([prose])).toEqual([]);
    });
  });
});
