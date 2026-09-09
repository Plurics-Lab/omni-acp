import { describe, expect, it } from "vitest";
import { InteractionConfig } from "@omni-acp/protocol";
import type { InteractionContext, WorkerId } from "@omni-acp/protocol";
import { elicitationScript, fakeClock, nullLogger, scriptedAgent, seqIds } from "@omni-acp/testkit";
import { openAcpLink } from "../../../src/acp/link.js";
import { createBaselineResponder } from "../../../src/index.js";
import { mapElicitation } from "../../../src/normalizer/map/elicitation.js";
import { createInteractionStrategy } from "../../../src/worker/interaction/strategy.js";

/**
 * `elicitationScript` — the testkit fixture that puts transcript `12`'s EXACT bytes on the wire —
 * driven through the real `AcpLink` and the real `InteractionStrategy`.
 *
 * Every detail it encodes is load-bearing (F29, F30, F32), and a fixture that got one of them
 * wrong would make every M2-A test agree with a shape no agent sends. So the bytes are asserted
 * against the transcript's shape on the way IN, and the answer against F30's routing rule on the
 * way OUT.
 *
 * Owned by M2-A-WP-I.
 */

const WORKER = "w_00000000000000000000000001" as WorkerId;

function rig(o?: { onUnresolved?: "park" | "deny" }) {
  const agent = scriptedAgent();
  const clock = fakeClock();
  const received: unknown[] = [];
  const emitted: unknown[] = [];
  const strategy = createInteractionStrategy({
    workerId: WORKER,
    clock,
    ids: seqIds(),
    logger: nullLogger(),
    config: InteractionConfig.parse({}),
    onUnresolved: o?.onUnresolved ?? "deny",
    parkTimeoutMs: 0,
    parkTimeoutAction: "deny",
    responder: createBaselineResponder("deny", clock),
  });
  const ctx: InteractionContext = {
    turnId: null,
    emit: (inputs) => emitted.push(...inputs),
    park: () => () => {},
    failTurn: () => {},
  };
  const updates: Record<string, unknown>[] = [];
  const acp = openAcpLink(
    agent.stream,
    {
      onSessionUpdate: (n) => updates.push(n.update),
      onPermissionRequest: () =>
        Promise.resolve({ outcome: { outcome: "selected" as const, optionId: "x" } }),
      onElicitation: (params) => {
        received.push(params);
        return strategy.elicitation(mapElicitation(params), ctx);
      },
      onClosed: () => {},
    },
    { logger: nullLogger() },
  );
  return {
    agent,
    strategy,
    received,
    emitted,
    updates,
    dispose: () => {
      acp.close();
      agent.die();
    },
  };
}

