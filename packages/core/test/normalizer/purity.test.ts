import { readFileSync, readdirSync } from "node:fs";
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

function tsFilesIn(dir: string): { path: string; absolute: string; text: string }[] {
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".d.ts"))
    .sort()
    .map((entry) => {
      const absolute = join(dir, entry);
      return {
        absolute,
        path: relative(PACKAGE_ROOT, absolute).split(sep).join("/"),
        text: readFileSync(absolute, "utf8"),
      };
    });
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
describe("guard: the normalizer and its suite are timer-free", () => {
  const files = [
    ...tsFilesIn(join(PACKAGE_ROOT, "src", "normalizer")),
    ...tsFilesIn(join(PACKAGE_ROOT, "test", "normalizer")),
  ];

  it("scans a real corpus, implementation and suite alike", () => {
    expect(files.length).toBeGreaterThanOrEqual(4);
    expect(files.map((f) => f.path)).toContain("src/normalizer/normalizer.ts");
    expect(files.map((f) => f.path)).toContain("src/normalizer/turn-lifecycle.ts");
    expect(files.map((f) => f.path)).toContain("test/normalizer/turn-lifecycle.test.ts");
    expect(files.map((f) => f.path)).toContain("test/normalizer/purity.test.ts");
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
