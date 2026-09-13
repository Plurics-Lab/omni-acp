import * as acp from "@agentclientprotocol/sdk";
import type { AgentProcess, Supervisor } from "@omni-acp/protocol";
import { waitGone } from "@omni-acp/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fixtureSpec,
  markerStartsGrowing,
  markerStopsGrowingWithin,
  realSupervisor,
  sleep,
  slow,
} from "./support.js";

/**
 * WP-2 acceptance 5, 6 and 9 — the reason this work package exists.
 *
 * The oracle is `orphan.mjs`'s marker file, not a pid: the grandchild appends to it every
 * `ORPHAN_INTERVAL_MS`, so "the tree is gone" is "this file stopped growing". That observation
 * needs no process introspection, which is exactly what Windows cannot give us (CONTRACTS.md
 * §6.4), so the same assertion runs unchanged on all three OSes.
 *
 * The POSIX-only additions are the ones POSIX can actually prove: `treeGone === true`, and
 * `kill(-pgid, 0)` answering ESRCH.
 */

const TIMEOUT = slow(30_000);
const isWindows = process.platform === "win32";
/** CONTRACTS.md §6.7's timer: how long a stdout EOF may lag the `exit` before we force. */
const EXIT_GRACE_MS = 500;

let dir = "";
let supervisor: Supervisor | null = null;
const started: AgentProcess[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "omni-acp-tree-"));
  supervisor = realSupervisor({
    gracefulMs: 1_000,
    killConfirmMs: 1_000,
    exitGraceMs: EXIT_GRACE_MS,
  });
});

afterEach(async () => {
  for (const p of started.splice(0)) await p.terminate({ force: true });
  supervisor = null;
  await rm(dir, { recursive: true, force: true });
});

/**
 * The grandchild's pid, straight from the fixture's own `session/prompt` response.
 *
 * Only reachable while the leader is alive, which is why the zombie tests ask for it up front.
 * The oracle the acceptance criterion uses is the marker file, precisely because Windows cannot
 * be asked this question — this is for cleanup, not for proof.
 */
async function grandchildPidOf(agent: AgentProcess): Promise<number> {
  const chunks: string[] = [];
  await acp
    .client({ name: "omni-acp-wp2-tree" })
    .onNotification(acp.methods.client.session.update, (ctx) => {
      const update = ctx.params.update as { content?: { text?: string } };
      if (typeof update.content?.text === "string") chunks.push(update.content.text);
    })
    .connectWith(agent.stream, async (ctx) => {
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
        prompt: [{ type: "text", text: "who is your child?" }],
      });
    });
  const reported = /grandchild pid (\d+)/.exec(chunks.join(""));
  expect(reported).not.toBeNull();
  return Number(reported?.[1]);
}

async function spawnOrphan(env: Record<string, string>): Promise<{
  process: AgentProcess;
  marker: string;
}> {
  const marker = join(dir, "marker.txt");
  const sup = supervisor;
  if (sup === null) throw new Error("no supervisor");
  const process_ = await sup.spawn(
    fixtureSpec("orphan", {
      env: { MARKER_FILE: marker, ORPHAN_INTERVAL_MS: "100", ...env },
      gracefulMs: 1_000,
      killConfirmMs: 1_000,
      exitGraceMs: EXIT_GRACE_MS,
    }),
  );
  started.push(process_);
  return { process: process_, marker };
}