describe("elicitationScript (§5.8.10) puts transcript 12's bytes on the wire", () => {
  it("refuses to script a request before there is a session to scope it to", () => {
    const r = rig();
    // The fixture's own precondition, stated as an error rather than as a silent empty id: F29
    // says the scope is the only thing this request carries, so an empty one is not a request.
    expect(() =>
      elicitationScript(r.agent, {
        message: "m",
        questions: [{ id: "question_0", choices: ["a"] }],
      }),
    ).toThrow(/no session yet/);
    r.dispose();
  });

  it("sends the FLAT scope, `oneOf[].const`, the paired `_custom` marker, and no `required`", async () => {
    const fresh = rig();
    // `scriptedAgent` mints a session on `session/new`; this drives it the way a worker would.
    (fresh.agent.sessionIds as string[]).push("sess_script");
    const answer = await elicitationScript(fresh.agent, {
      message: "What should the new file be named?",
      questions: [{ id: "question_0", title: "File name", choices: ["notes.md", "README.md"] }],
    });

    // D10's answer with nothing declared: `decline` (M2-R15). The BYTES are what this test is
    // about, and they arrived before the answer did.
    expect(answer.action).toBe("decline");

    const params = fresh.received[0] as Record<string, unknown>;
    expect(params["scope"]).toBeUndefined();
    expect(params["mode"]).toBe("form");
    // F29: FLAT.
    expect(params["sessionId"]).toBe("sess_script");
    expect(params["toolCallId"]).toBe("toolu_ask_1");
    const schema = params["requestedSchema"] as Record<string, unknown>;
    expect(schema["required"]).toBeUndefined();
    const properties = schema["properties"] as Record<string, Record<string, unknown>>;
    expect(Object.keys(properties)).toEqual(["question_0", "question_0_custom"]);
    // F30: `oneOf`, never `enum`.
    expect(properties["question_0"]?.["oneOf"]).toEqual([
      { const: "notes.md", title: "notes.md", description: "A file called notes.md" },
      { const: "README.md", title: "README.md", description: "A file called README.md" },
    ]);
    expect(properties["question_0"]?.["enum"]).toBeUndefined();
    // …and THE marker, which a schema parse would strip.
    expect(properties["question_0_custom"]?.["_meta"]).toEqual({
      _askUserQuestionCustomAnswer: { questionId: "question_0", isCustomAnswer: true },
    });

    // The real mapper reads them back into exactly one field with its twin attached.
    const mapped = mapElicitation(params);
    expect(mapped.fields.map((f) => f.id)).toEqual(["question_0"]);
    expect(mapped.fields[0]?.customField).toBe("question_0_custom");
    expect(mapped.unmodelled).toEqual([]);
    fresh.dispose();
  });

  it("mirrors the request as an AskUserQuestion tool call on the SAME toolCallId (F32)", async () => {
    const r = rig();
    (r.agent.sessionIds as string[]).push("sess_script");

    await elicitationScript(r.agent, {
      message: "m",
      questions: [{ id: "question_0", choices: ["a"] }],
      toolCallId: "toolu_join",
    });

    // The join a consumer uses: the mirror and the request carry the SAME `toolCallId`, so the
    // same interaction is never counted twice (F32, §19.9).
    const mirror = r.updates.find((u) => u["sessionUpdate"] === "tool_call");
    expect(mirror).toMatchObject({
      toolCallId: "toolu_join",
      kind: "other",
      title: "Asking for your input",
      _meta: { claudeCode: { toolName: "AskUserQuestion" } },
    });
    expect((r.received[0] as Record<string, unknown>)["toolCallId"]).toBe("toolu_join");
    r.dispose();
  });

  it("can omit the mirror and the custom slot, for the shapes the corpus does not carry", async () => {
    const r = rig();
    (r.agent.sessionIds as string[]).push("sess_script");
    await elicitationScript(r.agent, {
      message: "m",
      questions: [{ id: "question_0", choices: ["a"], custom: false }],
      mirror: false,
    });
    const params = r.received[0] as Record<string, unknown>;
    const schema = params["requestedSchema"] as Record<string, unknown>;
    expect(Object.keys(schema["properties"] as object)).toEqual(["question_0"]);
    expect(r.updates.filter((u) => u["sessionUpdate"] === "tool_call")).toEqual([]);
    r.dispose();
  });

  it("refuses to script a form with no question", () => {
    const r = rig();
    (r.agent.sessionIds as string[]).push("sess_script");
    expect(() => elicitationScript(r.agent, { message: "m", questions: [] })).toThrow(
      /at least one question/,
    );
    r.dispose();
  });

  it("PARKS when the strategy is a park one, and the same bytes reach the mapped form", async () => {
    const r = rig({ onUnresolved: "park" });
    (r.agent.sessionIds as string[]).push("sess_script");
    const live = elicitationScript(r.agent, {
      message: "What should the new file be named?",
      questions: [{ id: "question_0", title: "File name", choices: ["notes.md"] }],
    });
    // The park is observable one microtask after the request lands.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const pending = r.strategy.pending[0];
    expect(pending).toMatchObject({ kind: "elicitation", status: "pending" });
    expect(pending?.fields.map((f) => f.id)).toEqual(["question_0"]);
    expect(pending?.fields[0]?.customField).toBe("question_0_custom");

    await r.strategy.settleAll("close");
    expect((await live).action).toBe("decline");
    r.dispose();
  });
});
