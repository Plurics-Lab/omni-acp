import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/** Repository root, derived from this file rather than from cwd, so it holds under any runner. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/**
 * The three files allowed to put a value in a `seq` property, each for a reason that is not
 * "it was already there":
 *
 *  - `log-core.ts` IS the assigner. That is the whole point of the guard. It was
 *    `memory-log.ts` through M0; §14.1 moved the ring, the subscribers and the ONE `seq`
 *    assigner into the shared core so that BOTH drivers sit on identical behaviour, and
 *    `memory-log.ts` became a wrapper that assigns nothing. The allowlist moved with the code —
 *    which is exactly what the third test below exists to force.
 *  - `events.ts` declares the wire schema. `seq: z.number().int().positive()` validates a
 *    number that arrived from the network; it never produces one.
 *  - `fake-clock.ts` numbers pending TIMERS so `advance()` can fire same-deadline callbacks in
 *    creation order. Unrelated to the event log, and the testkit is never in the daemon's data
 *    path.
 *
 * `persist/event-store.ts` is deliberately NOT here: the durable store is TOLD what the seq is
 * (§5.1) and only ever copies `e.seq` out of the envelope it was handed.
 */
const ALLOWED = new Set([
  "packages/core/src/event-log/log-core.ts",
  "packages/protocol/src/events.ts",
  "packages/testkit/src/fake-clock.ts",
]);

const ASSIGNMENT_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

const unwrap = (e: ts.Expression): ts.Expression => {
  let node = e;
  for (;;) {
    if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) node = node.expression;
    else if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) node = node.expression;
    else return node;
  }
};

/** `x.seq`, `x?.seq`, `x["seq"]` — reading someone else's seq, at any depth of chaining. */
function isSeqRead(expression: ts.Expression): boolean {
  const node = unwrap(expression);
  if (ts.isPropertyAccessExpression(node)) return node.name.text === "seq";
  if (ts.isElementAccessExpression(node)) {
    const arg = unwrap(node.argumentExpression);
    return ts.isStringLiteralLike(arg) && arg.text === "seq";
  }
  return false;
}

const propertyName = (name: ts.PropertyName): string | null =>
  ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : null;

/**
 * Every place a file INVENTS a `seq` rather than copying one.
 *
 * Type positions are exempt by construction: `readonly seq: Seq` is a `PropertySignature`, not a
 * `PropertyAssignment`, so the parser separates the declaration of the field from the writing
 * of it — which is what makes this guard cheap enough to run over the whole repository and
 * still precise enough to leave `protocol/src/control-plane.ts` alone.
 *
 * Copying is allowed on purpose: `{ turnId, seq: accepted.seq }` is how `PromptAccepted` is
 * built from the envelope the log just returned, and forbidding it would push callers into
 * obfuscating the very thing the guard wants to see. The copy must be SPELLED, though — a
 * shorthand `{ seq }` hides which side of the line it is on, so it is reported and the fix is to
 * write the property access out.
 */
