import { OmniError, type AgentProcess } from "@omni-acp/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPlatformOps } from "../../src/process/platform.js";
import { createSupervisor } from "../../src/process/supervisor.js";
import {
  finishFakeChild,
  fixtureSpec,
  markerStartsGrowing,
  markerStopsGrowingWithin,
  realClock,
  realSupervisor,
  recordingLogger,
  recordingSpawn,
  sleep,
  slow,
  supervisorConfig,
} from "./support.js";

/**
 * `Supervisor` — the single spawn entry point, its ledger of what is still running, and
 * `shutdown()` (WP-2 acceptance 13).
 *
 * The config half is asserted with an injected `spawnFn` and no process at all: whether
 * `supervisor.maxFrameBytes` actually reaches the transport is a wiring question, and wiring
 * questions deserve fast, exact tests rather than a 30-second one that only says "something is
 * wrong somewhere".
 */

const TIMEOUT = slow(30_000);
const spec = {
  command: process.execPath,
  args: ["-e", "setTimeout(() => {}, 60000)"],
  cwd: process.cwd(),
  env: { PATH: process.env["PATH"] ?? "" },
} as const;

describe("the live ledger", () => {
  let dir = "";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "omni-acp-sup-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it(
    "acceptance 13: shutdown() reclaims every live tree and empties `live`",
    async () => {
      const supervisor = realSupervisor({
        gracefulMs: 1_000,
        killConfirmMs: 1_000,
        exitGraceMs: 500,
      });
      const markers = [join(dir, "a.txt"), join(dir, "b.txt"), join(dir, "c.txt")];
      const processes = await Promise.all(
        markers.map((marker) =>
          supervisor.spawn(
            fixtureSpec("orphan", {
              env: { MARKER_FILE: marker, ORPHAN_INTERVAL_MS: "100" },
              gracefulMs: 1_000,
              killConfirmMs: 1_000,
            }),
          ),
        ),
      );

      expect(supervisor.live.size).toBe(3);
      for (const marker of markers) {
        expect(await markerStartsGrowing(marker, slow(5_000))).toBe(true);
      }

      const outcomes = await supervisor.shutdown();

      expect(outcomes).toHaveLength(3);
      expect(supervisor.live.size).toBe(0);
      for (const outcome of outcomes) expect(outcome.leaderExited).toBe(true);
      if (process.platform !== "win32") {
        for (const outcome of outcomes) expect(outcome.treeGone).toBe(true);
      }
      // Not just the leaders: every grandchild stopped writing too.
      for (const marker of markers) {
        expect(await markerStopsGrowingWithin(marker, slow(2_000))).toBe(true);
      }
      for (const p of processes) expect(p.pid).toBeNull();
    },
    TIMEOUT,
  );

  it(
    "drops a process that dies on its own out of `live`",
    async () => {
      const supervisor = realSupervisor({ gracefulMs: 500, killConfirmMs: 500 });
      const p = await supervisor.spawn({
        ...spec,
        args: ["-e", "process.exit(0)"],
      });
      expect(supervisor.live.size).toBe(1);
      await p.exited;
      // `live` is what is still running, not what was ever started.
      for (let i = 0; i < 20 && supervisor.live.size > 0; i += 1) await sleep(10);
      expect(supervisor.live.size).toBe(0);
      await supervisor.shutdown();
    },
    TIMEOUT,
  );

  it(
    "shutdown() on an idle supervisor is an empty list, and is safe to repeat",
    async () => {
      const supervisor = realSupervisor();
      expect(await supervisor.shutdown()).toEqual([]);
      expect(await supervisor.shutdown()).toEqual([]);
      expect(supervisor.live.size).toBe(0);
    },
    TIMEOUT,
  );

  it(
    "a failed spawn adds nothing to the ledger",
    async () => {
      const supervisor = realSupervisor();
      const error = await supervisor
        .spawn({ ...spec, command: join(dir, "definitely-not-here") })
        .catch((e: unknown) => e);
      expect(OmniError.is(error, "agent_error")).toBe(true);
      expect(supervisor.live.size).toBe(0);
    },
    TIMEOUT,
  );

  it(
    "rejects an aborted spawn without leaving a process behind",
    async () => {
      const supervisor = realSupervisor();
      const controller = new AbortController();
      controller.abort(new Error("no longer wanted"));
      await expect(supervisor.spawn(spec, controller.signal)).rejects.toThrow(OmniError);
      expect(supervisor.live.size).toBe(0);
    },
    TIMEOUT,
  );
});

describe("SupervisorConfig reaches the launch", () => {
  function withConfig(config: Parameters<typeof supervisorConfig>[0]): {
    supervisor: ReturnType<typeof createSupervisor>;
    recorder: ReturnType<typeof recordingSpawn>;
  } {
    const recorder = recordingSpawn();
    const supervisor = createSupervisor({
      config: supervisorConfig(config),
      clock: realClock(),
      logger: recordingLogger(),
      platform: createPlatformOps("linux"),
      spawnFn: recorder.fn,
    });
    return { supervisor, recorder };
  }

  it("threads maxFrameBytes into the transport", async () => {
    const { supervisor, recorder } = withConfig({ maxFrameBytes: 64 });
    const p = await supervisor.spawn(spec);
    const reader = p.stream.readable.getReader();

    recorder.children[0]?.stdout.write(Buffer.alloc(200, 0x61)); // 200 bytes, no newline

    const error = await reader.read().then(
      () => null,
      (e: unknown) => e,
    );
    expect(OmniError.is(error, "agent_error")).toBe(true);
    expect((error as OmniError).detail).toMatchObject({ maxFrameBytes: 64 });
  });

  it("lets a per-agent SpawnSpec override the daemon default", async () => {
    const { supervisor, recorder } = withConfig({ maxFrameBytes: 64 });
    const p = await supervisor.spawn({ ...spec, maxFrameBytes: 4_096 });
    const reader = p.stream.readable.getReader();

    const child = recorder.children[0];
    child?.stdout.write(Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: 1 })}\n`));
    // 200 bytes would have tripped the daemon default; the spec's 4 KiB is what applies.
    child?.stdout.write(Buffer.alloc(200, 0x61));

    const first = await reader.read();
    expect(first.value).toMatchObject({ id: 1 });
    reader.releaseLock();
    if (child !== undefined) finishFakeChild(child);
    await p.exited;
  });

  it("threads stderrTailBytes into the tail ring", async () => {
    const { supervisor, recorder } = withConfig({ stderrTailBytes: 16 });
    const p = await supervisor.spawn(spec);
    const child = recorder.children[0];
    child?.stderr.write(Buffer.from("0123456789abcdefghijklmnopqrstuvwxyz\n"));
    await sleep(20);
    expect(Buffer.byteLength(p.stderr.snapshot(), "utf8")).toBeLessThanOrEqual(16);
    if (child !== undefined) finishFakeChild(child);
    await p.exited;
  });

  it("uses the config's gracefulMs when the caller names none", async () => {
    // 40ms graceful + 40ms confirm against a process that never exits: if the default 5s were
    // used instead, this call would still be running when the assertion below fires.
    const { supervisor, recorder } = withConfig({ gracefulMs: 40, killConfirmMs: 40 });
    const p: AgentProcess = await supervisor.spawn(spec);
    const startedAt = Date.now();
    await p.terminate();
    expect(Date.now() - startedAt).toBeLessThan(slow(3_000));
    const child = recorder.children[0];
    if (child !== undefined) finishFakeChild(child, 9);
    await p.exited;
  });
});
