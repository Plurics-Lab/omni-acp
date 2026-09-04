import { describe, expect, it } from "vitest";
import { createBaselineResponder } from "@omni-acp/core";
import {
  fakeClock,
  fakeRuntime,
  transcriptRequests,
  transcriptUpdates,
} from "@omni-acp/testkit";
import type { MappedPermissionRequest, PermissionOption } from "@omni-acp/protocol";
import { mapPermissionRequest } from "../../src/normalizer/map/permission.js";
import { claudeAcpDescriptor } from "./support/claude-acp.js";

/**
 * CONTRACTS.md §12.6 and ruling M1-R14: the RESPONDER RECEIVES THE V2-MAPPED REQUEST.
 *
 * D4's rules are written against v2's tagged `subject`, and mapping first is what lets M2's rule
 * engine match `kind` / `path` / `cmd` with no per-agent branch. The corpus is the input here —
 * both recorded `session/request_permission` requests, verbatim — because §12.6's every clause is
 * a claim about what those two objects contain.
 */

const D = claudeAcpDescriptor();
const map = (req: unknown, descriptor = D): MappedPermissionRequest =>
  mapPermissionRequest(req, descriptor);

/**
 * Every recorded `session/request_permission`, from the transcripts and not from a literal.
 *
 * Seven across six scenarios — the README's own count — and `09` carries TWO because the agent
 * asked again after our deliberately-malformed answer.
 */
const SCENARIOS = [
  "03-tool-write-allowed",
  "04-tool-write-denied",
  "05-plan",
  "05b-plan-natural-phrasing",
  "09-permission-bad-option-id",
  "10-tool-edit-existing",
] as const;
const RECORDED = SCENARIOS.flatMap((name) =>
  transcriptRequests(name, "session/request_permission"),
);

describe("the corpus really carries every request (a guard on the guard)", () => {
  it("finds all seven, and every one of them is v1-shaped", () => {
    expect(RECORDED).toHaveLength(7);
    for (const req of RECORDED) {
      expect(req).toHaveProperty("toolCall");
      expect(req).not.toHaveProperty("subject");
      expect(req).not.toHaveProperty("title");
    }
  });
});

describe("§12.6 — v1 {sessionId, toolCall, options} -> v2 {title, subject, options}", () => {
  it("maps the recorded request to exactly the v2 shape, with the tool call BY IDENTITY", () => {
    const req = RECORDED[0] as Record<string, unknown>;
    const out = map(req);
    expect(out.sessionId).toBe(req["sessionId"]);
    expect(out.title).toBe("Write hello.txt");
    expect(out.subject).toEqual({ type: "tool_call", toolCall: req["toolCall"] });
    // Identity: `kind`, `locations`, `content` and `rawInput` — what M2's rule engine matches on
    // — must arrive unmodified.
    expect((out.subject as { toolCall: unknown }).toolCall).toBe(req["toolCall"]);
    expect(out.toolCallId).toBe("toolu_01UqACvgrmqvqmbALS7hDmKR");
    expect(out._meta).toBe(req["_meta"]);
  });

  it("NEVER reshapes `options`: three pass through untouched, in order, by identity", () => {
    const req = RECORDED[0] as Record<string, unknown>;
    const out = map(req);
    expect(out.options).toEqual([
      { optionId: "allow-once", name: "Yes", kind: "allow_once" },
      {
        optionId: "allow-with-updates",
        name: "Yes, allow all edits during this session",
        kind: "allow_always",
      },
      { optionId: "reject", name: "No", kind: "reject_once" },
    ]);
    const offered = req["options"] as unknown[];
    out.options.forEach((o, i) => expect(o).toBe(offered[i]));
  });

  it("preserves an UNKNOWN `kind`, which D4 rule 6 needs in order to fail closed", () => {
    const out = map({
      sessionId: "s",
      toolCall: { toolCallId: "c", title: "t" },
      options: [{ optionId: "maybe", name: "Maybe", kind: "vendor_specific_grant" }],
    });
    expect(out.options).toEqual([
      { optionId: "maybe", name: "Maybe", kind: "vendor_specific_grant" },
    ]);
  });

  it("drops an option that is not structurally an option, rather than passing a hole downstream", () => {
    const out = map({
      sessionId: "s",
      toolCall: { toolCallId: "c" },
      options: [null, 7, { optionId: "ok", kind: "reject_once" }, { name: "no id" }],
    });
    expect(out.options).toEqual([{ optionId: "ok", kind: "reject_once" }]);
  });

  it("is IDEMPOTENT: a request that already carries a `subject` comes back unchanged", () => {
    const once = map(RECORDED[0]);
    const twice = map(once);
    expect(twice).toEqual(once);
    // …and the subject by identity, which is what makes the second application a no-op.
    expect(twice.subject).toBe(once.subject);
    expect(twice.toolCallId).toBe(once.toolCallId);
  });
});

