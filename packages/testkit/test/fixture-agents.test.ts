import { client as acpClient, ndJsonStream } from "@agentclientprotocol/sdk";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { fixtureAgentPath, isAlive, waitGone, wireAgentPath } from "@omni-acp/testkit";
import { launchFixture, type LaunchedFixture } from "./support/launch-fixture.js";

/**
 * Tier-2: every fixture is a REAL v1 stdio ACP agent, driven over real pipes by a real ACP
 * client. Five work packages build their process, crash, cancel and tree-kill tests on these
 * files, so "it is a working agent" has to be an assertion, not a comment.
 */

const slow = Number(process.env["OMNI_TEST_SLOW_FACTOR"] ?? "1");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms * slow));
const text = (u: Record<string, unknown>): string =>
  (u["content"] as { text?: string } | undefined)?.text ?? "";

let running: LaunchedFixture[] = [];
const launch = (...args: Parameters<typeof launchFixture>): LaunchedFixture => {
  const f = launchFixture(...args);
  running.push(f);
  return f;
};

afterEach(async () => {
  const all = running;
  running = [];
  await Promise.all(all.map((f) => f.kill()));
});

describe("fixtures/agents/echo.mjs", () => {
  it("handshakes and answers a prompt with two chunks and end_turn", async () => {
    const agent = launch("echo");
    const sessionId = await agent.handshake();
    expect(sessionId).toBe("echo-1");

    const res = await agent.cx.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "who are you?" }],
    });
    expect(res).toEqual({ stopReason: "end_turn" });
    expect(agent.updates).toHaveLength(2);
    expect(agent.updates.map(text).join("")).toBe("echo: who are you?");
  });

  it("exits on stdin EOF, which is the cooperative rung of the ladder", async () => {
    const agent = launch("echo");
    await agent.handshake();
    agent.child.stdin.end();
    const code = await new Promise<number | null>((resolve) => agent.child.once("exit", resolve));
    expect(code).toBe(0);
  });
});

describe("fixtures/agents/crash.mjs", () => {
  it("emits a chunk, then dies mid-turn without answering session/prompt", async () => {
    const agent = launch("crash");
    const sessionId = await agent.handshake();

    const prompt = agent.cx.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "go" }],
    });
    const exit = new Promise<number | null>((r) => agent.child.once("exit", r));

    // The in-flight RPC rejects with a plain transport error and NO JSON-RPC code, which is
    // exactly why CONTRACTS.md §6.7 says not to classify a crash from it.
    await expect(prompt).rejects.toThrow();
    expect(await exit).toBe(1);
    expect(agent.updates.map(text)).toEqual(["about to crash"]);
    expect(agent.stderrText()).toContain("simulated fault");
  });

  it("honours CRASH_EXIT_CODE and CRASH_DELAY_MS", async () => {
    // WP-2's crash classifier branches on the exit code, and WP-4's tests need a crash that
    // lands after the chunk rather than racing it. Both knobs are documented in the fixture
    // header, so both are pinned here.
    const agent = launch("crash", { CRASH_EXIT_CODE: "42", CRASH_DELAY_MS: "150" });
    const sessionId = await agent.handshake();
    const startedAt = Date.now();
    const exit = new Promise<number | null>((r) => agent.child.once("exit", r));
    void agent.cx
      .request("session/prompt", { sessionId, prompt: [{ type: "text", text: "go" }] })
      .catch(() => {});

    expect(await exit).toBe(42);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100);
    expect(agent.updates.map(text)).toEqual(["about to crash"]);
  });
});

describe("fixtures/agents/slow.mjs", () => {
  it("never answers session/prompt and ignores session/cancel", async () => {
    const agent = launch("slow");
    const sessionId = await agent.handshake();

    const prompt = agent.cx
      .request("session/prompt", { sessionId, prompt: [{ type: "text", text: "go" }] })
      .then(() => "answered");
    await agent.cx.notify("session/cancel", { sessionId });

    expect(await Promise.race([prompt, sleep(250).then(() => "still waiting")])).toBe(
      "still waiting",
    );
    expect(agent.child.exitCode).toBeNull(); // still alive: only escalation ends this one
  });

  it("withholds even the initialize response in handshake mode", async () => {
    const agent = launch("slow", { SLOW_HANDSHAKE: "1" });
    const init = agent.cx
      .request("initialize", { protocolVersion: 1, clientCapabilities: {} })
      .then(() => "answered");
    expect(await Promise.race([init, sleep(250).then(() => "still waiting")])).toBe(
      "still waiting",
    );
  });
});

