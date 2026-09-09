import { relative, resolve } from "node:path";

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

/**
 * The one normalization §25.4 allows: `path.resolve` plus a case-fold on win32.
 *
 * The PATCH TEXT is never normalized — git emits POSIX separators in its headers and a patch we
 * rewrote is a patch `git apply` may refuse — so this touches only the key we compare worktrees
 * on. On win32 `C:\Repo` and `c:\repo` are one directory and must key as one; on POSIX they are
 * two directories and must not.
 */
export function normalizeTopLevel(p: string): string {
  const absolute = resolve(p);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

/** `child` is inside `parent`, or is `parent`. Same test `auth.ts` uses for `cwdRoots`. */
function contains(parent: string, child: string): boolean {
  if (parent === "") return false;
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !/^([a-zA-Z]:)?[\\/]/.test(rel));
}

export function classifyWorktree(
  topLevel: string,
  liveCwds: readonly string[],
): "exact" | "shared_worktree" {
  const top = normalizeTopLevel(topLevel);
  // A cwd INSIDE the top level shares the worktree just as surely as one equal to it: `git add
  // -A` from the top level sweeps up both, so a patch computed for either contains the other's
  // edits. The caller passes the OTHER live workers' cwds; its own is never in the list.
  return liveCwds.some((cwd) => contains(top, normalizeTopLevel(cwd)))
    ? "shared_worktree"
    : "exact";
}
