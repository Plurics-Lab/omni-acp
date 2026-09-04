import { describe, expect, it } from "vitest";
import {
  blankOutNonCode,
  packageSources,
  type SourceFile,
} from "../../../testkit/test/arch/source-scan.js";

/**
 * Architecture guard: `no-direct-spawn` (CONTRACTS.md §6.1, §10.2, F10).
 *
 * `packages/core/src/process/spawn.ts` is the ONLY file allowed to import `node:child_process`,
 * and the only one allowed to call `spawn` / `exec` / `execFile` / `fork`. This is multica's
 * `TestOnlyLaunchGoSpawnsRuntimeProcesses`, ported: per-backend opt-in there left 19 of 27 spawn
 * sites without a process group (GH #7522), and a cancelled task's tool subprocesses outlived it
 * by forty minutes.
 *
 * It matches IMPORTS and CALL SITES, never raw substrings, because the forbidden names appear
 * legally in three places and a guard that fires on prose teaches people to delete the prose:
 *
 *  - `SupervisorOptions.spawnFn?: typeof import("node:child_process").spawn` — a type query that
 *    emits nothing and calls nothing (amendment A8),
 *  - doc comments in `agent-process.ts`, `contracts.ts` and this package's own sources,
 *  - `Supervisor.spawn(spec)` — a METHOD, declared in `contracts.ts` and implemented in
 *    `supervisor.ts` and `testkit`, and called as `supervisor.spawn(...)` everywhere else.
 *
 * The scanner is exported as pure functions over `SourceFile`s so the planted-violation cases
 * below are a real demonstration rather than a claim: each one is the exact source a future
 * commit would add, run through the same code that scans the tree.
 */

/** The allowlist. One file. */
const ALLOWED = "packages/core/src/process/spawn.ts";

