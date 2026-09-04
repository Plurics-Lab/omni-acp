import { describe, expect, it } from "vitest";
import { mapUpdate } from "../../src/normalizer/map/update.js";
import { fakeRuntime } from "@omni-acp/testkit";
import type { MappedUpdate } from "@omni-acp/protocol";
import { claudeAcpDescriptor, claudeAcpModes, countingIds } from "./support/claude-acp.js";

/**
 * CONTRACTS.md §12.7(a) — HAND-WRITTEN RULE EXPECTATIONS, one per row of §12.3.
 *
 * Input and expected output are both LITERALS, written from the contract and from the SDK's v2
 * type definitions, **never captured from the implementation**. This is the tier that can catch a
 * wrong map: a corpus property test proves the map is total, idempotent and self-consistent, and
 * would keep proving it about a map that renamed the wrong field.
 *
 * `descriptor` is §17.2's claude-acp table where a row depends on a quirk, and the zero-quirk
 * `fakeRuntime()` where it must not.
 */

const D = claudeAcpDescriptor();
const GENERIC = fakeRuntime();
const CONTEXT = { planId: "plan_t_00000000000000000000000001", modes: claudeAcpModes() };

const map = (
  update: unknown,
  descriptor = D,
  context = CONTEXT,
): MappedUpdate => mapUpdate(update, descriptor, countingIds(), context);

describe("§12.3 rows 1-3 — the three chunk kinds are `=` except `messageId`", () => {
  for (const sessionUpdate of [
    "user_message_chunk",
    "agent_message_chunk",
    "agent_thought_chunk",
  ]) {
    it(`${sessionUpdate}: an id the agent sent passes through, BY IDENTITY`, () => {
      const input = {
        sessionUpdate,
        messageId: "msg_011CehUUNHsFHRRieaSF7bBM",
        content: { type: "text", text: "PONG" },
      };
      const out = map(input);
      expect(out).toEqual({
        payload: input,
        payloadVersion: 2,
        rule: "",
        messageId: "msg_011CehUUNHsFHRRieaSF7bBM",
        keep: true,
      });
      // Identity, not deep equality: the whole point of `=` is that nothing was rebuilt.
      expect(out.payload).toBe(input);
    });

    it(`${sessionUpdate}: an ABSENT id is synthesized, marked, and nothing else changes`, () => {
      const out = map({ sessionUpdate, content: { type: "text", text: "hi" } });
      expect(out).toEqual({
        payload: {
          sessionUpdate,
          content: { type: "text", text: "hi" },
          messageId: `omni:test:${sessionUpdate}:1`,
        },
        payloadVersion: 2,
        rule: "messageId->synthesized",
        messageId: `omni:test:${sessionUpdate}:1`,
        keep: true,
      });
    });
  }

  it("groups a CONTIGUOUS RUN of id-less chunks under one id, and a kind change breaks it", () => {
    // §12.4: "a stream of id-less chunks is grouped as one message per contiguous run, which is
    // the only grouping the wire supports".
    const ids = countingIds();
    const chunk = (sessionUpdate: string): string | null =>
      mapUpdate({ sessionUpdate, content: { type: "text", text: "." } }, D, ids, CONTEXT).messageId;

    expect(chunk("agent_thought_chunk")).toBe("omni:test:agent_thought_chunk:1");
    expect(chunk("agent_thought_chunk")).toBe("omni:test:agent_thought_chunk:1");
    expect(chunk("agent_message_chunk")).toBe("omni:test:agent_message_chunk:2");
    expect(chunk("agent_thought_chunk")).toBe("omni:test:agent_thought_chunk:3");
  });

  it("a chunk with no `content` cannot be a v2 arm, so it passes through at 1", () => {
    // v2's `ContentChunk` requires `content`; there is nothing to synthesize it from, and a
    // `messageId` bolted onto a payload that is still not v2 would be a false claim.
    const input = { sessionUpdate: "agent_message_chunk" };
    const out = map(input);
    expect(out.payloadVersion).toBe(1);
    expect(out.payload).toBe(input);
    expect(out.messageId).toBeNull();
  });
});