describe("tree kill", () => {
  it(
    "acceptance 5: after terminate(), the grandchild's marker file stops growing within 2s",
    async () => {
      const { process: agent, marker } = await spawnOrphan({});

      // The grandchild is alive and writing — otherwise the oracle proves nothing.
      expect(await markerStartsGrowing(marker, slow(5_000))).toBe(true);

      const outcome = await agent.terminate();

      expect(outcome.leaderExited).toBe(true);
      expect(await markerStopsGrowingWithin(marker, slow(2_000))).toBe(true);
    },
    TIMEOUT,
  );

  it.skipIf(isWindows)(
    "acceptance 6 (POSIX): treeGone is true and kill(-pgid, 0) answers ESRCH",
    async () => {
      const { process: agent, marker } = await spawnOrphan({});
      expect(await markerStartsGrowing(marker, slow(5_000))).toBe(true);

      const groupId = agent.info.groupId;
      expect(groupId).toBe(agent.info.pid); // detached ⇒ setsid ⇒ pgid === pid

      const outcome = await agent.terminate();

      expect(outcome.treeGone).toBe(true);
      expect(outcome.leaderExited).toBe(true);
      expect(["stdin_eof", "sigterm", "sigkill"]).toContain(outcome.escalatedTo);

      let errno: string | undefined;
      try {
        process.kill(-(groupId as number), 0);
      } catch (e) {
        errno = (e as NodeJS.ErrnoException).code;
      }
      expect(errno).toBe("ESRCH");
    },
    TIMEOUT,
  );

  it.skipIf(!isWindows)(
    "acceptance 6 (Windows): treeGone stays false and leaderExited is verified",
    async () => {
      const { process: agent, marker } = await spawnOrphan({});
      expect(await markerStartsGrowing(marker, slow(5_000))).toBe(true);

      const outcome = await agent.terminate();

      // `taskkill /T` walks the LIVE parent chain and cannot prove a tree empty, so M0 reports
      // the weaker fact honestly rather than the stronger one optimistically (§6.6, D10).
      expect(outcome.treeGone).toBe(false);
      expect(outcome.leaderExited).toBe(true);
      expect(agent.info.groupId).toBeNull();
    },
    TIMEOUT,
  );

  it(
    "acceptance 9 (the zombie): a leader that exits while a grandchild holds stdout",
    async () => {
      const { process: agent, marker } = await spawnOrphan({ ORPHAN_EXIT_AFTER_MS: "300" });
      expect(await markerStartsGrowing(marker, slow(5_000))).toBe(true);

      // 1. The leader leaves on its own — nobody killed it.
      const exit = await agent.exited;
      expect(exit.code).toBe(0);
      expect(exit.requested).toBe(false);

      // 2. `stdoutEnded` does NOT follow, because the grandchild inherited the pipe. This is the
      //    hang: a close path that awaits EOF here waits forever (§6.7, §11.3). The wait is the
      //    spec's own `exitGraceMs` — §6.7's timer, run here in the Worker's place.
      const ended = await Promise.race([
        agent.stdoutEnded.then(() => "ended" as const),
        sleep(slow(EXIT_GRACE_MS + 100)).then(() => "still open" as const),
      ]);
      // Non-detached Windows descendants belong to libuv's kill-on-parent-exit job.
      // Only POSIX reproduces the inherited-pipe zombie; Windows closes the pipe.
      expect(ended).toBe(isWindows ? "ended" : "still open");

      // 3. So the Worker's exitGraceMs elapses and it forces — and that call RETURNS.
      const startedAt = Date.now();
      const outcome = await agent.terminate({ force: true });
      const elapsed = Date.now() - startedAt;

      expect(elapsed).toBeLessThan(slow(3_000));
      expect(outcome.leaderExited).toBe(true);
      if (!isWindows) {
        expect(outcome.escalatedTo).toBe("sigkill");
        expect(outcome.treeGone).toBe(true);
      }
      expect(await markerStopsGrowingWithin(marker, slow(2_000))).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "a plain terminate() on an already-exited zombie reports the tree it cannot claim",
    async () => {
      // Rung 0 verbatim (§6.5): the leader is gone, so the ladder reports `already_exited` — and
      // reports `treeGone: false`, because the real `kill(-pgid, 0)` still finds the grandchild.
      // `force` is what asks for the tree back, and it is what §6.7's crash path uses.
      //
      // This is also the one test that must clean up after ITSELF: `terminate()` is idempotent by
      // contract, so a second call with `force` returns the first outcome without running the
      // ladder again. The grandchild's pid — which the fixture reports over ACP while its leader
      // is still alive — is the only handle left afterwards.
      const { process: agent, marker } = await spawnOrphan({ ORPHAN_EXIT_AFTER_MS: "2000" });
      const grandchild = await grandchildPidOf(agent);
      expect(await markerStartsGrowing(marker, slow(5_000))).toBe(true);

      try {
        await agent.exited;
        const outcome = await agent.terminate();

        expect(outcome.escalatedTo).toBe("already_exited");
        expect(outcome.treeGone).toBe(false);
        expect(outcome.leaderExited).toBe(true);
      } finally {
        try {
          process.kill(grandchild, "SIGKILL");
        } catch {
          /* already gone */
        }
        expect(await waitGone(grandchild, slow(5_000))).toBe(true);
      }
    },
    TIMEOUT,
  );

  it(
    "terminate() called twice concurrently reclaims the tree once (acceptance 10, for real)",
    async () => {
      const { process: agent, marker } = await spawnOrphan({});
      expect(await markerStartsGrowing(marker, slow(5_000))).toBe(true);

      const [a, b] = await Promise.all([agent.terminate(), agent.terminate({ force: true })]);

      expect(a).toBe(b);
      expect(await markerStopsGrowingWithin(marker, slow(2_000))).toBe(true);
    },
    TIMEOUT,
  );
});
