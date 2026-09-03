import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isAlive, waitGone } from "@omni-acp/testkit";
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
