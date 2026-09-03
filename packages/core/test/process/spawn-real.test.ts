import * as acp from "@agentclientprotocol/sdk";
import { OmniError, type AgentProcess, type Supervisor } from "@omni-acp/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { fixtureSpec, realSupervisor, sleep, slow } from "./support.js";

/**
 * Tier-2: real processes, real ndJSON over real pipes (CONTRACTS.md §10.1).
 *
 * WP-2 acceptance 4 (the `initialize` round trip and the `ndJsonStream(write, read)` argument
 * order), 11 (the frame limit against `noisy.mjs`) and 12's real half (the stderr tail against a
 * process that actually crashes). Written to pass unchanged on all three OSes: every launch is
 * `process.execPath <fixture>` and nothing here reads a pid.
 */

const TIMEOUT = slow(20_000);

let supervisor: Supervisor | null = null;
const started: AgentProcess[] = [];

async function spawn(...args: Parameters<Supervisor["spawn"]>): Promise<AgentProcess> {
  supervisor ??= realSupervisor({ gracefulMs: 1_000, killConfirmMs: 1_000, exitGraceMs: 500 });
  const p = await supervisor.spawn(...args);
  started.push(p);
  return p;
}

afterEach(async () => {
  // No orphan processes after any suite, on any OS (M0-PLAN §5.4).
  for (const p of started.splice(0)) await p.terminate({ force: true });
  supervisor = null;
});