describe("fixtures/agents/chatty.mjs", () => {
  it("emits a chunk AFTER the prompt response, which is what the quiet window is for", async () => {
    const agent = launch("chatty", { CHATTY_AFTER_MS: "150" });
    const sessionId = await agent.handshake();

    const res = await agent.cx.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "go" }],
    });
    expect(res).toEqual({ stopReason: "end_turn" });
    // At the response boundary the tail has NOT arrived; emitting `idle` here would truncate it.
    expect(agent.updates.map(text)).toEqual(["the answer, "]);

    await sleep(400);
    expect(agent.updates.map(text)).toEqual([
      "the answer, ",
      "and its tail arriving after the response.",
    ]);
  });
});

describe("fixtures/agents/orphan.mjs", () => {
  it("leaves a grandchild appending to $MARKER_FILE — the portable tree-kill oracle", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omni-orphan-"));
    const marker = join(dir, "marker.txt");
    try {
      const agent = launch("orphan", { MARKER_FILE: marker, ORPHAN_INTERVAL_MS: "50" });
      const sessionId = await agent.handshake();
      const res = await agent.cx.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "go" }],
      });
      expect(res).toEqual({ stopReason: "end_turn" });

      const reported = /grandchild pid (\d+)/.exec(agent.updates.map(text).join(""));
      expect(reported).not.toBeNull();
      const grandchild = Number(reported?.[1]);
      expect(await isAlive(grandchild)).toBe(true);

      await sleep(250);
      const first = statSync(marker).size;
      expect(first).toBeGreaterThan(0);
      await sleep(250);
      expect(statSync(marker).size).toBeGreaterThan(first);

      // The grandchild outlives its parent: that is the whole point, and it is why WP-2 needs a
      // tree kill rather than a leader kill. Reclaim it here so this suite leaves no orphan.
      await agent.kill();
      try {
        process.kill(grandchild, "SIGKILL");
      } catch {
        /* already gone */
      }
      expect(await waitGone(grandchild, 3_000)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ORPHAN_EXIT_AFTER_MS: the leader leaves, the grandchild holds stdout open (the zombie)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omni-zombie-"));
    const marker = join(dir, "marker.txt");
    let grandchild = 0;
    try {
      const agent = launch("orphan", {
        MARKER_FILE: marker,
        ORPHAN_INTERVAL_MS: "50",
        ORPHAN_EXIT_AFTER_MS: "400",
      });
      const sessionId = await agent.handshake();
      const exit = new Promise<number | null>((r) => agent.child.once("exit", r));
      await agent.cx.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "go" }],
      });
      grandchild = Number(/grandchild pid (\d+)/.exec(agent.updates.map(text).join(""))?.[1]);
      expect(Number.isInteger(grandchild)).toBe(true);

      expect(await exit).toBe(0); // it left on its own — nobody killed it

      // WP-2 acceptance 9: `exited` has fired, but the grandchild INHERITED stdout, so the pipe
      // is still open and `stdoutEnded` has NOT. A close path that awaits EOF hangs right here,
      // which is the hang this knob exists to reproduce.
      // Windows may close the leader's pipe despite a live descendant. Keep the POSIX EOF
      // assertion, but use liveness and marker growth below as the portable orphan oracle.
      if (process.platform !== "win32") expect(agent.child.stdout.readableEnded).toBe(false);
      expect(await isAlive(grandchild)).toBe(true);

      // ...and the descendant is still writing, so the marker file still grows after the death
      // of the process that spawned it.
      const first = statSync(marker).size;
      expect(first).toBeGreaterThan(0);
      await sleep(200);
      expect(statSync(marker).size).toBeGreaterThan(first);
    } finally {
      if (grandchild > 0) {
        try {
          process.kill(grandchild, "SIGKILL");
        } catch {
          /* already gone */
        }
        await waitGone(grandchild, 3_000);
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("fixtures/agents/noisy.mjs", () => {
  it("floods stderr and emits one oversized frame", async () => {
    const agent = launch("noisy", {
      NOISY_FRAME_BYTES: "20000",
      NOISY_STDERR_BYTES: "20000",
    });
    const sessionId = await agent.handshake();
    const res = await agent.cx.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "go" }],
    });
    expect(res).toEqual({ stopReason: "end_turn" });
    expect(text(agent.updates[0] ?? {})).toHaveLength(20_000);
    // Bytes, not characters: the flood is deliberately multibyte so that WP-2's tail ring has
    // to truncate on a rune boundary rather than a byte one.
    for (let i = 0; i < 40 && Buffer.byteLength(agent.stderrText()) < 20_000; i++) {
      await sleep(25);
    }
    expect(Buffer.byteLength(agent.stderrText())).toBeGreaterThanOrEqual(20_000);
    expect(agent.stderrText()).toContain("ノイズ");
  });

  it("exits mid-turn on command", async () => {
    const agent = launch("noisy", {
      NOISY_FRAME_BYTES: "128",
      NOISY_STDERR_BYTES: "0",
      NOISY_EXIT_MID_TURN: "1",
    });
    const sessionId = await agent.handshake();
    const prompt = agent.cx.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "go" }],
    });
    const exit = new Promise<number | null>((r) => agent.child.once("exit", r));
    await expect(prompt).rejects.toThrow();
    expect(await exit).toBe(3);
  });
});

