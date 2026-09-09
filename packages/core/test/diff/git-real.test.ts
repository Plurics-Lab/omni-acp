import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DiffConfig, type PatchHandle, type WorkerId } from "@omni-acp/protocol";
import { nullLogger, seqIds, tempNonRepo, tempRepo } from "@omni-acp/testkit";
import { createGitDiffProvider } from "../../src/diff/git-provider.js";
import { runUtility } from "../../src/process/spawn.js";

/**
 * The REAL-git tier of D8's provider: four claims that are about git's behaviour rather than
 * about ours, and cannot honestly be made against a fake.
 *
 *  - a produced patch passes `git apply --check` in a clean clone (acceptance 5);
 *  - `.gitignore` is respected and the operator's own index is never written (acceptance 2);
 *  - a planted `diff.external` in the repository's config is NOT executed (acceptance 3);
 *  - a repository that appears UNDER the worker's cwd mid-turn is `patch_repo_changed` (F39).
 *
 * Every one is `skipIf`'d on a machine with no git, because `git-provider.test.ts` is the tier
 * that must run everywhere and it needs none.
 *
 * Owned by M2-WP-J.
 */

const WORKER = "w_00000000000000000000000001" as WorkerId;
const OTHER = "w_00000000000000000000000002" as WorkerId;
const GIT_MS = 30_000;

async function hasGit(): Promise<boolean> {
  try {
    return (await runUtility("git", ["--version"], { timeoutMs: GIT_MS })).code === 0;
  } catch {
    return false;
  }
}
const NO_GIT = !(await hasGit());

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose().catch(() => undefined);
});

function provider(o: { maxBytes?: number } = {}) {
  return createGitDiffProvider({
    run: runUtility,
    cfg: DiffConfig.parse({ provider: "git", ...(o.maxBytes === undefined ? {} : o) }),
    clock: {
      now: () => Date.now(),
      iso: () => new Date().toISOString(),
      setTimer: () => ({ cancel() {} }),
    },
    ids: seqIds(),
    logger: nullLogger(),
  });
}

async function repo(): Promise<string> {
  const fixture = await tempRepo();
  disposers.push(fixture.dispose);
  return fixture.dir;
}

/** One turn against a real repository: `begin`, the caller's edits, `end`. */
async function turn(
  dir: string,
  edit: () => Promise<void>,
  o: { maxBytes?: number; workerId?: WorkerId } = {},
) {
  const p = provider(o);
  const handle = await p.begin({ cwd: dir, workerId: o.workerId ?? WORKER });
  await edit();
  return { provider: p, handle, result: handle === null ? null : await p.end(handle) };
}

