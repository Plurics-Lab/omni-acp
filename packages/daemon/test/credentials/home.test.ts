import { chmod, lstat, mkdir, readFile, readdir, readlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nullLogger } from "@omni-acp/testkit";
import type { WorkerId } from "@omni-acp/protocol";
import { createHomeManager, linkTargetOf } from "../../src/credentials/home.js";
import { homeDir } from "../../src/credentials/paths.js";
import { removeTempRoots, tempRoot } from "../support/temp-dirs.js";

/**
 * The home manager (docs/M3-WP1-CREDENTIALS.md §Home 隔离).
 *
 * Two claims, and both are asserted on the FILESYSTEM because both ARE the filesystem:
 *
 *  1. THE LINK IS A LINK. E3 is the fact that decides it — the agent refreshes its own token —
 *     so a copy would diverge from the canonical file within hours while a symlink writes through.
 *     `readlink` is the assertion; comparing the two files' bytes would pass just as happily for
 *     two copies, which is exactly the bug this exists to prevent.
 *  2. A RELINK NEVER LEAVES A GAP. `rename` over the existing path, never unlink-then-create: the
 *     window in the second is a live agent reading `<home>/auth.json` and finding nothing there,
 *     which on codex-acp is `-32000 Authentication required` for a credential that was fine a
 *     millisecond earlier.
 *
 * Owned by M3-WP1.
 */

const W = (n: string): WorkerId => `w_${n.padStart(26, "0")}` as WorkerId;

interface Rig {
  readonly dataDir: string;
  readonly homes: ReturnType<typeof createHomeManager>;
  /** A store-shaped source directory holding one credential file. */
  source(name: string, files: Record<string, string>): Promise<string>;
}

async function rig(): Promise<Rig> {
  const root = await tempRoot("omni-homes-");
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  const homes = createHomeManager({ dataDir, logger: nullLogger() });
  return {
    dataDir,
    homes,
    async source(name, files): Promise<string> {
      const dir = join(dataDir, "credentials", "t", "agent", name, "files");
      await mkdir(dir, { recursive: true, mode: 0o700 });
      for (const [file, content] of Object.entries(files)) {
        await writeFile(join(dir, file), content, { mode: 0o600 });
      }
      return dir;
    },
  };
}

const mode = async (path: string): Promise<string> =>
  ((await lstat(path)).mode & 0o777).toString(8);

afterEach(async () => {
  await removeTempRoots();
});

describe("createHomeManager.create", () => {
  it("makes <dataDir>/homes/<workerId> at 0700, and ADOPTS an existing one", async () => {
    const r = await rig();
    const home = await r.homes.create(W("1"));
    expect(home).toBe(homeDir(r.dataDir, W("1")));
    expect(await mode(home)).toBe("700");
    expect(await mode(join(r.dataDir, "homes"))).toBe("700");

    // E7: the agent's OWN session files live in here (claude writes `projects/`, codex writes
    // `thread_history_1.sqlite`), so a wake and a restart must reuse the SAME directory. `create`
    // is therefore idempotent by contract rather than by luck.
    await writeFile(join(home, "session-state"), "the conversation");
    expect(await r.homes.create(W("1"))).toBe(home);
    expect(await readFile(join(home, "session-state"), "utf8")).toBe("the conversation");
  });

  it("restores 0700 on a directory somebody else created at 0755", async () => {
    const r = await rig();
    const home = homeDir(r.dataDir, W("2"));
    await mkdir(home, { recursive: true, mode: 0o755 });
    await chmod(home, 0o755);
    // `mkdir`'s mode is not applied to a pre-existing directory, so the `chmod` is the half that
    // actually bites — and a 0755 home is a credential another local account can read.
    await r.homes.create(W("2"));
    expect(await mode(home)).toBe("700");
  });
});