describe("a real agent over a real pipe", () => {
  it(
    "acceptance 4: `stream` completes an initialize round trip against echo.mjs",
    async () => {
      const p = await spawn(fixtureSpec("echo"));

      const result = await acp.client({ name: "omni-acp-wp2" }).connectWith(p.stream, (ctx) =>
        ctx.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {}, // D3: M0 advertises none at all
        }),
      );

      expect(result.protocolVersion).toBe(1);
      expect(result.agentCapabilities?.loadSession).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "acceptance 4: the ndJsonStream argument order is (what we WRITE, what we READ) — F6",
    async () => {
      // Swapping the two arguments produces a HANG, not an error: we would be writing to the
      // child's stdout and reading its stdin. So the proof is that a request written into
      // `stream.writable` comes back out of `stream.readable` at all, within a bounded wait.
      const p = await spawn(fixtureSpec("echo"));

      const writer = p.stream.writable.getWriter();
      await writer.write({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: 1, clientCapabilities: {} },
      } as never);
      writer.releaseLock();

      const reader = p.stream.readable.getReader();
      const first = await Promise.race([
        reader.read().then((r) => r.value),
        sleep(slow(8_000)).then(() => "timed out" as const),
      ]);
      reader.releaseLock();

      expect(first).not.toBe("timed out");
      expect(first).toMatchObject({ jsonrpc: "2.0", id: 1 });
    },
    TIMEOUT,
  );

  it(
    "reports a real pid, a real POSIX group id, and the resolved command",
    async () => {
      const p = await spawn(fixtureSpec("echo"));
      expect(p.pid).toBeGreaterThan(0);
      expect(p.info.pid).toBe(p.pid);
      expect(p.info.command).toBe(process.execPath);
      expect(p.info.argsRedacted[0]).toMatch(/echo\.mjs$/);
      if (process.platform === "win32") expect(p.info.groupId).toBeNull();
      else expect(p.info.groupId).toBe(p.info.pid);
    },
    TIMEOUT,
  );

  it(
    "settles `exited` and `stdoutEnded` when an agent dies on its own",
    async () => {
      // crash.mjs answers the handshake, writes to stderr and exits. Nothing inherits its
      // stdout, so both death signals arrive — the ordinary case §6.7 contrasts the zombie with.
      const p = await spawn(fixtureSpec("crash", { env: { CRASH_DELAY_MS: "10" } }));

      await acp
        .client({ name: "omni-acp-wp2" })
        .connectWith(p.stream, async (ctx) => {
          await ctx.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {},
          });
          const session = await ctx.request(acp.methods.agent.session.new, {
            cwd: process.cwd(),
            mcpServers: [],
          });
          await ctx
            .request(acp.methods.agent.session.prompt, {
              sessionId: session.sessionId,
              prompt: [{ type: "text", text: "go" }],
            })
            .catch(() => null); // the fixture dies instead of answering: that is the point
        })
        .catch(() => null);

      const exit = await p.exited;
      expect(exit.code).toBe(1);
      expect(exit.requested).toBe(false); // nobody asked for this one
      await p.stdoutEnded; // resolves: no grandchild is holding the pipe
      expect(p.pid).toBeNull();
    },
    TIMEOUT,
  );

  it(
    "acceptance 12 (real): the stderr tail holds the crash reason, flushed by finalize()",
    async () => {
      const lines: string[] = [];
      const p = await spawn(fixtureSpec("crash", { env: { CRASH_DELAY_MS: "10" } }));
      p.stderr.onLine((l) => lines.push(l));

      await acp
        .client({ name: "omni-acp-wp2" })
        .connectWith(p.stream, async (ctx) => {
          await ctx.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {},
          });
          const session = await ctx.request(acp.methods.agent.session.new, {
            cwd: process.cwd(),
            mcpServers: [],
          });
          await ctx
            .request(acp.methods.agent.session.prompt, {
              sessionId: session.sessionId,
              prompt: [{ type: "text", text: "go" }],
            })
            .catch(() => null);
        })
        .catch(() => null);

      await p.exited;
      expect(p.stderr.snapshot()).toContain("simulated fault");
      expect(lines.join("\n")).toContain("simulated fault");
    },
    TIMEOUT,
  );

  it(
    "acceptance 12 (real): a multibyte stderr flood is truncated on a rune boundary",
    async () => {
      const p = await spawn(
        fixtureSpec("noisy", {
          stderrTailBytes: 1_024,
          env: { NOISY_STDERR_BYTES: "200000", NOISY_FRAME_BYTES: "64" },
        }),
      );

      await acp.client({ name: "omni-acp-wp2" }).connectWith(p.stream, async (ctx) => {
        await ctx.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        const session = await ctx.request(acp.methods.agent.session.new, {
          cwd: process.cwd(),
          mcpServers: [],
        });
        await ctx.request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "go" }],
        });
      });

      const snapshot = p.stderr.snapshot();
      expect(Buffer.byteLength(snapshot, "utf8")).toBeLessThanOrEqual(1_024);
      expect(snapshot.length).toBeGreaterThan(0);
      // The flood is `ノイズ` — 3 bytes a rune, against a 1024-byte window that cannot land on a
      // multiple of 3. A byte-truncating ring shows U+FFFD here; this one does not.
      expect(snapshot).not.toContain("�");
      expect(snapshot).toContain("ノイズ");
    },
    TIMEOUT,
  );

  it(
    "acceptance 11 (real): an oversized frame errors the stdout stream instead of growing the heap",
    async () => {
      const p = await spawn(
        fixtureSpec("noisy", {
          maxFrameBytes: 4_096,
          env: { NOISY_FRAME_BYTES: "65536", NOISY_STDERR_BYTES: "0" },
        }),
      );

      const failure = await acp
        .client({ name: "omni-acp-wp2" })
        .connectWith(p.stream, async (ctx) => {
          await ctx.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {},
          });
          const session = await ctx.request(acp.methods.agent.session.new, {
            cwd: process.cwd(),
            mcpServers: [],
          });
          await ctx.request(acp.methods.agent.session.prompt, {
            sessionId: session.sessionId,
            prompt: [{ type: "text", text: "go" }],
          });
          return "completed" as const;
        })
        .catch((e: unknown) => e);

      // The turn cannot complete: the 64 KiB frame kills the transport at 4 KiB.
      expect(failure).not.toBe("completed");
      // The process itself is still there — reclaiming it is `terminate()`'s job, not the
      // limiter's (§11.3: protocol_error, THEN kill).
      expect(p.pid).not.toBeNull();

      const outcome = await p.terminate();
      expect(outcome.leaderExited).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "acceptance 11 (real): the frame limiter's own error is the one that surfaces",
    async () => {
      const p = await spawn(
        fixtureSpec("noisy", {
          maxFrameBytes: 4_096,
          env: { NOISY_FRAME_BYTES: "65536", NOISY_STDERR_BYTES: "0" },
        }),
      );

      // Read the transport directly, so the failure is not reshaped by the SDK's connection.
      const writer = p.stream.writable.getWriter();
      const send = async (id: number, method: string, params: unknown): Promise<void> => {
        await writer.write({ jsonrpc: "2.0", id, method, params } as never);
      };
      const reader = p.stream.readable.getReader();

      await send(1, "initialize", { protocolVersion: 1, clientCapabilities: {} });
      await reader.read();
      await send(2, "session/new", { cwd: process.cwd(), mcpServers: [] });
      const created = (await reader.read()).value as { result?: { sessionId?: string } };
      await send(3, "session/prompt", {
        sessionId: created.result?.sessionId,
        prompt: [{ type: "text", text: "go" }],
      });

      const error = await reader.read().then(
        () => null,
        (e: unknown) => e,
      );
      expect(OmniError.is(error, "agent_error")).toBe(true);
      expect((error as OmniError).message).toContain("maxFrameBytes");
      expect((error as OmniError).detail).toMatchObject({ maxFrameBytes: 4_096 });
    },
    TIMEOUT,
  );
});
