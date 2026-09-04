import { describe, expect, it } from "vitest";
import { createBaselineResponder } from "@omni-acp/core";
import type { MappedPermissionRequest, PermissionOption } from "@omni-acp/protocol";
import { fakeClock } from "@omni-acp/testkit";

const option = (optionId: string, kind: string, name = optionId): PermissionOption =>
  ({ optionId, kind, name }) as PermissionOption;

/**
 * The V2-MAPPED request, because ruling M1-R14 is that the responder never sees the raw v1 one:
 * D4's rule set is written against v2's tagged `subject`, and mapping first is what lets M2's
 * rule engine match without a per-agent branch. The mapping itself
 * (`normalizer/map/permission.ts`) is tested separately; every rule asserted below is unchanged.
 */
const request = (
  options: readonly PermissionOption[],
  title = "Write src/main.ts",
): MappedPermissionRequest => ({
  sessionId: "sess_1",
  title,
  subject: { type: "tool_call", toolCall: { toolCallId: "call_1", title } },
  options: [...options],
  toolCallId: "call_1",
});

const ALLOW_ONCE = option("allow", "allow_once");
const REJECT_ONCE = option("reject", "reject_once");
const ALLOW_ALWAYS = option("allow_always", "allow_always");
const REJECT_ALWAYS = option("reject_always", "reject_always");

const responder = (mode: "allow" | "deny") => createBaselineResponder(mode, fakeClock());

const chosen = (d: { response: { outcome: unknown } | null }): string | null => {
  if (d.response === null) return null;
  const outcome = d.response.outcome as { outcome: string; optionId?: string };
  return outcome.outcome === "selected" ? (outcome.optionId ?? null) : `!${outcome.outcome}`;
};

/**
 * D4's six hard rules, one test each (M0-PLAN WP-4 acceptance 6). These are the rules multica's
 * GH #5300 was written from: every one of them is a way a permission answer can be wrong that
 * looks right in a code review.
 */
