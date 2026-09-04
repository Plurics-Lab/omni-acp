import { describe, expect, it } from "vitest";
import { blankOutNonCode, identifierHits, packageSources } from "./source-scan.js";

/**
 * Architecture guard: `message-id-optional` (CONTRACTS.md §10.2).
 *
 * IT REPLACES M0's `no-message-id`. F3's guard said the field does not exist as far as this
 * repository is concerned, and that was true for exactly as long as backfill was deferred: M1's
 * map passes `messageId` THROUGH and synthesizes one only when it is absent (§12.4), so a guard
 * that forbade the identifier outright would now forbid the feature.
 *
 * What replaces it is the property that actually matters, and it is the same property the old
 * guard was protecting: v1 types `ContentChunk.messageId` OPTIONAL and v2 REQUIRES it, so code
 * that assumes one is present works against one agent and silently mis-groups messages from
 * another. Every read must therefore tolerate absence, and `reduceTurn` must never require one.
 *
 * Three files may name it: the SDK re-export point, the cross-package seam (which is TYPES ONLY
 * by construction — `MappedUpdate.messageId` is a declaration, and a declaration cannot assume
 * presence), and the map module whose whole subject it is.
 */
const ALLOWED = new Set([
  "packages/protocol/src/acp.ts",
  "packages/protocol/src/contracts.ts",
  "packages/core/src/normalizer/map/message-id.ts",
]);

describe("guard: message-id-optional", () => {
  const sources = packageSources();

  it("scans a real corpus", () => {
    expect(sources.length).toBeGreaterThan(20);
    expect(sources.map((s) => s.path)).toContain("packages/protocol/src/turn.ts");
  });

  it("reads `messageId` only where §12.4 puts it", () => {
    const offenders = sources
      .filter((s) => !ALLOWED.has(s.path))
      .flatMap((s) => identifierHits(s, "messageId").map((line) => `${s.path}:${line}`));
    expect(offenders).toEqual([]);
  });

  /**
   * M1-WP-B lands the reads; M1-WP-F lands this assertion over them (M1-PLAN §3). It is stated
   * as a todo rather than left unwritten so that the obligation is visible in the file that owns
   * it, which is the whole reason the guard was renamed rather than deleted.
   */
  it.todo("every `messageId` read is `?? null`-guarded, and reduceTurn never requires one");

  it("would catch a real read while ignoring the prose", () => {
    // The mechanism, asserted: the scan runs over code with comments and string literals
    // blanked out (amendment A8), so a doc comment naming the field is legal and a property
    // read is not. Without this, the guard would be a substring scan that punishes documentation.
    const scan = (text: string): number[] =>
      identifierHits(
        { path: "<planted>", absolute: "<planted>", text, code: blankOutNonCode(text) },
        "messageId",
      );

    expect(scan("// messageId pass-through is §12.4\n")).toEqual([]);
    expect(scan("/*\n * messageId\n */\n")).toEqual([]);
    expect(scan('const field = "messageId";\n')).toEqual([]);
    expect(scan("const id = chunk.messageId;\n")).toEqual([1]);
    expect(scan("// prose\nconst { messageId } = chunk;\n")).toEqual([2]);
  });
});