describe("createHomeManager.link — a LINK, not a copy (E3)", () => {
  it("symlinks every declared file at the store's canonical path", async () => {
    const r = await rig();
    const source = await r.source("default", { "auth.json": '{"auth_mode":"chatgpt"}' });
    const home = await r.homes.create(W("3"));

    const linked = await r.homes.link({ home, files: ["auth.json"], sourceDir: source });
    expect(linked).toEqual({ mode: "symlink", files: ["auth.json"] });

    // THE ASSERTION IS `readlink`. Two workers' homes both pointing at one canonical file is the
    // whole design: whichever of them the agent refreshes writes THROUGH to the file the other
    // one reads (E3), and a byte comparison could not tell that from two independent copies.
    expect(await readlink(join(home, "auth.json"))).toBe(join(source, "auth.json"));
    expect(await linkTargetOf(home, "auth.json")).toBe(join(source, "auth.json"));

    // And a write through the link lands in the STORE, which is the property in one line.
    await writeFile(join(home, "auth.json"), '{"auth_mode":"chatgpt","refreshed":true}');
    expect(await readFile(join(source, "auth.json"), "utf8")).toContain("refreshed");
  });

  it("gives two homes the SAME canonical target (acceptance 1's link half)", async () => {
    const r = await rig();
    const source = await r.source("default", { ".credentials.json": "{}" });
    const first = await r.homes.create(W("4"));
    const second = await r.homes.create(W("5"));
    for (const home of [first, second]) {
      await r.homes.link({ home, files: [".credentials.json"], sourceDir: source });
    }
    expect(first).not.toBe(second);
    expect(await readlink(join(first, ".credentials.json"))).toBe(
      await readlink(join(second, ".credentials.json")),
    );
  });

  it("replaces an existing link by RENAME, with no instant in which the file is absent", async () => {
    const r = await rig();
    const one = await r.source("one", { "auth.json": '{"which":"one"}' });
    const two = await r.source("two", { "auth.json": '{"which":"two"}' });
    const home = await r.homes.create(W("6"));

    await r.homes.link({ home, files: ["auth.json"], sourceDir: one });
    expect(await readFile(join(home, "auth.json"), "utf8")).toContain("one");

    // The relink. There is no unlink-then-create here, which is what the temp-and-rename shape in
    // `placeLink` is for — and the observable consequence is that the home NEVER contains a
    // half-written file and never contains none.
    await r.homes.link({ home, files: ["auth.json"], sourceDir: two });
    expect(await readlink(join(home, "auth.json"))).toBe(join(two, "auth.json"));
    expect(await readFile(join(home, "auth.json"), "utf8")).toContain("two");
    // No temp files left behind on the success path either.
    expect(await readdir(home)).toEqual(["auth.json"]);
  });

  it("reports the failure rather than leaving a half-linked home", async () => {
    const r = await rig();
    const home = await r.homes.create(W("7"));
    // A source that does not exist: a symlink would succeed (symlinks may dangle) but a hardlink
    // and a copy would not — so this asserts the SYMLINK rung's behaviour honestly, which is that
    // a dangling link is created and the agent will fail to authenticate. The manager's job is not
    // to validate the store's contents; the store's `resolveFor` is what refuses a missing
    // credential, with a `422` and before anything spawns.
    const linked = await r.homes.link({
      home,
      files: ["auth.json"],
      sourceDir: join(r.dataDir, "nope"),
    });
    expect(linked.mode).toBe("symlink");
    expect(await readlink(join(home, "auth.json"))).toContain("nope");
  });
});