describe("createBaselineResponder — D4 hard rules", () => {
  it("rule 1: never fabricates an optionId the agent did not offer", () => {
    // Both modes, over a menu whose ids are nothing like the conventional ones.
    const offered = [option("yes-please", "allow_once"), option("no-thanks", "reject_once")];
    for (const mode of ["allow", "deny"] as const) {
      const d = responder(mode).decide(request(offered));
      const picked = chosen(d);
      expect(offered.map((o) => o.optionId)).toContain(picked);
      expect(d.record.optionId).toBe(picked);
      // And the recorded menu is the one that was actually offered, verbatim.
      expect(d.record.offered).toEqual(offered);
    }
  });

  it("rule 2 (deny half): picks the offered reject_once", () => {
    const d = responder("deny").decide(request([ALLOW_ONCE, REJECT_ONCE, ALLOW_ALWAYS]));
    expect(chosen(d)).toBe("reject");
    expect(d.record.decision).toBe("deny");
    expect(d.record.rule).toBe("m0:auto-deny");
    expect(d.record.title).toBe("Write src/main.ts");
  });

  it("rule 3: allow mode picks allow_once and NEVER allow_always", () => {
    const d = responder("allow").decide(request([ALLOW_ALWAYS, ALLOW_ONCE, REJECT_ONCE]));
    expect(chosen(d)).toBe("allow");
    expect(d.record.decision).toBe("allow");
    expect(d.record.rule).toBe("m0:auto-allow");

    // With allow_always as the ONLY grant on the menu, allow mode must still refuse it and fall
    // back to deny — a runtime that persists it to the owner's disk allowlist outlives us.
    const onlyAlways = responder("allow").decide(request([ALLOW_ALWAYS, REJECT_ONCE]));
    expect(chosen(onlyAlways)).toBe("reject");
    expect(onlyAlways.record.decision).toBe("deny");

    // Even when the option ID says "session grant", an allow_always KIND is not selectable.
    const disguised = responder("allow").decide(
      request([option("allow_session", "allow_always"), ALLOW_ONCE]),
    );
    expect(chosen(disguised)).toBe("allow");
  });

  it("rule 2 (ordering): a known session-grant id wins over a plain allow_once", () => {
    const sessionGrant = option("allow_session", "allow_once");
    const d = responder("allow").decide(request([ALLOW_ONCE, sessionGrant]));
    expect(chosen(d)).toBe("allow_session");

    const alias = responder("allow").decide(
      request([ALLOW_ONCE, option("approve_for_session", "allow_once")]),
    );
    expect(chosen(alias)).toBe("approve_for_session");
  });

  it("rule 4: nothing acceptable offered => response null, so the caller replies -32603", () => {
    for (const offered of [[], [ALLOW_ALWAYS], [REJECT_ALWAYS], [ALLOW_ALWAYS, REJECT_ALWAYS]]) {
      const d = responder("deny").decide(request(offered));
      expect(d.response).toBeNull();
      expect(d.record.optionId).toBeNull();
      expect(d.record.decision).toBe("error");
      expect(d.record.rule).toBe("m0:auto-deny");
    }
    // Allow mode has the same floor: reject_always is not a reject_once.
    expect(responder("allow").decide(request([REJECT_ALWAYS])).response).toBeNull();
  });

  it("rule 5: never returns outcome:'cancelled' — not even when it cannot answer", () => {
    const menus: PermissionOption[][] = [
      [ALLOW_ONCE, REJECT_ONCE],
      [ALLOW_ALWAYS],
      [],
      [option("weird", "no_such_kind")],
    ];
    for (const mode of ["allow", "deny"] as const) {
      for (const offered of menus) {
        const d = responder(mode).decide(request(offered));
        if (d.response === null) continue;
        expect(d.response.outcome.outcome).toBe("selected");
      }
    }
  });

  it("rule 6: an unknown kind is a non-grant — fail closed", () => {
    // The kind is not in the SDK's closed enum at all; it must not be mistaken for a grant.
    const unknown = option("just-do-it", "allow_forever_and_ever");
    expect(responder("allow").decide(request([unknown])).response).toBeNull();
    expect(responder("deny").decide(request([unknown])).response).toBeNull();

    // ...and it must not shadow a real reject_once that IS on the menu.
    const withReject = responder("deny").decide(request([unknown, REJECT_ONCE]));
    expect(chosen(withReject)).toBe("reject");

    // A malformed option (no kind) is dropped rather than crashing the decision.
    const malformed = responder("deny").decide(
      request([{ optionId: "x" } as unknown as PermissionOption, REJECT_ONCE]),
    );
    expect(chosen(malformed)).toBe("reject");
    expect(malformed.record.offered).toEqual([REJECT_ONCE]);
  });
});

describe("createBaselineResponder — the recorded decision", () => {
  it("carries the title from request.toolCall.title, defaulting to '' (review R9)", () => {
    expect(responder("deny").decide(request([REJECT_ONCE], "Delete build/")).record.title).toBe(
      "Delete build/",
    );
    // The mapper is what recovers a title from `toolCall.title` (v1 has no top-level one); a
    // request whose tool call had none arrives here with `title: ""`, and the record keeps it.
    const noTitle = {
      sessionId: "s",
      title: "",
      subject: { type: "tool_call", toolCall: { toolCallId: "c" } },
      options: [REJECT_ONCE],
      toolCallId: "c",
    } as MappedPermissionRequest;
    expect(responder("deny").decide(noTitle).record.title).toBe("");
  });

  it("mints a distinct requestId per request so the two envelopes can be paired", () => {
    const r = responder("deny");
    const ids = [1, 2, 3].map(() => r.decide(request([REJECT_ONCE])).record.requestId);
    expect(new Set(ids).size).toBe(3);
  });

  it("is total: a request with no options array at all still yields a record", () => {
    const d = responder("deny").decide({ sessionId: "s" } as unknown as MappedPermissionRequest);
    expect(d.response).toBeNull();
    expect(d.record.offered).toEqual([]);
    expect(d.record.title).toBe("");
  });
});
