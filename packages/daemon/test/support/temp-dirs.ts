import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `mkdtemp` with the cleanup its integration counterpart already has
 * (`tests/integration/src/support/harness.ts`).
 *
 * The daemon's unit suites make a fresh data directory per `beforeEach` — a `dataDir` is not
 * optional for `createDaemon`, and sharing one between cases would let a `daemon-id`, a probe
 * cache or a lock leak from one test into the next. None of them removed it, and the measured
 * cost was ~800 directories per full run: after 29 runs `/tmp` held ~24,000. On a CI runner, or
 * on a dev box with `/tmp` on tmpfs, that is unbounded inode and RAM growth ACROSS runs.
 *
 * The registry is module-local, so a suite that imports this and calls `removeTempRoots()` in an
 * `afterEach` cleans up exactly the directories it made. `realpath` is applied here because every
 * caller wants it: macOS `/var` -> `/private/var` would otherwise make a `cwdRoots` comparison
 * fail on one platform only.
 */
const roots: string[] = [];

export async function tempRoot(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  roots.push(dir);
  return dir;
}

/**
 * Tracks a directory a test made ITSELF, next to one `tempRoot` handed out — the sibling in
 * `auth.test.ts`'s prefix case, which has to be `<root>-evil` and so cannot come from `mkdtemp`.
 * Deliberate and rare on purpose: everything else must come from `tempRoot`, so that cleanup only
 * ever removes paths this module minted.
 */
export function trackTempDir(dir: string): string {
  roots.push(dir);
  return dir;
}

/** Removes every directory `tempRoot` has handed out since the last call. Never throws. */
export async function removeTempRoots(): Promise<void> {
  for (const dir of roots.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
