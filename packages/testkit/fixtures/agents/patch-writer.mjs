#!/usr/bin/env node
// Fixture agent: patch-writer — Tier-2 (a real process, real ndJSON over real pipes).
//
// It actually WRITES to its own cwd, which no other fixture and neither the SDK example agent do:
// the example agent SIMULATES its edit (`rawOutput: {success: true}`) and never touches the disk,
// so it can prove a permission was allowed and can prove nothing at all about D8. A git patch is
// a fact about the filesystem, and a fixture that changes no file can only ever produce an empty
// one.
//
// It can also create `.git/` in its own cwd MID-TURN, which is F39's observed codex-acp behaviour
// (`08`'s `workspace_after` held `.git/`, `.codex/` and `.agents/` the recorder never made). That
// is the input the provider's "probe at BOTH ends of every turn" rule exists for, and this is the
// only way to reproduce it deterministically.
//
// The turn is one `tool_call{kind:"edit"}`, the write, one terminal `tool_call_update`, a message
// chunk and `end_turn` — the shape a real edit turn has, so the whole daemon path (normalizer,
// turn projection, diff provider) sees what it would see from a real agent.
//
// Env:
//   PATCH_FILES=<json>    {"<relative path>": "<content>"}; default {"hello.txt":"hello\n"}
//   PATCH_INIT_GIT=1      write a `.git/` skeleton into the cwd BEFORE the files (F39)
//   PATCH_DELAY_MS=<n>    wait this long before writing, so two turns can be made to overlap
//   PATCH_NO_LOCATIONS=1  omit `locations[]`, which is codex's under-reporting shape (F38)
//   PATCH_ASK=1           request `session/request_permission` for the edit, and write ONLY if a
//                         grant option was chosen — the shape §4 step 1's park needs from a
//                         fixture, because the SDK example agent asks and then simulates
import * as acp from "@agentclientprotocol/sdk";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));

const FILES = JSON.parse(process.env.PATCH_FILES ?? '{"hello.txt":"hello\\n"}');
const INIT_GIT = process.env.PATCH_INIT_GIT === "1";
const DELAY_MS = Number(process.env.PATCH_DELAY_MS ?? "0");
const NO_LOCATIONS = process.env.PATCH_NO_LOCATIONS === "1";
const ASK = process.env.PATCH_ASK === "1";

let sessions = 0;
/** The cwd `session/new` was called with — where the files go. */
const cwdOf = new Map();

/** The same four entries `testkit`'s `tempRepo()` writes: a zero-commit repository (§25.2). */
function initGit(cwd) {
  mkdirSync(join(cwd, ".git", "objects"), { recursive: true });
  mkdirSync(join(cwd, ".git", "refs", "heads"), { recursive: true });
  writeFileSync(join(cwd, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
  writeFileSync(
    join(cwd, ".git", "config"),
    "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n",
    "utf8",
  );
}

acp
  .agent({ name: "patch-writer" })
  .onRequest("initialize", () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false },
  }))
  .onRequest("session/new", (ctx) => {
    const sessionId = `patch-writer-${++sessions}`;
    cwdOf.set(sessionId, ctx.params.cwd);
    return { sessionId };
  })
  .onRequest("session/prompt", async (ctx) => {
    const sessionId = ctx.params.sessionId;
    const cwd = cwdOf.get(sessionId) ?? process.cwd();
    const paths = Object.keys(FILES).map((p) => join(cwd, p));

    await ctx.client.notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "patch_write_1",
        title: `Write ${Object.keys(FILES).join(", ")}`,
        kind: "edit",
        status: "in_progress",
        ...(NO_LOCATIONS ? {} : { locations: paths.map((path) => ({ path })) }),
      },
    });

    // The permission, when asked for: two options, `allow_once` and `reject_once`, which is the
    // menu D4 rule 2 expects and the one both real agents offer for an edit (corpus 03/04/09).
    let allowed = true;
    if (ASK) {
      const outcome = await ctx.client.request("session/request_permission", {
        sessionId,
        toolCall: {
          toolCallId: "patch_write_1",
          title: `Write ${Object.keys(FILES).join(", ")}`,
          kind: "edit",
          ...(NO_LOCATIONS ? {} : { locations: paths.map((path) => ({ path })) }),
        },
        options: [
          { optionId: "allow", name: "Yes", kind: "allow_once" },
          { optionId: "reject", name: "No", kind: "reject_once" },
        ],
      });
      allowed = outcome?.outcome?.outcome === "selected" && outcome.outcome.optionId === "allow";
      process.stderr.write(`omni-fixture permission ${JSON.stringify(outcome)}\n`);
    }

    if (DELAY_MS > 0) await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
    // BEFORE the files, so a provider that probed only at `begin` would diff a repository that
    // did not exist when it started.
    if (INIT_GIT) initGit(cwd);
    if (allowed) {
      for (const [relative, content] of Object.entries(FILES)) {
        const path = join(cwd, relative);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content, "utf8");
      }
    }

    await ctx.client.notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "patch_write_1",
        status: allowed ? "completed" : "failed",
        rawOutput: { written: allowed ? Object.keys(FILES) : [] },
      },
    });
    await ctx.client.notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: allowed
            ? `wrote ${String(Object.keys(FILES).length)} file(s)`
            : "the write was refused, so I changed nothing",
        },
      },
    });
    return { stopReason: "end_turn" };
  })
  .connect(stream);
