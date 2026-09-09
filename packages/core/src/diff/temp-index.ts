import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { OmniError } from "@omni-acp/protocol";
import type { RunUtility } from "@omni-acp/protocol";

/**
 * D8's 不碰用户 index, made mechanical: `GIT_INDEX_FILE` pointed at a temp file, on BOTH
 * `write-tree` calls.
 *
 * The user's real index and worktree must be byte-identical before and after — a `git add` into
 * their index to compute a diff would stage changes they never asked to stage, and they would
 * find out at their next commit. The temp index lives OUTSIDE every worktree (`diff.tmpDir`), so
 * it can never appear in a produced patch.
 *
 * `GIT_OPTIONAL_LOCKS=0` keeps this from taking the index lock a concurrent user command wants.
 *
 * The helper OWNS the `git add -A` half — that is what the temp index exists for and it is the
 * one call that must never be made against the operator's own index — and hands the caller the
 * index file so the `write-tree` that reads it runs under the same `GIT_INDEX_FILE`. The file is
 * removed in a `finally`, so a turn that dies between the two calls leaves nothing behind
 * (M2 definition of done 6: "zero temp git index files left behind").
 *
 * Owned by M2-WP-J.
 */

/**
 * The environment every git invocation in this package runs under (§25.2).
 *
 * Every entry is a control rather than a nicety:
 *  - `GIT_INDEX_FILE` — the whole technique. It has no command-line spelling, which is why
 *    `RunUtility` carries an `env` at all.
 *  - `GIT_OPTIONAL_LOCKS=0` — this runs while a human may be using the same repository, so we
 *    never take a lock their own command is waiting for.
 *  - `GIT_TERMINAL_PROMPT=0` — a prompt on a daemon's stdin is a hang, not a question.
 *  - `GIT_PAGER=cat` / `GIT_CONFIG_NOSYSTEM` is deliberately NOT set: `--no-pager` is argv and a
 *    system config is the operator's own. `LC_ALL=C` keeps git's own messages parseable.
 */
export function gitEnv(indexFile: string | null): Readonly<Record<string, string>> {
  return {
    ...(indexFile === null ? {} : { GIT_INDEX_FILE: indexFile }),
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    LC_ALL: "C",
  };
}

/**
 * The global argv every git invocation carries, before the subcommand.
 *
 * `--no-pager` because a pager attached to a pipe is a hang; `-C <dir>` because it is the ONLY
 * way this package points git at a directory — `RunUtility` was widened for `env` and for nothing
 * else, and a `cwd` we did not need is a seam we did not take.
 */
export function gitGlobals(dir: string): readonly string[] {
  return ["--no-pager", "-C", dir];
}

export async function withTempIndex<T>(
  run: RunUtility,
  o: { topLevel: string; tmpDir: string; timeoutMs: number },
  fn: (indexFile: string) => Promise<T>,
): Promise<T> {
  await mkdir(o.tmpDir, { recursive: true });
  // OUTSIDE every worktree by construction (`diff.tmpDir`), and uniquely named: two workers on
  // one repository each get their own index, which is §25.4's "each worker has its own temp
  // index, so the operator's index is never touched".
  const indexFile = join(o.tmpDir, `omni-index-${randomUUID()}`);
  try {
    const added = await run(
      "git",
      [...gitGlobals(o.topLevel), "add", "-A", "--"],
      // `.gitignore` is respected by construction: `add -A` is what reads it, and an EMPTY index
      // is what makes the resulting tree the worktree — so it needs no `HEAD` and works in a
      // repository with zero commits, which is exactly the repository codex creates (F39).
      { timeoutMs: o.timeoutMs, env: gitEnv(indexFile) },
    );
    if (added.code !== 0) {
      throw new OmniError(
        "internal",
        `git add -A exited ${added.code === null ? "with no code" : String(added.code)}`,
        { detail: { topLevel: o.topLevel } },
      );
    }
    return await fn(indexFile);
  } finally {
    // Best effort, and deliberately not reported: an index we could not delete is a temp file,
    // and a turn must never fail over one.
    await rm(indexFile, { force: true }).catch(() => undefined);
  }
}
