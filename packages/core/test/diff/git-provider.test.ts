import { afterEach, describe, expect, it } from "vitest";
import { DiffConfig, type PatchHandle, type RunUtility, type WorkerId } from "@omni-acp/protocol";
import { nullLogger, seqIds } from "@omni-acp/testkit";
import { createGitDiffProvider } from "../../src/diff/git-provider.js";
import { truncateAtHunk } from "../../src/diff/git-provider.js";
import { classifyWorktree, normalizeTopLevel } from "../../src/diff/worktrees.js";

/**
 * D8's git provider. Every test in this file runs with NO GIT INSTALLED — the provider reaches
 * git only through the injected `RunUtility`, which is what makes that possible and what
 * `no-direct-spawn` already enforces for `fingerprint.ts`'s `ps`.
 *
 * The REAL-git tier is `git-real.test.ts` beside this file, `skipIf`'d on a machine without one:
 * `git apply --check`, `.gitignore`, the operator's untouched index and the planted
 * `diff.external` are claims about git's behaviour and cannot be made against a fake.
 *
 * Owned by M2-WP-J.
 */

const WORKER = "w_00000000000000000000000001" as WorkerId;
const OTHER = "w_00000000000000000000000002" as WorkerId;
const TOP = "/tmp/omni-fake-repo";

interface Call {
  readonly file: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>> | undefined;
  readonly timeoutMs: number;
}

interface FakeGit {
  readonly run: RunUtility;
  readonly calls: readonly Call[];
  /** The subcommand of each call, in order: `rev-parse`, `add`, `write-tree`, `diff-tree`. */
  verbs(): readonly string[];
}

type Reply = { code: number | null; stdout: string } | Error;

/**
 * A `RunUtility` that answers a script instead of starting a process.
 *
 * It is keyed on the SUBCOMMAND rather than on call order, because the provider's own order is
 * exactly what several of these tests are asserting and a fixture that encoded it would agree
 * with whatever the provider did.
 */
function fakeGit(script: Partial<Record<string, (call: Call, n: number) => Reply>>): FakeGit {
  const calls: Call[] = [];
  const seen = new Map<string, number>();
  const run: RunUtility = (file, args, o) => {
    const call: Call = { file, args: [...args], env: o.env, timeoutMs: o.timeoutMs };
    calls.push(call);
    // `--no-pager -C <dir> <verb> …`
    const verb = args[3] ?? "";
    const n = (seen.get(verb) ?? 0) + 1;
    seen.set(verb, n);
    const reply = script[verb]?.(call, n) ?? { code: 0, stdout: "" };
    return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
  };
  return {
    run,
    calls,
    verbs: () => calls.map((c) => c.args[3] ?? ""),
  };
}

/** The happy path: a repo, a before tree, an after tree, and one patch. */
const PATCH = [
  "diff --git a/a.txt b/a.txt",
  "index 45b983b..f830548 100644",
  "--- a/a.txt",
  "+++ b/a.txt",
  "@@ -1 +1,2 @@",
  " hi",
  "+bye",
  "",
].join("\n");

function happyScript(patch = PATCH): Partial<Record<string, (c: Call, n: number) => Reply>> {
  let tree = 0;
  return {
    "rev-parse": () => ({ code: 0, stdout: `${TOP}\n` }),
    add: () => ({ code: 0, stdout: "" }),
    "write-tree": () => {
      tree += 1;
      return { code: 0, stdout: `${"0".repeat(39)}${String(tree)}\n` };
    },
    "diff-tree": () => ({ code: 0, stdout: patch }),
  };
}

function provider(git: FakeGit, cfg: Partial<Record<string, unknown>> = {}) {
  return createGitDiffProvider({
    run: git.run,
    cfg: DiffConfig.parse({ provider: "git", ...cfg }),
    clock: {
      now: () => 1_000,
      iso: () => "1970-01-01T00:00:01.000Z",
      setTimer: () => ({ cancel() {} }),
    },
    ids: seqIds(),
    logger: nullLogger(),
  });
}

async function oneTurn(
  git: FakeGit,
  cfg: Partial<Record<string, unknown>> = {},
  cwd = TOP,
): Promise<{
  handle: PatchHandle | null;
  result: Awaited<ReturnType<ReturnType<typeof provider>["end"]>> | null;
}> {
  const p = provider(git, cfg);
  const handle = await p.begin({ cwd, workerId: WORKER });
  if (handle === null) return { handle, result: null };
  return { handle, result: await p.end(handle) };
}

