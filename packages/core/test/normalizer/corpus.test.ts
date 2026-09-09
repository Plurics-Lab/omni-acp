import { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import { describe, expect, it } from "vitest";
import { transcriptNames, transcriptUpdates } from "@omni-acp/testkit";
import { M1_TRANSCRIPTS, allTranscriptUpdates } from "./support/corpus-facts.js";
import type { MappedUpdate } from "@omni-acp/protocol";
import { mapUpdate } from "../../src/normalizer/map/update.js";
import { claudeAcpDescriptor, claudeAcpModes, countingIds } from "./support/claude-acp.js";

/**
 * CONTRACTS.md §12.7(b) — CORPUS CONFORMANCE: machine-checked properties, no blessed output.
 *
 * All 216 recorded updates from the 11 claude-acp transcripts go through `mapUpdate`, and the
 * eight properties below are asserted over every one of them. Nothing here is captured from the
 * implementation: each property is a statement the contract makes, written as a predicate.
 *
 * This file imports the SDK's own v2 guards DIRECTLY, which no `src` file may do (`acp.ts` is
 * "the ONE place the ACP SDK is imported"). That is the point: the map's own
 * `isV2SessionUpdate` is hand-written so the ingest path does not depend on an unstable entry
 * point, and this is where the two are held against each other on real data.
 */

const D = claudeAcpDescriptor();
const CONTEXT = { planId: "plan_t_corpus", modes: claudeAcpModes() };
const map = (u: unknown): MappedUpdate => mapUpdate(u, D, countingIds(), CONTEXT);

const ALL = allTranscriptUpdates();
const GUARD_NAMES = Object.keys(SessionUpdate).filter(
  (n) => n !== "isCustom",
) as (keyof typeof SessionUpdate)[];

/** Which v2 arm the SDK says this payload is, or null. Never more than one can match. */
function sdkArm(payload: unknown): string | null {
  const matched = GUARD_NAMES.filter((name) =>
    (SessionUpdate[name] as (v: unknown) => boolean)(payload),
  );
  expect(matched.length).toBeLessThanOrEqual(1);
  return matched[0] ?? null;
}

/**
 * §12.7(b)(2): content blocks, RECURSIVELY.
 *
 * The v2 union's open arm accepts a v1-shaped diff nested inside an otherwise-valid
 * `tool_call_update` — verified: `SessionUpdate.isToolCallUpdate` returns true for
 * `{toolCallId:"c", content:[{type:"diff", path, oldText, newText}]}`. So the SDK guard is
 * NECESSARY AND NOT SUFFICIENT, and this is the check that closes the hole.
 */
function v1DiffsIn(payload: unknown): unknown[] {
  const found: unknown[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    const o = node as Record<string, unknown>;
    if (o["type"] === "diff" && !Array.isArray(o["changes"])) found.push(o);
    for (const value of Object.values(o)) walk(value);
  };
  walk(payload);
  return found;
}

describe("the corpus is the corpus (a guard on the guard)", () => {
  it("loads 11 M1 transcripts and exactly 216 recorded session/update payloads", () => {
    // The eleven §12.7(b) is written about, and the directory they live in — which grew to 18
    // when M2's corpus landed (11-17). Both numbers are asserted so that a transcript added and
    // then used by nobody is visible here, and so that adding one can never silently restate the
    // counts below about a different set of files.
    expect(M1_TRANSCRIPTS).toHaveLength(11);
    expect(transcriptNames()).toHaveLength(18);
    expect(transcriptNames()).toEqual(expect.arrayContaining([...M1_TRANSCRIPTS]));
    expect(ALL).toHaveLength(216);
    // The per-file counts the research README records, so a silently truncated file is caught
    // here rather than by a property that would still hold over the remainder.
    expect(transcriptUpdates("01-plain-answer")).toHaveLength(8);
    expect(transcriptUpdates("05-plan")).toHaveLength(49);
    expect(transcriptUpdates("08-set-model-extension")).toHaveLength(4);
  });

  it("contains the kind distribution the README records", () => {
    const counts = new Map<string, number>();
    for (const { update } of ALL) {
      const kind = String(update["sessionUpdate"]);
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    expect(Object.fromEntries([...counts].sort())).toEqual({
      agent_message_chunk: 85,
      available_commands_update: 23,
      config_option_update: 1,
      tool_call: 10,
      tool_call_update: 36,
      usage_update: 60,
      user_message_chunk: 1,
    });
  });
});

describe("§12.7(b) — the eight properties, over all 216 recorded updates", () => {
  it("1. every mapped payload passes the SDK's v2 guard for its own arm, and isCustom is FALSE", () => {
    const offenders: string[] = [];
    for (const { name, index, update } of ALL) {
      const mapped = map(update).payload;
      const arm = sdkArm(mapped);
      const custom = SessionUpdate.isCustom(mapped as never);
      // The escape hatch is a FAILURE, not a pass: v2's union ends in an open arm, so a guard is
      // necessary and not sufficient, and landing on `isCustom` means we produced a vendor kind.
      if (arm === null || custom) {
        offenders.push(
          `${name}#${String(index)} ${String(update["sessionUpdate"])} arm=${String(arm)} custom=${String(custom)}`,
        );
      }
    }
    expect(offenders).toEqual([]);
  });

  it("2. content blocks are checked RECURSIVELY: no v1 diff survives inside a valid arm", () => {
    const before = ALL.flatMap(({ update }) => v1DiffsIn(update));
    // The corpus really does contain them, or this property would be vacuous.
    expect(before.length).toBeGreaterThan(0);

    const after = ALL.flatMap(({ name, index, update }) =>
      v1DiffsIn(map(update).payload).map(() => `${name}#${String(index)}`),
    );
    expect(after).toEqual([]);
  });

  it("3. `mapUpdate` is IDEMPOTENT and TOTAL, over the corpus and over its own output", () => {
    for (const { name, index, update } of ALL) {
      const once = map(update);
      const twice = map(once.payload);
      expect(twice.payload, `${name}#${String(index)}`).toEqual(once.payload);
      expect(twice.payloadVersion, `${name}#${String(index)}`).toBe(once.payloadVersion);
      expect(twice.keep, `${name}#${String(index)}`).toBe(once.keep);
    }
  });

  it("3b. TOTAL over hostile inputs too: nothing makes it throw", () => {
    const hostile: unknown[] = [
      null,
      undefined,
      0,
      "",
      [],
      {},
      { sessionUpdate: null },
      { sessionUpdate: "tool_call", content: "not an array" },
      { sessionUpdate: "tool_call_update", toolCallId: 1, content: [null, 3, "x"] },
      { sessionUpdate: "plan", entries: "nope" },
      { sessionUpdate: "current_mode_update", currentModeId: 7 },
      { sessionUpdate: "agent_message_chunk", messageId: 7, content: null },
      { sessionUpdate: "usage_update", used: "1", size: null, _meta: [] },
    ];
    for (const input of hostile) {
      expect(() => map(input)).not.toThrow();
      expect(() => map(map(input).payload)).not.toThrow();
    }
  });

  it("4. `_meta` survives BY IDENTITY wherever the input had one", () => {
    let withMeta = 0;
    let identical = 0;
    for (const { name, index, update } of ALL) {
      const meta = update["_meta"];
      if (meta === undefined) continue;
      withMeta += 1;
      const mapped = map(update).payload as unknown as Record<string, unknown>;
      // The map rewrites `_meta` on exactly one row — the diff block's, and that is the BLOCK's
      // `_meta`, never the update's. So the update-level object must be the same object.
      if (mapped["_meta"] === meta) identical += 1;
      // In every case, every original entry survives by identity.
      for (const [key, value] of Object.entries(meta as Record<string, unknown>)) {
        expect(
          (mapped["_meta"] as Record<string, unknown>)[key],
          `${name}#${String(index)} _meta.${key}`,
        ).toBe(value);
      }
    }
    expect(withMeta).toBe(67);
    expect(identical).toBe(withMeta);
  });

  it("5. no `tool_call`, no `plan` and no `current_mode_update` survives the map", () => {
    const survivors = ALL.map(
      ({ update }) => (map(update).payload as unknown as Record<string, unknown>)["sessionUpdate"],
    ).filter((k) => k === "tool_call" || k === "plan" || k === "current_mode_update");
    expect(survivors).toEqual([]);
    // …and the corpus really contains ten `tool_call`s, so the property is not vacuous.
    expect(ALL.filter(({ update }) => update["sessionUpdate"] === "tool_call")).toHaveLength(10);
  });

  it("6. `messageId` is synthesized ZERO times for this agent: 86 of 86 chunks pass through", () => {
    const CHUNKS = new Set(["user_message_chunk", "agent_message_chunk", "agent_thought_chunk"]);
    let chunks = 0;
    const synthesized: string[] = [];
    for (const { name, index, update } of ALL) {
      if (!CHUNKS.has(String(update["sessionUpdate"]))) continue;
      chunks += 1;
      const mapped = map(update);
      // Two independent checks, because either alone could be satisfied by the wrong map: the
      // RULE must not report a synthesis, and the id in force must be the agent's own object.
      if (mapped.rule === "messageId->synthesized") synthesized.push(`${name}#${String(index)}`);
      expect(mapped.messageId, `${name}#${String(index)}`).toBe(update["messageId"]);
      expect(mapped.payload, `${name}#${String(index)}`).toBe(update as never);
    }
    expect(chunks).toBe(86);
    expect(synthesized).toEqual([]);
  });

  it("7. `payloadVersion === 2` for every kind in the map", () => {
    const offenders = ALL.filter(({ update }) => map(update).payloadVersion !== 2).map(
      ({ name, index, update }) => `${name}#${String(index)} ${String(update["sessionUpdate"])}`,
    );
    expect(offenders).toEqual([]);
  });

  it("7b. …and `keep` is true for all of them: nothing in this corpus is dropped by default", () => {
    // §14.6: "no kind carries the drop shape by default". `available_commands_update` is
    // DIGESTED, which is a storage decision, and it still streams in full.
    expect(ALL.every(({ update }) => map(update).keep)).toBe(true);
  });
});
