import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDaemon } from "@omni-acp/daemon";
import type { DaemonConfig } from "@omni-acp/protocol";
import { fixtureAgentPath, isAlive, waitGone } from "@omni-acp/testkit";
import { afterEach, describe, expect, it } from "vitest";
import { scaled, tempRoot, until } from "./support/harness.js";

/**
 * §15.7's orphan handling, proven against a process that REALLY survived (M1-PLAN §2, WP-F 8).
 *
 * A daemon in a CHILD process with `orphan.mjs`, SIGKILLed; the marker file keeps growing, which
 * is what proves the orphan outlived its daemon rather than the test asserting a fixture.
 *
 * The RECORD half runs everywhere — including Windows, where `orphansAtStart` must report
 * `{found: 1, reaped: 0, skipped: 1}` rather than silence. Only the REAP half is
 * `skipIf(win32)`, because a null fingerprint forbids signalling the pid at all.
 *
 * `node:child_process` here is legitimate: §6.1's single-spawn rule scopes to package sources
 * under `src`, and a test whose subject is a daemon that DIED cannot ask that daemon to spawn
 * itself.
 *
 * Owned by M1-WP-F.
 */

const WINDOWS = process.platform === "win32";

interface Doomed {
  readonly dataDir: string;
  readonly cwd: string;
  readonly token: string;
  readonly marker: string;
  readonly workerId: string;
  readonly agentPid: number;
  readonly daemonPid: number;
}

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

/** The size of the grandchild's marker file — the portable tree-liveness oracle (§6.4). */
function markerSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return -1;
  }
}

/**
 * A daemon in a CHILD process, with one live `orphan` worker, then SIGKILLed.
 *
 * SIGKILL and not SIGTERM: the whole subject is what a daemon leaves behind when it had no
 * chance to clean up. A graceful stop reclaims the tree and there would be no orphan to find.
 */
async function abandonADaemon(): Promise<Doomed> {
  const cwd = await tempRoot("omni-acp-orphan-cwd-");
  const dataDir = await tempRoot("omni-acp-orphan-data-");
  dirs.push(cwd, dataDir);
  const marker = join(cwd, "marker.txt");
  const token = randomBytes(32).toString("hex");

  // The script lives in a TEMP directory, so a bare `@omni-acp/daemon` specifier would resolve
  // from there and find nothing: node resolves from the importing FILE, not from `cwd`. The
  // absolute module URL is taken here, where resolution works, and embedded — the same class of
  // trap `cliBinPath()` documents for the CLI's own `bin.js`.
  const daemonUrl = daemonModuleUrl();
  const script = join(dataDir, "doomed.mjs");
  await writeFile(
    script,
    `
import { createDaemon } from ${JSON.stringify(daemonUrl)};
const daemon = await createDaemon(${JSON.stringify(configFor(dataDir, cwd, token, marker))});
await daemon.start();
const auth = daemon.authenticate(new Headers({ authorization: "Bearer " + ${JSON.stringify(token)} }));
const handle = await daemon.workers.create({ agent: "orphan", cwd: ${JSON.stringify(cwd)} }, auth);
const snapshot = handle.snapshot();
process.stdout.write(JSON.stringify({ workerId: snapshot.workerId, pid: snapshot.process.pid }) + "\\n");
// Hold the process open. The parent SIGKILLs it, which is the point.
setInterval(() => {}, 1000);
`,
    "utf8",
  );

  const child = spawn(process.execPath, [script], {
    cwd: dataDir,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  let out = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (c: string) => (out += c));

  let err = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c: string) => (err += c));
  const ready = await until(() => out.includes("\n"), scaled(30_000), 50);
  expect(ready, `the child daemon never created a worker.\nstdout: ${out}\nstderr: ${err}`).toBe(
    true,
  );
  const line = JSON.parse(out.split("\n")[0] ?? "{}") as { workerId: string; pid: number };

  const daemonPid = child.pid ?? 0;
  expect(daemonPid).toBeGreaterThan(0);
  expect(line.pid).toBeGreaterThan(0);

  child.kill("SIGKILL");
  expect(await waitGone(daemonPid, scaled(10_000))).toBe(true);

  return {
    dataDir,
    cwd,
    token,
    marker,
    workerId: line.workerId,
    agentPid: line.pid,
    daemonPid,
  };
}

