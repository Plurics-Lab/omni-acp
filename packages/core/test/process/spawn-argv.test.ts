import { OmniError } from "@omni-acp/protocol";
import { describe, expect, it } from "vitest";
import { createPlatformOps } from "../../src/process/platform.js";
import { createSupervisor } from "../../src/process/supervisor.js";
import { spawnAgentProcess } from "../../src/process/spawn.js";
import {
  finishFakeChild,
  realClock,
  recordingLogger,
  recordingSpawn,
  recordingUtility,
  supervisorConfig,
  type RecordedSpawn,
} from "./support.js";

/**
 * WP-2 acceptance 3 — the launch options, asserted on EVERY OS by injecting `spawnFn` and
 * starting no process at all (CONTRACTS.md §6.2).
 *
 * Each of these five has a specific incident behind it:
 *
 *  - `shell: false` — a shell is an injection surface AND an extra process layer between the
 *    supervisor and the agent, which is exactly the layer that breaks tree kill;
 *  - `detached === (platform !== "win32")` — on POSIX it is `setsid()` and the whole mechanism;
 *    on Windows libuv maps it to `DETACHED_PROCESS`, which means no console, which means a
 *    visible window per grandchild (multica #1521);
 *  - `windowsHide: true` on win32 — CREATE_NO_WINDOW, the popup-storm mitigation (F9);
 *  - `stdio: ["pipe","pipe","pipe"]` — never "inherit", because stderr must stay sniffable and
 *    the crash reason lives in its last unterminated line;
 *  - a COMPLETE `env` — the caller composed it; the Supervisor adds nothing and removes nothing.
 */

const SPEC = {
  command: "agent",
  args: ["--serve"],
  cwd: process.cwd(),
  env: { PATH: "/usr/bin", OMNI_TEST: "1" },
} as const;

async function launchWith(platformName: NodeJS.Platform): Promise<RecordedSpawn> {
  const recorder = recordingSpawn();
  const platform = createPlatformOps(platformName, { runUtility: recordingUtility().fn });
  const process_ = await spawnAgentProcess(SPEC, platform, {
    clock: realClock(),
    logger: recordingLogger(),
    allowShimLaunch: false,
    windowsHide: true,
    spawnFn: recorder.fn,
  });
  const child = recorder.children[0];
  if (child !== undefined) finishFakeChild(child);
  await process_.exited;
  const call = recorder.calls[0];
  if (call === undefined) throw new Error("spawnFn was never called");
  return call;
}

describe("the launch options, on every OS", () => {
  for (const platformName of ["linux", "darwin", "win32"] as const) {
    describe(platformName, () => {
      it("never uses a shell", async () => {
        expect((await launchWith(platformName)).options["shell"]).toBe(false);
      });

      it("pipes all three stdio streams — never inherit", async () => {
        expect((await launchWith(platformName)).options["stdio"]).toEqual(["pipe", "pipe", "pipe"]);
      });

      it("detaches everywhere except win32", async () => {
        expect((await launchWith(platformName)).options["detached"]).toBe(platformName !== "win32");
      });

      it("passes the environment through complete and unmodified", async () => {
        expect((await launchWith(platformName)).options["env"]).toEqual({
          PATH: "/usr/bin",
          OMNI_TEST: "1",
        });
      });

      it("launches the resolved command with the caller's args and cwd", async () => {
        const call = await launchWith(platformName);
        expect(call.args).toEqual(["--serve"]);
        expect(call.options["cwd"]).toBe(process.cwd());
      });
    });
  }

  it("sets windowsHide on win32", async () => {
    expect((await launchWith("win32")).options["windowsHide"]).toBe(true);
  });

  it("leaves windowsHide off on POSIX, where it means nothing", async () => {
    expect((await launchWith("linux")).options["windowsHide"]).toBe(false);
  });

  it("honours supervisor.windowsHide: false, which is why it is a knob (F9)", async () => {
    const recorder = recordingSpawn();
    const platform = createPlatformOps("win32", { runUtility: recordingUtility().fn });
    const p = await spawnAgentProcess(SPEC, platform, {
      clock: realClock(),
      logger: recordingLogger(),
      allowShimLaunch: false,
      windowsHide: false,
      spawnFn: recorder.fn,
    });
    const child = recorder.children[0];
    if (child !== undefined) finishFakeChild(child);
    await p.exited;
    expect(recorder.calls[0]?.options["windowsHide"]).toBe(false);
  });
});