describe.skipIf(NO_GIT)("the git diff provider against real git (§25)", () => {
  it("produces a patch a clean clone accepts with `git apply --check`", async () => {
    const dir = await repo();
    await writeFile(join(dir, "a.txt"), "hi\n", "utf8");

    const { result } = await turn(dir, async () => {
      await writeFile(join(dir, "a.txt"), "hi\nbye\n", "utf8");
      await writeFile(join(dir, "new.txt"), "fresh\n", "utf8");
    });

    expect(result?.source).toBe("git");
    expect(result?.quality).toBe("exact");
    expect(result?.truncated).toBe(false);
    expect(result?.warnings).toEqual([]);
    const text = result?.text ?? "";
    expect(text).toContain("diff --git a/a.txt b/a.txt");
    expect(text).toContain("+bye");
    expect(text).toContain("new file mode");
    // The temp index lives outside every worktree, so it can never appear in a produced patch.
    expect(text).not.toContain("omni-index");

    // A CLEAN CLONE: the before state, in a repository that has never seen our index.
    const clone = await repo();
    await writeFile(join(clone, "a.txt"), "hi\n", "utf8");
    const patchFile = join(tmpdir(), `omni-patch-${String(process.pid)}.diff`);
    await writeFile(patchFile, text, "utf8");
    try {
      const check = await runUtility(
        "git",
        ["--no-pager", "-C", clone, "apply", "--check", patchFile],
        { timeoutMs: GIT_MS },
      );
      expect(check.code).toBe(0);
    } finally {
      await rm(patchFile, { force: true });
    }
  });

  it("respects .gitignore and NEVER writes the operator's own index", async () => {
    const dir = await repo();
    await writeFile(join(dir, ".gitignore"), "*.log\n", "utf8");
    await writeFile(join(dir, "tracked.txt"), "one\n", "utf8");

    const before = await readdir(join(dir, ".git"));
    const { result } = await turn(dir, async () => {
      await writeFile(join(dir, "tracked.txt"), "one\ntwo\n", "utf8");
      await writeFile(join(dir, "noisy.log"), "ignored\n", "utf8");
    });

    expect(result?.text).toContain("tracked.txt");
    // `.gitignore` is respected BY CONSTRUCTION: `add -A` is what reads it.
    expect(result?.text).not.toContain("noisy.log");

    // D8's 不碰用户 index, as a fact about the repository rather than about our argv: the fixture
    // repository has no `.git/index` at all, and it still has none.
    const after = await readdir(join(dir, ".git"));
    expect(after).not.toContain("index");
    expect(after.filter((e) => e !== "objects").sort()).toEqual(
      before.filter((e) => e !== "objects").sort(),
    );
    // …and the worktree the operator can see is untouched: no temp file was left in it.
    const entries = await readdir(dir);
    expect(entries.sort()).toEqual([".git", ".gitignore", "tracked.txt", "noisy.log"].sort());
  });

  it("does NOT execute a planted diff.external, and leaves no temp index behind", async () => {
    const dir = await repo();
    await writeFile(join(dir, "a.txt"), "hi\n", "utf8");

    // The repository's own config asking for an arbitrary program, which is why `--no-ext-diff`
    // is a security flag and not tidiness (§25.2).
    const marker = join(tmpdir(), `omni-ext-diff-ran-${String(process.pid)}`);
    const script = join(dir, "evil.sh");
    await rm(marker, { force: true });
    await writeFile(
      script,
      process.platform === "win32"
        ? `@echo off\r\ntype nul > "${marker}"\r\n`
        : `#!/bin/sh\ntouch "${marker}"\necho "external diff ran"\n`,
      { encoding: "utf8", mode: 0o755 },
    );
    await runUtility("git", ["--no-pager", "-C", dir, "config", "diff.external", script], {
      timeoutMs: GIT_MS,
    });

    const tmpIndexDir = join(tmpdir(), "omni-acp-diff");
    const { result } = await turn(dir, async () => {
      await writeFile(join(dir, "a.txt"), "hi\nbye\n", "utf8");
    });

    expect(result?.text).toContain("+bye");
    await expect(stat(marker)).rejects.toThrow();

    // Definition of done 6: zero temp git index files left behind.
    const leftovers = await readdir(tmpIndexDir).catch(() => [] as string[]);
    expect(leftovers.filter((f) => f.startsWith("omni-index-"))).toEqual([]);
  });

  it("answers patch_repo_changed when a repository appears UNDER the cwd mid-turn (F39)", async () => {
    const parent = await repo();
    const inner = join(parent, "work");
    await mkdir(inner, { recursive: true });
    await writeFile(join(inner, "a.txt"), "hi\n", "utf8");

    const p = provider();
    const handle = await p.begin({ cwd: inner, workerId: WORKER });
    expect(handle).not.toBeNull();
    // codex-acp's observed move: `.git/` created in its own cwd while the turn is running. The
    // top level is now `inner`, not `parent`, and a diff between the two trees would report the
    // whole workspace as added.
    await mkdir(join(inner, ".git", "objects"), { recursive: true });
    await mkdir(join(inner, ".git", "refs", "heads"), { recursive: true });
    await writeFile(join(inner, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
    await writeFile(
      join(inner, ".git", "config"),
      "[core]\n\trepositoryformatversion = 0\n\tbare = false\n",
      "utf8",
    );

    const result = await p.end(handle as PatchHandle);
    expect(result.text).toBeNull();
    expect(result.warnings.map((w) => w.code)).toEqual(["patch_repo_changed"]);
  });

  it("answers patch_not_a_repo outside a repository, even when one appears later", async () => {
    const fixture = await tempNonRepo();
    disposers.push(fixture.dispose);
    await writeFile(join(fixture.dir, "a.txt"), "hi\n", "utf8");

    const p = provider();
    const handle = await p.begin({ cwd: fixture.dir, workerId: WORKER });
    await fixture.initRepo();
    const result = await p.end(handle as PatchHandle);

    expect(result.text).toBeNull();
    expect(result.warnings.map((w) => w.code)).toEqual(["patch_not_a_repo"]);
  });

  it("reports a binary file as git's own line, with no blob content", async () => {
    const dir = await repo();
    const { result } = await turn(dir, async () => {
      await writeFile(join(dir, "blob.bin"), Buffer.from([0, 1, 2, 3, 255, 254]));
    });
    expect(result?.text).toContain("Binary files");
    expect(result?.text).not.toContain("GIT binary patch");
  });

  it("labels two workers on one repository shared_worktree, and names how many", async () => {
    const dir = await repo();
    const sub = join(dir, "packages", "x");
    await mkdir(sub, { recursive: true });
    await writeFile(join(dir, "a.txt"), "hi\n", "utf8");

    const p = provider();
    const a = (await p.begin({ cwd: dir, workerId: WORKER })) as PatchHandle;
    const b = (await p.begin({ cwd: sub, workerId: OTHER })) as PatchHandle;
    await writeFile(join(dir, "a.txt"), "hi\nbye\n", "utf8");

    for (const handle of [a, b]) {
      const result = await p.end(handle);
      expect(result.quality).toBe("shared_worktree");
      expect(result.warnings.map((w) => w.code)).toEqual(["patch_shared_worktree"]);
      expect(result.warnings[0]?.detail).toMatchObject({ workers: 2 });
      // The text is still the disk truth — we REPORT the contamination rather than withhold it.
      expect(result.text).toContain("+bye");
    }
  });

  it("reads the same patch back through a second turn — begin/end are per TURN, not per worker", async () => {
    const dir = await repo();
    await writeFile(join(dir, "a.txt"), "one\n", "utf8");
    const first = await turn(dir, async () => {
      await writeFile(join(dir, "a.txt"), "one\ntwo\n", "utf8");
    });
    expect(first.result?.text).toContain("+two");

    // The SECOND turn's "before" is the first turn's "after": a patch is what THIS turn changed.
    const second = await turn(dir, async () => {
      await writeFile(join(dir, "a.txt"), "one\ntwo\nthree\n", "utf8");
    });
    expect(second.result?.text).toContain("+three");
    expect(second.result?.text).not.toContain("+two");
  });
});