/**
 * A raw spawn with NO ACP client attached. Two of the documented knobs are about what the agent
 * puts on stdout or what it does with a bad environment — neither survives a client that parses
 * every line as ndJSON, so those two are observed from outside.
 *
 * `node:child_process` here is fine: §6.1's single-spawn rule scopes to the packages' `src`
 * directories, and this file is a test.
 */
function runRaw(
  name: Parameters<typeof launchFixture>[0],
  env: Record<string, string>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [fixtureAgentPath(name)], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => (stdout += d));
    child.stderr.on("data", (d: string) => (stderr += d));
    child.on("error", () => {});
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
    // Nothing is written to stdin, and every agent here exits on EOF — except the ones that
    // exit sooner, which is the point of both cases below.
    child.stdin.end();
  });
}

describe("the documented env knobs, pinned so downstream work packages can rely on them", () => {
  it("noisy: NOISY_STDOUT_GARBAGE=1 puts a banner and a non-JSON line ahead of any frame", async () => {
    const { stdout } = await runRaw("noisy", {
      NOISY_STDOUT_GARBAGE: "1",
      NOISY_STDERR_BYTES: "0",
      NOISY_FRAME_BYTES: "16",
    });
    // WP-2's frame reader must skip these rather than treat them as a protocol_error; a reader
    // that dies on line 1 never reaches the handshake.
    expect(stdout.split("\n").slice(0, 2)).toEqual(["starting up...", "{not json"]);
  });

  it("noisy: the garbage is OFF by default, so no existing test changes behaviour", async () => {
    const { stdout } = await runRaw("noisy", { NOISY_STDERR_BYTES: "0", NOISY_FRAME_BYTES: "16" });
    expect(stdout).not.toContain("starting up...");
  });

  it("orphan: MARKER_FILE is required and its absence is EX_USAGE, not a silent no-op", async () => {
    const { code, stderr } = await runRaw("orphan", { MARKER_FILE: "" });
    expect(code).toBe(64);
    expect(stderr).toContain("MARKER_FILE is required");
  });
});

// ── M1's four gap-filling fixtures, and the wire replayer (CONTRACTS.md §5.7) ─
//
// Each one exists because the research README's "Known gaps" section says the only real agent
// available never produced that shape. They are the ONLY exercise those rows of §12.3 get, so
// "it launches and emits what its header says" has to be an assertion here rather than a claim
// in the file that needs it.