describe("createHomeManager.unlink — the credential files ONLY (E7)", () => {
  it("removes the linked credential and leaves the agent's session state untouched", async () => {
    const r = await rig();
    const source = await r.source("default", { "auth.json": "{}" });
    const home = await r.homes.create(W("8"));
    await r.homes.link({ home, files: ["auth.json"], sourceDir: source });
    // The agent's own state, which is what E7 is about and what a `setCredential` must never
    // touch: destroying it would silently discard the conversation the home exists to preserve.
    await mkdir(join(home, "sessions"), { recursive: true });
    await writeFile(join(home, "sessions", "abc.jsonl"), "the conversation");

    await r.homes.unlink({ home, files: ["auth.json"] });
    expect(await readdir(home)).toEqual(["sessions"]);
    expect(await readFile(join(home, "sessions", "abc.jsonl"), "utf8")).toBe("the conversation");
    // And the STORE's copy is still there: `unlink` removes the link, never its target.
    expect(await readFile(join(source, "auth.json"), "utf8")).toBe("{}");
  });

  it("is a no-op for a file that is not there", async () => {
    const r = await rig();
    const home = await r.homes.create(W("9"));
    await expect(r.homes.unlink({ home, files: ["auth.json"] })).resolves.toBeUndefined();
  });
});

describe("createHomeManager.sweep — §Home 隔离's retention", () => {
  it("keeps a LIVE worker's home whatever its age, including a hibernated one", async () => {
    const r = await rig();
    const live = await r.homes.create(W("a"));
    const asleep = await r.homes.create(W("b"));
    const swept = await r.homes.sweep({
      nowMs: 10 * 86_400_000,
      retentionDays: 1,
      // A hibernated worker owns no process and may sleep for a month before waking into the
      // session files this directory holds (E7) — so `keep` is every row that still EXISTS, not
      // every row that is running.
      keep: new Set([W("a"), W("b")]),
      closedAtMs: new Map(),
    });
    expect(swept.removed).toEqual([]);
    expect(await readdir(live)).toEqual([]);
    expect(await readdir(asleep)).toEqual([]);
  });

  it("removes a CLOSED worker's home once it is older than retentionDays", async () => {
    const r = await rig();
    await r.homes.create(W("c"));
    await r.homes.create(W("d"));
    const now = 10 * 86_400_000;
    const swept = await r.homes.sweep({
      nowMs: now,
      retentionDays: 1,
      keep: new Set(),
      closedAtMs: new Map([
        // Closed two days ago: gone.
        [W("c"), now - 2 * 86_400_000],
        // Closed an hour ago: kept, so a post-mortem can still read the agent's own session
        // files, which is what the retention window is FOR.
        [W("d"), now - 3_600_000],
      ]),
    });
    expect(swept.removed).toEqual([W("c")]);
    expect(await readdir(join(r.dataDir, "homes"))).toEqual([W("d")]);
  });

  it("removes a home whose worker row is GONE ENTIRELY, immediately", async () => {
    const r = await rig();
    await r.homes.create(W("e"));
    // This is the rule that matters over months: the event-log retention sweep drops the ROW, and
    // without this line `<dataDir>/homes` would grow forever with directories nothing in the
    // daemon ever looks at again.
    const swept = await r.homes.sweep({
      nowMs: 0,
      retentionDays: 7,
      keep: new Set(),
      closedAtMs: new Map(),
    });
    expect(swept.removed).toEqual([W("e")]);
    expect(await readdir(join(r.dataDir, "homes"))).toEqual([]);
  });

  it("answers an empty sweep when no home has ever been made", async () => {
    const r = await rig();
    // A daemon that has never isolated a home has no `homes/` directory, which is the normal state
    // of an M2 config and must not be an error on a timer.
    expect(
      await r.homes.sweep({ nowMs: 0, retentionDays: 1, keep: new Set(), closedAtMs: new Map() }),
    ).toEqual({ removed: [] });
  });
});

describe("createHomeManager.remove", () => {
  it("takes the whole home, including what the agent wrote", async () => {
    const r = await rig();
    const home = await r.homes.create(W("f"));
    await mkdir(join(home, "projects", "deep"), { recursive: true });
    await writeFile(join(home, "projects", "deep", "x.jsonl"), "x");
    await r.homes.remove(W("f"));
    await expect(lstat(home)).rejects.toThrow();
    // Idempotent: a retention sweep and a close can both reach it.
    await expect(r.homes.remove(W("f"))).resolves.toBeUndefined();
  });
});
