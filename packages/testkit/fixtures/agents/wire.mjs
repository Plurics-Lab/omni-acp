#!/usr/bin/env node
// Fixture agent: wire — Tier-2, and the only one that is not hand-written behaviour.
//
// It REPLAYS a recorded claude-acp transcript over a real pipe: the same `session/update`
// notifications, in the same order, with the same bytes, answered through the SDK's own agent
// helper. That is what makes the corpus exercise the Supervisor, the frame limiter and the
// AcpLink rather than only `mapUpdate` (CONTRACTS.md §5.7, §12.7's "Wire-level" note).
//
// Driven entirely by the environment — see `wireAgentPath()` / `wireAgentEnv()` in
// `packages/testkit/src/wire-agent.ts`:
//
//   WIRE_TRANSCRIPT=<name>   required, e.g. "02-tool-read"
//   WIRE_SPEED=<factor>      0 (default) = as fast as the pipe allows; 1 = recorded real time
//   WIRE_STOP_REASON=<r>     override the recorded stop reason
//
// What it does NOT replay: the recorded `session/request_permission` requests. Answering one
// requires a client, and a fixture that BLOCKED on a permission answer would hang every test
// that did not happen to install a responder. The permission path has its own fixtures.
//
// Launched as `process.execPath <this file>`, never through npx (CONTRACTS.md §6.3).
import * as acp from "@agentclientprotocol/sdk";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

const NAME = process.env.WIRE_TRANSCRIPT ?? "";
const SPEED = Number(process.env.WIRE_SPEED ?? "0");
const STOP_REASON = process.env.WIRE_STOP_REASON ?? "";

if (NAME === "") {
  process.stderr.write("WIRE_TRANSCRIPT is required\n");
  process.exit(64); // EX_USAGE, the same contract orphan.mjs uses
}

const here = dirname(fileURLToPath(import.meta.url));
// fixtures/agents/wire.mjs -> packages/testkit -> packages -> <repo root>
const file = join(
  here,
  "..",
  "..",
  "..",
  "..",
  "docs",
  "research",
  "transcripts",
  "claude-acp-0.73.0",
  `${NAME}.jsonl`,
);

let lines;
try {
  lines = readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l))
    .filter((l) => l.dir !== "meta");
} catch (e) {
  process.stderr.write(`cannot read transcript ${NAME}: ${String(e)}\n`);
  process.exit(66); // EX_NOINPUT
}

const fromAgent = lines.filter((l) => l.dir === "agent->client" && l.msg);
const updates = fromAgent.filter((l) => l.msg.method === "session/update");
/** The recorded answer to `session/prompt`, which is client request id 3 in every scenario. */
const promptResult = fromAgent.find((l) => l.msg.result && l.msg.result.stopReason)?.msg.result;
const initializeResult = fromAgent.find((l) => l.msg.result && l.msg.result.agentCapabilities)?.msg
  .result;
const newSessionResult = fromAgent.find((l) => l.msg.result && l.msg.result.sessionId)?.msg.result;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));

acp
  .agent({ name: "wire" })
  .onRequest(
    "initialize",
    () =>
      // The RECORDED body when the transcript has one, so `mapCapabilities` sees the real shape.
      initializeResult ?? {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: { loadSession: false },
      },
  )
  .onRequest("session/new", () => newSessionResult ?? { sessionId: `wire-${NAME}` })
  .onRequest("session/prompt", async (ctx) => {
    const sessionId = ctx.params.sessionId;
    let previous = updates.length > 0 ? updates[0].tMs : 0;
    for (const line of updates) {
      if (SPEED > 0) {
        await sleep(Math.max(0, (line.tMs - previous) / SPEED));
        previous = line.tMs;
      }
      // `update` verbatim; only `sessionId` is rewritten, because it is OUR session and the
      // recorded one belongs to a process that no longer exists.
      await ctx.client.notify("session/update", { sessionId, update: line.msg.params.update });
    }
    const result = promptResult ?? { stopReason: "end_turn" };
    return STOP_REASON === "" ? result : { ...result, stopReason: STOP_REASON };
  })
  .onNotification("session/cancel", () => {})
  .connect(stream);