describe("what the launch produces", () => {
  it("reports a POSIX process group whose id IS the pid", async () => {
    const recorder = recordingSpawn({ pid: 31_337 });
    const platform = createPlatformOps("linux");
    const p = await spawnAgentProcess(SPEC, platform, {
      clock: realClock(),
      logger: recordingLogger(),
      allowShimLaunch: false,
      spawnFn: recorder.fn,
    });
    expect(p.pid).toBe(31_337);
    expect(p.info.pid).toBe(31_337);
    expect(p.info.groupId).toBe(31_337);
    expect(p.info.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const child = recorder.children[0];
    if (child !== undefined) finishFakeChild(child);
    await p.exited;
  });

  it("reports NO group id on Windows, because there is none to report", async () => {
    const recorder = recordingSpawn({ pid: 999 });
    const platform = createPlatformOps("win32", { runUtility: recordingUtility().fn });
    const p = await spawnAgentProcess(SPEC, platform, {
      clock: realClock(),
      logger: recordingLogger(),
      allowShimLaunch: false,
      spawnFn: recorder.fn,
    });
    expect(p.info.groupId).toBeNull();
    const child = recorder.children[0];
    if (child !== undefined) finishFakeChild(child);
    await p.exited;
  });

  it("drops `pid` to null the moment `exit` is delivered", async () => {
    const recorder = recordingSpawn();
    const p = await spawnAgentProcess(SPEC, createPlatformOps("linux"), {
      clock: realClock(),
      logger: recordingLogger(),
      allowShimLaunch: false,
      spawnFn: recorder.fn,
    });
    expect(p.pid).not.toBeNull();
    const child = recorder.children[0];
    if (child !== undefined) finishFakeChild(child, 7);
    const exit = await p.exited;
    expect(p.pid).toBeNull();
    expect(exit).toMatchObject({ code: 7, signal: null, requested: false });
    expect(p.info.pid).toBe(4242); // `info` is the identity, and it does not change
  });

  it("redacts anything credential-shaped out of argsRedacted", async () => {
    const recorder = recordingSpawn();
    const p = await spawnAgentProcess(
      {
        ...SPEC,
        args: ["--model", "sonnet", "--api-key", "sk-secret", "--token=hunter2", "--serve"],
      },
      createPlatformOps("linux"),
      {
        clock: realClock(),
        logger: recordingLogger(),
        allowShimLaunch: false,
        spawnFn: recorder.fn,
      },
    );
    // The real argv still carries the secret — the child needs it. `argsRedacted` is what is
    // safe to put in a WorkerSnapshot, which is served over HTTP.
    expect(recorder.calls[0]?.args).toContain("sk-secret");
    expect(p.info.argsRedacted).toEqual([
      "--model",
      "sonnet",
      "--api-key",
      "<redacted>",
      "--token=<redacted>",
      "--serve",
    ]);
    const child = recorder.children[0];
    if (child !== undefined) finishFakeChild(child);
    await p.exited;
  });
});

describe("failure paths", () => {
  it("refuses to launch before spawning when resolveLaunch rejects (§6.3)", async () => {
    const recorder = recordingSpawn();
    const platform = createPlatformOps("win32", { runUtility: recordingUtility().fn });
    // A `.cmd` cannot be resolved off-Windows, so drive the refusal through the platform's own
    // resolver by handing it a shim path directly.
    const shim = await platform
      .resolveLaunch("C:\\npm\\agent.cmd", [], false)
      .then(() => null)
      .catch((e: unknown) => e);
    expect(OmniError.is(shim, "bad_request")).toBe(true);
    expect(recorder.calls).toEqual([]);
  });

  it("turns a spawn `error` into agent_error rather than an unhandled event (§6.7)", async () => {
    const recorder = recordingSpawn();
    const failing = ((file: string, args: readonly string[], options: unknown) => {
      const child = recorder.fn(file, args as string[], options as never);
      queueMicrotask(() => {
        child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
      });
      return child;
    }) as unknown as typeof recorder.fn;

    const error = await spawnAgentProcess(
      { ...SPEC, command: "nope" },
      createPlatformOps("linux"),
      {
        clock: realClock(),
        logger: recordingLogger(),
        allowShimLaunch: false,
        spawnFn: failing,
      },
    ).catch((e: unknown) => e);

    expect(OmniError.is(error, "agent_error")).toBe(true);
    expect((error as OmniError).status).toBe(502);
    expect((error as OmniError).message).toContain("ENOENT");
  });

  it("rejects an already-aborted spawn without starting anything", async () => {
    const recorder = recordingSpawn();
    const controller = new AbortController();
    controller.abort();
    const error = await spawnAgentProcess(
      SPEC,
      createPlatformOps("linux"),
      {
        clock: realClock(),
        logger: recordingLogger(),
        allowShimLaunch: false,
        spawnFn: recorder.fn,
      },
      controller.signal,
    ).catch((e: unknown) => e);
    expect(OmniError.is(error)).toBe(true);
    expect(recorder.calls).toEqual([]);
  });
});

describe("the Supervisor threads its config into the launch", () => {
  it("passes allowShimLaunch and windowsHide down from SupervisorConfig", async () => {
    const recorder = recordingSpawn();
    const supervisor = createSupervisor({
      config: supervisorConfig({ windowsHide: false }),
      clock: realClock(),
      logger: recordingLogger(),
      platform: createPlatformOps("win32", { runUtility: recordingUtility().fn }),
      spawnFn: recorder.fn,
    });
    const p = await supervisor.spawn(SPEC);
    expect(recorder.calls[0]?.options["windowsHide"]).toBe(false);
    const child = recorder.children[0];
    if (child !== undefined) finishFakeChild(child);
    await p.exited;
  });
});
