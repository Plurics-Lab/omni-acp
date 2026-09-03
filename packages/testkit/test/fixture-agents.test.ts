import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixtureAgentPath, isAlive, waitGone } from "@omni-acp/testkit";
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
      expect(agent.child.stdout.readableEnded).toBe(false);
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
