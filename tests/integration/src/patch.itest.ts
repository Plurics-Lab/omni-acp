import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runUtility } from "@omni-acp/core";
import { reduceTurn, type TurnStatus } from "@omni-acp/protocol";
import { initGitRepoAt } from "@omni-acp/testkit";
import type { Server, Worker } from "@omni-acp/client";
import { fixtureAgent, startHarness, type Harness } from "./support/harness.js";

/**
 * D8 end to end, through the assembled daemon: `POST /v1/workers` → a turn that WRITES → a
 * `TurnResult.patch` that `git apply --check` accepts (§25, M2-WP-J acceptance 4, 5 and 6).
 *
 * Tier 3: a real process, real ndJSON, real loopback HTTP, real `git`. The agent is
 * `patch-writer.mjs`, the only fixture that touches the disk — the SDK example agent SIMULATES
 * its edit and never writes a file, so it can prove a permission was allowed and nothing at all
 * about a patch.
 *
 * Every `null` here is asserted WITH its named warning, because §25.3's rule is not "sometimes
 * there is no patch" but "`null` is an answer, and it is always explained".
 *
 * Owned by M2-WP-J.
 */

const GIT_MS = 30_000;
const TURN_MS = 60_000;

async function hasGit(): Promise<boolean> {
  try {
    return (await runUtility("git", ["--version"], { timeoutMs: GIT_MS })).code === 0;
  } catch {
    return false;
  }
}
const NO_GIT = !(await hasGit());

let live: Harness | null = null;
let server: Server | null = null;
afterEach(async () => {
  await server?.close().catch(() => undefined);
  await live?.dispose();
  server = null;
  live = null;
});

/**
 * A daemon with the git provider wired, and three writer agents:
 *
 *  - `writer` writes `hello.txt`;
 *  - `writer-initgit` creates `.git/` in its own cwd BEFORE writing (F39's move);
 *  - `writer-slow` waits before writing, so two turns can be made to overlap (§25.4).
 */
async function startPatchHarness(files?: Record<string, string>): Promise<Harness> {
  const env: Record<string, string> =
    files === undefined ? {} : { PATCH_FILES: JSON.stringify(files) };
  const harness = await startHarness({
    config: { diff: { provider: "git" } },
    agents: [
      fixtureAgent("writer", "patch-writer", env),
      fixtureAgent("writer-initgit", "patch-writer", { ...env, PATCH_INIT_GIT: "1" }),
      fixtureAgent("writer-slow", "patch-writer", { ...env, PATCH_DELAY_MS: "700" }),
    ],
  });
  live = harness;
  return harness;
}

/** The turn as the DAEMON folded it — D7's other half. */
async function turnFromDaemon(
  harness: Harness,
  workerId: string,
  turnId: string,
): Promise<TurnStatus> {
  const response = await fetch(
    `${harness.daemon.url ?? ""}/v1/workers/${workerId}/turns/${turnId}`,
    {
      headers: { authorization: `Bearer ${harness.token}` },
    },
  );
  expect(response.ok).toBe(true);
  return (await response.json()) as TurnStatus;
}

