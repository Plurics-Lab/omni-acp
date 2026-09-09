import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { EventEnvelope, InteractionPayload, PolicyDecisionPayload } from "@omni-acp/protocol";

/**
 * WP-I acceptance 1's real content: the baseline's envelopes are M1's **modulo `payloadVersion`
 * and the additive fields**, and NOTHING ELSE MOVED.
 *
 * Ruling M2-R3 flips `acp.interaction` to `payloadVersion: 2` with a mapped `request` beside
 * `raw`, and §19.10 adds `kind` / `toolCallId` / `answer.parkedMs` — so a byte-identical claim was
 * never satisfiable (review R4). What IS checkable is the RELATION between the two shapes, and it
 * is checked here against the four checked-in M2 goldens rather than against a remembered M1 file:
 *
 *  - the M2 `raw` is exactly the v1 `RequestPermissionRequest` M1 put in `request`;
 *  - the M2 `request` is derivable from it and adds no information of its own;
 *  - the payload's key set is exactly M1's key set ∪ the four fields §19.10 names, and the
 *    decision's is exactly M1's ∪ the five §5.8.3 declares;
 *  - `omni.policy_decision` still appears exactly once per `requestId`, immediately after its
 *    `acp.interaction`, which is M1's order (§7.4).
 *
 * Owned by M2-A-WP-I.
 */

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "normalizer", "golden");

/** The four goldens that carry a permission (M2-PLAN §3 lists them as this package's). */
const NAMES = [
  "03-tool-write-allowed",
  "04-tool-write-denied",
  "09-permission-bad-option-id",
  "10-tool-edit-existing",
] as const;

/** `acp.interaction`'s payload keys, as an M1 daemon wrote them (`worker.ts`, still frozen). */
const M1_INTERACTION_KEYS = ["requestId", "method", "request", "status", "answer"] as const;
/** §19.10's additions, and the complete list of them. */
const M2_INTERACTION_KEYS = ["kind", "raw", "toolCallId"] as const;
/** M1's `answer` block, and M2's one addition. */
const M1_ANSWER_KEYS = ["optionId", "by"] as const;
const M2_ANSWER_KEYS = ["parkedMs"] as const;

const M1_DECISION_KEYS = [
  "requestId",
  "title",
  "decision",
  "rule",
  "optionId",
  "offered",
  "toolCallId",
] as const;
const M2_DECISION_KEYS = ["kind", "method", "by", "ruleSource", "parkedMs"] as const;

function envelopes(name: string): EventEnvelope[] {
  return JSON.parse(readFileSync(join(DIR, `${name}.envelopes.json`), "utf8")) as EventEnvelope[];
}

