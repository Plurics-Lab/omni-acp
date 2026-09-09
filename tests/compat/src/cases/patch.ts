import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { reduceTurn, type DaemonConfig, type TurnStatus } from "@omni-acp/protocol";
import { initGitRepoAt } from "@omni-acp/testkit";
import { allEnvelopes, assert, deepEqual, type CompatCase, type CompatContext } from "./support.js";

/**
 * Compat cases for the git diff provider and `TurnResult.patch` (§27.2's `patch-git` row).
 *
 * TWO cases, and the second is the one that matters more: a `null` patch is D8's honest answer
 * and it is ALWAYS EXPLAINED. F39 records codex-acp creating `.git/` in its own cwd mid-session,
 * so a worker that started outside a repository must still answer `patch: null` +
 * `patch_not_a_repo` at the end of the turn — never a garbage diff reporting the whole workspace
 * as added — whatever the agent did to the directory in between.
 *
 * Both `requires: ["patch"]`, which the two real agents' YAML declares now that M2-WP-J wires
 * `DaemonDeps.diff`; a fixture that cannot write a file declares neither `patch` nor `tools` and
 * is a printed `capability` skip rather than a silent pass. The suite refuses to assert an
 * `unverified` descriptor row at all.
 *
 * Owned by M2-WP-J.
 */

/** `diff.provider` defaults to `"none"`, so without this overlay every patch is vacuously null. */
const withGitProvider = (base: DaemonConfig): DaemonConfig => ({
  ...base,
  diff: { provider: "git", mode: "on_write" },
});

/** The turn as the DAEMON folded it, for D7's deep-equality check. */
async function turnFromDaemon(
  ctx: CompatContext,
  workerId: string,
  turnId: string,
): Promise<TurnStatus> {
  const response = await fetch(
    `${ctx.serverUrl}/v1/workers/${workerId}/turns/${encodeURIComponent(turnId)}`,
    { headers: { authorization: `Bearer ${ctx.token}` } },
  );
  assert(response.ok, `GET /turns/${turnId} answered HTTP ${String(response.status)}`);
  return (await response.json()) as TurnStatus;
}

export function patchCases(): readonly CompatCase[] {
  return [
    {
      /**
       * A write turn in a git repository yields a real patch, and the daemon's own fold agrees
       * with the SDK's — INCLUDING `patch`, which is D7 re-proven rather than assumed (§25.1).
       */
      id: "patch-git",
      requires: ["patch", "tools"],
      async run(ctx: CompatContext) {
        await ctx.withDaemonConfig(withGitProvider);
        // A repository INSIDE the token's only `cwdRoot`: a worker's cwd is ACL-checked, so the
        // fixture cannot be a temp directory of its own. The skeleton is written with `node:fs`
        // and never with a `git` process (see `git-fixture.ts`).
        const repo = join(ctx.cwd, "patch-repo");
        await mkdir(repo, { recursive: true });
        await initGitRepoAt(repo);

        const worker = await ctx.harness.A.createAgent(ctx.agentId, { cwd: repo });
        try {
          const result = await worker.prompt(ctx.prompts.write);

          assert(
            result.patch !== null,
            `a write turn in a git repository produced no patch; warnings: ` +
              JSON.stringify(result.warnings.map((w) => w.code)),
          );
          const patch = result.patch ?? "";
          assert(
            patch.includes("diff --git "),
            `the patch does not look like a git patch: ${patch.slice(0, 120)}`,
          );
          assert(
            patch.includes("new file mode") || patch.includes("+++ b/"),
            "the patch names no file",
          );
          assert(
            result.patchInfo?.source === "git",
            `patchInfo.source is ${JSON.stringify(result.patchInfo?.source)}`,
          );
          assert(
            result.patchInfo?.quality === "exact",
            `a single worker's patch is ${JSON.stringify(result.patchInfo?.quality)}, not exact`,
          );
          assert(result.patchInfo?.truncated === false, "a small patch reported truncated");
          // The temp index lives OUTSIDE every worktree, so it can never appear in a patch.
          assert(!patch.includes("omni-index-"), "the temp index leaked into the patch");

          // D7, re-proven: the SDK's local fold and the daemon's `GET /turns/{id}` are the same
          // `TurnResult`, patch and all. The patch rides on `state_update{idle}._meta` precisely
          // so that this is true for a `?since=` reader and across a restart (§25.1).
          const envelopes = await allEnvelopes(ctx, worker.id);
          const local = reduceTurn(result.turnId, envelopes);
          const remote = await turnFromDaemon(ctx, worker.id, result.turnId);
          assert(
            deepEqual(local.patch, remote.result?.patch),
            `reduceTurn's patch and GET /turns' patch differ`,
          );
          assert(
            deepEqual(local.patchInfo, remote.result?.patchInfo),
            `reduceTurn's patchInfo and GET /turns' patchInfo differ`,
          );
          assert(deepEqual(local, remote.result), "reduceTurn and GET /turns disagree");
        } finally {
          await worker.close().catch(() => {});
          await ctx.withDaemonConfig(null);
        }
      },
    },

    {
      /**
       * §25.3, and F39's live half: a cwd that is not a repository answers `patch: null` with the
       * NAMED warning — and it still does when the agent creates `.git/` underneath itself
       * mid-turn, which codex-acp does on its own (`08`'s `workspace_after`). The provider probes
       * at BOTH ends of every turn and refuses to diff a top level that appeared.
       */
      id: "patch-outside-a-repo",
      requires: ["patch", "tools"],
      async run(ctx: CompatContext) {
        await ctx.withDaemonConfig(withGitProvider);
        const plain = join(ctx.cwd, "patch-not-a-repo");
        await mkdir(plain, { recursive: true });

        const worker = await ctx.harness.A.createAgent(ctx.agentId, { cwd: plain });
        try {
          const result = await worker.prompt(ctx.prompts.write);

          assert(
            result.patch === null,
            "a turn outside a git repository produced a patch, which can only be a diff of " +
              "something we were not asked about",
          );
          const codes = result.warnings.filter((w) => w.source === "patch").map((w) => w.code);
          // ALWAYS EXPLAINED. `patch_repo_changed` is the same honest answer when the agent
          // created the repository between `begin` and `end` — never a diff either way.
          assert(
            codes.includes("patch_not_a_repo") || codes.includes("patch_repo_changed"),
            `the null patch carries no named warning; saw ${JSON.stringify(codes)}`,
          );
          assert(
            result.patchInfo === null || result.patchInfo.quality === "unavailable",
            `patchInfo claims ${JSON.stringify(result.patchInfo?.quality)} for a null patch`,
          );
          // A missing patch is not a failed turn (D8): the turn itself is unaffected.
          assert(
            result.verdict !== "failed",
            `the turn is ${result.verdict}; a git failure must never fail a turn`,
          );
        } finally {
          await worker.close().catch(() => {});
          await ctx.withDaemonConfig(null);
        }
      },
    },
  ];
}
