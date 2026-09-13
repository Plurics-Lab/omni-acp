// A real ACP fixture that connects a supplied stdio MCP. No model or external service.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
let child;
let nextId = 0;
const pending = new Map();

function rpc(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

async function connect(server) {
  if (!server?.command) throw new Error("fixture requires one stdio MCP server");
  child = spawn(server.command, server.args ?? [], {
    stdio: ["pipe", "pipe", "inherit"],
    env: {
      ...process.env,
      ...Object.fromEntries((server.env ?? []).map((v) => [v.name, v.value])),
    },
  });
  const fail = (error) => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  child.on("error", fail);
  child.on("exit", () => fail(new Error("MCP fixture exited")));
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });
  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "fixture", version: "1" },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const listed = await rpc("tools/list");
  if (listed.tools?.[0]?.name !== "ping") throw new Error("installed MCP did not expose ping");
}

async function handle(message) {
  const { id, method, params } = message;
  if (method === "initialize")
    return send({
      id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: false, mcpCapabilities: {}, promptCapabilities: {} },
        agentInfo: { name: "managed-mcp-fixture", version: "1" },
      },
    });
  if (method === "session/new") {
    await connect(params.mcpServers?.[0]);
    return send({ id, result: { sessionId: "managed-session" } });
  }
  if (method === "session/prompt") {
    const result = await rpc("tools/call", { name: "ping", arguments: {} });
    send({
      method: "session/update",
      params: {
        sessionId: "managed-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: result.content[0].text },
        },
      },
    });
    return send({ id, result: { stopReason: "end_turn" } });
  }
  if (method === "session/cancel") {
    child?.kill();
    return;
  }
  if (id !== undefined) send({ id, error: { code: -32601, message: "Method not found" } });
}

createInterface({ input: process.stdin })
  .on("line", (line) => {
    const message = JSON.parse(line);
    handle(message).catch((error) =>
      send({ id: message.id, error: { code: -32603, message: error.message } }),
    );
  })
  .on("close", () => {
    child?.kill();
    process.exit(0);
  });
process.on("SIGTERM", () => {
  child?.kill();
  process.exit(0);
});
