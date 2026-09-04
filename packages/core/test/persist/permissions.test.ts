import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openPersistence } from "@omni-acp/core";
import { fakeClock, nullLogger } from "@omni-acp/testkit";
import { sqliteConfig } from "./support/harness.js";

/**
 * The event database is the most sensitive thing this daemon writes, so it is the one file whose
 * mode is not left to the driver.
 *
 * `events.db` holds every worker's whole event log: prompt text, agent output, tool-call
 * payloads, `cwd` paths, `sessionId`, `ownerTokenId`. `node:sqlite` creates it — and its `-wal`
 * and `-shm` siblings, which mirror its contents — at 0644 by default, and `mkdir` leaves the
 * directory at 0777 &~umask. That was inconsistent with the posture the rest of the repository
 * takes and states as a rule: the probe cache is 0600/0700 for a *ProbeSummary*, `daemon-id` is
 * 0600, `daemon.lock` is 0600, and CONTRACTS H16 pins the probe cache. The file that actually
 * holds the data must not be the open one.
 *
 * POSIX only: on win32 the mode is advisory and `chmod` is a near-no-op, which is a platform
 * fact rather than a silent failure — the same note `probe-cache.ts` already makes.
 */
const posix = process.platform !== "win32";

/** The file name is part of the on-disk contract (§14.7); `open.ts` is not allowed to move it. */
const EVENTS_DB_FILE = "events.db";
const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

const mode = async (file: string): Promise<number> => (await stat(file)).mode & 0o777;

describe.skipIf(!posix)("the event database is owner-only (§14.7)", () => {
  it("creates events.db at 0600 and its data dir at 0700", async () => {
    const outer = await mkdtemp(join(tmpdir(), "omni-acp-mode-"));
    dirs.push(outer);
    // A dataDir that does NOT exist yet: `mkdir(…, {mode: 0o700})` is the half under test here,
    // and its mode is umask-masked, so the assertion is on what `open.ts` leaves behind.
    const dir = join(outer, "data");
    const handle = await openPersistence({
      dataDir: dir,
      config: sqliteConfig(),
      clock: fakeClock(),
      logger: nullLogger(),
    });
    try {
      expect(await mode(join(dir, EVENTS_DB_FILE))).toBe(0o600);
      expect(await mode(dir)).toBe(0o700);
      // WAL is on, so these two exist and mirror the database's content — a 0600 `events.db`
      // beside a 0644 `events.db-wal` protects nothing.
      expect(await mode(join(dir, `${EVENTS_DB_FILE}-wal`))).toBe(0o600);
      expect(await mode(join(dir, `${EVENTS_DB_FILE}-shm`))).toBe(0o600);
    } finally {
      handle.close();
    }
  });

  it("tightens a data dir that ALREADY exists, which is the case that actually matters", async () => {
    // `mkdir`'s `mode` is masked by the umask and is a no-op on an existing directory, so the
    // `chmod` is the half that bites — every restart after the first lands here.
    const dir = await mkdtemp(join(tmpdir(), "omni-acp-mode-open-"));
    dirs.push(dir);
    await mkdir(dir, { recursive: true, mode: 0o755 }).catch(() => {});
    const handle = await openPersistence({
      dataDir: dir,
      config: sqliteConfig(),
      clock: fakeClock(),
      logger: nullLogger(),
    });
    try {
      expect(await mode(dir)).toBe(0o700);
      expect(await mode(join(dir, EVENTS_DB_FILE))).toBe(0o600);
    } finally {
      handle.close();
    }
  });
});