/**
 * `@omni-acp/daemon`'s built entry, as an absolute URL.
 *
 * `import.meta.resolve` rather than `createRequire(...).resolve`: the package's `exports` map
 * declares only `types` and `import`, so the CJS resolver has no condition to match and throws
 * `No "exports" main defined` (the same trap `cli-start.itest.ts` documents).
 */
function daemonModuleUrl(): string {
  try {
    return import.meta.resolve("@omni-acp/daemon");
  } catch {
    return pathToFileURL(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "..",
        "..",
        "..",
        "packages",
        "daemon",
        "dist",
        "index.js",
      ),
    ).href;
  }
}

function configFor(dataDir: string, cwd: string, token: string, marker: string): DaemonConfig {
  return {
    dataDir,
    listen: null,
    logLevel: "error",
    // Nothing here survives a restart under the memory driver, and a boot with nothing to adopt
    // is a boot that cannot find an orphan (§14.8).
    eventLog: { driver: "sqlite" },
    tokens: [{ id: "local", secret: token, role: "admin", cwdRoots: [cwd], maxWorkers: 4 }],
    agents: [
      {
        id: "orphan",
        command: process.execPath,
        args: [fixtureAgentPath("orphan")],
        // `ORPHAN_SURVIVE_EOF` is what makes this test's subject exist. Killing the daemon
        // closes the agent's stdin; without the knob the LEADER exits on its own, the pid the
        // daemon recorded is already `gone` by the next boot, and ruling M1-R9's fingerprint
        // match — the thing that decides between reaping and leaking — is never exercised.
        env: { MARKER_FILE: marker, ORPHAN_INTERVAL_MS: "50", ORPHAN_SURVIVE_EOF: "1" },
      },
    ],
  };
}

