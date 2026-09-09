import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * M2's two WP-I architecture guards (CONTRACTS §27.4), each demonstrated FAILING on a planted
 * violation — §10.2's rule, because a guard nobody has seen fail is a guard nobody knows works.
 *
 *  - `no-elicitation-schema-parse`: no schema parse anywhere on an elicitation path under
 *    `core/src/**`. A `z.object` would strip `_meta._askUserQuestionCustomAnswer`, the marker
 *    that decides WHICH of two properties the agent actually reads (F30: our accept filled both
 *    and the agent created `omni-choice.txt` instead of `notes.md`), and it would strip the FLAT
 *    `sessionId` / `toolCallId`, the only scope the request carries (F29).
 *  - `interaction-id-is-daemon-minted`: no read of a JSON-RPC `id` as an interaction id. F33: the
 *    two agent→client requests share ONE id counter, so the transport id is not an identity a
 *    route may address.
 *
 * Owned by M2-A-WP-I.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");
const CORE_SRC = join(REPO_ROOT, "packages", "core", "src");

const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(full);
  }
}

function coreSources(): { path: string; text: string }[] {
  const files: string[] = [];
  walk(CORE_SRC, files);
  return files.sort().map((absolute) => ({
    path: relative(REPO_ROOT, absolute).split(sep).join("/"),
    text: readFileSync(absolute, "utf8"),
  }));
}

/**
 * The elicitation PATH: every `core/src` file whose name or content puts it on the route from
 * `elicitation/create` to an answer.
 *
 * Deliberately generous — a file that so much as mentions the method is scanned — because the
 * cost of a false positive is one comment reworded and the cost of a miss is F30 shipping again.
 */
function elicitationPath(sources: readonly { path: string; text: string }[]): {
  path: string;
  text: string;
}[] {
  return sources.filter(
    (s) =>
      s.path.includes("/worker/interaction/") ||
      s.path.endsWith("/normalizer/map/elicitation.ts") ||
      s.text.includes("elicitation/create") ||
      s.text.includes("mapElicitation"),
  );
}

/**
 * The ONE exemption, and it is a different OBJECT rather than a different opinion.
 *
 * `InteractionAnswerBody` is the daemon's OWN control-plane body — what a human POSTs to
 * `…/interactions/{reqId}` — declared in `@omni-acp/protocol` and containing not one agent byte.
 * The thing this guard exists to protect is the agent's `elicitation/create` PARAMS, where a
 * schema would strip `_meta._askUserQuestionCustomAnswer` (F30) and the FLAT scope (F29); a
 * schema over our own request body strips nothing of the sort.
 *
 * It is parsed inside `Worker.answerInteraction` because §19.6 puts the body SHAPE check AFTER
 * the lease, and that is the one place downstream of it (review finding V10). The exemption names
 * the schema, so it cannot silently widen to "any parse on this line": the planted-violation test
 * below pins that a second parse on the same line is still caught.
 */
