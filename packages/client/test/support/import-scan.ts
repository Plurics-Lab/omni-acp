import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** This package's root, derived from this file so it holds under any runner and any cwd. */
export const CLIENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface Violation {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

/**
 * Blanks the CONTENT of comments, keeping every offset and line break — and keeping string,
 * template and regex literals intact, because a module specifier lives inside a string and this
 * scan is about specifiers.
 *
 * The state machine is the whole point. CONTRACTS.md amendment A8 is explicit that
 * `client-has-no-daemon-import` is an IMPORT scan and not a substring scan: `@omni-acp/daemon`
 * appears legally in `local.ts`'s doc comment (twice), and a guard that fired on prose would
 * teach the next person to delete the prose.
 *
 * Two rules keep it honest rather than merely convenient:
 *  - an unterminated quote fails closed at the END OF ITS LINE, never at EOF: a scan-to-EOF
 *    would blank the rest of the file and the guard would pass by finding nothing;
 *  - a regex literal is recognized, so the `/` in `/^[^"]+$/` opens no string.
 */
export function stripComments(source: string): string {
  const out = source.split("");
  const blank = (from: number, to: number): void => {
    for (let i = from; i < to && i < out.length; i++) {
      if (out[i] !== "\n") out[i] = " ";
    }
  };

  const identifier = /[A-Za-z0-9_$]/;
  const regexPreceders = new Set("([{,;:=!&|?+-*%~^<>".split(""));

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
      // The literal's CONTENT survives — this pass removes comments only.
      i = closed ? j + 1 : j;
      continue;
    }

    if (ch === "/") {
      // Decide division vs. regex the standard lexical way: a `/` can start a regex only where
      // an operand may begin.
      let k = i - 1;
      while (k >= 0 && /\s/.test(out[k] ?? "")) k -= 1;
      const prev = k < 0 ? "" : (out[k] ?? "");
      const isRegex = k < 0 || regexPreceders.has(prev) || !identifier.test(prev);
      if (isRegex) {
        let j = i + 1;
        let inClass = false;
        while (j < source.length) {
          const c = source[j];
          if (c === "\\") {
            j += 2;
            continue;
          }
          if (c === "\n") break;
          if (c === "[") inClass = true;
          else if (c === "]") inClass = false;
          else if (c === "/" && !inClass) break;
          j += 1;
        }
        i = j + 1;
        continue;
      }
    }
    i += 1;
  }
  return out.join("");
}

/**
 * Every position at which `specifier` appears as a module specifier, EXCEPT the ones that are
 * the argument of a dynamic `import(...)`.
 *
 * A dynamic import is the one legal way `@omni-acp/daemon` may be named in this package (D14):
 * it is an optional peer, resolved when `local()` runs and never when the module loads. Every
 * other position — `import … from`, `export … from`, a bare `import "…"`, `require("…")` — puts
 * it in the module graph and drags an HTTP server into a browser bundle.
 */
export function staticImportsOf(source: string, specifier: string): number[] {
  const code = stripComments(source);
  const quoted = new RegExp(`(["'])${specifier.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&")}\\1`, "g");
  const lines: number[] = [];
  for (const match of code.matchAll(quoted)) {
    const before = code.slice(0, match.index).trimEnd();
    if (/\bimport\s*\($/.test(before)) continue;
    lines.push(code.slice(0, match.index).split("\n").length);
  }
  return lines;
}

/** Every `.ts` source file under `packages/client/src`, repo-relative with forward slashes. */
export function clientSources(): { path: string; text: string }[] {
  const root = join(CLIENT_ROOT, "src");
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) files.push(full);
    }
  };
  walk(root);
  return files.sort().map((absolute) => ({
    path: relative(CLIENT_ROOT, absolute).split(sep).join("/"),
    text: readFileSync(absolute, "utf8"),
  }));
}
