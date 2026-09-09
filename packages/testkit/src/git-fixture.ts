import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A temporary git repository, and a temporary directory that can BECOME one mid-test.
 *
 * `tempNonRepo().initRepo()` is not a convenience: F39 records codex-acp creating `.git/` in its
 * own cwd MID-SESSION, which is why `DiffProvider.begin` runs per TURN and why "outside a repo ⇒
 * null" cannot be decided once at worker start. The fixture exists so that is a test rather than
 * a comment.
 *
 * **It creates the repository with `node:fs` and never runs git**, for two reasons that are both
 * structural rather than stylistic: `no-direct-spawn` scans every source file under `packages`, including
 * this one, and `@omni-acp/testkit` may not import `@omni-acp/core` (§3.1's DAG runs
 * `protocol → testkit`, and core dev-depends on this package, so the edge would be a cycle). A
 * `.git/` holding `HEAD`, `config`, `objects/` and `refs/heads/` IS a repository to git — one
 * with zero commits, which is exactly the shape codex creates and the shape the provider's
 * `add -A` into an EMPTY temp index is designed for (§25.2).
 *
 * Owned by M2-WP-J.
 */

/** The four entries `git rev-parse --show-toplevel` needs to call a directory a repository. */
async function writeGitSkeleton(dir: string): Promise<void> {
  const dot = join(dir, ".git");
  await mkdir(join(dot, "objects"), { recursive: true });
  await mkdir(join(dot, "refs", "heads"), { recursive: true });
  await writeFile(join(dot, "HEAD"), "ref: refs/heads/main\n", "utf8");
  await writeFile(
    join(dot, "config"),
    "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n",
    "utf8",
  );
}

async function tempDir(prefix: string): Promise<string> {
  // realpath'd: on macOS `os.tmpdir()` is a symlink and `git rev-parse --show-toplevel` answers
  // the RESOLVED path, so an un-resolved fixture path would never compare equal to it.
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

export async function tempRepo(): Promise<{ dir: string; dispose(): Promise<void> }> {
  const dir = await tempDir("omni-repo-");
  await writeGitSkeleton(dir);
  return {
    dir,
    dispose: async (): Promise<void> => {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

export async function tempNonRepo(): Promise<{
  dir: string;
  initRepo(): Promise<void>;
  dispose(): Promise<void>;
}> {
  const dir = await tempDir("omni-nonrepo-");
  return {
    dir,
    // F39's move, exactly: the directory BECOMES a repository between `begin` and `end`.
    initRepo: () => writeGitSkeleton(dir),
    dispose: async (): Promise<void> => {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}