describe("the M2 goldens are M1 modulo payloadVersion and the additive fields (M2-R3, review R4)", () => {
  for (const name of NAMES) {
    describe(name, () => {
      const all = envelopes(name);
      const interactions = all.filter((e) => e.kind === "acp.interaction");
      const decisions = all.filter((e) => e.kind === "omni.policy_decision");

      it("carries at least one permission, so the assertions below are not vacuous", () => {
        expect(interactions.length).toBeGreaterThan(0);
        expect(decisions).toHaveLength(interactions.length);
      });

      it("flips payloadVersion to 2 on acp.interaction and leaves the decision at 2", () => {
        expect(interactions.map((e) => e.payloadVersion)).toEqual(interactions.map(() => 2));
        expect(decisions.map((e) => e.payloadVersion)).toEqual(decisions.map(() => 2));
      });

      it("keeps the agent's v1 request VERBATIM in `raw` — what M1 put in `request` (§7.5)", () => {
        for (const e of interactions) {
          const p = e.payload as InteractionPayload;
          const raw = p.raw as Record<string, unknown>;
          expect(raw).toBeDefined();
          // The v1 `RequestPermissionRequest` shape, untouched: a `toolCall`, the agent's own
          // `options` menu and the flat `sessionId`. An audit of a RESHAPED object audits our
          // reshaping, which is exactly why `raw` is kept beside the map.
          expect(Object.keys(raw).sort()).toEqual(["_meta", "options", "sessionId", "toolCall"]);
        }
      });

      it("derives `request` from `raw` and adds no information of its own (M2-R3)", () => {
        for (const e of interactions) {
          const p = e.payload as InteractionPayload;
          const raw = p.raw as Record<string, unknown>;
          const request = p.request as Record<string, unknown>;
          expect(Object.keys(request).sort()).toEqual(["options", "subject", "title"]);
          // Every field of the map is a field of the raw request, read out of it.
          expect(request["options"]).toEqual(raw["options"]);
          expect((request["subject"] as { toolCall: unknown }).toolCall).toEqual(raw["toolCall"]);
          expect(request["title"]).toBe((raw["toolCall"] as { title?: string }).title ?? "");
        }
      });

      it("adds exactly the fields §19.10 names to acp.interaction, and no others", () => {
        for (const e of interactions) {
          const p = e.payload as unknown as Record<string, unknown>;
          expect(Object.keys(p).sort()).toEqual(
            [...M1_INTERACTION_KEYS, ...M2_INTERACTION_KEYS].sort(),
          );
          const answer = p["answer"] as Record<string, unknown>;
          expect(Object.keys(answer).sort()).toEqual([...M1_ANSWER_KEYS, ...M2_ANSWER_KEYS].sort());
          // An auto-resolved interaction was never parked, so this is 0 by construction.
          expect(answer["parkedMs"]).toBe(0);
          expect(answer["by"]).toBe("baseline");
          expect(p["kind"]).toBe("permission");
          // No `park` block: nothing here ever waited for a human.
          expect(p["park"]).toBeUndefined();
        }
      });

      it("adds exactly the fields §5.8.3 names to omni.policy_decision, and no others", () => {
        for (const e of decisions) {
          const p = e.payload as unknown as Record<string, unknown>;
          expect(Object.keys(p).sort()).toEqual([...M1_DECISION_KEYS, ...M2_DECISION_KEYS].sort());
          expect(p["by"]).toBe("baseline");
          expect(p["ruleSource"]).toBe("baseline");
          expect(p["parkedMs"]).toBe(0);
          expect(p["kind"]).toBe("permission");
          expect(p["method"]).toBe("session/request_permission");
          // `clamped` and `blindsPolicy` are M2-B's and are absent, not null.
          expect(p["clamped"]).toBeUndefined();
          expect(p["blindsPolicy"]).toBeUndefined();
        }
      });

      it("still emits the two envelopes ADJACENTLY, interaction first (§7.4, M1's order)", () => {
        for (const e of interactions) {
          const at = all.indexOf(e);
          const next = all[at + 1];
          expect(next?.kind).toBe("omni.policy_decision");
          expect((next?.payload as PolicyDecisionPayload).requestId).toBe(
            (e.payload as InteractionPayload).requestId,
          );
          expect(next?.turnId).toBe(e.turnId);
        }
      });

      it("keeps M1's synthesized requestId spelling — the id did NOT move", () => {
        for (const e of interactions) {
          // `perm_<n>` is what the generator stamps and what M1 stamped. The daemon-minted
          // `x_<ULID>` (F33) belongs to the strategy that can actually be ASKED about one; the
          // baseline parks nothing and answers `interaction_not_found` to every id.
          expect((e.payload as InteractionPayload).requestId).toMatch(/^perm_\d+$/);
        }
      });

      it("emits omni.policy_decision EXACTLY once per requestId (ruling M2-R4)", () => {
        const counts = new Map<string, number>();
        for (const e of decisions) {
          const id = (e.payload as PolicyDecisionPayload).requestId;
          counts.set(id, (counts.get(id) ?? 0) + 1);
        }
        expect([...counts.values()]).toEqual(decisions.map(() => 1));
      });
    });
  }

  it("the four goldens are the complete list this bullet touches (M2-PLAN §3)", () => {
    // A fifth golden growing a permission would be a file this package does not own.
    for (const name of [
      "01-plain-answer",
      "02-tool-read",
      "06-cancel-mid-turn",
      "07-session-load",
    ]) {
      expect(envelopes(name).filter((e) => e.kind === "acp.interaction")).toEqual([]);
    }
  });
});
