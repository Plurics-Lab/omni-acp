#!/usr/bin/env node
// Fixture agent: wire-recorder — Tier-3 (a real process, real ndJSON over real pipes).
//
// It answers a handshake and a prompt, and it WRITES DOWN EVERY REQUEST IT RECEIVED, one JSON
// object per line, to `$RECORDER_LOG`. That log is the whole point: two of M2-B-WP-S's acceptance
// bullets are claims about what did or did not reach an agent, and neither can be checked from
// this side of the pipe.
//
//   * §26 / F37 / F38 — "in every rejected case the fixture agent recorded ZERO `session/prompt`
//     calls". Containment is ours or it does not exist, and "before the send" is the entire
//     acceptance, so the only honest evidence is the agent's own record of what it was asked.
//   * §12.3 row 22 — the `McpServer` `type` injection, unreachable from the wire in M1 because
//     `mcpServers` was always `[]`. The recorded `session/new` params are the first look at what
//     a resolved preset actually looks like on the wire.
//
// DEPENDENCY-FREE ON PURPOSE. It speaks JSON-RPC over ndJSON by hand rather than through
// `@agentclientprotocol/sdk`, so it can be launched as `process.execPath <this file>` from
// anywhere — including a `mkdtemp` workspace with no `node_modules` — and so that a bug in the
// SDK's framing cannot be mistaken for a bug in ours. Never through npx (CONTRACTS.md §6.3).
//
// Environment:
//   RECORDER_LOG          required. JSONL: {"method","params"} per received request/notification.
//   RECORDER_MCP_CAPS     JSON for `agentCapabilities.mcpCapabilities`. Omitted when unset, which
//                         is the "agent declared no block" case `toleratesOmittedMcpCapabilities`
//                         decides (§23.2).
//   RECORDER_PROMPT_CAPS  JSON for `agentCapabilities.promptCapabilities`. Default
//                         `{"image":true,"embeddedContext":true}` — claude-acp 0.73.0's recorded
//                         answer (F37).
//   RECORDER_REPLY        the text this agent streams back. Default "recorded".
//
// Owned by M2-B-WP-S.
import { appendFileSync } from "node:fs";

const LOG = process.env.RECORDER_LOG ?? "";
if (LOG === "") {
  process.stderr.write("RECORDER_LOG is required\n");
  process.exit(64); // EX_USAGE, the contract orphan.mjs uses
}

const parseEnvJson = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    process.stderr.write(`${name} is not JSON\n`);
    process.exit(65); // EX_DATAERR
  }
};

const MCP_CAPS = parseEnvJson("RECORDER_MCP_CAPS", undefined);
const PROMPT_CAPS = parseEnvJson("RECORDER_PROMPT_CAPS", {
  image: true,
  embeddedContext: true,
});
const REPLY = process.env.RECORDER_REPLY ?? "recorded";

/** Appended SYNCHRONOUSLY, so a test that reads the file after a rejected prompt sees the truth. */
function record(method, params) {
  appendFileSync(LOG, `${JSON.stringify({ method, params })}\n`);
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

let sessions = 0;

function handle(message) {
  const { id, method, params } = message;
  if (typeof method !== "string") return; // a response to something we sent; we send no requests
  record(method, params ?? null);

  // A notification has no id and gets no reply — `session/cancel` is the one that matters.
  if (id === undefined || id === null) return;

  if (method === "initialize") {
    const agentCapabilities = { loadSession: false, promptCapabilities: PROMPT_CAPS };
    // OMITTED rather than null when unset: an absent block and an empty one are different
    // questions, and only the absent one reaches the descriptor quirk (§23.2).
    if (MCP_CAPS !== undefined) agentCapabilities.mcpCapabilities = MCP_CAPS;
    write({
      jsonrpc: "2.0",
      id,
      result: { protocolVersion: 1, agentCapabilities, agentInfo: { name: "wire-recorder" } },
    });
    return;
  }

  if (method === "session/new") {
    sessions += 1;
    write({ jsonrpc: "2.0", id, result: { sessionId: `rec-${sessions}` } });
    return;
  }

  if (method === "session/prompt") {
    const sessionId = params?.sessionId;
    write({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: REPLY } },
      },
    });
    write({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    return;
  }

  if (method === "session/close") {
    write({ jsonrpc: "2.0", id, result: {} });
    return;
  }

  // Everything else is honestly unknown, with the uniform shape the corpus records (§17.4).
  write({
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: "Method not found", data: { method } },
  });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line !== "") {
      try {
        handle(JSON.parse(line));
      } catch (e) {
        process.stderr.write(`unparseable frame: ${String(e)}\n`);
      }
    }
    newline = buffer.indexOf("\n");
  }
});
process.stdin.on("end", () => {
  process.exit(0);
});