const ANSWER_BODY_PARSE = /\bInteractionAnswerBody\s*\.\s*parse\s*\(/;

/** A schema parse: `z.object(`, `z.strictObject(`, or any `.parse(` / `.safeParse(` call. */
function schemaParses(text: string): string[] {
  const hits: string[] = [];
  const lines = text.split("\n");
  for (const [i, line] of lines.entries()) {
    const rest = line.replace(ANSWER_BODY_PARSE, "");
    // Comments count too: the guard is byte-wise on purpose. A file that has to WRITE one of
    // these words in prose is a file whose prose belongs somewhere else — the same ruling
    // `policy-never-names-an-option` got (M2-R16, review follow-up 7).
    if (/\bz\s*\.\s*(strict)?[Oo]bject\s*\(/.test(rest) || /\.(safeParse|parse)\s*\(/.test(rest)) {
      hits.push(`${String(i + 1)}: ${line.trim()}`);
    }
  }
  return hits;
}

/**
 * A JSON-RPC transport id read as an interaction identity.
 *
 * The AST form, because the string form has too many innocent matches: any property assignment
 * whose name is one of the interaction-identity fields and whose initializer reads `.id` off
 * something that is not already an interaction.
 */
const IDENTITY_FIELDS = new Set(["requestId", "interactionId"]);

function transportIdReads(fileName: string, text: string): { line: number; code: string }[] {
  const source = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const hits: { line: number; code: string }[] = [];

  const reads = (e: ts.Expression): boolean => {
    if (ts.isPropertyAccessExpression(e)) return e.name.text === "id";
    if (ts.isElementAccessExpression(e)) {
      const arg = e.argumentExpression;
      return ts.isStringLiteralLike(arg) && arg.text === "id";
    }
    return false;
  };
  /** `req.id` where `req` is an `InteractionRequest` is the DAEMON's id and is fine. */
  const fromInteraction = (e: ts.Expression): boolean => {
    if (!ts.isPropertyAccessExpression(e)) return false;
    const owner = e.expression;
    const name = ts.isIdentifier(owner)
      ? owner.text
      : ts.isPropertyAccessExpression(owner)
        ? owner.name.text
        : "";
    return /^(req|request|interaction|held|entry|e)$/i.test(name);
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name)) &&
      IDENTITY_FIELDS.has(node.name.text) &&
      reads(node.initializer as ts.Expression) &&
      !fromInteraction(node.initializer as ts.Expression)
    ) {
      hits.push({
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        code: node.getText(source).split("\n")[0]?.trim() ?? "",
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

describe("guard: no-elicitation-schema-parse (§19.3, §27.4)", () => {
  const sources = coreSources();

  it("scans a real corpus, and the elicitation path is in it", () => {
    expect(sources.length).toBeGreaterThan(20);
    const paths = elicitationPath(sources).map((s) => s.path);
    expect(paths).toContain("packages/core/src/normalizer/map/elicitation.ts");
    expect(paths).toContain("packages/core/src/worker/interaction/strategy.ts");
    expect(paths).toContain("packages/core/src/worker/worker.ts");
  });

  it("no elicitation path under core/src parses its params through a schema", () => {
    const offenders = elicitationPath(sources).flatMap((s) =>
      schemaParses(s.text).map((h) => `${s.path}:${h}`),
    );
    expect(
      offenders,
      "A schema parse on an elicitation path strips `_meta._askUserQuestionCustomAnswer` — the " +
        "field that decides which of two properties the agent reads (F30) — and the FLAT scope " +
        "(F29). `link.ts` registers `elicitation/create` with `verbatim` and every reader below " +
        "it narrows by hand.",
    ).toEqual([]);
  });

  it("FAILS on a planted violation", () => {
    const planted = [
      "const Schema = z.object({ mode: z.string() });",
      "const params = Schema.parse(raw);",
    ].join("\n");
    expect(schemaParses(planted)).toHaveLength(2);
    // …and on the exact line the ruling forbids, in a comment as well as in code (byte-wise).
    expect(schemaParses("// a z.object( here would be a violation too")).toHaveLength(1);

    // The ONE exemption is a NAMED schema and nothing wider: our own control-plane answer body
    // passes, and a second parse on the very same line is still caught. Without this, the
    // exemption added for review finding V10 would be a hole any parse could be smuggled through.
    expect(schemaParses("parsed = InteractionAnswerBody.parse(a);")).toEqual([]);
    expect(
      schemaParses("InteractionAnswerBody.parse(a); const p = Elicit.parse(params);"),
    ).toHaveLength(1);
  });
});

describe("guard: interaction-id-is-daemon-minted (F33, §19.1, §27.4)", () => {
  const sources = coreSources();

  it("scans a real corpus", () => {
    expect(sources.map((s) => s.path)).toContain(
      "packages/core/src/worker/interaction/strategy.ts",
    );
  });

  it("no core/src file reads a JSON-RPC id as an interaction id", () => {
    const offenders = sources.flatMap((s) =>
      transportIdReads(s.path, s.text).map((h) => `${s.path}:${String(h.line)} ${h.code}`),
    );
    expect(
      offenders,
      "F33: `elicitation/create` and `session/request_permission` share ONE agent→client " +
        "JSON-RPC id counter (transcript 12: the elicitation is id 0 and the later permission " +
        "is id 1), so a transport id is not an identity a route may address. Mint one with " +
        "`IdGen.interaction()`.",
    ).toEqual([]);
  });

  it("mints every new interaction id through IdGen.interaction()", () => {
    const strategy = sources.find((s) => s.path.endsWith("/worker/interaction/strategy.ts"));
    expect(strategy?.text).toContain("o.ids.interaction()");
    // …and the baseline keeps M1's synthesized id, which is the one documented exception and is
    // documented AT the line.
    const baseline = sources.find((s) => s.path.endsWith("/worker/interaction/baseline.ts"));
    expect(baseline?.text).toContain("id: record.requestId");
  });

  it("FAILS on a planted violation", () => {
    const planted = `
      function handle(msg: { id: number }) {
        return { requestId: msg.id, method: "elicitation/create" };
      }
    `;
    expect(transportIdReads("planted.ts", planted)).toHaveLength(1);
    const bracketed = `const x = { requestId: msg["id"] };`;
    expect(transportIdReads("planted2.ts", bracketed)).toHaveLength(1);
  });

  it("does NOT fire on the daemon-minted id it is there to protect", () => {
    const legitimate = `const payload = { requestId: req.id, method: req.method };`;
    expect(transportIdReads("ok.ts", legitimate)).toEqual([]);
  });
});