describe("§12.3 row 4 — `tool_call` -> `tool_call_update`", () => {
  it("renames the discriminant AND NOTHING ELSE", () => {
    const meta = { claudeCode: { toolName: "Read" } };
    const input = {
      _meta: meta,
      toolCallId: "toolu_01Abc",
      sessionUpdate: "tool_call",
      rawInput: {},
      title: "Preparing file…",
      kind: "read",
      status: "pending",
      content: [],
      locations: [],
    };
    const out = map(input);
    expect(out).toEqual({
      payload: {
        _meta: meta,
        toolCallId: "toolu_01Abc",
        sessionUpdate: "tool_call_update",
        rawInput: {},
        title: "Preparing file…",
        kind: "read",
        status: "pending",
        content: [],
        locations: [],
      },
      payloadVersion: 2,
      rule: "tool_call->tool_call_update",
      messageId: null,
      keep: true,
    });
    // No defaulting and no synthesis: exactly the input's keys, in the input's order.
    expect(Object.keys(out.payload as object)).toEqual(Object.keys(input));
    // `_meta` survives BY IDENTITY even though the payload was rebuilt.
    expect((out.payload as { _meta: unknown })._meta).toBe(meta);
  });

  it("does NOT merge: an update carrying only {toolCallId, sessionUpdate, _meta} is stored as itself", () => {
    // §12.1: the stream is a log of events, not a materialized view. 8 of the 36 recorded
    // `tool_call_update`s have exactly this shape, and merging here would hand a client
    // reconnecting mid-tool-call a DIFFERENT history than one connected throughout.
    const input = { toolCallId: "toolu_01Abc", sessionUpdate: "tool_call_update", _meta: {} };
    const out = map(input);
    expect(out.payload).toBe(input);
    expect(out.payloadVersion).toBe(2);
    expect(out.rule).toBe("");
  });
});

describe("§12.3 row 5 — `tool_call_update` is `=` verbatim", () => {
  it("passes a sparse patch through by identity, `_meta` included", () => {
    const meta = { claudeCode: { toolName: "Edit" } };
    const input = {
      _meta: meta,
      toolCallId: "toolu_01Abc",
      sessionUpdate: "tool_call_update",
      status: "completed",
      rawOutput: { ok: true },
    };
    const out = map(input);
    expect(out.payload).toBe(input);
    expect(out.payloadVersion).toBe(2);
  });
});

