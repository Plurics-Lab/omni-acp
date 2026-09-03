import { client as acpClient } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { ACP_V1_VERSION, type PermissionOption } from "@omni-acp/protocol";
import { memoryStreamPair, scriptedAgent } from "@omni-acp/testkit";

/** CONTRACTS.md §10.3: macOS CI gets a 2x multiplier; the budget is a budget, not a stopwatch. */
const slow = Number(process.env["OMNI_TEST_SLOW_FACTOR"] ?? "1");

interface Driver {
  readonly updates: Record<string, unknown>[];
  readonly connection: ReturnType<ReturnType<typeof acpClient>["connect"]>;
}

function driveClient(
  stream: Parameters<ReturnType<typeof acpClient>["connect"]>[0],
  onPermission?: (req: unknown) => unknown,
): Driver {
  const updates: Record<string, unknown>[] = [];
  const app = acpClient({ name: "test-client" })
    .onNotification("session/update", (ctx) => {
      updates.push(ctx.params.update as unknown as Record<string, unknown>);
    })
    .onRequest("session/request_permission", (ctx) => {
      if (onPermission === undefined) {
        return { outcome: { outcome: "cancelled" } };
      }
      return onPermission(ctx.params) as never;
    });
  return { updates, connection: app.connect(stream) };
}

describe("memoryStreamPair", () => {
  it("cross-wires the two sides", async () => {
    const [a, b] = memoryStreamPair();
    const writer = a.writable.getWriter();
    const reader = b.readable.getReader();
    const message = { jsonrpc: "2.0", id: 1, method: "ping", params: {} };
    // A TransformStream's readable side has highWaterMark 0, so the write only completes once
    // something reads: real backpressure, which is the point of using one here.
    const written = writer.write(message as never);
    const { value } = await reader.read();
    // `toBe`, not `toEqual`: the very same object crosses the pair, which is only possible with
    // no serialization and therefore no process in between.
    expect(value).toBe(message);
    await written;
    reader.releaseLock();
    await writer.close();
  });
});

async function fullExchange(): Promise<void> {
  const agent = scriptedAgent();
  const { connection } = driveClient(agent.stream);
  const cx = connection.agent;
  await cx.request("initialize", { protocolVersion: ACP_V1_VERSION, clientCapabilities: {} });
  const session = await cx.request("session/new", { cwd: "/tmp", mcpServers: [] });
  const prompt = cx.request("session/prompt", {
    sessionId: session.sessionId,
    prompt: [{ type: "text", text: "warm up" }],
  });
  await agent.emitChunk("warm");
  agent.resolvePrompt("end_turn");
  await prompt;
  connection.close();
}

