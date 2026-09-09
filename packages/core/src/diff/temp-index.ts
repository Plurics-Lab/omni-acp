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
 * Owned by M2-WP-J.
 */
export function withTempIndex<T>(
  _run: RunUtility,
  _o: { topLevel: string; tmpDir: string; timeoutMs: number },
  _fn: (indexFile: string) => Promise<T>,
): Promise<T> {
  throw new OmniError("internal", "unimplemented: M2-WP-J");
}
