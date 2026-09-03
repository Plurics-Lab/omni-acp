import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root, derived from this file rather than from cwd, so it holds under any runner. */
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

export interface SourceFile {
  /** Repo-relative, always with forward slashes, so assertions read the same on Windows. */
  readonly path: string;
  readonly absolute: string;
  readonly text: string;
  /** `text` with comments and string/template literals blanked out (lengths preserved). */
  readonly code: string;
}

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "vitest-report", "coverage"]);

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(full);
  }
}

/**
 * Every TypeScript source file under some `packages/<pkg>/src` directory.
 *
 * Guards run over `code`, not `text`: CONTRACTS.md §6.1 / amendment A8 are explicit that these
 * are import and call-site scans, never substring scans — the forbidden names appear legally in
 * doc comments, and a guard that fires on prose teaches people to delete the prose.
 */
export function packageSources(): SourceFile[] {
  const files: string[] = [];
  for (const pkg of readdirSync(join(REPO_ROOT, "packages"))) {
    const src = join(REPO_ROOT, "packages", pkg, "src");
    try {
      if (!statSync(src).isDirectory()) continue;
    } catch {
      continue;
    }
    walk(src, files);
  }
  return files.sort().map((absolute) => {
    const text = readFileSync(absolute, "utf8");
    return {
      absolute,
      path: relative(REPO_ROOT, absolute).split(sep).join("/"),
      text,
      code: blankOutNonCode(text),
    };
  });
}

/**
 * Replaces the CONTENT of comments and string/template literals with spaces, keeping every
 * offset and line break, so a match in `code` is a real identifier at a real line number.
 */
export function blankOutNonCode(source: string): string {
  const out = source.split("");
  const blank = (from: number, to: number): void => {
    for (let i = from; i < to && i < out.length; i++) {
      if (out[i] !== "\n") out[i] = " ";
    }
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
        j += 1;
      }
      blank(i + 1, j);
      i = Math.min(j + 1, source.length);
      continue;
    }
    i += 1;
  }
  return out.join("");
}

/** Every module specifier a file statically imports, exports-from, or dynamically imports. */
export function importedModules(file: SourceFile): string[] {
  const found = new Set<string>();
  const patterns = [
    /(?:^|\n)\s*(?:import|export)\b[^;\n]*?\bfrom\s*["']([^"']+)["']/g,
    /(?:^|\n)\s*import\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  // Specifiers live inside string literals, which `code` blanks — so this scans `text` and the
  // callers below check the RESULT, which is a module name rather than a substring.
  for (const re of patterns) {
    for (const m of file.text.matchAll(re)) {
      const spec = m[1];
      if (spec !== undefined) found.add(spec);
    }
  }
  return [...found];
}

/** Line numbers (1-based) where `identifier` is read as a real identifier, not in prose. */
export function identifierHits(file: SourceFile, identifier: string): number[] {
  const re = new RegExp(`\\b${identifier}\\b`, "g");
  const lines: number[] = [];
  for (const m of file.code.matchAll(re)) {
    lines.push(file.code.slice(0, m.index).split("\n").length);
  }
  return lines;
}

export function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(REPO_ROOT, relativePath), "utf8")) as Record<string, unknown>;
}

export function workspaceManifests(): {
  path: string;
  name: string;
  json: Record<string, unknown>;
}[] {
  const paths = [
    ...readdirSync(join(REPO_ROOT, "packages")).map((p) => `packages/${p}/package.json`),
    "tests/integration/package.json",
    "package.json",
  ];
  return paths.map((path) => {
    const json = readJson(path);
    return { path, name: String(json["name"] ?? path), json };
  });
}