describe("fixtures/agents/plan.mjs", () => {
  it("emits v1 `plan` twice, then a `plan_update` with a `{plan}` body", async () => {
    // The corpus gap: NO `plan` update was emitted in two attempts (this build has no todo
    // tool), so §12.3 rows 7 and 8 have no real-agent ground truth at all.
    const agent = launch("plan");
    const sessionId = await agent.handshake();
    const res = await agent.cx.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "go" }],
    });
    expect(res).toEqual({ stopReason: "end_turn" });
    // The response and the last notification travel on one pipe, and the SDK may resolve the
    // request before it has drained what follows it — which is the whole reason the quiet window
    // exists (§7.2). Waiting here is the test's version of it.
    for (let i = 0; i < 20 && agent.updates.length < 4; i++) await sleep(25);

    const kinds = agent.updates.map((u) => u["sessionUpdate"]);
    expect(kinds).toEqual(["plan", "plan", "plan_update", "agent_message_chunk"]);

    // Two v1 `plan`s with DIFFERENT entry sets: what pins `planId` being stable across the turn.
    const plans = agent.updates.filter((u) => u["sessionUpdate"] === "plan");
    expect(plans).toHaveLength(2);
    expect(JSON.stringify(plans[0]?.["entries"])).not.toBe(JSON.stringify(plans[1]?.["entries"]));

    // Row 8's `=` branch: `{plan:{type,planId,entries}}`, which is what SDK 1.4.0's **v1**
    // schema already requires — see the correction in the fixture's header.
    const updates = agent.updates.filter((u) => u["sessionUpdate"] === "plan_update");
    expect(updates).toHaveLength(1);
    expect((updates[0]?.["plan"] as { type: string }).type).toBe("items");
    expect(updates[0]).not.toHaveProperty("entries");
  });

  it("PLAN_EMIT_V2=0 sends row 8's `{entries}` body, and a v1 client SILENTLY DROPS it", async () => {
    // The correction to §12.3 row 8, asserted rather than assumed. SDK 1.4.0's **v1** schema
    // already types `PlanUpdate` as `{plan: PlanUpdateContent}`, so `{sessionUpdate:"plan_update",
    // entries:[…]}` is not a v1 shape either: the client deserializes it, fails, and drops it —
    // no notification, no error, nothing on stderr. The map still handles the shape, because a
    // non-SDK agent can put anything on a pipe; it simply cannot arrive through this SDK.
    const agent = launch("plan", { PLAN_EMIT_V2: "0" });
    const sessionId = await agent.handshake();
    await agent.cx.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "go" }],
    });
    for (let i = 0; i < 20 && agent.updates.length < 3; i++) await sleep(25);
    await sleep(150);

    expect(agent.updates.map((u) => u["sessionUpdate"])).toEqual([
      "plan",
      "plan",
      "agent_message_chunk",
    ]);
    expect(agent.stderrText()).toBe("");
  });
});

describe("fixtures/agents/thought.mjs", () => {
  it("emits agent_thought_chunk with AND without messageId, in runs", async () => {
    // Two gaps at once: thoughts are never emitted at the default effort, and every recorded
    // chunk carries an id — so §12.4's SYNTHESIS half has no real-agent sample either.
    const agent = launch("thought");
    const sessionId = await agent.handshake();
    await agent.cx.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "go" }],
    });

    expect(agent.updates.map((u) => u["sessionUpdate"])).toEqual([
      "agent_thought_chunk",
      "agent_thought_chunk",
      "agent_message_chunk",
      "agent_thought_chunk",
      "agent_thought_chunk",
    ]);
    // Four without, one with. The run structure is the point: two thoughts, a kind change, a
    // thought again — which is three synthesized ids, not one and not four.
    const withId = agent.updates.filter((u) => u["messageId"] !== undefined);
    expect(withId).toHaveLength(1);
    expect(withId[0]?.["messageId"]).toBe("thought-from-the-agent");
  });
});

describe("fixtures/agents/mode.mjs", () => {
  it("returns `modes` from session/new and emits v1 `current_mode_update`", async () => {
    // The gap: `session/set_mode` on claude-acp produced the v2 `config_option_update` instead,
    // so §12.3 row 11 has no v1-side sample. Row 11 also cannot build its select without the
    // handshake's `modes.availableModes`, which is why the fixture returns one.
    const agent = launch("mode");
    await agent.cx.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const session = (await agent.cx.request("session/new", {
      cwd: process.cwd(),
      mcpServers: [],
    })) as { sessionId: string; modes?: { currentModeId: string; availableModes: unknown[] } };

    expect(session.modes?.currentModeId).toBe("default");
    expect(session.modes?.availableModes).toHaveLength(3);

    await agent.cx.request("session/prompt", {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "go" }],
    });
    const modeUpdates = agent.updates.filter((u) => u["sessionUpdate"] === "current_mode_update");
    expect(modeUpdates.map((u) => u["currentModeId"])).toEqual(["default", "acceptEdits"]);
    // And NOT the v2 spelling: this fixture exists precisely to produce the one claude-acp never did.
    expect(agent.updates.some((u) => u["sessionUpdate"] === "config_option_update")).toBe(false);
  });

  it("MODE_NO_MODES=1 returns no catalogue, which is row 11's honest `options: []` branch", async () => {
    const agent = launch("mode", { MODE_NO_MODES: "1" });
    await agent.cx.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const session = (await agent.cx.request("session/new", {
      cwd: process.cwd(),
      mcpServers: [],
    })) as { modes?: unknown };
    expect(session.modes).toBeUndefined();
  });
});