function inventedSeqs(fileName: string, text: string): { line: number; code: string }[] {
  const source = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const hits: { line: number; code: string }[] = [];
  const record = (node: ts.Node): void => {
    hits.push({
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      code: node.getText(source).split("\n")[0]?.trim() ?? "",
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && propertyName(node.name) === "seq") {
      if (!isSeqRead(node.initializer)) record(node);
    } else if (ts.isShorthandPropertyAssignment(node) && node.name.text === "seq") {
      record(node);
    } else if (
      ts.isBinaryExpression(node) &&
      ASSIGNMENT_OPERATORS.has(node.operatorToken.kind) &&
      isSeqRead(node.left)
    ) {
      record(node);
    } else if (
      (ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken) &&
      isSeqRead(node.operand)
    ) {
      record(node);
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(source, visit);
  return hits;
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

function packageSources(): { path: string; text: string }[] {
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
  return files.sort().map((absolute) => ({
    path: relative(REPO_ROOT, absolute).split(sep).join("/"),
    text: readFileSync(absolute, "utf8"),
  }));
}

/**
 * Architecture guard: `seq-single-writer` (CONTRACTS.md §7.6, §8.2, M0-PLAN WP-3 acceptance 4).
 *
 * `EventLog.append()` is the sole assigner of `seq`, synchronously, and everything downstream
 * rests on it: `?since=` recovery, `PromptAccepted.seq - 1` as a subscription cursor, and
 * `reduceTurn`'s `(workerId, seq)` envelope identity. A second writer anywhere — a daemon
 * merging two workers' streams, an SSE frame with a fabricated id — makes two subscribers
 * disagree about history, and no cursor can recover from that.
 *
 * The type system already forbids the common case (`EventInput` has no `seq` field, so stamping
 * one in a `log.append({…})` call is a compile error). This catches the case the type system
 * cannot see: a NEW sequence invented somewhere else.
 */
describe("guard: seq-single-writer", () => {
  const sources = packageSources();

  it("scans a real corpus", () => {
    expect(sources.length).toBeGreaterThan(20);
    expect(sources.map((s) => s.path)).toContain("packages/core/src/event-log/memory-log.ts");
    expect(sources.map((s) => s.path)).toContain("packages/core/src/event-log/log-core.ts");
    expect(sources.map((s) => s.path)).toContain("packages/core/src/persist/event-store.ts");
    expect(sources.map((s) => s.path)).toContain("packages/daemon/src/http/sse.ts");
  });

  it("invents a seq nowhere but the event log", () => {
    const offenders = sources
      .filter((s) => !ALLOWED.has(s.path))
      .flatMap((s) => inventedSeqs(s.path, s.text).map((h) => `${s.path}:${h.line} ${h.code}`));
    expect(
      offenders,
      "EventLog.append() is the only assigner of seq (CONTRACTS.md §8.2). Copy one with an " +
        "explicit read — `{ seq: accepted.seq }` — never a shorthand `{ seq }` and never a " +
        "computed value.",
    ).toEqual([]);
  });

  it("still holds if the allowed files change: each one is scanned and accounted for", () => {
    // An allowlist that outlives its reason is how a guard dies quietly. Every entry must still
    // be a file that exists AND still be a file that actually assigns a seq — otherwise it is a
    // hole waiting for someone to walk through.
    for (const path of ALLOWED) {
      const file = sources.find((s) => s.path === path);
      expect(file, path).toBeDefined();
      expect(inventedSeqs(path, file?.text ?? "").length, path).toBeGreaterThan(0);
    }
  });

  it("catches a planted assignment and leaves the honest ones alone", () => {
    const scan = (text: string): string[] =>
      inventedSeqs("<planted>", text).map((h) => String(h.line));

    // Planted: a second sequence, however it is spelled.
    expect(scan("const e = { seq: 1 };\n")).toEqual(["1"]);
    expect(scan("const e = { kind: k, seq: next++, ts };\n")).toEqual(["1"]);
    expect(scan('const e = { "seq": counter };\n')).toEqual(["1"]);
    expect(scan("envelope.seq = 5;\n")).toEqual(["1"]);
    expect(scan("envelope.seq += 1;\n")).toEqual(["1"]);
    expect(scan("this.#state.seq++;\n")).toEqual(["1"]);
    expect(scan('frame["seq"] = n;\n')).toEqual(["1"]);
    expect(scan("const a = 1;\nconst e = { seq: a };\n")).toEqual(["2"]);
    expect(scan("const seq = counter + 1;\nconst e = { kind, seq };\n")).toEqual(["2"]);

    // Honest: declarations, reads, copies, and prose.
    expect(scan("interface E {\n  readonly seq: Seq;\n}\n")).toEqual([]);
    expect(scan("type E = { seq: number };\n")).toEqual([]);
    expect(scan("function f(seq: Seq) {\n  return seq;\n}\n")).toEqual([]);
    expect(scan("const accepted = { turnId, seq: envelope.seq };\n")).toEqual([]);
    expect(scan("const accepted = { seq: (envelope as EventEnvelope).seq };\n")).toEqual([]);
    expect(scan('const accepted = { seq: envelope["seq"] };\n')).toEqual([]);
    expect(scan("const n = e.seq - 1;\n")).toEqual([]);
    expect(scan("// seq: 1 is assigned only by append()\n")).toEqual([]);
    expect(scan('const s = "seq: 1";\n')).toEqual([]);
  });
});
