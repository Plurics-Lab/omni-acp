import { describe, expect, it } from "vitest";
import type { EventEnvelope } from "@omni-acp/protocol";
import { scriptedAgent } from "@omni-acp/testkit";
import { flush, harness, OWNER, TEXT } from "./support/harness.js";
import { asScriptedAgent, rawAgent } from "./support/raw-agent.js";

const updates = (all: readonly EventEnvelope[]): Record<string, unknown>[] =>
  all
    .filter((e) => e.kind === "acp.session_update")
    .map((e) => e.payload as unknown as Record<string, unknown>);

describe("a turn, end to end", () => {
  it("keeps an unknown agent->client request from derailing the turn (acceptance 9)", async () => {
    const h = harness();
    const agent = rawAgent();
    h.supervisor.enqueue(asScriptedAgent(agent));
    const w = await h.create();

    const accepted = await w.prompt([TEXT("read a file for me")], OWNER);
    await flush();

    // D3: we advertise no `fs` capability, so a compliant agent must not ask — but an agent that
    // asks anyway gets an answer, not silence, which is the whole point (DESIGN §6.2).
    await expect(agent.request("fs/read_text_file", { path: "/etc/passwd" })).rejects.toMatchObject(
      { code: -32601 },
    );

    await agent.update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "I used my own tools instead." },
    });
    agent.resolvePrompt("end_turn");
    await flush();
    h.clock.advance(250);
    await flush();

    const status = w.turn(accepted.turnId);
    expect(status.state).toBe("completed");
    expect(status.stopReason).toBe("end_turn");
    expect(status.result?.text).toBe("I used my own tools instead.");
    expect(w.snapshot().state).toBe("ready");
  });

  it("forwards every non-synthesized update verbatim at payloadVersion 1 (§7.5)", async () => {
    const h = harness();
    const agent = rawAgent();
    h.supervisor.enqueue(asScriptedAgent(agent));
    const w = await h.create();

    const accepted = await w.prompt([TEXT("go")], OWNER);
    await flush();
    await agent.update({
      sessionUpdate: "tool_call",
      toolCallId: "call_1",
      title: "Read package.json",
      kind: "read",
      status: "completed",
      _meta: { vendor: { requestId: "abc" } },
    });
    await agent.update({ sessionUpdate: "usage_update", used: 120, size: 8_000 });
    agent.resolvePrompt("end_turn");
    await flush();
    h.clock.advance(250);
    await flush();

    const versions = h.log.all
      .filter((e) => e.kind === "acp.session_update")
      .map((e) => e.payloadVersion);
    // running (2), tool_call (1), usage_update (1), idle (2) — the flag is what lets an M0
    // client tell a synthesized v2 payload from a forwarded v1 one, and makes M1 non-breaking.
    expect(versions).toEqual([2, 1, 1, 2]);

    const toolCall = updates(h.log.all).find((p) => p["sessionUpdate"] === "tool_call");
    expect(toolCall?.["_meta"]).toEqual({ vendor: { requestId: "abc" } });

    const result = w.turn(accepted.turnId).result;
    expect(result?.toolCalls).toEqual([
      {
        toolCallId: "call_1",
        title: "Read package.json",
        kind: "read",
        status: "completed",
        locations: [],
        content: [],
      },
    ]);
    expect(result?.usage).toEqual({ used: 120, size: 8_000 });
    expect(result?.patch).toBeNull();
    expect(result?.changes).toEqual([]);
  });

  it("stamps the sessionId from session/new forward, and never back-fills the prefix (§8.2)", async () => {
    const h = harness();
    const agent = scriptedAgent();
    h.supervisor.enqueue(agent);
    const w = await h.create();
    await w.prompt([TEXT("hi")], OWNER);
    agent.resolvePrompt("end_turn");
    await flush();
    h.clock.advance(250);
    await flush();

    expect(h.log.all[0]?.sessionId).toBeNull();
    for (const e of h.log.all.slice(1)) expect(e.sessionId).toBe("sess_1");
    for (const e of h.log.all) expect(e.workerId).toBe(w.id);
    expect(h.log.all.map((e) => e.seq)).toEqual(h.log.all.map((_, i) => i + 1));
  });

  it("runs consecutive turns with distinct ids and independent aggregates", async () => {
    const h = harness();
    const agent = scriptedAgent();
    h.supervisor.enqueue(agent);
    const w = await h.create();

    const first = await w.prompt([TEXT("one")], OWNER);
    await flush();
    await agent.emitChunk("answer one");
    agent.resolvePrompt("end_turn");
    await flush();
    h.clock.advance(250);
    await flush();

    const second = await w.prompt([TEXT("two")], OWNER);
    await flush();
    await agent.emitChunk("answer two");
    agent.resolvePrompt("max_tokens");
    await flush();
    h.clock.advance(250);
    await flush();

    expect(first.turnId).not.toBe(second.turnId);
    expect(second.seq).toBeGreaterThan(first.seq);
    expect(w.turn(first.turnId).result?.text).toBe("answer one");
    expect(w.turn(second.turnId).result?.text).toBe("answer two");
    expect(w.turn(second.turnId).stopReason).toBe("max_tokens");
    // Neither turn's fold leaks into the other's — the linkage is the envelope's turnId (§8.3).
    expect(w.turn(first.turnId).endSeq).toBeLessThan(w.turn(second.turnId).startSeq!);
  });

  it("caps a permanently chatty agent at the hard cutoff", async () => {
    const h = harness({ quietMs: 250, hardMs: 1_000 });
    const agent = scriptedAgent();
    h.supervisor.enqueue(agent);
    const w = await h.create();

    const accepted = await w.prompt([TEXT("go")], OWNER);
    await flush();
    agent.resolvePrompt("end_turn");
    await flush();

    // An update every 200 ms would move the quiet deadline forever; the hard cutoff is what
    // stops a turn from never ending.
    for (let i = 0; i < 10; i += 1) {
      h.clock.advance(200);
      await agent.emitChunk(`chunk ${String(i)}`);
      await flush();
      if (w.snapshot().state === "ready") break;
    }
    expect(w.snapshot().state).toBe("ready");
    expect(w.turn(accepted.turnId).stopReason).toBe("end_turn");
  });
});