describe("fixtures/agents/hybrid.mjs", () => {
  it("is a v1/v2 HYBRID: protocolVersion 1, `configOptions` on session/new, `usage_update` on the wire", async () => {
    // F24, made launchable. A mapper that switched on a version number would mangle this agent.
    const agent = launch("hybrid");
    const init = (await agent.cx.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
    })) as { protocolVersion: number };
    expect(init.protocolVersion).toBe(1);

    const session = (await agent.cx.request("session/new", {
      cwd: process.cwd(),
      mcpServers: [],
    })) as { sessionId: string; configOptions?: unknown[]; modes?: unknown };
    expect(session.configOptions).toHaveLength(1);
    expect(session.modes).toBeDefined();

    const res = (await agent.cx.request("session/prompt", {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "go" }],
    })) as { stopReason: string; usage?: { totalTokens: number } };
    expect(res.stopReason).toBe("end_turn");
    // F21: the v2 `Usage` block on the prompt RESPONSE.
    expect(res.usage?.totalTokens).toBe(30);

    expect(agent.updates.map((u) => u["sessionUpdate"])).toEqual([
      "config_option_update",
      "tool_call",
      "usage_update",
      "tool_call_update",
      "agent_message_chunk",
    ]);
  });

  it("fails a tool call ON ITS OWN MERITS — the corpus's last gap", async () => {
    // Every recorded failure was a DENIED permission. This one asks for no permission at all and
    // still ends `status: "failed"`, which is what makes `verdict: partial` provable from the
    // status enum alone.
    const agent = launch("hybrid");
    const sessionId = await agent.handshake();
    await agent.cx.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "go" }],
    });
    const final = agent.updates.find((u) => u["status"] === "failed");
    expect(final?.["toolCallId"]).toBe("hybrid-call-1");
    expect(String(final?.["rawOutput"])).toContain("ENOENT");
  });

  it("HYBRID_EOF_MARKER records stdin EOF, which is how a test observes §13.2 rung 2", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omni-hybrid-"));
    const marker = join(dir, "rungs.txt");
    try {
      const agent = launch("hybrid", { HYBRID_EOF_MARKER: marker });
      await agent.handshake();
      expect(existsSync(marker)).toBe(false);

      const exit = new Promise<number | null>((r) => agent.child.once("exit", r));
      agent.child.stdin.end();
      expect(await exit).toBe(0);
      expect(readFileSync(marker, "utf8")).toBe("eof\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("HYBRID_IGNORE_EOF=1 records the EOF and STAYS ALIVE, so stdout never ends", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omni-hybrid-"));
    const marker = join(dir, "rungs.txt");
    try {
      const agent = launch("hybrid", { HYBRID_EOF_MARKER: marker, HYBRID_IGNORE_EOF: "1" });
      await agent.handshake();
      agent.child.stdin.end();
      await sleep(250);
      expect(readFileSync(marker, "utf8")).toBe("eof\n");
      expect(agent.child.exitCode).toBeNull();
      expect(agent.child.stdout.readableEnded).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("HYBRID_FATAL_STDERR=1 writes ONE COMPLETE line, which is what §13.4 keys on", async () => {
    const agent = launch("hybrid", { HYBRID_FATAL_STDERR: "1" });
    const sessionId = await agent.handshake();
    await agent.cx.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "go" }],
    });
    for (let i = 0; i < 20 && !agent.stderrText().includes("\n"); i++) await sleep(25);
    expect(agent.stderrText()).toBe("FATAL: hybrid fixture cannot continue\n");
  });

  it("HYBRID_NEVER_ANSWER=1 emits every update and then hangs, so a ladder has a live turn", async () => {
    const agent = launch("hybrid", { HYBRID_NEVER_ANSWER: "1" });
    const sessionId = await agent.handshake();
    const prompt = agent.cx
      .request("session/prompt", { sessionId, prompt: [{ type: "text", text: "go" }] })
      .then(() => "answered");
    expect(await Promise.race([prompt, sleep(300).then(() => "still waiting")])).toBe(
      "still waiting",
    );
    expect(agent.updates).toHaveLength(5);
  });

  it("HYBRID_RATE_LIMIT puts a status under the fixture's OWN `_meta` pointer", async () => {
    const agent = launch("hybrid", { HYBRID_RATE_LIMIT: "rejected" });
    const sessionId = await agent.handshake();
    await agent.cx.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "go" }],
    });
    const usage = agent.updates.find((u) => u["sessionUpdate"] === "usage_update");
    expect(
      (usage?.["_meta"] as Record<string, { status: string }>)["hybrid.test/rateLimit"],
    ).toEqual({ status: "rejected", utilization: 0.9 });
  });
});

