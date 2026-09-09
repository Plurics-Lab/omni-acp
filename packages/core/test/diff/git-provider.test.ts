import { describe, it } from "vitest";

/**
 * D8's git provider. Every test in this file runs with NO GIT INSTALLED — the provider reaches
 * git only through the injected `RunUtility`, which is what makes that possible and what
 * `no-direct-spawn` already enforces for `fingerprint.ts`'s `ps`.
 *
 * Owned by M2-WP-J.
 */

describe("createGitDiffProvider (§25, D8)", () => {
  it.todo(
    "createGitDiffProvider reaches git ONLY through the injected RunUtility (no-direct-spawn, patch-runs-no-shell), and its unit tests run with NO git installed",
  );
  it.todo(
    "GIT_INDEX_FILE is used on BOTH write-tree calls; the user's real index and worktree are byte-identical before and after (D8's 不碰用户 index), the temp index NEVER appears in a produced patch, and .gitignore is respected",
  );
  it.todo(
    "--no-ext-diff / --no-textconv are present and a planted diff.external in the test repo's config is NOT executed; GIT_OPTIONAL_LOCKS=0 is set",
  );
  it.todo(
    "patch is null OUTSIDE a repo, null when the agent created .git/ mid-session (initRepoMidSession(), F39), null over diff.maxBytes (truncated at a hunk boundary, truncated: true), null on any git failure and on timeout — and EVERY one carries its named TurnWarning",
  );
  it.todo(
    'two workers on one repo: both patches carry quality:"shared_worktree" and the warning; a single worker carries "exact"; a produced patch passes `git apply --check` in a clean clone (skipIf no git)',
  );
});