describe("§12.3 row 6 — the diff block (§12.5)", () => {
  it("a CREATION: `oldText: null` becomes operation `add`, and the text moves to `_meta`", () => {
    const out = map({
      toolCallId: "toolu_01Uq",
      sessionUpdate: "tool_call_update",
      content: [
        { type: "diff", path: "/tmp/ws/hello.txt", oldText: null, newText: "hello" },
      ],
    });
    expect(out.payload).toEqual({
      toolCallId: "toolu_01Uq",
      sessionUpdate: "tool_call_update",
      content: [
        {
          type: "diff",
          changes: [{ operation: "add", path: "/tmp/ws/hello.txt" }],
          _meta: {
            "omni/v1Diff": { oldText: null, newText: "hello", fragment: true },
          },
        },
      ],
    });
    expect(out.rule).toBe("diff->changes");
  });

  it("an EDIT: a non-null `oldText` becomes operation `modify`", () => {
    const out = map({
      toolCallId: "toolu_01Hb",
      sessionUpdate: "tool_call_update",
      content: [
        {
          type: "diff",
          path: "/tmp/ws/config.txt",
          oldText: "mode = slow",
          newText: "mode = fast",
        },
      ],
    });
    expect((out.payload as { content: unknown[] }).content).toEqual([
      {
        type: "diff",
        changes: [{ operation: "modify", path: "/tmp/ws/config.txt" }],
        _meta: {
          "omni/v1Diff": { oldText: "mode = slow", newText: "mode = fast", fragment: true },
        },
      },
    ]);
  });

  it("`fragment` comes from the DESCRIPTOR and is never guessed", () => {
    // F19: claude-acp WIDENS the pair between updates, so a consumer that writes `newText` to
    // `path` corrupts the file. A runtime with no such quirk reports false — which is the
    // absence of the claim, not the opposite claim.
    const block = {
      toolCallId: "c",
      sessionUpdate: "tool_call_update",
      content: [{ type: "diff", path: "/a", oldText: "x", newText: "y" }],
    };
    const fragmentOf = (out: MappedUpdate): unknown =>
      (
        (out.payload as { content: { _meta: { "omni/v1Diff": { fragment: unknown } } }[] })
          .content[0] as { _meta: { "omni/v1Diff": { fragment: unknown } } }
      )._meta["omni/v1Diff"].fragment;

    expect(fragmentOf(map(block, D))).toBe(true);
    expect(fragmentOf(map(block, GENERIC))).toBe(false);
  });

  it("`patch` is NOT filled — D8 and ruling M1-R11", () => {
    const out = map({
      toolCallId: "c",
      sessionUpdate: "tool_call_update",
      content: [{ type: "diff", path: "/a", oldText: null, newText: "x" }],
    });
    const diff = (out.payload as { content: Record<string, unknown>[] }).content[0];
    expect(diff).not.toHaveProperty("patch");
  });

  it("preserves the block's ORIGINAL `_meta` entries alongside `omni/v1Diff`", () => {
    const out = map({
      toolCallId: "c",
      sessionUpdate: "tool_call_update",
      content: [
        {
          type: "diff",
          path: "/a",
          oldText: null,
          newText: "x",
          _meta: { "vendor.io/blockTrace": "abc" },
        },
      ],
    });
    const diff = (out.payload as { content: { _meta: Record<string, unknown> }[] }).content[0];
    expect(diff?._meta["vendor.io/blockTrace"]).toBe("abc");
    expect(diff?._meta).toHaveProperty("omni/v1Diff");
  });

  it("a block that is ALREADY v2 comes back by identity — idempotence, at the block level", () => {
    const block = {
      type: "diff",
      changes: [{ operation: "add", path: "/a" }],
      _meta: { "omni/v1Diff": { oldText: null, newText: "x", fragment: true } },
    };
    const out = map({ toolCallId: "c", sessionUpdate: "tool_call_update", content: [block] });
    expect((out.payload as { content: unknown[] }).content[0]).toBe(block);
    expect(out.rule).toBe("");
  });
});

describe("§12.3 rows 7 and 8 — `plan` -> `plan_update`", () => {
  const entries = [{ content: "read the file", priority: "medium", status: "pending" }];

  it("row 7: `{entries}` becomes `{plan:{type:'items', planId, entries}}`", () => {
    const out = map({ sessionUpdate: "plan", entries });
    expect(out).toEqual({
      payload: {
        sessionUpdate: "plan_update",
        plan: { type: "items", planId: "plan_t_00000000000000000000000001", entries },
      },
      payloadVersion: 2,
      rule: "plan->plan_update",
      messageId: null,
      keep: true,
    });
  });

  it("row 7: `planId` is `plan_<turnId>` and STABLE, so two updates upsert ONE plan", () => {
    const a = map({ sessionUpdate: "plan", entries });
    const b = map({ sessionUpdate: "plan", entries: [] });
    const idOf = (m: MappedUpdate): unknown =>
      (m.payload as { plan: { planId: unknown } }).plan.planId;
    expect(idOf(a)).toBe(idOf(b));
    expect(idOf(a)).toBe("plan_t_00000000000000000000000001");
  });

  it("row 8: `plan_update` with a STRING `plan.type` is `=`, by identity", () => {
    const input = {
      sessionUpdate: "plan_update",
      plan: { type: "items", planId: "agent-authored", entries },
    };
    const out = map(input);
    expect(out.payload).toBe(input);
    expect(out.rule).toBe("");
  });

  it("row 8: `plan_update` with a v1 BODY is treated as row 7", () => {
    const out = map({ sessionUpdate: "plan_update", entries });
    expect(out.payload).toEqual({
      sessionUpdate: "plan_update",
      plan: { type: "items", planId: "plan_t_00000000000000000000000001", entries },
    });
    expect(out.rule).toBe("plan->plan_update");
  });

  it("a `plan` with NO entries is not rewritten into an empty plan", () => {
    // "The agent cleared its plan" and "this payload carried no plan" are different claims.
    const input = { sessionUpdate: "plan", marker: 1 };
    const out = map(input);
    expect(out.payload).toBe(input);
    expect(out.payloadVersion).toBe(1);
  });
});