describe("fixtures/agents/wire.mjs — the corpus over a REAL pipe", () => {
  it("replays a recorded transcript's updates, in order, with the recorded bytes", async () => {
    // §12.7's "Wire-level" note: every other corpus test hands `mapUpdate` an object a
    // `JSON.parse` in the test produced. This one makes the same bytes arrive the way they
    // actually arrived — through the frame limiter and the SDK's own client.
    const child = spawn(process.execPath, [wireAgentPath()], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, WIRE_TRANSCRIPT: "02-tool-read" },
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
    try {
      const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
      const updates: Record<string, unknown>[] = [];
      const connection = acpClient({ name: "wire-driver" })
        .onNotification("session/update", (ctx) => {
          updates.push(ctx.params.update as unknown as Record<string, unknown>);
        })
        .connect(stream);

      const init = (await connection.agent.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {},
      })) as { agentCapabilities?: { loadSession?: boolean } };
      // The RECORDED handshake body, so `mapCapabilities` sees the shape the real agent sent.
      expect(init.agentCapabilities?.loadSession).toBe(true);

      const session = (await connection.agent.request("session/new", {
        cwd: process.cwd(),
        mcpServers: [],
      })) as { sessionId: string };
      const res = (await connection.agent.request("session/prompt", {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "go" }],
      })) as { stopReason: string };

      expect(res.stopReason).toBe("end_turn");
      // The transcript's own count and kinds, over a real pipe.
      expect(updates).toHaveLength(16);
      expect(updates.filter((u) => u["sessionUpdate"] === "tool_call")).toHaveLength(1);
      expect(updates.filter((u) => u["sessionUpdate"] === "tool_call_update")).toHaveLength(3);
      // …and it is the RECORDED object, not a reconstruction: the tool call id is the real one.
      expect(updates.find((u) => u["sessionUpdate"] === "tool_call")?.["toolCallId"]).toBe(
        "toolu_01QAxu6j2Q52J8pYPMBXHRUm",
      );
      connection.close();
    } finally {
      child.kill("SIGKILL");
      await new Promise((r) => child.once("exit", r));
    }
  }, 20_000);

  it("carries a 12.7 KB `available_commands_update` through the framer intact (F13)", async () => {
    const child = spawn(process.execPath, [wireAgentPath()], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, WIRE_TRANSCRIPT: "01-plain-answer" },
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
    try {
      const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
      const updates: Record<string, unknown>[] = [];
      const connection = acpClient({ name: "wire-driver" })
        .onNotification("session/update", (ctx) => {
          updates.push(ctx.params.update as unknown as Record<string, unknown>);
        })
        .connect(stream);
      await connection.agent.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
      const session = (await connection.agent.request("session/new", {
        cwd: process.cwd(),
        mcpServers: [],
      })) as { sessionId: string };
      await connection.agent.request("session/prompt", {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "go" }],
      });

      const commands = updates.filter((u) => u["sessionUpdate"] === "available_commands_update");
      expect(commands).toHaveLength(2);
      // The single largest line in the corpus, arriving as ONE frame.
      expect(JSON.stringify(commands[0]).length).toBeGreaterThan(10_000);
      connection.close();
    } finally {
      child.kill("SIGKILL");
      await new Promise((r) => child.once("exit", r));
    }
  }, 20_000);

  it("WIRE_TRANSCRIPT is required, and its absence is EX_USAGE", async () => {
    const { code, stderr } = await runRawPath(wireAgentPath(), { WIRE_TRANSCRIPT: "" });
    expect(code).toBe(64);
    expect(stderr).toContain("WIRE_TRANSCRIPT is required");
  });

  it("a transcript that does not exist is EX_NOINPUT, not a silent empty replay", async () => {
    const { code, stderr } = await runRawPath(wireAgentPath(), { WIRE_TRANSCRIPT: "99-nope" });
    expect(code).toBe(66);
    expect(stderr).toContain("cannot read transcript 99-nope");
  });
});

/** `runRaw`, for an agent whose path is not a `FixtureAgentName`. */
function runRawPath(
  path: string,
  env: Record<string, string>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => (stdout += d));
    child.stderr.on("data", (d: string) => (stderr += d));
    child.on("error", () => {});
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end();
  });
}
