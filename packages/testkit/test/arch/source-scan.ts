import { createHash } from "node:crypto";
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
  /** `text` with comments, string/template and regex literals blanked (lengths preserved). */
  readonly code: string;
  /**
   * The identity of the BYTES this scan actually ran over — sha256 of `text`, and its length.
   *
   * They exist because an architecture guard's failure message has to be attributable. A red
   * `no-direct-spawn` once named a line whose only occurrence of the forbidden specifier is
   * backtick-quoted inside a doc comment, i.e. a match the scanner cannot produce from the file
   * as it is on disk. With these on every violation string, the next such red either names a
   * real import — reproducible by hashing the file — or proves that the text this process read
   * was not the text the file holds, which is a toolchain report rather than a code change.
   */
  readonly sha256: string;
  readonly bytes: number;
}

/** The one place a `SourceFile` is built, so `text`, `code`, `sha256` and `bytes` cannot drift. */
export function sourceFile(o: { path: string; absolute: string; text: string }): SourceFile {
  return {
    path: o.path,
    absolute: o.absolute,
    text: o.text,
    code: blankOutNonCode(o.text),
    sha256: createHash("sha256").update(o.text, "utf8").digest("hex"),
    bytes: Buffer.byteLength(o.text, "utf8"),
  };
}

/**
 * `path:line`, plus the evidence that makes a surprising hit attributable: the scanned file's
 * hash and byte length, and the 80 characters of `text` around the match.
 */
export function locate(file: SourceFile, at: number, line: number): string {
  const window = JSON.stringify(file.text.slice(Math.max(0, at - 40), at + 40));
  return `${file.path}:${String(line)} [sha256=${file.sha256.slice(0, 16)} bytes=${String(
    file.bytes,
  )} near=${window}]`;
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
  return files.sort().map((absolute) =>
    sourceFile({
      absolute,
      path: relative(REPO_ROOT, absolute).split(sep).join("/"),
      text: readFileSync(absolute, "utf8"),
    }),
  );
}

/**
 * A `/` starts a regex literal only where an OPERAND may begin. This is the standard
 * lexer-level heuristic: after `(`, `,`, `=`, `:`, `[`, `!`, `&`, `|`, `?`, `{`, `;`, an
 * arithmetic operator, or one of the keywords below, a `/` cannot be division. After an
 * identifier, a literal, `)` or `]`, it must be.
 */
const REGEX_PRECEDERS = new Set("([{,;:=!&|?+-*%~^<>".split(""));
const REGEX_KEYWORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);
const IDENT = /[A-Za-z0-9_$]/;

/** `scanned` is the partially blanked output, so a preceding comment already reads as spaces. */
function startsRegex(scanned: readonly string[], at: number): boolean {
  let j = at - 1;
  while (j >= 0 && /\s/.test(scanned[j] ?? "")) j -= 1;
  if (j < 0) return true;
  const ch = scanned[j] ?? "";
  if (REGEX_PRECEDERS.has(ch)) return true;
  if (!IDENT.test(ch)) return false;
  let k = j;
  while (k >= 0 && IDENT.test(scanned[k] ?? "")) k -= 1;
  return REGEX_KEYWORDS.has(scanned.slice(k + 1, j + 1).join(""));
}

/**
 * Replaces the CONTENT of comments, string/template literals and regex literals with spaces,
 * keeping every offset and line break, so a match in `code` is a real identifier at a real line
 * number.
 *
 * Two rules keep this honest rather than merely convenient:
 *
 *  - An unterminated `'` or `"` FAILS CLOSED — it swallows the rest of its LINE and no more.
 *    Scanning to EOF (which is what an unmatched apostrophe in `// don't` used to do before
 *    comments were stripped first, and what any future stray quote would do) blanks the whole
 *    remainder of the file, and every guard downstream then passes by finding nothing. A guard
 *    that goes quiet on malformed input is the one failure mode a guard may not have.
 *  - Regex literals are recognized, because `/^[^"]+$/` contains a quote that would otherwise
 *    open a string and blank everything to the end of the line.
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
      // Only a template literal may cross a newline; for the other two, the line end is a
      // terminator that fails closed.
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
    if (ch === "/" && startsRegex(out, i)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < source.length) {
        const c = source[j];
        if (c === "\\") {
          j += 2;
          continue;
        }
        if (c === "\n") break; // a regex literal cannot span lines
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) {
          closed = true;
          break;
        }
        j += 1;
      }
      if (closed) {
        blank(i + 1, j);
        i = j + 1;
        continue;
      }
      // Not a regex after all — the heuristic guessed wrong, so leave the `/` as division and
      // blank nothing.
      i += 1;
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