describe("§12.3 row 9 — `plan_removed` is `=`", () => {
  it("passes through by identity", () => {
    const input = { sessionUpdate: "plan_removed", planId: "p1" };
    const out = map(input);
    expect(out.payload).toBe(input);
    expect(out.payloadVersion).toBe(2);
  });
});

describe("§12.3 row 10 — `available_commands_update` is `=` ON THE WIRE", () => {
  it("is streamed in full, unmodified, at payloadVersion 2 (ruling M1-R3)", () => {
    const input = {
      sessionUpdate: "available_commands_update",
      availableCommands: [{ name: "review", description: "review the diff" }],
    };
    const out = map(input);
    expect(out.payload).toBe(input);
    expect(out.payloadVersion).toBe(2);
    // Never truncated and never withheld: `keep` is what decides whether it is appended at all,
    // and §14.6 forbids store-but-do-not-stream outright.
    expect(out.keep).toBe(true);
  });

  it("the descriptor's DROP shape is the only thing that stops it, and it is decided here", () => {
    // §14.6: `stream:false, store:false` is the operator's escape hatch, decided in the
    // Normalizer BEFORE `append()`, so no `seq` is spent and the log stays gap-free.
    const dropping = fakeRuntime({
      updates: {
        available_commands_update: { map: null, stream: false, store: false, digest: false },
      },
    });
    const out = map({ sessionUpdate: "available_commands_update", availableCommands: [] }, dropping);
    expect(out.keep).toBe(false);
  });
});

describe("§12.3 row 11 — `current_mode_update` -> `config_option_update`", () => {
  it("builds ONE select from the handshake's `modes.availableModes`", () => {
    const out = map({ sessionUpdate: "current_mode_update", currentModeId: "acceptEdits" });
    expect(out).toEqual({
      payload: {
        sessionUpdate: "config_option_update",
        configOptions: [
          {
            id: "mode",
            name: "Mode",
            category: "mode",
            type: "select",
            currentValue: "acceptEdits",
            options: [
              { value: "default", name: "Manual", description: "Always ask before making changes" },
              {
                value: "acceptEdits",
                name: "Accept edits",
                description: "Automatically accept all file edits",
              },
              {
                value: "plan",
                name: "Plan",
                description: "Create a plan before making changes",
              },
            ],
          },
        ],
        _meta: { "omni/derivedFrom": "current_mode_update" },
      },
      payloadVersion: 2,
      rule: "current_mode_update->config_option_update",
      messageId: null,
      keep: true,
    });
  });

  it("with NO handshake modes: `options: []` — honest, not invented", () => {
    const out = map({ sessionUpdate: "current_mode_update", currentModeId: "default" }, D, {
      planId: "plan_x",
      modes: null,
    });
    expect((out.payload as { configOptions: { options: unknown }[] }).configOptions[0]?.options)
      .toEqual([]);
  });

  it("preserves the update's own `_meta` beside `omni/derivedFrom`", () => {
    const out = map({
      sessionUpdate: "current_mode_update",
      currentModeId: "default",
      _meta: { "vendor.io/trace": "abc" },
    });
    expect((out.payload as { _meta: Record<string, unknown> })._meta).toEqual({
      "vendor.io/trace": "abc",
      "omni/derivedFrom": "current_mode_update",
    });
  });
});

