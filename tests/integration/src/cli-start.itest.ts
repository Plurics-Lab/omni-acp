import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { isAlive, waitGone } from "@omni-acp/testkit";
import { afterEach, describe, expect, it } from "vitest";
import { tempRoot } from "./support/harness.js";

/**
 * WP-6. The real binary, as a real child process, on all three OSes.
 *
 * Launched as `process.execPath <packages/cli/dist/bin.js>`, never through `node_modules/.bin`:
 * the bin symlink does not exist until the first build (pnpm even warns about it on a fresh
 * install), and the direct-module form is what CONTRACTS.md §6.3 wants anyway — one fewer
 * process in the tree and no `.cmd` shim on Windows.
 *
 * `node:child_process` here is legitimate: §6.1's single-spawn rule scopes to package sources
 * under src, and a test whose subject IS the executable cannot borrow the Supervisor to launch it.
 */

/**
 * Derived from the package's MAIN ENTRY, the same way `sdkExampleAgentPath()` is (F8).
 *
 * `import.meta.resolve`, not `createRequire(...).resolve`: `@omni-acp/cli`'s `exports` map
 * declares only `types` and `import`, so the CJS resolver has no condition to match and throws
 * `No "exports" main defined` — the same class of trap as the SDK's unexported `./dist/examples`.
 * `bin.js` is not an exported subpath either, so it is reached by joining onto the resolved main
 * entry's directory rather than by being resolved directly.
 *
 * The repo-relative fallback covers a runner that has not implemented `import.meta.resolve`.
 * Both paths land on `packages/cli/dist/bin.js` and never on `node_modules/.bin/omni-acp`, which
 * does not exist until the first build and is a `.cmd` shim on Windows (§6.3).
 */
function cliBinPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates: string[] = [];
  try {
    candidates.push(join(dirname(fileURLToPath(import.meta.resolve("@omni-acp/cli"))), "bin.js"));
  } catch {
    // Fall through to the repository layout.
  }
  candidates.push(join(here, "..", "..", "..", "packages", "cli", "dist", "bin.js"));

  const found = candidates.find((path) => existsSync(path));
  if (found === undefined) {
    throw new Error(
      `the CLI is not built — run pnpm -r build first. Tried:\n${candidates.join("\n")}`,
    );
  }
  return found;
}

interface Child {
  /** stdin is `ignore`d: the daemon reads nothing, and a pipe nobody writes is a handle. */
  readonly proc: ChildProcessByStdio<null, Readable, Readable>;
  readonly stdout: () => string;
  readonly stderr: () => string;
  readonly exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function launch(args: readonly string[], env: NodeJS.ProcessEnv = {}): Child {
  const proc = spawn(process.execPath, [cliBinPath(), ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
    shell: false,
    windowsHide: true,
  });
  let out = "";
  let err = "";
  proc.stdout.setEncoding("utf8");
  proc.stderr.setEncoding("utf8");
  proc.stdout.on("data", (c: string) => (out += c));
  proc.stderr.on("data", (c: string) => (err += c));

  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    proc.on("exit", (code, signal) => resolve({ code, signal }));
  });
  return { proc, stdout: () => out, stderr: () => err, exit };
}

