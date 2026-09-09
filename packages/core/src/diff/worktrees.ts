import { OmniError } from "@omni-acp/protocol";

/**
 * §25.4: is another LIVE worker sharing this repository?
 *
 * If one is, the patch may contain ITS edits and can even contain a half-written file, so the
 * result is `quality:"shared_worktree"` plus a warning. We REPORT rather than misattribute — a
 * patch labelled `exact` that contains somebody else's work is worse than no patch, because a
 * caller will apply it.
 *
 * Owned by M2-WP-J.
 */
export function classifyWorktree(
  _topLevel: string,
  _liveCwds: readonly string[],
): "exact" | "shared_worktree" {
  throw new OmniError("internal", "unimplemented: M2-WP-J");
}