describe("§12.6 — `title` precedence is evidence-ordered and never empty", () => {
  const base = { sessionId: "s", options: [] };

  it("1. `_meta.permission.title` wins — it is present on BOTH observed requests", () => {
    expect(
      map({
        ...base,
        toolCall: { toolCallId: "c", title: "the schema'd one" },
        _meta: { permission: { version: 1, title: "the agent's own label" } },
      }).title,
    ).toBe("the agent's own label");
  });

  it("2. then `toolCall.title`, the schema'd field", () => {
    expect(map({ ...base, toolCall: { toolCallId: "c", title: "Write hello.txt" } }).title).toBe(
      "Write hello.txt",
    );
  });

  it("3. then a constructed `<kind>: <name|toolCallId>` — still TRUE, not a placeholder", () => {
    expect(map({ ...base, toolCall: { toolCallId: "c1", kind: "edit", name: "Write" } }).title).toBe(
      "edit: Write",
    );
    expect(map({ ...base, toolCall: { toolCallId: "c1", kind: "edit" } }).title).toBe("edit: c1");
    expect(map({ ...base, toolCall: { toolCallId: "c1" } }).title).toBe("tool_call: c1");
  });

  it("never empty, because v2 requires a string", () => {
    for (const req of [{}, { ...base }, { ...base, toolCall: {} }, null, 7]) {
      expect(map(req).title.length).toBeGreaterThan(0);
    }
  });
});

describe("§12.6 — the responder REFUSES an optionId the agent did not offer (corpus 09)", () => {
  const responder = (mode: "allow" | "deny") => createBaselineResponder(mode, fakeClock());

  it("only ever answers with an id from `offered`, in both modes, over the recorded requests", () => {
    for (const req of RECORDED) {
      const mapped = map(req);
      const offered = new Set(mapped.options.map((o) => o.optionId));
      for (const mode of ["allow", "deny"] as const) {
        const decision = responder(mode).decide(mapped);
        const optionId = decision.record.optionId;
        expect(optionId).not.toBeNull();
        expect(offered.has(optionId as string)).toBe(true);
        expect(
          (decision.response as { outcome: { optionId: string } }).outcome.optionId,
        ).toBe(optionId);
      }
    }
  });

  it("D4 rule 3 is absolute: `allow_always` is never selected, even in allow mode", () => {
    // The recorded requests offer `allow-with-updates` (kind `allow_always`), which some
    // runtimes persist to the owner's disk allowlist. `allow-once` is the only safe allow here.
    const decision = responder("allow").decide(map(RECORDED[0]));
    expect(decision.record.optionId).toBe("allow-once");
  });

  it("answers -32603 rather than inventing one when NOTHING acceptable is offered (rule 4)", () => {
    const mapped = map({
      sessionId: "s",
      toolCall: { toolCallId: "c", title: "t" },
      options: [{ optionId: "allow-with-updates", name: "Yes, always", kind: "allow_always" }],
    });
    const decision = responder("deny").decide(mapped);
    // `null` is the instruction to the caller to reply with JSON-RPC -32603 — not to invent an
    // option id (rule 1) and not to cancel the whole turn (rule 5).
    expect(decision.response).toBeNull();
    expect(decision.record.decision).toBe("error");
    expect(decision.record.optionId).toBeNull();
  });

  it("carries `toolCallId` through to the policy record, which is the join §13.4 needs", () => {
    const decision = responder("deny").decide(map(RECORDED[0]));
    expect(decision.record.toolCallId).toBe("toolu_01UqACvgrmqvqmbALS7hDmKR");
    // Never recovered from the agent's English `rawOutput`; we are the party that denied.
    expect(decision.record.decision).toBe("deny");
  });

  it("the PLANTED violation is what corpus 09 recorded, and the recording is the cost", () => {
    // Transcript 09 is the observed cost of violating D4 rule 1: the responder answered with an
    // `optionId` the agent never offered, and the agent did NOT fail the turn — every tool call
    // went `status: "failed"` and `stopReason` stayed `end_turn`. So rule 1 cannot be enforced
    // by watching `stopReason`, and this asserts BOTH halves: the planted responder produces an
    // unoffered id, and the recording shows what that costs.
    const planted = {
      decide(req: MappedPermissionRequest) {
        const invented: PermissionOption = { optionId: "undefined", name: "?", kind: "allow_once" };
        return {
          response: { outcome: { outcome: "selected" as const, optionId: invented.optionId } },
          record: {
            requestId: "planted",
            title: req.title,
            decision: "allow" as const,
            rule: "planted:invented-option",
            optionId: invented.optionId,
            offered: req.options,
            toolCallId: req.toolCallId,
          },
        };
      },
    };
    const mapped = map(RECORDED.at(-1));
    const decision = planted.decide(mapped);
    const offered = new Set(mapped.options.map((o) => o.optionId));
    expect(offered.has(decision.record.optionId)).toBe(false);

    // …and this is what the agent did about it, from the transcript rather than from prose:
    // every tool call that reported a status ended `failed`.
    const statuses = new Map<string, string>();
    for (const u of transcriptUpdates("09-permission-bad-option-id")) {
      const id = u["toolCallId"];
      const status = u["status"];
      if (typeof id === "string" && typeof status === "string") statuses.set(id, status);
    }
    expect(statuses.size).toBeGreaterThan(0);
    expect([...new Set(statuses.values())]).toEqual(["failed"]);
  });
});

describe("§12.6 — the descriptor is read, never branched on", () => {
  it("maps identically under the zero-quirk profile: both shapes are handled structurally", () => {
    expect(map(RECORDED[0], fakeRuntime())).toEqual(map(RECORDED[0], D));
  });
});