describe("createGitDiffProvider (§25, D8)", () => {
  it("reaches git ONLY through the injected RunUtility, with no shell and no command string", async () => {
    const git = fakeGit(happyScript());
    const { result } = await oneTurn(git);

    expect(result?.text).toBe(PATCH);
    expect(result?.source).toBe("git");
    expect(git.calls.length).toBeGreaterThan(0);
    for (const call of git.calls) {
      // One argv, one program, and never a string a shell would re-split.
      expect(call.file).toBe("git");
      expect(call.args.every((a) => typeof a === "string")).toBe(true);
      expect(call.args).not.toContain("-c");
      expect(call.timeoutMs).toBe(15_000);
    }
    // `-C <dir>` is how this package points git at a directory: `RunUtility` was widened for
    // `env` and for nothing else.
    expect(git.calls[0]?.args.slice(0, 3)).toEqual(["--no-pager", "-C", TOP]);
  });

  it("uses GIT_INDEX_FILE on BOTH write-tree calls, outside the worktree, and never on the read-only ones", async () => {
    const git = fakeGit(happyScript());
    await oneTurn(git);

    expect(git.verbs()).toEqual([
      "rev-parse",
      "add",
      "write-tree",
      "rev-parse",
      "add",
      "write-tree",
      "diff-tree",
    ]);

    const indexed = git.calls.filter((c) => c.env?.["GIT_INDEX_FILE"] !== undefined);
    // Two `add -A` calls and two `write-tree` calls — the pair, twice (§25.2, D8).
    expect(indexed.map((c) => c.args[3])).toEqual(["add", "write-tree", "add", "write-tree"]);
    // The `add` and the `write-tree` of one pair share ONE index; the two pairs do not.
    const paths = indexed.map((c) => c.env?.["GIT_INDEX_FILE"] ?? "");
    expect(paths[0]).toBe(paths[1]);
    expect(paths[2]).toBe(paths[3]);
    expect(paths[0]).not.toBe(paths[2]);
    for (const path of paths) {
      expect(path).not.toBe("");
      // OUTSIDE every worktree: a temp index inside one would be swept up by `add -A` and appear
      // in the patch as a change the agent never made.
      expect(path.startsWith(TOP)).toBe(false);
    }
    // `rev-parse` and `diff-tree` read; neither may point git at our index.
    for (const call of git.calls.filter(
      (c) => c.args[3] === "rev-parse" || c.args[3] === "diff-tree",
    )) {
      expect(call.env?.["GIT_INDEX_FILE"]).toBeUndefined();
    }
  });

  it("passes --no-ext-diff / --no-textconv on the diff, and GIT_OPTIONAL_LOCKS=0 everywhere", async () => {
    const git = fakeGit(happyScript());
    await oneTurn(git);

    const diff = git.calls.find((c) => c.args[3] === "diff-tree");
    expect(diff?.args).toContain("--no-ext-diff");
    expect(diff?.args).toContain("--no-textconv");
    // Never `--binary`: a binary file comes back as git's own "Binary files … differ" line and
    // no blob content is smuggled into a patch.
    expect(diff?.args).not.toContain("--binary");
    for (const call of git.calls) {
      expect(call.env?.["GIT_OPTIONAL_LOCKS"]).toBe("0");
      expect(call.env?.["GIT_TERMINAL_PROMPT"]).toBe("0");
      expect(call.env?.["GIT_PAGER"]).toBe("cat");
      expect(call.env?.["LC_ALL"]).toBe("C");
    }
  });

  it("is null OUTSIDE a repo, and says so", async () => {
    const git = fakeGit({
      "rev-parse": () => ({ code: 128, stdout: "" }),
    });
    const { result } = await oneTurn(git, {}, "/tmp/not-a-repo");
    expect(result?.text).toBeNull();
    expect(result?.quality).toBe("unavailable");
    expect(result?.warnings.map((w) => w.code)).toEqual(["patch_not_a_repo"]);
    expect(result?.warnings[0]?.source).toBe("patch");
    // The honest null still costs ONE git call, and no tree was ever written.
    expect(git.verbs()).toEqual(["rev-parse"]);
  });

  it("is null when git itself cannot be run", async () => {
    const git = fakeGit({ "rev-parse": () => new Error("spawn git ENOENT") });
    const { result } = await oneTurn(git);
    expect(result?.text).toBeNull();
    expect(result?.warnings.map((w) => w.code)).toEqual(["patch_git_missing"]);
  });

  it("is null when the agent created .git/ MID-SESSION (F39), never a garbage diff", async () => {
    // codex-acp's OBSERVED behaviour: the cwd is not a repository at `begin` and is one at `end`.
    let seen = 0;
    const git = fakeGit({
      "rev-parse": () => {
        seen += 1;
        return seen === 1 ? { code: 128, stdout: "" } : { code: 0, stdout: `${TOP}\n` };
      },
    });
    const { result } = await oneTurn(git);
    // `begin` already knew there was no repository, so the answer is that — and never a diff of
    // the whole workspace against nothing.
    expect(result?.text).toBeNull();
    expect(result?.warnings.map((w) => w.code)).toEqual(["patch_not_a_repo"]);
    expect(git.verbs()).not.toContain("diff-tree");
  });

  it("is null when the repository MOVED between begin and end", async () => {
    let seen = 0;
    const git = fakeGit({
      ...happyScript(),
      "rev-parse": () => {
        seen += 1;
        return { code: 0, stdout: seen === 1 ? `${TOP}\n` : "/tmp/somewhere-else\n" };
      },
    });
    const { result } = await oneTurn(git);
    expect(result?.text).toBeNull();
    expect(result?.warnings.map((w) => w.code)).toEqual(["patch_repo_changed"]);
    expect(result?.warnings[0]?.detail).toMatchObject({ before: TOP });
  });

  it("is null when write-tree fails, and when diff-tree fails, each with its own warning", async () => {
    const noTree = fakeGit({
      ...happyScript(),
      "write-tree": () => ({ code: 128, stdout: "" }),
    });
    expect((await oneTurn(noTree)).result?.warnings.map((w) => w.code)).toEqual([
      "patch_write_tree_failed",
    ]);

    const noDiff = fakeGit({
      ...happyScript(),
      "diff-tree": () => ({ code: 129, stdout: "" }),
    });
    const failed = await oneTurn(noDiff);
    expect(failed.result?.text).toBeNull();
    expect(failed.result?.warnings.map((w) => w.code)).toEqual(["patch_diff_failed"]);
  });

  it("truncates at a hunk boundary over diff.maxBytes, and is null when not even one hunk fits", async () => {
    const two = [
      "diff --git a/a.txt b/a.txt",
      "@@ -1 +1,2 @@",
      " hi",
      "+bye",
      "diff --git a/b.txt b/b.txt",
      "@@ -1 +1,2 @@",
      " ho",
      "+hum",
      "",
    ].join("\n");
    const first = two.indexOf("diff --git a/b.txt");

    const git = fakeGit(happyScript(two));
    const { result } = await oneTurn(git, { maxBytes: first + 4 });
    expect(result?.truncated).toBe(true);
    expect(result?.text).toBe(two.slice(0, first));
    // A truncated patch is not an EXACT one however it is labelled: `git apply` would reject the
    // fragment, so the quality says so and the warning names the bytes.
    expect(result?.quality).toBe("unavailable");
    expect(result?.warnings.map((w) => w.code)).toEqual(["patch_truncated"]);
    expect(result?.warnings[0]?.detail).toMatchObject({ maxBytes: first + 4 });

    const tiny = await oneTurn(fakeGit(happyScript(two)), { maxBytes: 8 });
    expect(tiny.result?.text).toBeNull();
    expect(tiny.result?.truncated).toBe(true);
    expect(tiny.result?.warnings.map((w) => w.code)).toEqual(["patch_truncated"]);
  });

  it("reports shared_worktree while two workers hold a handle on one repo, and exact otherwise", async () => {
    const git = fakeGit(happyScript());
    const p = provider(git);

    const a = await p.begin({ cwd: TOP, workerId: WORKER });
    const b = await p.begin({ cwd: `${TOP}/packages/x`, workerId: OTHER });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();

    const first = await p.end(a as PatchHandle);
    const second = await p.end(b as PatchHandle);
    for (const result of [first, second]) {
      expect(result.quality).toBe("shared_worktree");
      expect(result.warnings.map((w) => w.code)).toEqual(["patch_shared_worktree"]);
      expect(result.warnings[0]?.detail).toMatchObject({ workers: 2 });
      // REPORTED, never withheld: the text is still the honest disk truth.
      expect(result.text).toBe(PATCH);
    }

    // A single worker, alone on the repository, is `exact` with no warning.
    const alone = await oneTurn(fakeGit(happyScript()));
    expect(alone.result?.quality).toBe("exact");
    expect(alone.result?.warnings).toEqual([]);
  });

  it('runs no git at all under diff.mode:"off", and answers a null handle', async () => {
    const git = fakeGit(happyScript());
    const p = provider(git, { mode: "off" });
    expect(await p.begin({ cwd: TOP, workerId: WORKER })).toBeNull();
    expect(git.calls).toEqual([]);
  });

  it("agrees between mode on_write and mode always, and runs no diff when nothing changed", async () => {
    // The two trees are EQUAL, which is "this turn wrote nothing" answered on disk truth rather
    // than on the agent's own report — F38 records codex under-reporting exactly that.
    const script = {
      "rev-parse": () => ({ code: 0, stdout: `${TOP}\n` }),
      add: () => ({ code: 0, stdout: "" }),
      "write-tree": () => ({ code: 0, stdout: `${"0".repeat(40)}\n` }),
      "diff-tree": () => ({ code: 0, stdout: "SHOULD NOT RUN" }),
    };
    for (const mode of ["on_write", "always"] as const) {
      const git = fakeGit(script);
      const { result } = await oneTurn(git, { mode });
      expect(result?.text).toBe("");
      expect(result?.source).toBe("git");
      expect(result?.quality).toBe("exact");
      expect(git.verbs()).not.toContain("diff-tree");
    }
  });

  it("never throws: an unknown handle, a double end and abandon are all answers", async () => {
    const git = fakeGit(happyScript());
    const p = provider(git);
    const handle = (await p.begin({ cwd: TOP, workerId: WORKER })) as PatchHandle;

    expect((await p.end(handle)).text).toBe(PATCH);
    // The second `end` has no state left; it says so rather than diffing something else.
    const again = await p.end(handle);
    expect(again.text).toBeNull();
    expect(again.warnings.map((w) => w.code)).toEqual(["patch_diff_failed"]);

    expect(() => {
      p.abandon(handle);
    }).not.toThrow();
    expect(() => {
      p.abandon({ topLevel: "", indexFile: "", tree: "", startedAtMs: 0 });
    }).not.toThrow();
  });

  it("abandon drops the handle, so a turn that dies leaves no live worktree claim", async () => {
    const git = fakeGit(happyScript());
    const p = provider(git);
    const a = (await p.begin({ cwd: TOP, workerId: WORKER })) as PatchHandle;
    p.abandon(a);

    const b = (await p.begin({ cwd: TOP, workerId: OTHER })) as PatchHandle;
    // The abandoned worker is gone, so the survivor is alone and its patch is `exact`.
    expect((await p.end(b)).quality).toBe("exact");
  });
});

