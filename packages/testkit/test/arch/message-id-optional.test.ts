import { reduceTurn, type EventEnvelope, type TurnId, type WorkerId } from "@omni-acp/protocol";
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
   * The property the guard is actually protecting, over the three files allowed to name the
   * field: v1 types `ContentChunk.messageId` OPTIONAL and v2 REQUIRES it, so every read has to
   * tolerate absence. "Tolerates absence" is made mechanical as: the line either DECLARES the
   * field nullable, or reads it through an accessor whose result type includes `null`.
   *
   * The shapes are enumerated rather than sniffed for `??`, because the map does not use `??` at
   * all — it uses `str()`, which returns `string | null` — and a guard that demanded a particular
   * operator would have been satisfied by `chunk.messageId ?? ""`, which is the bug (an empty
   * string is a message id that groups every id-less chunk into one message).
   */
  const TOLERATES_ABSENCE: readonly RegExp[] = [
    // A DECLARATION of the field as nullable or optional. A declaration cannot assume presence.
    /messageId\??\s*:\s*(string\s*\|\s*null|null\s*\|\s*string|string\s*\|\s*undefined)/,
    // Read through `str()` / `has()`, whose results are `string | null` and `boolean`.
    /\b(str|has)\(\s*payload\s*(,|\[)\s*["']messageId["']\s*\]?\s*\)/,
    // Written from a value the caller already narrowed to `string | null`.
    /messageId:\s*id\b/,
    // The signature that hands the id out as nullable in the first place.
    /Pick<MappedUpdate,\s*["']messageId["']>/,
  ];

  it("every `messageId` read tolerates absence, in all three files allowed to name it", () => {
    const offenders: string[] = [];
    for (const source of sources) {
      if (!ALLOWED.has(source.path)) continue;
      const lines = source.text.split("\n");
      for (const line of identifierHits(source, "messageId")) {
        const text = lines[line - 1] ?? "";
        if (TOLERATES_ABSENCE.some((shape) => shape.test(text))) continue;
        offenders.push(`${source.path}:${String(line)}: ${text.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("scans a corpus that actually contains the reads — otherwise the rule above is vacuous", () => {
    const hits = sources
      .filter((s) => ALLOWED.has(s.path))
      .flatMap((s) => identifierHits(s, "messageId"));
    expect(hits.length).toBeGreaterThan(2);
  });

  it("would catch the shape that looks guarded and is not", () => {
    // `?? ""` is the bug this rule exists for, and it is the one a `??`-sniffing guard would
    // wave through: an empty string is a message id, and it groups every id-less chunk from
    // every kind into ONE message.
    const planted = {
      path: "packages/core/src/normalizer/map/message-id.ts",
      absolute: "<planted>",
      text: 'const id = payload.messageId ?? "";\n',
      code: blankOutNonCode('const id = payload.messageId ?? "";\n'),
    };
    const line = planted.text.split("\n")[0] ?? "";
    expect(identifierHits(planted, "messageId")).toEqual([1]);
    expect(TOLERATES_ABSENCE.some((shape) => shape.test(line))).toBe(false);
  });

  it("reduceTurn never requires one: a turn of id-less chunks folds normally", () => {
    // The other half of the property, and the one a consumer feels: v1 agents send chunks with
    // no `messageId` at all (86 of 86 in the claude-acp corpus carry one, but `thought.mjs`
    // exists precisely because another agent's do not), and the aggregate must not depend on it.
    const workerId = "w_01J00000000000000000000001" as WorkerId;
    const turnId = "t_01J00000000000000000000001" as TurnId;
    const envelope = (seq: number, payload: Record<string, unknown>): EventEnvelope =>
      ({
        seq,
        ts: `2026-01-01T00:00:0${String(seq)}.000Z`,
        daemonId: "d_01J00000000000000000000001",
        workerId,
        sessionId: "s1",
        turnId,
        payloadVersion: 2,
        kind: "acp.session_update",
        payload,
      }) as EventEnvelope;

    const result = reduceTurn(turnId, [
      envelope(1, { sessionUpdate: "state_update", state: "running" }),
      // No `messageId` on either chunk.
      envelope(2, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "a" } }),
      envelope(3, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "b" } }),
      envelope(4, { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" }),
    ]);

    expect(result.text).toBe("ab");
    expect(result.stopReason).toBe("end_turn");
    expect(result.verdict).toBe("ok");
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

    expect(scan("// messageId pass-through is §12.4\n")).toEqual([]);
    expect(scan("/*\n * messageId\n */\n")).toEqual([]);
    expect(scan('const field = "messageId";\n')).toEqual([]);
    expect(scan("const id = chunk.messageId;\n")).toEqual([1]);
    expect(scan("// prose\nconst { messageId } = chunk;\n")).toEqual([2]);
  });
});