describe("scriptedAgent", () => {
  it("drives initialize -> session/new -> session/prompt -> stopReason with no process", async () => {
    // Warm-up first: the budget is for the EXCHANGE, not for the first-ever JIT of the SDK's
    // connection machinery, which would make the number a measure of module loading.
    await fullExchange();

    const started = performance.now();
    const agent = scriptedAgent({ name: "unit" });
    const { updates, connection } = driveClient(agent.stream);
    const cx = connection.agent;

    const init = await cx.request("initialize", {
      protocolVersion: ACP_V1_VERSION,
      clientCapabilities: {},
    });
    expect(init.protocolVersion).toBe(1);
    expect(init.agentCapabilities?.loadSession).toBe(false);

    const session = await cx.request("session/new", { cwd: "/tmp", mcpServers: [] });
    expect(session.sessionId).toBe("sess_1");
    expect(agent.sessionIds).toEqual(["sess_1"]);

    const prompt = cx.request("session/prompt", {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "who are you?" }],
    });

    await agent.emitChunk("I am ");
    await agent.emitChunk("a script.");
    agent.resolvePrompt("end_turn");

    expect(await prompt).toEqual({ stopReason: "end_turn" });
    expect(updates.map((u) => u["sessionUpdate"])).toEqual([
      "agent_message_chunk",
      "agent_message_chunk",
    ]);

    connection.close();
    // WP-1 acceptance 7's load-bearing claim is "no process", so assert that directly: the
    // agent talks over the in-memory pair (see the memoryStreamPair suite: a message crosses it
    // by object identity, which no pipe to a child process could do).
    // The budget is a spawn detector, not a microbenchmark: a real spawn + handshake of the SDK
    // example agent is ~400-700ms (see the fixture-agents suite), so 250ms still proves no
    // process was started while leaving room for a loaded, parallel runner.
    expect(performance.now() - started).toBeLessThan(250 * slow);
  });

  it("emits thoughts, tool calls, diffs and usage in the shapes reduceTurn folds", async () => {
    const agent = scriptedAgent();
    const { updates, connection } = driveClient(agent.stream);
    const cx = connection.agent;
    await cx.request("initialize", { protocolVersion: ACP_V1_VERSION, clientCapabilities: {} });
    await cx.request("session/new", { cwd: "/tmp", mcpServers: [] });

    await agent.emitThought("hmm");
    await agent.emitToolCall({ toolCallId: "call_1", title: "Reading", kind: "read" });
    await agent.emitDiff("call_1", "/repo/a.ts", null, "created");
    await agent.emitUsage(42, 200);

    expect(updates).toEqual([
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } },
      { sessionUpdate: "tool_call", toolCallId: "call_1", title: "Reading", kind: "read" },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "call_1",
        content: [{ type: "diff", path: "/repo/a.ts", oldText: null, newText: "created" }],
      },
      { sessionUpdate: "usage_update", used: 42, size: 200 },
    ]);
    connection.close();
  });

  it("issues session/request_permission and reports the option the client chose", async () => {
    const agent = scriptedAgent();
    const offered: PermissionOption[] = [
      { kind: "allow_once", name: "Allow", optionId: "allow" },
      { kind: "reject_once", name: "Skip", optionId: "reject" },
    ];
    const { connection } = driveClient(agent.stream, () => ({
      outcome: { outcome: "selected", optionId: "reject" },
    }));
    const cx = connection.agent;
    await cx.request("initialize", { protocolVersion: ACP_V1_VERSION, clientCapabilities: {} });
    await cx.request("session/new", { cwd: "/tmp", mcpServers: [] });

    expect(await agent.requestPermission(offered)).toBe("reject");
    connection.close();
  });

  it("reports a JSON-RPC error answer as {error: code}, which is D4 rule 4's -32603", async () => {
    const agent = scriptedAgent();
    const { connection } = driveClient(agent.stream, () => {
      throw new Error("nothing acceptable was offered");
    });
    const cx = connection.agent;
    await cx.request("initialize", { protocolVersion: ACP_V1_VERSION, clientCapabilities: {} });
    await cx.request("session/new", { cwd: "/tmp", mcpServers: [] });

    expect(await agent.requestPermission([])).toEqual({ error: -32603 });
    connection.close();
  });

  it("emits an update AFTER the prompt has already returned (the L5 quiet-window case)", async () => {
    const agent = scriptedAgent();
    const { updates, connection } = driveClient(agent.stream);
    const cx = connection.agent;
    await cx.request("initialize", { protocolVersion: ACP_V1_VERSION, clientCapabilities: {} });
    await cx.request("session/new", { cwd: "/tmp", mcpServers: [] });

    const prompt = cx.request("session/prompt", {
      sessionId: "sess_1",
      prompt: [{ type: "text", text: "hi" }],
    });
    agent.emitAfterPromptResolves(20, "the tail");
    agent.resolvePrompt("end_turn");
    await prompt;
    expect(updates).toEqual([]);

    await new Promise((r) => setTimeout(r, 60 * slow));
    expect(updates).toEqual([
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "the tail" } },
    ]);
    connection.close();
  });

  it("hang() leaves the prompt unanswered forever", async () => {
    const agent = scriptedAgent();
    const { connection } = driveClient(agent.stream);
    const cx = connection.agent;
    await cx.request("initialize", { protocolVersion: ACP_V1_VERSION, clientCapabilities: {} });
    await cx.request("session/new", { cwd: "/tmp", mcpServers: [] });

    agent.hang();
    const race = await Promise.race([
      cx
        .request("session/prompt", { sessionId: "sess_1", prompt: [{ type: "text", text: "?" }] })
        .then(() => "answered"),
      new Promise((r) => setTimeout(() => r("still waiting"), 50 * slow)),
    ]);
    expect(race).toBe("still waiting");
    connection.close();
  });

  it("die() closes the transport, so an in-flight request rejects instead of hanging", async () => {
    const agent = scriptedAgent();
    const { connection } = driveClient(agent.stream);
    const cx = connection.agent;
    await cx.request("initialize", { protocolVersion: ACP_V1_VERSION, clientCapabilities: {} });
    await cx.request("session/new", { cwd: "/tmp", mcpServers: [] });

    const prompt = cx.request("session/prompt", {
      sessionId: "sess_1",
      prompt: [{ type: "text", text: "?" }],
    });
    agent.die();
    await expect(prompt).rejects.toThrow();
    connection.close();
  });

  it("setCapabilities is reflected by the next initialize", async () => {
    const agent = scriptedAgent();
    agent.setCapabilities({ loadSession: true, sessionCapabilities: { close: true } });
    const { connection } = driveClient(agent.stream);
    const init = await connection.agent.request("initialize", {
      protocolVersion: ACP_V1_VERSION,
      clientCapabilities: {},
    });
    expect(init.agentCapabilities).toEqual({
      loadSession: true,
      sessionCapabilities: { close: true },
    });
    connection.close();
  });
});