describe("truncateAtHunk", () => {
  const text = [
    "diff --git a/a b/a",
    "@@ -1 +1 @@",
    "-x",
    "+y",
    "diff --git a/b b/b",
    "@@ -1 +1 @@",
    "-p",
    "+q",
    "",
  ].join("\n");

  it("returns -1 when nothing has to be cut", () => {
    expect(truncateAtHunk(text, Buffer.byteLength(text, "utf8"))).toBe(-1);
  });

  it("cuts on a `diff --git` or `@@` line and never inside a hunk", () => {
    for (const max of [20, 30, 40, 50, 60, 70]) {
      const cut = truncateAtHunk(text, max);
      if (cut === 0) continue;
      expect(cut).toBeLessThanOrEqual(max);
      const kept = text.slice(0, cut);
      expect(kept.endsWith("\n")).toBe(true);
      const next = text.slice(cut).split("\n")[0] ?? "";
      expect(next.startsWith("diff --git ") || next.startsWith("@@ ")).toBe(true);
    }
  });

  it("returns 0 when not even the first hunk fits", () => {
    expect(truncateAtHunk(text, 5)).toBe(0);
  });
});

describe("normalizeTopLevel — the ONE normalization §25.4 allows", () => {
  const platform = process.platform;
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
  });

  it("case-folds on win32 and NEVER on posix, because `/Repo` and `/repo` are two directories there", () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    expect(normalizeTopLevel("C:\\Repo")).toBe(normalizeTopLevel("c:\\repo"));

    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    expect(normalizeTopLevel("/Repo")).not.toBe(normalizeTopLevel("/repo"));
  });

  it("resolves a relative path, so two spellings of one directory key as one", () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    expect(normalizeTopLevel("/repo/packages/..")).toBe(normalizeTopLevel("/repo"));
  });
});

describe("classifyWorktree (§25.4)", () => {
  it("counts a cwd INSIDE the top level as sharing it, and an unrelated one as not", () => {
    expect(classifyWorktree("/repo", [])).toBe("exact");
    expect(classifyWorktree("/repo", ["/repo"])).toBe("shared_worktree");
    expect(classifyWorktree("/repo", ["/repo/packages/x"])).toBe("shared_worktree");
    expect(classifyWorktree("/repo", ["/other"])).toBe("exact");
    // A sibling whose name merely STARTS with the top level is not inside it — the check is a
    // path containment, not a string prefix.
    expect(classifyWorktree("/repo", ["/repository"])).toBe("exact");
  });
});
