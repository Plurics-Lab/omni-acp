#!/usr/bin/env node
// Fixture agent: orphan — Tier-2 (a real process, real ndJSON over real pipes).
//
// Spawns a GRANDCHILD that appends to $MARKER_FILE every 100ms and then sleeps for 300s. The
// marker file is the portable tree-kill oracle: after terminate(), the file must stop growing
// within 2s. It needs no pid introspection, which is exactly what Windows cannot give us
// (CONTRACTS.md §6.4, M0-PLAN WP-2 acceptance 5).
//
// The grandchild INHERITS this process's stdout, so it also holds the ndJSON pipe open after
// the leader exits — the "zombie" case where `stdoutEnded` fires long after `exited`, or never
// (WP-2 acceptance 9). Set ORPHAN_EXIT_AFTER_MS to make the leader leave on its own.
//
// Env: MARKER_FILE (required), ORPHAN_INTERVAL_MS (default 100), ORPHAN_EXIT_AFTER_MS (unset).
//
// `node:child_process` here is fine: §6.1's single-spawn rule scopes to packages/*/src/**, and
// a fixture whose entire job is to leave a descendant behind cannot borrow the Supervisor.
import * as acp from "@agentclientprotocol/sdk";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));

const MARKER_FILE = process.env.MARKER_FILE;
const INTERVAL_MS = Number(process.env.ORPHAN_INTERVAL_MS ?? "100");
const EXIT_AFTER_MS = process.env.ORPHAN_EXIT_AFTER_MS;

if (!MARKER_FILE) {
  process.stderr.write("orphan.mjs: MARKER_FILE is required\n");
  process.exit(64); // EX_USAGE
}

// Dynamic import rather than `require`, so the snippet runs whether node evaluates `-e` as
// CommonJS or as ESM.
const GRANDCHILD = `
import("node:fs").then(({ appendFileSync }) => {
  const f = ${JSON.stringify(MARKER_FILE)};
  setInterval(() => { try { appendFileSync(f, "x"); } catch {} }, ${INTERVAL_MS});
  setTimeout(() => process.exit(0), 300000);
});
`;

const grandchild = spawn(process.execPath, ["-e", GRANDCHILD], {
  // stdout is INHERITED on purpose: that is what makes this the zombie-case fixture too.
  stdio: ["ignore", "inherit", "ignore"],
  windowsHide: true,
});
grandchild.unref();

if (EXIT_AFTER_MS !== undefined) {
  setTimeout(() => process.exit(0), Number(EXIT_AFTER_MS));
}

let sessions = 0;

acp
  .agent({ name: "orphan" })
  .onRequest("initialize", () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false },
  }))
  .onRequest("session/new", () => ({ sessionId: `orphan-${++sessions}` }))
  .onRequest("session/prompt", async (ctx) => {
    await ctx.client.notify("session/update", {
      sessionId: ctx.params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `grandchild pid ${grandchild.pid}` },
      },
    });
    return { stopReason: "end_turn" };
  })
  .onNotification("session/cancel", () => {})
  .connect(stream);
