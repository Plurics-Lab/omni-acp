import { describe, expect, it } from "vitest";
import { blankOutNonCode, identifierHits, packageSources } from "./source-scan.js";

const ALLOWED = new Set(["packages/protocol/src/acp.ts"]);

/**
 * Architecture guard: `no-message-id` (CONTRACTS.md §10.2, F3).
 *
 * v1's `ContentChunk.messageId` is OPTIONAL and v2's is required, so any M0 code that reads it
 * works against one agent and silently mis-groups messages from another. Backfill is M1; until
 * then the field does not exist as far as this repository is concerned. `reduceTurn`'s golden
 * corpus asserts the same property behaviourally.
 */
describe("guard: no-message-id", () => {
  const sources = packageSources();

  it("scans a real corpus", () => {
    expect(sources.length).toBeGreaterThan(20);
    expect(sources.map((s) => s.path)).toContain("packages/protocol/src/turn.ts");
  });

  it("reads `messageId` nowhere but the SDK re-export point", () => {
    const offenders = sources
      .filter((s) => !ALLOWED.has(s.path))
      .flatMap((s) => identifierHits(s, "messageId").map((line) => `${s.path}:${line}`));
    expect(offenders).toEqual([]);
  });

  it("would catch a real read while ignoring the prose", () => {
    // The mechanism, asserted: the scan runs over code with comments and string literals
    // blanked out (amendment A8), so a doc comment naming the field is legal and a property
    // read is not. Without this, the guard would be a substring scan that punishes documentation.
    const scan = (text: string): number[] =>
      identifierHits(
        { path: "<planted>", absolute: "<planted>", text, code: blankOutNonCode(text) },
        "messageId",
      );

    expect(scan("// messageId backfill is M1 (F3)\n")).toEqual([]);
    expect(scan("/*\n * messageId\n */\n")).toEqual([]);
    expect(scan('const field = "messageId";\n')).toEqual([]);
    expect(scan("const id = chunk.messageId;\n")).toEqual([1]);
    expect(scan("// prose\nconst { messageId } = chunk;\n")).toEqual([2]);
  });
});
