import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { OmniError } from "@omni-acp/protocol";

/** Part of the on-disk contract: an operator may read it to find out who holds the data dir. */
export const DAEMON_LOCK_FILE = "daemon.lock";

export interface DaemonLockBody {
  readonly pid: number;
  readonly bootId: string;
  readonly startedAt: string;
  readonly hostname: string;
}

export interface DataDirLock {
  release(): Promise<void>;
  /** true ⇒ the previous holder's pid was provably gone and its lock was taken over. */
  brokeStaleLock: boolean;
}

/**
 * Is this pid alive from our point of view?
 *
 * `EPERM` counts as ALIVE: the process exists, it simply belongs to another user, and breaking
 * a lock held by a process we cannot even signal is the one case where being wrong destroys
 * somebody else's log. Everything except a clean `ESRCH` is therefore treated as "still there".
 */
function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * ONE daemon per data dir, lock-enforced (§14.10).
 *
 * Two daemons over one `events.db` is not a sharing problem, it is a `seq` problem: both would
 * assign from their own head. WAL would let both write happily, and the `(worker_id, seq)`
 * primary key would catch it only once the two logs had already forked. The lock names the
 * holder's pid and bootId so a refusal can say WHO, and a stale lock (holder gone) is broken
 * rather than requiring a manual delete — the same shape `ids-file.ts` already uses, for the
 * same reason.
 *
 * Skipped entirely for the memory driver — there is no file to contend for, and
 * `OmniACP.local()` must stay able to run N instances side by side (the M0 integration suite
 * depends on it). The skip lives in `open.ts`, which is the only caller.
 *
 * Owned by M1-WP-A.
 */
export async function acquireDataDirLock(
  dir: string,
  self: { pid: number; bootId: string },
): Promise<DataDirLock> {
  await mkdir(dir, { recursive: true });
  const file = join(dir, DAEMON_LOCK_FILE);

  const body: DaemonLockBody = {
    pid: self.pid,
    bootId: self.bootId,
    startedAt: new Date().toISOString(),
    hostname: hostname(),
  };
  const text = `${JSON.stringify(body, null, 2)}\n`;

  const write = async (flag: "wx" | "w"): Promise<void> => {
    await writeFile(file, text, { encoding: "utf8", flag, mode: 0o600 });
  };

  const release = async (): Promise<void> => {
    // Best effort, and deliberately not fatal: a leftover lock naming a pid that is gone is
    // broken by the next start, so a failed unlink costs a log line and never a startup.
    await rm(file, { force: true }).catch(() => {});
  };

  try {
    await write("wx");
    return { release, brokeStaleLock: false };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
      throw new OmniError("internal", `cannot write the data-dir lock at ${file}`, { cause: e });
    }
  }

  const holder = await readLock(file);

  // Unreadable or truncated: a lock we cannot attribute cannot be honoured — it names nobody to
  // refuse on behalf of — and a half-written file is exactly what a `SIGKILL` mid-write leaves.
  if (holder === null) {
    await write("w");
    return { release, brokeStaleLock: true };
  }

  if (isAlive(holder.pid)) {
    throw new OmniError(
      "internal",
      `data dir ${dir} is already held by pid ${holder.pid} (boot ${holder.bootId}` +
        `${holder.hostname === hostname() ? "" : ` on ${holder.hostname}`}); ` +
        "one daemon per data dir — two would assign seq from two heads and fork every worker's log",
      { detail: { file, holder: { ...holder } } },
    );
  }

  await write("w");
  return { release, brokeStaleLock: true };
}

async function readLock(file: string): Promise<DaemonLockBody | null> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as Partial<DaemonLockBody>;
    if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid)) return null;
    return {
      pid: parsed.pid,
      bootId: typeof parsed.bootId === "string" ? parsed.bootId : "unknown",
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "unknown",
      hostname: typeof parsed.hostname === "string" ? parsed.hostname : "unknown",
    };
  } catch {
    return null;
  }
}