describe("recovery from a previous boot", () => {
  it("the orphan really survives: the marker file keeps growing after the daemon is SIGKILLed", async () => {
    const doomed = await abandonADaemon();
    try {
      // The daemon is gone. If the agent tree went with it, everything below this file asserts is
      // about a situation that never happened — so this is the load-bearing assertion.
      // The grandchild appends every 50 ms, so the file exists within a tick or two of the
      // spawn — but "within a tick" is not a thing to assert on a loaded CI runner.
      expect(await until(() => markerSize(doomed.marker) > 0, scaled(5_000), 25)).toBe(true);
      const before = markerSize(doomed.marker);
      expect(
        await until(() => markerSize(doomed.marker) > before, scaled(5_000), 50),
        "the marker stopped growing: the tree did not outlive its daemon",
      ).toBe(true);
      expect(await isAlive(doomed.agentPid)).toBe(true);
    } finally {
      await reap(doomed);
    }
  });

  it("on restart, orphansAtStart.found === 1 on every platform — the RECORD half", async () => {
    const doomed = await abandonADaemon();
    const daemon = await createDaemon(
      configFor(doomed.dataDir, doomed.cwd, doomed.token, doomed.marker),
    );
    try {
      // Recorded EVERYWHERE, reaped only where a fingerprint can prove identity (ruling M1-R9).
      // Windows records `{found:1, reaped:0, skipped:1}` rather than staying silent, which is the
      // same honesty §6.6 already demands of `treeGone`.
      expect(daemon.info.orphansAtStart.found).toBe(1);
      expect(daemon.info.orphansAtStart.reaped + daemon.info.orphansAtStart.skipped).toBe(1);
      expect(daemon.info.bootId).not.toBe("");

      // The row converged, and it says so IN BAND: the worker's own log carries the
      // `daemon_restart` / `orphaned` envelope plus an `omni.error`, so a client that reconnects
      // learns what happened from the stream it was already reading (§15.7).
      const auth = daemon.authenticate(new Headers({ authorization: `Bearer ${doomed.token}` }));
      const snapshot = daemon.workers.snapshot(doomed.workerId as never, auth);
      expect(["hibernated", "closed"]).toContain(snapshot.state);
      expect(snapshot.orphan?.pid).toBe(doomed.agentPid);
      expect(snapshot.crashed).toBe(true);
      expect(snapshot.process).toBeNull();
    } finally {
      await daemon.stop({ graceful: true }).catch(() => {});
      await reap(doomed);
    }
  });

  it.skipIf(WINDOWS)(
    "on Linux, reaped === 1 and the marker stops inside 2 s — the REAP half, skipIf(win32)",
    async () => {
      const doomed = await abandonADaemon();
      const daemon = await createDaemon(
        configFor(doomed.dataDir, doomed.cwd, doomed.token, doomed.marker),
      );
      try {
        // A fingerprint match is PROOF that this pid is the process we spawned, and leaking agent
        // trees that hold a cwd and an API quota is worse than an audited kill (ruling M1-R9).
        expect(daemon.info.orphansAtStart).toEqual({ found: 1, reaped: 1, skipped: 0 });

        const size = markerSize(doomed.marker);
        const stopped = await until(
          () => {
            const now = markerSize(doomed.marker);
            return now === size || now === -1;
          },
          scaled(2_000),
          50,
        );
        expect(stopped, "the marker kept growing: the tree was not reaped").toBe(true);
        expect(await waitGone(doomed.agentPid, scaled(2_000))).toBe(true);
      } finally {
        await daemon.stop({ graceful: true }).catch(() => {});
        await reap(doomed);
      }
    },
  );

  it.skipIf(!WINDOWS)(
    "on win32, orphansAtStart is {found:1, reaped:0, skipped:1} and the record says unsupported_platform",
    async () => {
      const doomed = await abandonADaemon();
      const daemon = await createDaemon(
        configFor(doomed.dataDir, doomed.cwd, doomed.token, doomed.marker),
      );
      try {
        // Windows cannot fingerprint, and a null fingerprint FORBIDS signalling the pid: reuse
        // would make the kill a coin flip on an unrelated process. So it reports and does not
        // touch — and `GET /v1/info` says so rather than the leak being invisible.
        expect(daemon.info.orphansAtStart).toEqual({ found: 1, reaped: 0, skipped: 1 });
        const auth = daemon.authenticate(new Headers({ authorization: `Bearer ${doomed.token}` }));
        const snapshot = daemon.workers.snapshot(doomed.workerId as never, auth);
        expect(snapshot.orphan?.fingerprint).toBeNull();
        expect(snapshot.orphan?.reaped).toBe(false);
        expect(snapshot.orphan?.reapSkipped).toBe("unsupported_platform");
      } finally {
        await daemon.stop({ graceful: true }).catch(() => {});
        await reap(doomed);
      }
    },
  );

  it("boot adoption is a NO-OP on a second run", async () => {
    const doomed = await abandonADaemon();
    const first = await createDaemon(
      configFor(doomed.dataDir, doomed.cwd, doomed.token, doomed.marker),
    );
    const auth = first.authenticate(new Headers({ authorization: `Bearer ${doomed.token}` }));
    const head = first.workers.snapshot(doomed.workerId as never, auth).headSeq;
    expect(first.info.orphansAtStart.found).toBe(1);
    await first.stop({ graceful: true });

    const second = await createDaemon(
      configFor(doomed.dataDir, doomed.cwd, doomed.token, doomed.marker),
    );
    try {
      // `abandoned(bootId)` selects rows whose boot id is not the CURRENT one, and adoption
      // stamps the current id — so a second run finds nothing. Without that, every restart would
      // append another set of envelopes to every abandoned worker's log, forever.
      expect(second.info.orphansAtStart).toEqual({ found: 0, reaped: 0, skipped: 0 });
      const auth2 = second.authenticate(new Headers({ authorization: `Bearer ${doomed.token}` }));
      expect(second.workers.snapshot(doomed.workerId as never, auth2).headSeq).toBe(head);
    } finally {
      await second.stop({ graceful: true }).catch(() => {});
      await reap(doomed);
    }
  });
});

/** Last resort: never leave a grandchild running past this file, on any OS. */
async function reap(doomed: Doomed): Promise<void> {
  if (!(await isAlive(doomed.agentPid))) return;
  try {
    process.kill(process.platform === "win32" ? doomed.agentPid : -doomed.agentPid, "SIGKILL");
  } catch {
    try {
      process.kill(doomed.agentPid, "SIGKILL");
    } catch {
      // Already gone, or not ours. Either way there is nothing further to do.
    }
  }
}