describe("§12.3 rows 12 and 13 — already-v2 kinds are `=`", () => {
  const cases: readonly Record<string, unknown>[] = [
    {
      sessionUpdate: "config_option_update",
      configOptions: [
        { id: "mode", name: "Mode", type: "select", currentValue: "default", options: [] },
      ],
    },
    { sessionUpdate: "session_info_update", title: "a session", updatedAt: "2026-09-04T00:00:00Z" },
    { sessionUpdate: "usage_update", used: 1_234, size: 200_000 },
    {
      sessionUpdate: "usage_update",
      used: 1,
      size: 2,
      cost: { amount: 0.12, currency: "USD" },
    },
    { sessionUpdate: "compaction_update", compactionId: "c1", status: "completed" },
    {
      sessionUpdate: "compaction_summary_chunk",
      compactionId: "c1",
      content: { type: "text", text: "…" },
    },
  ];

  for (const input of cases) {
    it(`${String(input["sessionUpdate"])}: identity, payloadVersion 2`, () => {
      const out = map(input);
      expect(out.payload).toBe(input);
      expect(out.payloadVersion).toBe(2);
      expect(out.rule).toBe("");
    });
  }
});

describe("§12.3 row 15 — the synthesized `state_update` is already v2 and stays `=`", () => {
  it("running and idle both pass through", () => {
    for (const input of [
      { sessionUpdate: "state_update", state: "running" },
      { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" },
    ]) {
      const out = map(input);
      expect(out.payload).toBe(input);
      expect(out.payloadVersion).toBe(2);
    }
  });
});

describe("§12.3 rows 16 and 17 — what is NOT synthesized", () => {
  it("no v2 upsert form and no terminal kind is ever invented from a v1 stream", () => {
    // Row 16: `agent_message` / `user_message` / `agent_thought` / `tool_call_content_chunk` are
    // v2 UPSERT forms with patch semantics and no v1 producer. Row 17: `terminal_*` cannot exist
    // under D3's `clientCapabilities: {}`. So no INPUT may produce one as OUTPUT.
    const invented = new Set([
      "agent_message",
      "user_message",
      "agent_thought",
      "tool_call_content_chunk",
      "terminal_update",
      "terminal_output_chunk",
    ]);
    const inputs: unknown[] = [
      { sessionUpdate: "agent_message_chunk", messageId: "m", content: { type: "text", text: "x" } },
      { sessionUpdate: "user_message_chunk", messageId: "m", content: { type: "text", text: "x" } },
      { sessionUpdate: "tool_call", toolCallId: "c", title: "t" },
      { sessionUpdate: "tool_call_update", toolCallId: "c" },
      { sessionUpdate: "plan", entries: [] },
      { sessionUpdate: "current_mode_update", currentModeId: "default" },
      { sessionUpdate: "usage_update", used: 1, size: 2 },
    ];
    for (const input of inputs) {
      const kind = (map(input).payload as { sessionUpdate: string }).sessionUpdate;
      expect(invented.has(kind)).toBe(false);
    }
  });

  it("but an AGENT that sends one is still carried — declining to synthesize is not declining to carry", () => {
    const input = { sessionUpdate: "terminal_output_chunk", terminalId: "t1", output: "hi" };
    const out = map(input);
    expect(out.payload).toBe(input);
    expect(out.payloadVersion).toBe(2);
  });
});

describe("§12.3 row 18 — an unknown kind is pass-through BY IDENTITY at payloadVersion 1", () => {
  it("keeps `_meta` because the object is forwarded, not rebuilt", () => {
    const meta = { "vendor.io/trace": "abc" };
    const input = { sessionUpdate: "vendor.io/telemetry", counter: 7, _meta: meta };
    const out = map(input);
    expect(out).toEqual({
      payload: input,
      payloadVersion: 1,
      rule: "",
      messageId: null,
      keep: true,
    });
    expect(out.payload).toBe(input);
    expect((out.payload as { _meta: unknown })._meta).toBe(meta);
  });

  it("is TOTAL: null, a number, an array and a tagless object all come back, never a throw", () => {
    for (const input of [null, 7, "x", [], {}, { sessionUpdate: 3 }]) {
      const out = map(input);
      expect(out.payloadVersion).toBe(1);
      expect(out.payload).toBe(input as never);
      expect(out.keep).toBe(true);
    }
  });
});
