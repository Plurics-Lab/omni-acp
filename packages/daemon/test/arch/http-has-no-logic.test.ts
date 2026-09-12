import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WORKER_STATES } from "@omni-acp/protocol";

/**
 * Architecture guard: `http-has-no-logic` (CONTRACTS.md §10.2, D15 constraint 1).
 *
 * Nothing under `packages/daemon/src/http/**` may import `@omni-acp/core` or
 * `node:child_process`, and nothing there may branch on domain state — no `WorkerState` literal,
 * no status decision of its own. Every route is parse -> ONE daemon call -> serialize; the
 * companion "exactly one WorkerRegistry method" assertion lives in `test/http/routes.test.ts`.
 *
 * `sse.ts` is exempt for EXACTLY two things (review R7): the heartbeat interval, and the
 * stream-terminal predicate that recognises a closed-worker envelope in order to write
 * `omni.stream_end`. Both are transport concerns §8.4 mandates. When M1 moves the predicate into
 * `protocol` as `isWorkerClosedEnvelope(e)` and injects a `Clock` into `SseOptions`, the two
 * exemptions below can go and this file gets simpler.
 *
 * Scans are over CODE, never over prose: the forbidden names appear legally in the doc comments
 * that explain why they are forbidden, and a guard that fires on its own rationale teaches
 * people to delete the rationale (amendment A8).
 */

const HTTP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "http");

/** The one exempt file, and the one thing each exemption buys. */
const TIMER_EXEMPT = "sse.ts";
const STATE_LITERAL_EXEMPT = { file: "sse.ts", literal: "closed" };

/** `errors.ts` is the single mapper; a status may be decided there and nowhere else (§9). */
const STATUS_EXEMPT = "errors.ts";

interface Source {
  readonly file: string;
  readonly text: string;
  /** Comments blanked, string CONTENT kept — for literal scans. */
  readonly code: string;
  /** Comments and string content blanked — for identifier and number scans. */
  readonly bare: string;
}

/** Blanks comments, and optionally string content, preserving every offset and line break. */
function blank(source: string, stripStrings: boolean): string {
  const out = source.split("");
  const erase = (from: number, to: number): void => {
    for (let i = from; i < to && i < out.length; i++) if (out[i] !== "\n") out[i] = " ";
  };

  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === "//") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      erase(i, stop);
      i = stop;
      continue;
    }
    if (two === "/*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      erase(i, stop);
      i = stop;
      continue;
    }
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      let closed = false;
      while (j < source.length) {
        const c = source[j];
        if (c === "\\") {
          j += 2;
          continue;
        }
        // Only a template literal may cross a newline; for the other two the line end is a
        // terminator that fails CLOSED, so a stray quote cannot blank the rest of the file and
        // leave every check below silently passing.
        if (ch !== "`" && c === "\n") break;
        if (c === ch) {
          closed = true;
          break;
        }
        j += 1;
      }
      if (stripStrings) erase(i + 1, j);
      i = closed ? j + 1 : j;
      continue;
    }
    i += 1;
  }
  return out.join("");
}

function read(file: string, text: string): Source {
  return { file, text, code: blank(text, false), bare: blank(text, true) };
}

/**
 * RECURSIVE, since the Land step split `routes.ts` into `routes/` (M1-PLAN §1.1): four route
 * families, four owners, one guard. A non-recursive scan would have kept passing while every new
 * route in the repository went unchecked, which is the exact way a guard goes quiet.
 *
 * `file` is the path RELATIVE to `src/http`, so the exemptions below still name one file each.
 */
function httpSources(dir = HTTP_DIR, prefix = ""): Source[] {
  const out: Source[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...httpSources(join(dir, entry.name), rel));
    else if (entry.name.endsWith(".ts"))
      out.push(read(rel, readFileSync(join(dir, entry.name), "utf8")));
  }
  return out;
}

/** Module specifiers a file statically imports, exports-from, or imports dynamically. */
function imports(source: Source): string[] {
  const found = new Set<string>();
  const patterns = [
    /(?:^|\n)\s*(?:import|export)\b[^;\n]*?\bfrom\s*["']([^"']+)["']/g,
    /(?:^|\n)\s*import\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const re of patterns) {
    for (const m of source.text.matchAll(re)) if (m[1] !== undefined) found.add(m[1]);
  }
  return [...found];
}

const FORBIDDEN_IMPORTS = ["@omni-acp/core", "node:child_process", "child_process"];

function forbiddenImports(source: Source): string[] {
  return imports(source).filter((spec) => FORBIDDEN_IMPORTS.includes(spec));
}

/** `WorkerState` values as quoted literals — the shape a domain branch takes in this layer. */
function stateLiterals(source: Source): string[] {
  const hits: string[] = [];
  for (const state of WORKER_STATES) {
    const re = new RegExp(`["'\`]${state}["'\`]`, "g");
    for (const _ of source.code.matchAll(re)) hits.push(state);
  }
  return hits;
}

/** A 4xx/5xx literal is a status decision; only the one mapper may make one. */
function statusNumbers(source: Source): string[] {
  return [...source.bare.matchAll(/\b([45]\d\d)\b/g)].map((m) => m[1] ?? "");
}

function timers(source: Source): string[] {
  return [...source.bare.matchAll(/\b(setInterval|setTimeout)\b/g)].map((m) => m[1] ?? "");
}