describe.skipIf(NO_GIT)("TurnResult.patch, through the daemon (§25, D8)", () => {
  it(
    "a write turn in a repository yields a patch a clean clone accepts, and the daemon's fold agrees",
    { timeout: TURN_MS },
    async () => {
      const harness = await startPatchHarness({ "src/hello.txt": "hello\nworld\n" });
      const repo = harness.roots[0] ?? "";
      await initGitRepoAt(repo);
      server = await harness.connect();

      const worker = await server.createAgent("writer", { cwd: repo });
      const result = await worker.prompt("write it");

      expect(result.stopReason).toBe("end_turn");
      expect(result.patch).not.toBeNull();
      expect(result.patch).toContain("diff --git a/src/hello.txt b/src/hello.txt");
      expect(result.patch).toContain("+hello");
      expect(result.patchInfo).toEqual({ source: "git", truncated: false, quality: "exact" });
      // The temp index lives outside every worktree, so it can never appear in a patch (§25.2).
      expect(result.patch).not.toContain("omni-index-");
      // And the worktree the operator sees holds the file and nothing of ours.
      expect((await readdir(repo)).sort()).toEqual([".git", "src"]);

      // `git apply --check` in a CLEAN CLONE: a repository that has never seen our index, at the
      // state the turn started from.
      const clone = join(tmpdir(), `omni-patch-clone-${String(process.pid)}`);
      await mkdir(clone, { recursive: true });
      await initGitRepoAt(clone);
      const patchFile = join(tmpdir(), `omni-patch-${String(process.pid)}.diff`);
      await writeFile(patchFile, result.patch ?? "", "utf8");
      try {
        const check = await runUtility(
          "git",
          ["--no-pager", "-C", clone, "apply", "--check", patchFile],
          { timeoutMs: GIT_MS },
        );
        expect(check.code).toBe(0);
      } finally {
        await rm(patchFile, { force: true });
        await rm(clone, { recursive: true, force: true });
      }

      // D7, INCLUDING `patch`: the SDK's local fold and `GET /turns/{id}` are the same object.
      // That is what the `state_update{idle}._meta` channel buys — a `?since=` reader and a
      // restart both see the patch, because it is IN THE LOG (§25.1).
      const envelopes: unknown[] = [];
      for await (const envelope of worker.events({
        since: 0,
        signal: AbortSignal.timeout(5_000),
      })) {
        envelopes.push(envelope);
        if (envelopes.length > 500) break;
      }
      const local = reduceTurn(result.turnId, envelopes as Parameters<typeof reduceTurn>[1]);
      const remote = await turnFromDaemon(harness, worker.id, result.turnId);
      expect(local.patch).toEqual(remote.result?.patch);
      expect(local.patchInfo).toEqual(remote.result?.patchInfo);
      expect(local).toEqual(remote.result);
    },
  );

  it(
    "a cwd that is not a repository is `null` — with the warning that says so",
    { timeout: TURN_MS },
    async () => {
      const harness = await startPatchHarness();
      const plain = harness.roots[1] ?? "";
      server = await harness.connect();

      const worker = await server.createAgent("writer", { cwd: plain });
      const result = await worker.prompt("write it");

      expect(result.patch).toBeNull();
      expect(result.warnings.map((w) => w.code)).toContain("patch_not_a_repo");
      expect(result.warnings.find((w) => w.code === "patch_not_a_repo")?.source).toBe("patch");
      // D8: a git failure is never a failed turn.
      expect(result.stopReason).toBe("end_turn");
      expect(result.verdict).toBe("ok");
      // The write itself happened; only the diff is missing.
      expect(await readdir(plain)).toContain("hello.txt");
    },
  );

  it(
    "the agent creating `.git/` MID-TURN is `patch_repo_changed`, never a garbage diff (F39)",
    { timeout: TURN_MS },
    async () => {
      const harness = await startPatchHarness();
      const repo = harness.roots[0] ?? "";
      await initGitRepoAt(repo);
      // A worker whose cwd is INSIDE the repository, so `begin` resolves the top level to the
      // root — and then the agent makes its own cwd a repository, which is exactly codex-acp's
      // observed behaviour (`08`'s `workspace_after`).
      const inner = join(repo, "work");
      await mkdir(inner, { recursive: true });
      server = await harness.connect();

      const worker = await server.createAgent("writer-initgit", { cwd: inner });
      const result = await worker.prompt("write it");

      expect(result.patch).toBeNull();
      expect(result.warnings.map((w) => w.code)).toContain("patch_repo_changed");
      expect(result.stopReason).toBe("end_turn");
      // The two trees would have diffed the WHOLE workspace as added; the provider refused.
      expect(result.patchInfo?.quality ?? "unavailable").toBe("unavailable");
    },
  );

  it(
    '`patch: "off"` runs no git at all, and says nothing about it',
    { timeout: TURN_MS },
    async () => {
      const harness = await startPatchHarness();
      const repo = harness.roots[0] ?? "";
      await initGitRepoAt(repo);
      server = await harness.connect();

      const worker = await server.createAgent("writer", { cwd: repo, patch: "off" });
      const result = await worker.prompt("write it");

      expect(worker.snapshot.patchMode).toBe("off");
      expect(result.patch).toBeNull();
      // NO warning: the operator asked for no patch, so there is nothing to explain (§25.3's
      // rule is about a patch we could not produce, not one nobody wanted).
      expect(result.warnings.filter((w) => w.source === "patch")).toEqual([]);
    },
  );

  it(
    "two workers on ONE repository both report shared_worktree, and neither misattributes",
    { timeout: TURN_MS },
    async () => {
      const harness = await startPatchHarness({ "a.txt": "a\n" });
      const repo = harness.roots[0] ?? "";
      await initGitRepoAt(repo);
      const second = join(repo, "packages", "b");
      await mkdir(second, { recursive: true });
      server = await harness.connect();

      // `writer-slow` waits 700 ms before writing, so both turns are genuinely in flight at the
      // same time — which is what "another LIVE worker shares this repository" means.
      const a: Worker = await server.createAgent("writer-slow", { cwd: repo });
      const b: Worker = await server.createAgent("writer-slow", { cwd: second });
      const [first, other] = await Promise.all([a.prompt("write it"), b.prompt("write it")]);

      for (const result of [first, other]) {
        expect(result.patchInfo?.quality).toBe("shared_worktree");
        expect(result.warnings.map((w) => w.code)).toContain("patch_shared_worktree");
        // REPORTED rather than withheld: a patch labelled `exact` that contains somebody else's
        // work is worse than no patch, because a caller will apply it.
        expect(result.patch).not.toBeNull();
      }
    },
  );

  it(
    "a second turn diffs only what THAT turn changed — begin/end are per turn (F39's other half)",
    { timeout: TURN_MS },
    async () => {
      const harness = await startPatchHarness({ "one.txt": "one\n" });
      const repo = harness.roots[0] ?? "";
      await initGitRepoAt(repo);
      server = await harness.connect();

      const worker = await server.createAgent("writer", { cwd: repo });
      const first = await worker.prompt("write it");
      expect(first.patch).toContain("one.txt");

      // The same files, written again with the same content: nothing changed on disk, so the
      // patch is EMPTY rather than a repeat of the first turn's. Both `diff.mode`s answer this
      // from the two trees rather than from the agent's own report of what it did (F38).
      const second = await worker.prompt("write it again");
      expect(second.patch).toBe("");
      expect(second.patchInfo).toEqual({ source: "git", truncated: false, quality: "exact" });
      expect(second.warnings.filter((w) => w.source === "patch")).toEqual([]);
    },
  );
});

describe("the provider is OFF by default", () => {
  it(
    "a daemon with no `diff` config produces `patch: null` and no warning — M1 exactly",
    { timeout: TURN_MS },
    async () => {
      // `diff.provider` defaults to `"none"`: a daemon that ran `git` on every turn without being
      // asked would be touching the operator's repository because it could (ruling M1-R11's
      // condition, kept).
      const harness = await startHarness({ agents: [fixtureAgent("writer", "patch-writer")] });
      live = harness;
      const repo = harness.roots[0] ?? "";
      await initGitRepoAt(repo);
      server = await harness.connect();

      const worker = await server.createAgent("writer", { cwd: repo });
      const result = await worker.prompt("write it");

      expect(result.patch).toBeNull();
      expect(result.patchInfo).toBeNull();
      expect(result.warnings.filter((w) => w.source === "patch")).toEqual([]);
    },
  );
});