/** Waits for a line, or throws with everything the child said — a silent timeout tells nobody. */
async function waitForLine(child: Child, pattern: RegExp, timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const match = pattern.exec(child.stdout());
    if (match !== null) return match[0];
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out waiting for ${String(pattern)}\nstdout:\n${child.stdout()}\nstderr:\n${child.stderr()}`,
      );
    }
    if (child.proc.exitCode !== null) {
      throw new Error(
        `the CLI exited (${String(child.proc.exitCode)}) before ${String(pattern)}\n` +
          `stdout:\n${child.stdout()}\nstderr:\n${child.stderr()}`,
      );
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
}

describe("omni-acp start", () => {
  const scratch: string[] = [];
  let running: Child | undefined;

  afterEach(async () => {
    if (running !== undefined && running.proc.exitCode === null) {
      running.proc.kill("SIGKILL");
      await running.exit.catch(() => undefined);
    }
    running = undefined;
    while (scratch.length > 0) {
      const dir = scratch.pop();
      if (dir !== undefined) await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  async function dataDir(): Promise<string> {
    const dir = await tempRoot("omni-acp-cli-");
    scratch.push(dir);
    return dir;
  }

  it("serves GET /v1/health 200 with --port 0", async () => {
    const child = launch(["start", "--port", "0", "--data-dir", await dataDir()]);
    running = child;

    const line = await waitForLine(child, /listening on http:\/\/127\.0\.0\.1:\d+/);
    const url = line.replace("listening on ", "");
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const res = await fetch(`${url}/v1/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    // The generated token is NOT on stdout unless asked: a daemon under a supervisor writes its
    // stdout to a log file, and a credential does not belong there.
    expect(child.stdout()).toContain('generated admin token id "local"');
    expect(child.stdout()).not.toMatch(/omni-acp: token /);
  }, 45_000);

  it("exits 2 with usage on an unknown flag", async () => {
    const bad = launch(["start", "--nope"]);
    const badExit = await bad.exit;

    expect(badExit.code).toBe(2);
    expect(bad.stderr()).toContain('unknown flag "--nope"');
    expect(bad.stderr()).toContain("Usage:");
    // Usage goes to stderr on a failure, so `omni-acp start | jq` is never fed a help screen.
    expect(bad.stdout()).toBe("");
  }, 30_000);

  it("lets CLI flags override YAML", async () => {
    // The YAML says "no socket"; `--port 0` says otherwise, and the flag wins. This pair is the
    // observable form of the override rule: one run binds nothing, the other serves health.
    const dir = await dataDir();
    const configPath = join(dir, "daemon.yaml");
    await writeFile(
      configPath,
      [
        "listen: null",
        "tokens:",
        "  - id: local",
        "    secret: a-secret-long-enough-for-zod-to-accept",
        "    role: admin",
        `dataDir: ${JSON.stringify(dir)}`,
        "",
      ].join("\n"),
    );

    const withoutFlag = launch(["start", "--config", configPath]);
    running = withoutFlag;
    await waitForLine(withoutFlag, /no socket \(listen: null\)/);
    withoutFlag.proc.kill(process.platform === "win32" ? "SIGKILL" : "SIGINT");
    await withoutFlag.exit;

    const withFlag = launch(["start", "--config", configPath, "--port", "0"]);
    running = withFlag;
    const line = await waitForLine(withFlag, /listening on http:\/\/127\.0\.0\.1:\d+/);
    const res = await fetch(`${line.replace("listening on ", "")}/v1/health`);
    expect(res.status).toBe(200);
  }, 60_000);

  // Node cannot deliver a graceful console signal to a child on Windows: `child.kill("SIGINT")`
  // and `process.kill(pid, "SIGBREAK")` both go through libuv, which has no
  // `GenerateConsoleCtrlEvent`, so they land as an immediate TerminateProcess. `main()` registers
  // SIGINT + SIGTERM + SIGBREAK per CONTRACTS.md L12 and a person pressing Ctrl+C in a console
  // gets the graceful path; a TEST cannot produce that event from Node, so asserting it here
  // would be asserting the kill, not the handler (CONTRACTS.md §10.3: the reason lives next to
  // the code).
  describe.skipIf(process.platform === "win32")("signals", () => {
    it("calls daemon.stop({graceful:true}) exactly once on SIGINT and exits 0", async () => {
      const child = launch(["start", "--port", "0", "--data-dir", await dataDir()]);
      running = child;
      await waitForLine(child, /omni-acp: ready/);

      const pid = child.proc.pid ?? 0;
      expect(await isAlive(pid)).toBe(true);

      // Twice, deliberately: a second signal during shutdown must not start a second teardown.
      child.proc.kill("SIGINT");
      child.proc.kill("SIGINT");

      const exit = await child.exit;
      expect(exit.code).toBe(0);
      expect(exit.signal).toBeNull();

      const stopping = child.stdout().match(/omni-acp: stopping \(/g) ?? [];
      expect(stopping).toHaveLength(1);
      expect(child.stdout()).toContain("omni-acp: stopped");

      // No orphan: the CLI process itself is gone, and it started no agents to leave behind.
      expect(await waitGone(pid, 10_000)).toBe(true);
    }, 45_000);

    it("shuts down gracefully on SIGTERM too", async () => {
      const child = launch(["start", "--port", "0", "--data-dir", await dataDir()]);
      running = child;
      await waitForLine(child, /omni-acp: ready/);

      child.proc.kill("SIGTERM");
      const exit = await child.exit;

      expect(exit.code).toBe(0);
      expect(child.stdout()).toContain("omni-acp: stopping (SIGTERM, graceful)");
    }, 45_000);
  });

  describe.skipIf(process.platform !== "win32")("windows shutdown", () => {
    it("terminates and leaves no orphan, even without a graceful console signal", async () => {
      const child = launch(["start", "--port", "0", "--data-dir", await dataDir()]);
      running = child;
      await waitForLine(child, /omni-acp: ready/);
      const pid = child.proc.pid ?? 0;

      child.proc.kill();
      await child.exit;

      expect(await waitGone(pid, 10_000)).toBe(true);
    }, 45_000);
  });

  it("prints the version and the usage without starting anything", async () => {
    const version = launch(["--version"]);
    expect((await version.exit).code).toBe(0);
    expect(version.stdout().trim()).toMatch(/^\d+\.\d+\.\d+/);

    const help = launch(["--help"]);
    expect((await help.exit).code).toBe(0);
    expect(help.stdout()).toContain("omni-acp start");
  }, 30_000);
});
