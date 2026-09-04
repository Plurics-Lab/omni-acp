import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, "..", "..");

/**
 * Names that would make the reducer — or the suite that proves it is a reducer — depend on
 * something other than its arguments. They are listed as STRINGS, and the scan below looks at
 * identifier nodes, so this file passes its own guard (M0-PLAN WP-3 acceptance 5).
 *
 * `Clock.setTimer` is deliberately absent: the injected clock is the Worker's, and the
 * normalizer never touches it — `step()` returns `scheduleTickAt` and the Worker arms the timer
 * (CONTRACTS.md §7.6). A test that used `clock.setTimer` would still be timer-free in the sense
 * that matters, and a name-based guard that banned it would be banning the wrong thing.
 */
const FORBIDDEN_NAMES = new Set([
  "setTimeout",
  "setInterval",
  "setImmediate",
  "clearTimeout",
  "clearInterval",
  "queueMicrotask",
  "requestAnimationFrame",
  "Promise",
  "useFakeTimers",
  "useRealTimers",
  "advanceTimersByTime",
  "runAllTimers",
]);



interface Hit {
  readonly line: number;
  readonly what: string;
}

/** Async / timer usage as the PARSER sees it: prose and string literals cannot trip it. */
function impurities(fileName: string, text: string): Hit[] {
  const source = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const hits: Hit[] = [];
  const at = (node: ts.Node): number =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

  const visit = (node: ts.Node): void => {
    if (ts.isAwaitExpression(node)) hits.push({ line: at(node), what: "await" });
    if (ts.canHaveModifiers(node)) {
      for (const modifier of ts.getModifiers(node) ?? []) {
        if (modifier.kind === ts.SyntaxKind.AsyncKeyword) {
          hits.push({ line: at(node), what: "async" });
        }
      }
    }
    if (ts.isForOfStatement(node) && node.awaitModifier !== undefined) {
      hits.push({ line: at(node), what: "for await" });
    }
    if (ts.isIdentifier(node) && FORBIDDEN_NAMES.has(node.text)) {
      hits.push({ line: at(node), what: node.text });
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(source, visit);
  return hits;
}

interface Scanned {
  path: string;
  absolute: string;
  text: string;
}

function tsFilesIn(dir: string, recursive = false): Scanned[] {
  const out: Scanned[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const absolute = join(dir, entry);
    if (statSync(absolute).isDirectory()) {
      if (recursive) out.push(...tsFilesIn(absolute, true));
      continue;
    }
    if (!entry.endsWith(".ts") || entry.endsWith(".d.ts")) continue;
    out.push({
      absolute,
      path: relative(PACKAGE_ROOT, absolute).split(sep).join("/"),
      text: readFileSync(absolute, "utf8"),
    });
  }
  return out;
}

/**
 * M1's `normalizer-is-pure` (CONTRACTS.md §10.2) adds three bans, for `src` ONLY:
 * `normalizer/map/**` and `turn-lifecycle.ts` "import no `node:*`, no `Date`, no `Math.random`".
 *
 * A reducer that reached for a platform module could not run in a browser, a worker, or a
 * deterministic replay — and `Date` / `Math.random` are the two ways a pure function silently
 * stops being one. The sha256 under `map/digest.ts` is implemented rather than imported from
 * `node:crypto` for exactly this reason, and `digest.test.ts` proves it against `node:crypto`.
 *
 * `src` only: a TEST may legally name a fixed epoch, and every one of them does.
 */
function nonDeterminism(fileName: string, text: string): Hit[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: Hit[] = [];
  const at = (node: ts.Node): number =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const visit = (node: ts.Node): void => {
    // `Date` as a VALUE — `new Date()`, `Date.now()`. A type position (`readonly at: Date`)
    // cannot make a function impure, and banning it would be banning the wrong thing.
    if (ts.isIdentifier(node) && node.text === "Date" && !isTypePosition(node)) {
      found.push({ line: at(node), what: "Date" });
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "Math" &&
      node.name.text === "random"
    ) {
      found.push({ line: at(node), what: "Math.random" });
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return found;
}

function isTypePosition(node: ts.Node): boolean {
  let parent: ts.Node | undefined = node.parent;
  while (parent !== undefined) {
    if (ts.isTypeNode(parent)) return true;
    parent = parent.parent;
  }
  return false;
}

/** Module specifiers a `src/normalizer` file may not import. */
function nodeImports(text: string): string[] {
  const found: string[] = [];
  for (const re of [
    /(?:^|\n)\s*(?:import|export)\b[^;\n]*?\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ]) {
    for (const m of text.matchAll(re)) {
      const spec = m[1];
      if (spec !== undefined && spec.startsWith("node:")) found.push(spec);
    }
  }
  return found;
}

/**
 * Guard: the Normalizer is a PURE, TIMER-FREE, ASYNC-FREE reducer, and so is the suite that
 * proves it (M0-PLAN WP-3 acceptance 5).
 *
 * The suite matters as much as the implementation: a quiet-window test written with real timers
 * would pass on a normalizer that scheduled its own `idle`, and the property CONTRACTS.md §7.6
 * actually needs — "same inputs => same outputs, forever", with the Worker owning the clock —
 * would go untested while looking tested.
 */
/**
 * The ONE part of the suite that is allowed to be impure, named individually with its reason.
 *
 * `test/normalizer/e2e/**` drives a REAL Worker over REAL pipes and shells out to `git apply`;
 * neither is a reducer test, and neither can be written without `await`. Excluding a DIRECTORY
 * silently would be the hole this guard exists to prevent, so the exclusion is a list, the list
 * is asserted to be exactly what is on disk, and every file in it is asserted NOT to test the
 * reducer's timing — `stepTurnLifecycle` and `scheduleTickAt` may not appear there.
 */
const IMPURE_BY_DESIGN: readonly string[] = [
  "test/normalizer/e2e/close-out-ladder.test.ts",
  "test/normalizer/e2e/support.ts",
  "test/normalizer/e2e/vendor-patch.test.ts",
];

describe("guard: the normalizer and its suite are timer-free", () => {
  const srcFiles = tsFilesIn(join(PACKAGE_ROOT, "src", "normalizer"), true);
  const files = [...srcFiles, ...tsFilesIn(join(PACKAGE_ROOT, "test", "normalizer"))];

  it("scans a real corpus, implementation and suite alike", () => {
    expect(files.length).toBeGreaterThanOrEqual(4);
    expect(files.map((f) => f.path)).toContain("src/normalizer/normalizer.ts");
    expect(files.map((f) => f.path)).toContain("src/normalizer/turn-lifecycle.ts");
    expect(files.map((f) => f.path)).toContain("test/normalizer/turn-lifecycle.test.ts");
    expect(files.map((f) => f.path)).toContain("test/normalizer/purity.test.ts");
    // RECURSIVELY, for `src`: `map/**` and `vendor/**` are the mapping path and are exactly what
    // §10.2's `normalizer-is-pure` names. A flat scan would have passed over all of it.
    expect(files.map((f) => f.path)).toContain("src/normalizer/map/update.ts");
    expect(files.map((f) => f.path)).toContain("src/normalizer/vendor/dialects.ts");
  });

  it("§10.2's `normalizer-is-pure`: no `node:*`, no `Date`, no `Math.random` in src", () => {
    const offenders = srcFiles.flatMap((f) => [
      ...nodeImports(f.text).map((spec) => `${f.path} imports ${spec}`),
      ...nonDeterminism(f.path, f.text).map((h) => `${f.path}:${String(h.line)} ${h.what}`),
    ]);
    expect(offenders).toEqual([]);
  });

  it("…and would catch each of the three, while ignoring a type position", () => {
    const scan = (text: string): string[] =>
      [
        ...nodeImports(text).map((spec) => `imports ${spec}`),
        ...nonDeterminism("<planted>", text).map((h) => `${String(h.line)}:${h.what}`),
      ].sort();

    expect(scan('import { createHash } from "node:crypto";\n')).toEqual(["imports node:crypto"]);
    expect(scan("const t = Date.now();\n")).toEqual(["1:Date"]);
    expect(scan("const r = Math.random();\n")).toEqual(["1:Math.random"]);
    expect(scan("interface X { at: Date }\n")).toEqual([]);
    expect(scan('import { record } from "./json.js";\n')).toEqual([]);
  });

  it("the impure corner of the SUITE is named, not a silently-skipped directory", () => {
    const e2eDir = join(PACKAGE_ROOT, "test", "normalizer", "e2e");
    const onDisk = tsFilesIn(e2eDir, true).map((f) => f.path);
    expect(onDisk.sort()).toEqual([...IMPURE_BY_DESIGN].sort());

    for (const path of IMPURE_BY_DESIGN) {
      const text = readFileSync(join(PACKAGE_ROOT, path), "utf8");
      // They may `await` a process; they may NOT be reducer-timing tests wearing a disguise.
      expect(`${path}: ${String(text.includes("stepTurnLifecycle"))}`).toBe(`${path}: false`);
      expect(`${path}: ${String(text.includes("scheduleTickAt"))}`).toBe(`${path}: false`);
    }
  });

  it("contains no await, no async and no timer anywhere", () => {
    const offenders = files.flatMap((f) =>
      impurities(f.path, f.text).map((h) => `${f.path}:${h.line} ${h.what}`),
    );
    expect(offenders).toEqual([]);
  });

  it("would catch the real thing while ignoring prose and string literals", () => {
    const scan = (text: string): string[] =>
      impurities("<planted>", text).map((h) => `${h.line}:${h.what}`);

    expect(scan("// setTimeout is banned here\n")).toEqual([]);
    expect(scan('const banned = "setTimeout";\n')).toEqual([]);
    expect(scan("/*\n * await\n */\n")).toEqual([]);
    expect(scan("const t = clock.setTimer(5, fn);\n")).toEqual([]);

    expect(scan("setTimeout(() => {}, 5);\n")).toEqual(["1:setTimeout"]);
    expect(scan("const f = async () => {};\n")).toEqual(["1:async"]);
    expect(scan("async function f() {\n  await g();\n}\n")).toEqual(["1:async", "2:await"]);
    expect(scan("const p = new Promise(() => {});\n")).toEqual(["1:Promise"]);
    expect(scan("vi.useFakeTimers();\n")).toEqual(["1:useFakeTimers"]);
    expect(scan("for await (const x of y) {\n}\n")).toEqual(["1:for await"]);
  });
});