describe("guard: http-has-no-logic", () => {
  const sources = httpSources();

  it("covers every file under src/http (a rename must not make this guard vacuous)", () => {
    expect(sources.map((s) => s.file)).toEqual([
      "app.ts",
      "auth-middleware.ts",
      "errors.ts",
      "routes/agents.ts",
      // M2's four route modules (H22-H26). Each feature adds its OWN file beside `workers.ts`,
      // which is M1's routes split reused unchanged — and every one of them is covered by the
      // same guard, recursively, which is what this list exists to keep true.
      "routes/config.ts",
      // M3-WP1's seven routes, in the same shape and under the same guard, recursively — which is
      // what this list exists to keep true.
      "routes/credentials.ts",
      "routes/index.ts",
      "routes/interactions.ts",
      "routes/lease.ts",
      "routes/runs.ts",
      "routes/webhooks.ts",
      "routes/workers.ts",
      "sse.ts",
    ]);
  });

  it("imports neither @omni-acp/core nor node:child_process, anywhere — sse.ts included", () => {
    for (const source of sources) {
      expect({ file: source.file, forbidden: forbiddenImports(source) }).toEqual({
        file: source.file,
        forbidden: [],
      });
    }
  });

  it("talks to the daemon through the CONTRACT, never through the library's own modules", () => {
    // If this list ever needs `../registry.js`, the adapter has stopped being an adapter and
    // "delete the HTTP layer and the library still tests" has quietly become false.
    // `../../types.js` and `../auth-middleware.js` appear once the route modules live a
    // directory deeper. The rule is unchanged and is the one that matters: the adapter reaches
    // the daemon through the CONTRACT (`types.js`) and its own siblings, never through
    // `../registry.js`.
    const allowed =
      /^(@omni-acp\/protocol|hono|\.\.\/\.\.\/types\.js|\.\.\/types\.js|\.\.\/[\w-]+\.js|\.\/[\w-]+\.js|\.\/routes\/[\w-]+\.js)$/;
    for (const source of sources) {
      for (const spec of imports(source)) {
        expect({ file: source.file, spec, ok: allowed.test(spec) }).toEqual({
          file: source.file,
          spec,
          ok: true,
        });
      }
    }
  });

  it("branches on no WorkerState literal, with sse.ts's ONE documented exemption", () => {
    for (const source of sources) {
      const hits = stateLiterals(source);
      const expected =
        source.file === STATE_LITERAL_EXEMPT.file ? [STATE_LITERAL_EXEMPT.literal] : [];
      expect({ file: source.file, hits }).toEqual({ file: source.file, hits: expected });
    }
  });

  it("decides no status of its own: 4xx/5xx literals live in the one mapper", () => {
    for (const source of sources) {
      if (source.file === STATUS_EXEMPT) continue;
      expect({ file: source.file, statuses: statusNumbers(source) }).toEqual({
        file: source.file,
        statuses: [],
      });
    }
  });

  it("keeps every timer inside sse.ts's heartbeat exemption", () => {
    for (const source of sources) {
      if (source.file === TIMER_EXEMPT) continue;
      expect({ file: source.file, timers: timers(source) }).toEqual({
        file: source.file,
        timers: [],
      });
    }
  });

  it("reads ERROR_STATUS in exactly one place", () => {
    const readers = sources.filter((s) => /\bERROR_STATUS\b/.test(s.bare)).map((s) => s.file);
    expect(readers).toEqual([STATUS_EXEMPT]);
  });
});

describe("guard: http-has-no-logic FIRES on a planted violation", () => {
  // A guard nobody has watched fail is a guard nobody knows works (M0-PLAN §5.2).
  it("catches a planted @omni-acp/core import, even one hidden behind a dynamic import", () => {
    expect(
      forbiddenImports(read("planted.ts", `import { createWorker } from "@omni-acp/core";`)),
    ).toEqual(["@omni-acp/core"]);
    expect(
      forbiddenImports(read("planted.ts", `const m = await import("node:child_process");`)),
    ).toEqual(["node:child_process"]);
  });

  it("catches a planted domain branch and a planted status decision", () => {
    expect(
      stateLiterals(read("planted.ts", `if (worker.state === "running") return c.json({}, 409);`)),
    ).toEqual(["running"]);
    expect(
      statusNumbers(read("planted.ts", `if (worker.state === "running") return c.json({}, 409);`)),
    ).toEqual(["409"]);
    expect(timers(read("planted.ts", `setTimeout(() => reap(), 10);`))).toEqual(["setTimeout"]);
  });

  it("does NOT fire on prose: the rationale names what it forbids", () => {
    const prose = `
      // A route must never branch on "running" or return 409 itself; that is the mapper's job.
      /* Nor may it import "@omni-acp/core" or call setInterval. */
      export const ok = 1;
    `;
    const planted = read("prose.ts", prose);
    expect(stateLiterals(planted)).toEqual([]);
    expect(statusNumbers(planted)).toEqual([]);
    expect(timers(planted)).toEqual([]);
    expect(forbiddenImports(planted)).toEqual([]);
  });

  it("fails CLOSED on a stray quote instead of going quiet", () => {
    // An unterminated string swallows its LINE and no more; scanning to EOF would blank the
    // rest of the file and every check above would then pass by finding nothing.
    const planted = read(
      "stray.ts",
      `const s = "unterminated;\nif (w.state === "running") return c.json({}, 500);\n`,
    );
    expect(statusNumbers(planted)).toEqual(["500"]);
  });
});
