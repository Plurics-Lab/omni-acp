import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { OmniError } from "@omni-acp/protocol";
import type {
  Clock,
  DiffProvider,
  IdGen,
  Logger,
  PatchHandle,
  PatchResult,
  ResolvedDiffConfig,
  RunUtility,
  TurnWarning,
  WorkerId,
} from "@omni-acp/protocol";
import { gitEnv, gitGlobals, withTempIndex } from "./temp-index.js";
import { classifyWorktree, normalizeTopLevel } from "./worktrees.js";

/**
 * D8's disk truth: `TurnResult.patch`, from git and from nothing else.
 *
 * It reaches git ONLY through the injected `RunUtility` — the same seam `fingerprint.ts` uses for
 * `ps`, which `core/test/process/no-direct-spawn.test.ts` already enforces — so its unit tests
 * run with NO GIT INSTALLED at all.
 *
 * The honest nulls, each with its own named `TurnWarning`, because D8's rule is "never wrong":
 * outside a repo; when the agent created `.git/` MID-SESSION (F39 — codex-acp's observed
 * behaviour, not a hypothetical, which is why `begin` runs per TURN and not once per worker);
 * over `diff.maxBytes`, truncated at a hunk boundary with `truncated: true`; on any git failure;
 * and on timeout. Never a throw, never a failed turn.
 *
 * `--no-ext-diff` and `--no-textconv` are present because a repository's own `diff.external`
 * config would otherwise run an arbitrary program of the repository's choosing inside the daemon
 * — the test plants one and asserts it is not executed.
 *
 * **Every null is EXPLAINED, which is why `begin` answers a handle even when it already knows
 * there is no patch.** `worker.ts` is frozen and calls `end` only for a non-null handle (hunk 8),
 * so a `null` from `begin` drops the `omni/patch` key altogether and takes the warning with it —
 * and §25.3's "`null` is an answer, and it is always explained" would be false for exactly the
 * two cases it names first (outside a repo, git missing). So those return a SENTINEL handle whose
 * `tree` is empty, and `end` turns it into a real `PatchResult` carrying the named warning. The
 * only `null` from `begin` is `diff.mode:"off"`, where the operator asked for no patch and there
 * is nothing to explain.
 *
 * Owned by M2-WP-J.
 */

/** Why `begin` could not produce a "before" tree. Each maps to one named `TurnWarning`. */
type BeginFailure = "not_a_repo" | "git_missing" | "write_tree_failed";

interface HandleState {
  readonly workerId: WorkerId;
  readonly cwd: string;
  /** Normalized, and `""` for a sentinel handle (`failure !== null`). */
  readonly topLevel: string;
  readonly failure: BeginFailure | null;
  /** Every OTHER live worker's cwd that shared this repository while this handle was open. */
  readonly shared: Set<string>;
  readonly detail: Readonly<Record<string, unknown>> | null;
}

const WARNING_MESSAGES: Readonly<Record<string, string>> = {
  patch_not_a_repo: "the worker's cwd is not inside a git repository, so there is no patch",
  patch_git_missing: "git could not be run, so there is no patch",
  patch_repo_changed:
    "the repository top level appeared, moved or vanished during the turn (F39), so no patch " +
    "could be attributed to it",
  patch_write_tree_failed: "git could not write a tree for the workspace, so there is no patch",
  patch_diff_failed: "git could not produce a diff between the two trees",
  patch_truncated: "the patch was truncated at a hunk boundary because it exceeded diff.maxBytes",
  patch_shared_worktree:
    "another live worker shares this repository, so this patch may contain its edits",
};

function warning(code: string, detail?: Readonly<Record<string, unknown>>): TurnWarning {
  return {
    code,
    message: WARNING_MESSAGES[code] ?? code,
    source: "patch",
    ...(detail === undefined ? {} : { detail }),
  };
}

/** The honest "we have no patch": never a throw, and never a half-built result. */
function unavailable(warnings: readonly TurnWarning[]): PatchResult {
  return { text: null, source: null, truncated: false, quality: "unavailable", warnings };
}

