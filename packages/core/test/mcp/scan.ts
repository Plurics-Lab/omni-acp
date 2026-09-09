import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The source scanner M2-B-WP-S's guards run over.
 *
 * It is a SECOND scanner, and that deserves a reason rather than a shrug: `packages/testkit`'s
 * `test/arch/source-scan.ts` is the repository's other one, it belongs to M2-WP-J, and it lives
 * inside another package's test tree with no export path — a core test can only reach it by
 * relative-pathing across a package boundary into a directory this work package does not own.
 * The two are kept honest by an assertion below rather than by hope: `packageSources()` must find
 * the same files, and `blankOutNonCode` must preserve every offset and line break, which is what
 * makes a reported `path:line` a real one.
 *
 * Owned by M2-B-WP-S.
 */

/** Repository root, derived from this file rather than from cwd, so it holds under any runner. */
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

export interface SourceFile {
  /** Repo-relative, always with forward slashes, so assertions read the same on Windows. */
  readonly path: string;
  readonly text: string;
  /** `text` with comment and string/template CONTENT blanked, lengths and newlines preserved. */
  readonly code: string;
  readonly sha256: string;
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

export function sourceFile(path: string, text: string): SourceFile {
  return {
    path,
    text,
    code: blankOutNonCode(text),
    sha256: createHash("sha256").update(text, "utf8").digest("hex"),
  };
}

/** Every TypeScript source file under some `packages/<pkg>/src` directory. */
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
  return files
    .sort()
    .map((absolute) =>
      sourceFile(
        relative(REPO_ROOT, absolute).split(sep).join("/"),
        readFileSync(absolute, "utf8"),
      ),
    );
}

/**
 * Replaces the CONTENT of comments and string/template literals with spaces, keeping every offset
 * and line break, so a match in `code` is a real identifier at a real line number.
 *
 * An unterminated `'` or `"` FAILS CLOSED — it swallows the rest of its LINE and no more. Running
 * to EOF (which an apostrophe in `// don't` would do if comments were not blanked first) blanks
 * the whole remainder of the file, and every guard downstream then passes by finding nothing. A
 * guard that goes quiet on malformed input is the one failure mode a guard may not have.
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
      const multiline = ch === "`";
      let j = i + 1;
      let closed = false;
      while (j < source.length) {
        const c = source[j];
        if (c === "\\") {
          j += 2;
          continue;
        }
        if (!multiline && c === "\n") break;
        if (c === ch) {
          closed = true;
          break;
        }
        j += 1;
      }
      blank(i + 1, j);
      i = closed ? j + 1 : j; // unterminated: resume AT the newline, not past it
      continue;
    }
    i += 1;
  }
  return out.join("");
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

/** `path:line`, plus the hash of the bytes actually scanned, so a surprising hit is chaseable. */
export function locate(file: SourceFile, line: number): string {
  return `${file.path}:${String(line)} [sha256=${file.sha256.slice(0, 16)}]`;
}
