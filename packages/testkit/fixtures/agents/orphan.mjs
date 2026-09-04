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
// Env: MARKER_FILE (required), ORPHAN_INTERVAL_MS (default 100), ORPHAN_EXIT_AFTER_MS (unset),
//      ORPHAN_SURVIVE_EOF (unset).
//
// ORPHAN_SURVIVE_EOF=1 keeps the LEADER alive after stdin closes, which is the only shape in
// which §15.7's orphan story is observable end to end. Without it, killing the daemon closes
// this process's stdin, the SDK connection ends, node's event loop empties and the leader exits
// on its own — so the pid the daemon RECORDED (`OrphanRecord.pid`) is already gone by the time
// the next boot looks, `reapSkipped` is `"gone"`, and the fingerprint match the whole ruling
// M1-R9 rests on is never exercised. A wedged agent that ignores EOF is a real failure mode
// (`hybrid.mjs` has the same knob for the close-out ladder), and it is the one that leaves a
// process tree behind for a later boot to find.
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
const SURVIVE_EOF = process.env.ORPHAN_SURVIVE_EOF === "1";

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

// A live (not unref'd) timer: with stdin at EOF nothing else holds the loop open, and "survive"
// takes work rather than being the default. `SIGTERM` still ends it, so the Supervisor's ladder
// reclaims this process exactly as it does any other.
if (SURVIVE_EOF) {
  const keepAlive = setInterval(() => {}, 1_000);
  process.on("SIGTERM", () => {
    clearInterval(keepAlive);
    process.exit(0);
  });
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