const FAILURE_WARNING: Readonly<Record<BeginFailure, string>> = {
  not_a_repo: "patch_not_a_repo",
  git_missing: "patch_git_missing",
  write_tree_failed: "patch_write_tree_failed",
};

/**
 * The last offset at which `text` can be cut so that only WHOLE hunks survive.
 *
 * A patch cut mid-hunk is not a patch — `git apply` rejects it and a reader cannot tell what was
 * lost — so the cut lands on the first byte of a `diff --git` or `@@` line. `0` means not even
 * the first hunk fits, and the caller then reports `text: null` rather than a fragment.
 */
export function truncateAtHunk(text: string, maxBytes: number): number {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return -1;
  let offset = 0;
  let boundary = 0;
  for (const line of text.split("\n")) {
    const isBoundary = line.startsWith("diff --git ") || line.startsWith("@@ ");
    if (isBoundary && offset > 0 && offset <= maxBytes) boundary = offset;
    // +1 for the "\n" `split` removed. The final line may carry none, which over-counts a cap by
    // one byte — the safe direction for a bound.
    offset += Buffer.byteLength(line, "utf8") + 1;
    if (offset > maxBytes && boundary > 0) break;
  }
  return boundary;
}

export function createGitDiffProvider(o: {
  run: RunUtility;
  cfg: ResolvedDiffConfig;
  clock: Clock;
  ids: IdGen;
  logger: Logger;
}): DiffProvider {
  const { run, cfg, clock, ids, logger } = o;
  // OUTSIDE every worktree (§25.2): a temp index inside one would be swept up by `git add -A`
  // and appear in the patch as a change the agent never made.
  const tmpDir = cfg.tmpDir ?? join(tmpdir(), "omni-acp-diff");
  const timeoutMs = cfg.timeoutMs;
  const live = new Map<PatchHandle, HandleState>();
  /** §25.3: `patch_git_missing` is warned ONCE per daemon, at info. A turn still gets it. */
  let warnedGitMissing = false;

  const git = async (
    dir: string,
    args: readonly string[],
    indexFile: string | null,
  ): Promise<{ code: number | null; stdout: string }> =>
    run("git", [...gitGlobals(dir), ...args], { timeoutMs, env: gitEnv(indexFile) });

  /**
   * The repository this cwd belongs to, or `null`.
   *
   * Asked at BOTH ends of every turn, because F39 makes it a per-turn question: codex-acp creates
   * `.git/` in its own cwd mid-session, and a "before" taken outside a repository against an
   * "after" taken inside one would report the whole workspace as added.
   */
  const topLevelOf = async (cwd: string): Promise<string | "missing" | null> => {
    try {
      const res = await git(cwd, ["rev-parse", "--show-toplevel"], null);
      if (res.code !== 0) return null;
      const line = res.stdout.split("\n")[0]?.trim() ?? "";
      return line === "" ? null : normalizeTopLevel(line);
    } catch (e) {
      // The RunUtility rejects only when the process could not be STARTED (or timed out), which
      // for `git` is "there is no git on this machine" — a different answer from "this is not a
      // repository", and the operator needs to be able to tell them apart.
      logger.debug("git could not be run", { error: String(e) });
      return "missing";
    }
  };

  /** `add -A` into a fresh temp index, then `write-tree`. Throws; every caller catches. */
  const treeOf = async (topLevel: string): Promise<string> =>
    withTempIndex(run, { topLevel, tmpDir, timeoutMs }, async (indexFile) => {
      const res = await git(topLevel, ["write-tree"], indexFile);
      const tree = res.stdout.split("\n")[0]?.trim() ?? "";
      if (res.code !== 0 || tree === "") {
        throw new OmniError("internal", "git write-tree produced no tree", {
          detail: { code: res.code },
        });
      }
      return tree;
    });

  /** A handle nobody will diff, carrying the reason `end` has to report. */
  const sentinel = (
    workerId: WorkerId,
    cwd: string,
    failure: BeginFailure,
    detail?: Readonly<Record<string, unknown>>,
  ): PatchHandle => {
    const handle: PatchHandle = {
      topLevel: "",
      indexFile: "",
      tree: "",
      startedAtMs: clock.now(),
    };
    live.set(handle, {
      workerId,
      cwd,
      topLevel: "",
      failure,
      shared: new Set<string>(),
      detail: detail ?? null,
    });
    return handle;
  };

  return {
    async begin(opts: {
      cwd: string;
      workerId: WorkerId;
      signal?: AbortSignal;
    }): Promise<PatchHandle | null> {
      // `off` is the one case with nothing to explain: the operator asked for no patch, so no
      // handle is opened and no git process is started (§25.4).
      if (cfg.mode === "off") return null;
      try {
        const found = await topLevelOf(opts.cwd);
        if (found === "missing") {
          if (!warnedGitMissing) {
            warnedGitMissing = true;
            logger.info("git is not runnable, so TurnResult.patch will be null for every turn");
          }
          return sentinel(opts.workerId, opts.cwd, "git_missing");
        }
        if (found === null) return sentinel(opts.workerId, opts.cwd, "not_a_repo");

        let tree: string;
        try {
          tree = await treeOf(found);
        } catch (e) {
          logger.warn("git could not write the before-tree", { error: String(e) });
          return sentinel(opts.workerId, opts.cwd, "write_tree_failed");
        }

        const handle: PatchHandle = {
          topLevel: found,
          // The index this tree was written through. It is already GONE — `withTempIndex` removes
          // it in a `finally`, so nothing is held between `begin` and `end` — and the name is
          // kept so `abandon` has something to sweep if a future change ever holds one open.
          indexFile: join(tmpDir, `omni-index-${ids.request()}`),
          tree,
          startedAtMs: clock.now(),
        };
        const state: HandleState = {
          workerId: opts.workerId,
          cwd: opts.cwd,
          topLevel: found,
          failure: null,
          shared: new Set<string>(),
          detail: null,
        };
        // §25.4, both directions: a worker that starts a turn on a repository somebody else is
        // already diffing contaminates BOTH patches, and the one already open must hear about it
        // — its `end` has not run yet.
        for (const [, other] of live) {
          if (other.workerId === state.workerId || other.topLevel === "") continue;
          if (classifyWorktree(other.topLevel, [state.cwd]) === "shared_worktree") {
            other.shared.add(state.cwd);
            state.shared.add(other.cwd);
          }
        }
        live.set(handle, state);
        return handle;
      } catch (e) {
        // Contracted NEVER to throw. A provider that fails is a turn without a patch, never a
        // failed turn (D8).
        logger.warn("the git diff provider could not open a handle", { error: String(e) });
        return null;
      }
    },

    async end(
      h: PatchHandle,
      opts?: { signal?: AbortSignal; wroteFiles?: boolean },
    ): Promise<PatchResult> {
      const state = live.get(h);
      live.delete(h);
      try {
        if (state === undefined) {
          return unavailable([warning("patch_diff_failed", { reason: "unknown patch handle" })]);
        }
        if (state.failure !== null) {
          const code = FAILURE_WARNING[state.failure];
          return unavailable([
            warning(code, state.detail === null ? { cwd: state.cwd } : state.detail),
          ]);
        }
        if (opts?.signal?.aborted === true) {
          return unavailable([warning("patch_diff_failed", { reason: "aborted" })]);
        }

        /**
         * §25.4's `on_write`, and review finding V12 is that it did nothing at all: `cfg.mode`
         * was read in exactly ONE place — to answer `"off"` — so `on_write`, the DOCUMENTED
         * DEFAULT, ran the same two `git add -A` + `write-tree` pairs per turn that `"always"`
         * did, and §11.9's stated mitigation for that cost saved nothing.
         *
         * The ANSWER is identical to the `after === h.tree` branch below, which is the property
         * `git-provider.test.ts` already pins ("the two modes agree"): a turn that wrote nothing
         * has an empty patch either way. What differs is the COST — the second `git add -A` +
         * `write-tree` pair, plus the `rev-parse` — which is the whole reason the mode exists.
         *
         * `wroteFiles` absent means "the caller does not report it", and then the honest reading
         * is `"always"`: an observation we do not have must never suppress a patch.
         */
        if (cfg.mode === "on_write" && opts?.wroteFiles === false) {
          const nothing = classifyWorktree(state.topLevel, [...state.shared]);
          return {
            text: "",
            source: "git",
            truncated: false,
            quality: nothing,
            warnings:
              nothing === "shared_worktree"
                ? [warning("patch_shared_worktree", { workers: state.shared.size + 1 })]
                : [],
          };
        }

        // F39, the whole reason `begin` runs per turn: the top level must still be the SAME one.
        const now = await topLevelOf(state.cwd);
        if (now !== state.topLevel) {
          return unavailable([
            warning("patch_repo_changed", { before: state.topLevel, after: now ?? null }),
          ]);
        }

        let after: string;
        try {
          after = await treeOf(state.topLevel);
        } catch (e) {
          logger.warn("git could not write the after-tree", { error: String(e) });
          return unavailable([warning("patch_write_tree_failed", { cwd: state.cwd })]);
        }

        const quality = classifyWorktree(state.topLevel, [...state.shared]);
        const shared =
          quality === "shared_worktree"
            ? [warning("patch_shared_worktree", { workers: state.shared.size + 1 })]
            : [];

        // Nothing changed on disk. Both `diff.mode`s agree here and neither runs a diff: the
        // question "did this turn write" is answered by the two trees rather than by the agent's
        // own report, which F38 records under-reporting (a two-file read reported as one
        // `kind:"read"` call with one location).
        if (after === h.tree) {
          return { text: "", source: "git", truncated: false, quality, warnings: shared };
        }

        let patch: { code: number | null; stdout: string };
        try {
          patch = await git(
            state.topLevel,
            [
              "diff-tree",
              "-p",
              // SECURITY, not tidiness (§25.2): an operator's `diff.external` /
              // `diff.*.textconv` is arbitrary code and this runs on every turn.
              "--no-ext-diff",
              "--no-textconv",
              // Never `--binary`: a binary file comes back as git's own "Binary files … differ"
              // line and no blob content is smuggled into a patch.
              "--no-color",
              h.tree,
              after,
            ],
            null,
          );
        } catch (e) {
          logger.warn("git diff-tree could not be run", { error: String(e) });
          return unavailable([warning("patch_diff_failed", { reason: String(e) })]);
        }
        if (patch.code !== 0) {
          return unavailable([warning("patch_diff_failed", { code: patch.code })]);
        }

        const text = patch.stdout;
        const bytes = Buffer.byteLength(text, "utf8");
        if (bytes > cfg.maxBytes) {
          const cut = truncateAtHunk(text, cfg.maxBytes);
          const detail = { bytes, maxBytes: cfg.maxBytes };
          // A patch that lost hunks is not `exact` however it is labelled, so it says
          // `unavailable` and keeps the text a reader can still look at. `null` is the honest
          // answer when not even the first hunk fits.
          return {
            text: cut <= 0 ? null : text.slice(0, cut),
            source: "git",
            truncated: true,
            quality: "unavailable",
            warnings: [warning("patch_truncated", detail), ...shared],
          };
        }
        return { text, source: "git", truncated: false, quality, warnings: shared };
      } catch (e) {
        // Contracted NEVER to throw (§5.8.8): a git failure is `text: null` and a warning.
        logger.warn("the git diff provider failed", { error: String(e) });
        return unavailable([warning("patch_diff_failed", { reason: String(e) })]);
      }
    },

    abandon(h: PatchHandle): void {
      live.delete(h);
      // Best effort, and NEVER a throw: `withTempIndex` already removed the index in its own
      // `finally`, so this only sweeps a file a crashed process could have left behind.
      if (h.indexFile !== "") void rm(h.indexFile, { force: true }).catch(() => undefined);
    },
  };
}