/** `child_process`, with or without the `node:` prefix, as a MODULE SPECIFIER (hence quoted). */
const MODULE_SPECIFIER = /["'](?:node:)?child_process["']/g;

/**
 * The call sites. The four CONTRACTS.md §6.1 names plus their `*Sync` twins, which are the same
 * hazard with a blocking signature. `(?<![.\w$])` drops `supervisor.spawn(`, `p.exec(`,
 * `re.exec(` and `spawnAgentProcess(` — a method call on an object is not a new spawn site.
 */
const CALL_SITE = /(?<![.\w$])(spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(/g;

/** Tokens that can precede a method DECLARATION but never a call expression. */
const DECLARATION_PRECEDERS = new Set(["{", "}", ";", ",", ""]);
const DECLARATION_KEYWORDS = new Set([
  "async",
  "function",
  "static",
  "readonly",
  "export",
  "declare",
  "abstract",
  "public",
  "private",
  "protected",
]);

export function plant(path: string, text: string): SourceFile {
  return { path, absolute: path, text, code: blankOutNonCode(text) };
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

/**
 * Every reference to `node:child_process` that survives to runtime.
 *
 * Specifiers live inside string literals, which `code` blanks — so the scan runs over `text` and
 * uses `code` only to decide whether the quote itself was blanked, which is precisely the test
 * for "this occurrence is inside a comment or a template literal".
 */
export function moduleReferences(file: SourceFile): string[] {
  const hits: string[] = [];
  for (const m of file.text.matchAll(MODULE_SPECIFIER)) {
    const at = m.index;
    // The delimiters of a string literal survive blanking; a comment does not.
    if (file.code[at] === " ") continue;
    const before = file.text.slice(Math.max(0, at - 200), at);
    // `typeof import("node:child_process").spawn` — a type query. Emits nothing (A8).
    if (/\btypeof\s+import\s*\(\s*$/.test(before)) continue;
    // `import type … from "node:child_process"` — erased before it reaches a runtime.
    if (/\bimport\s+type\b[^;]*\bfrom\s*$/.test(before)) continue;
    hits.push(`${file.path}:${String(lineOf(file.text, at))}`);
  }
  return hits;
}

/**
 * `true` when the `(` at `openParen` belongs to a method/function DECLARATION rather than to a
 * call. Two conditions, because either alone is wrong: `cond ? spawn(a) : b` also has a `:` after
 * its closing paren, and `spawn(spec)` at the start of a line also has a bare preceding token.
 */
function isDeclaration(code: string, identifierAt: number, openParen: number): boolean {
  let depth = 0;
  let closed = -1;
  for (let i = openParen; i < code.length; i += 1) {
    const ch = code[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        closed = i;
        break;
      }
    }
  }
  // Unbalanced parentheses: fail CLOSED and call it a call site. A guard that goes quiet on
  // input it cannot parse is the one failure mode a guard may not have.
  if (closed === -1) return false;
  const after = /^\s*([\s\S])/.exec(code.slice(closed + 1))?.[1] ?? "";
  if (after !== "{" && after !== ":") return false;

  let j = identifierAt - 1;
  while (j >= 0 && /\s/.test(code[j] ?? "")) j -= 1;
  const ch = code[j] ?? "";
  if (DECLARATION_PRECEDERS.has(ch)) return true;
  if (!/[A-Za-z0-9_$]/.test(ch)) return false;
  let k = j;
  while (k >= 0 && /[A-Za-z0-9_$]/.test(code[k] ?? "")) k -= 1;
  return DECLARATION_KEYWORDS.has(code.slice(k + 1, j + 1));
}

/** Every place a process is actually started, as `path:line (name)`. */
export function spawnCallSites(file: SourceFile): string[] {
  const hits: string[] = [];
  for (const m of file.code.matchAll(CALL_SITE)) {
    const name = m[1] ?? "";
    const identifierAt = m.index;
    const openParen = file.code.indexOf("(", identifierAt + name.length);
    if (openParen === -1) continue;
    if (isDeclaration(file.code, identifierAt, openParen)) continue;
    hits.push(`${file.path}:${String(lineOf(file.code, identifierAt))} (${name})`);
  }
  return hits;
}

export function violations(files: readonly SourceFile[]): string[] {
  return files
    .filter((f) => f.path !== ALLOWED)
    .flatMap((f) => [...moduleReferences(f), ...spawnCallSites(f)])
    .sort();
}

describe("guard: no-direct-spawn", () => {
  const files = packageSources();

  it("scans a tree that actually contains the allowlisted file", () => {
    expect(files.map((f) => f.path)).toContain(ALLOWED);
    expect(files.length).toBeGreaterThan(10);
  });

  it("finds no second spawn site anywhere under packages/*/src", () => {
    expect(violations(files)).toEqual([]);
  });

  it("still sees the real imports and calls INSIDE the allowlisted file", () => {
    // Otherwise the guard could be passing because the scanner matches nothing at all.
    const spawnTs = files.find((f) => f.path === ALLOWED);
    expect(spawnTs).toBeDefined();
    expect(moduleReferences(spawnTs as SourceFile).length).toBeGreaterThan(0);
    expect(spawnCallSites(spawnTs as SourceFile).length).toBeGreaterThan(0);
  });

  // ── planted violations: the guard demonstrated FAILING (M0-PLAN WP-2 acceptance 2) ─────────
  describe("fails on a planted violation", () => {
    const planted: [string, string][] = [
      ["a static value import", `import { spawn } from "node:child_process";\nspawn("x", []);\n`],
      ["the un-prefixed module name", `import cp from "child_process";\nvoid cp;\n`],
      ["a namespace import", `import * as cp from "node:child_process";\nvoid cp;\n`],
      ["a re-export", `export { spawn } from "node:child_process";\n`],
      ["require()", `const { spawn } = require("node:child_process");\nvoid spawn;\n`],
      ["a dynamic import", `const cp = await import("node:child_process");\nvoid cp;\n`],
      ["a bare spawn() call", `const child = spawn(cmd, args, { shell: true });\n`],
      ["an exec() call", `exec("rm -rf /", (e) => {\n  void e;\n});\n`],
      ["an execFile() call", `void execFile(file, args);\n`],
      ["a fork() call", `const w = fork(modulePath);\n`],
      ["a spawnSync() call", `const r = spawnSync(file, args);\n`],
      ["a call hidden in a ternary", `const c = windows ? spawn(a) : b;\n`],
    ];

    for (const [name, source] of planted) {
      it(name, () => {
        const file = plant("packages/daemon/src/planted.ts", source);
        expect(violations([file])).not.toEqual([]);
      });
    }

    it("would NOT have caught it inside the allowlisted file", () => {
      const file = plant(ALLOWED, `import { spawn } from "node:child_process";\nspawn(a, b);\n`);
      expect(violations([file])).toEqual([]);
    });
  });

  // ── the exemptions, which are what stop the guard from being deleted ───────────────────────
  describe("does not fire on the legal uses", () => {
    it("exempts the `typeof import(...)` type query in SupervisorOptions", () => {
      const file = plant(
        "packages/core/src/process/supervisor.ts",
        `export interface O {\n  readonly spawnFn?: typeof import("node:child_process").spawn;\n}\n`,
      );
      expect(violations([file])).toEqual([]);
    });

    it("exempts a type-only import", () => {
      const file = plant(
        "packages/core/src/process/agent-process.ts",
        `import type { ChildProcess } from "node:child_process";\nexport type C = ChildProcess;\n`,
      );
      expect(violations([file])).toEqual([]);
    });

    it("exempts a doc comment naming the module, quotes and all", () => {
      const file = plant(
        "packages/protocol/src/contracts.ts",
        `/** Only spawn.ts may import "node:child_process" — and only it may call spawn(). */\nexport type X = 1;\n`,
      );
      expect(violations([file])).toEqual([]);
    });

    it("exempts a `spawn(...)` METHOD declaration and a `.spawn(...)` method call", () => {
      const file = plant(
        "packages/daemon/src/registry.ts",
        `export interface S {\n  spawn(spec: SpawnSpec): Promise<AgentProcess>;\n}\n` +
          `const impl = {\n  spawn(spec) {\n    return null;\n  },\n};\n` +
          `const p = await deps.supervisor.spawn(spec);\nvoid impl;\nvoid p;\n`,
      );
      expect(violations([file])).toEqual([]);
    });

    it("exempts `re.exec(...)`, which is a regular expression and not a process", () => {
      const file = plant("packages/client/src/sse-parse.ts", `const m = /a(b)/.exec(line);\n`);
      expect(violations([file])).toEqual([]);
    });
  });

  // ── M1's two new spawn-shaped call sites (M1-PLAN §3, "extended to runtime/probe.ts") ──────
  //
  // M1 adds two places a reader would reasonably expect a `child_process` import to appear, and
  // neither may have one:
  //
  //  - `runtime/probe.ts` (M1-WP-E) launches an agent to ask it what it implements;
  //  - `process/fingerprint.ts` (M1-WP-C) runs `ps -o lstart=` on darwin (§15.7).
  //
  // Both go through the seams that already exist — `Supervisor.spawn` and the injected
  // `RunUtility` — so the allowlist stays at one file. The assertions below are IN the scanned
  // tree rather than about it, so they go red the moment either file grows an import.
  describe("M1's new launch sites stay behind the existing seams", () => {
    const covered = (path: string): SourceFile => {
      const file = files.find((f) => f.path === path);
      if (file === undefined) throw new Error(`the scan does not cover ${path}`);
      return file;
    };

    for (const path of [
      "packages/core/src/runtime/probe.ts",
      "packages/core/src/process/fingerprint.ts",
    ]) {
      it(`${path} is scanned, and imports nothing from node:child_process`, () => {
        const file = covered(path);
        expect(moduleReferences(file)).toEqual([]);
        expect(spawnCallSites(file)).toEqual([]);
      });
    }

    it("fingerprint.ts reaches `ps` only through the injected RunUtility", () => {
      const source = covered("packages/core/src/process/fingerprint.ts").text;
      expect(source).toContain("RunUtility");
      // Never by importing the module that owns the spawn — the same rule review R8 set for
      // `platform-windows.ts`'s `taskkill` / `tasklist`.
      expect(source).not.toMatch(/from\s+["']\.\/spawn\.js["']/);
    });
  });
});
