import { readFileSync, statSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixtureAgent, startHarness, tempRoot, until, type Harness } from "./support/harness.js";

/**
 * The portable oracle: `orphan.mjs` spawns a grandchild that appends to `$MARKER_FILE` every
 * 100 ms. After DELETE, the file stops growing within 2 s. This needs no pid introspection,
 * which is precisely what Windows cannot give us (CONTRACTS.md §6.4). WP-6 owns this file.
 *
 * A pid-based assertion would have to be written twice — once honestly for POSIX and once
 * apologetically for Windows — and the Windows half would assert nothing. A file that stops
 * growing asks the same question on all three OSes.
 *
 * `MARKER_FILE` reaches the agent through the CATALOG descriptor's `env`, which is
 * trusted and config-supplied; per-request `env` is M2 and `CreateWorkerRequest`'s
 * `strictObject` rejects it today (D19).
 */
describe("tree kill", () => {
  let harness: Harness | undefined;
  let scratch: string | undefined;

  afterEach(async () => {
    await harness?.dispose();
    harness = undefined;
    if (scratch !== undefined) await rm(scratch, { recursive: true, force: true }).catch(() => {});
    scratch = undefined;
  });

  /** A marker file outside the daemon's `cwdRoots` — it is an oracle, not agent workspace. */
  async function marker(name: string): Promise<string> {
    scratch ??= await tempRoot("omni-acp-marker-");
    const path = join(scratch, name);
    await writeFile(path, "");
    return path;
  }

  const sizeOf = (path: string): number => {
    try {
      return statSync(path).size;
    } catch {
      return 0;
    }
  };

  it("stops the grandchild's marker file growing within 2 s of DELETE, on all three OSes", async () => {
    const path = await marker("marker.txt");
    harness = await startHarness({
      roots: 1,
      agents: [fixtureAgent("orphan", "orphan", { MARKER_FILE: path, ORPHAN_INTERVAL_MS: "100" })],
    });
    const server = await harness.connect();
    const worker = await server.createAgent("orphan", { cwd: harness.roots[0] ?? "" });

    // The grandchild is alive and writing — otherwise "it stopped" proves nothing.
    expect(await until(() => sizeOf(path) > 0, 5_000)).toBe(true);
    const running = sizeOf(path);
    expect(await until(() => sizeOf(path) > running, 5_000)).toBe(true);

    const result = await worker.close();
    expect(result.state).toBe("closed");
    expect(result.leaderExited).toBe(true);

    // Give the escalation ladder its moment, then measure across a window ten times the
    // fixture's write interval.
    await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
    const settled = sizeOf(path);
    await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
    expect(sizeOf(path)).toBe(settled);

    await server.close();
  }, 60_000);

  it("reports treeGone true on POSIX and false on Windows — never optimistic", async () => {
    const path = await marker("marker2.txt");
    harness = await startHarness({
      roots: 1,
      agents: [fixtureAgent("orphan", "orphan", { MARKER_FILE: path })],
    });
    const server = await harness.connect();
    const worker = await server.createAgent("orphan", { cwd: harness.roots[0] ?? "" });

    const result = await worker.close();

    // `treeGone` means "the whole tree is PROVABLY gone", nothing weaker. On Windows
    // `taskkill /T` walks the live PPID chain and cannot prove anything, so M0 answers false
    // and puts the weaker fact in `leaderExited` (D10, §6.4, §6.6).
    expect(result.treeGone).toBe(process.platform !== "win32");
    expect(result.leaderExited).toBe(true);

    // The same honesty surfaces on `GET /v1/info`, before anything goes wrong.
    expect(harness.daemon.info.ownership.confirmsTreeGone).toBe(process.platform !== "win32");

    await server.close();
  }, 60_000);

  it("survives a leader that exits while its grandchild holds the stdout pipe open", async () => {
    // The zombie case: `stdoutEnded` fires long after `exited`, or never (WP-2 acceptance 9).
    // A daemon that waited on a pipe a dead agent's child is holding would never close this
    // worker at all.
    const path = await marker("marker3.txt");
    harness = await startHarness({
      roots: 1,
      agents: [
        fixtureAgent("orphan", "orphan", { MARKER_FILE: path, ORPHAN_EXIT_AFTER_MS: "500" }),
      ],
    });
    const server = await harness.connect();
    const worker = await server.createAgent("orphan", { cwd: harness.roots[0] ?? "" });

    const closed = await worker.closed;
    expect(closed.state).toBe("closed");
    expect(closed.closeReason === "agent_exited" || closed.closeReason === "agent_crashed").toBe(
      true,
    );
    expect(readFileSync(path, "utf8").length).toBeGreaterThan(0);

    // Closing the worker is not enough: the grandchild is the whole point of this fixture, and a
    // close that merely REPORTS `treeGone:false` has leaked an MCP server or an agent-spawned
    // shell for the 300 s the fixture sleeps. Same oracle as the DELETE test above — the marker
    // must stop growing — asserted here because nothing else notices a leader that exited on its
    // own: the AgentProcess has already left `supervisor.live`, so `daemon.stop()`'s backstop
    // never sees it either (§6.7).
    await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
    const settled = sizeOf(path);
    await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
    expect(sizeOf(path)).toBe(settled);

    await server.close();
  }, 60_000);
});
