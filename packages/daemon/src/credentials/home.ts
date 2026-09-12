import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  readdir,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { OmniError, type HomeManager, type Logger, type WorkerId } from "@omni-acp/protocol";
import { DIR_MODE, FILE_MODE, homeDir, homesRoot, segment } from "./paths.js";

/**
 * Per-worker home directories — `<dataDir>/homes/<workerId>`, mode 0700.
 *
 * E7 is why this is its own object rather than three lines inside the store: the agent's OWN
 * session files live in the home (claude writes `projects/`, `sessions/`, `.claude.json` and
 * `backups/`; codex writes `sessions/`, `thread_history_1.sqlite` and a dozen more sqlite files),
 * so a hibernate, a wake and a restart must all reuse the SAME directory while the credential
 * inside it may change under them. One object owns the directory's lifetime; the store owns the
 * credential's content; nothing owns both.
 *
 * ── The link, and why it is a link ──────────────────────────────────────────────────────────────
 *
 * E3 is the fact that decides this: the agent REFRESHES its own token, so the credential file is
 * not read-only data. Two workers sharing one home would race on the same file; two workers with
 * independent COPIES would each refresh their own and diverge from the source within hours. A
 * SYMLINK per home at one canonical file gives both properties at once — every worker reads the
 * newest token, and whichever worker refreshes it writes through to the file all the others read.
 *
 * The ladder is symlink → hardlink → copy, and it is a ladder because Windows is real: an
 * unprivileged process there cannot create a symlink unless Developer Mode is on, a hard link
 * works on NTFS within one volume, and a copy always works. The MODE IS REPORTED rather than
 * assumed, because a copy does NOT get the refresh-through property and an operator must be able
 * to tell that this daemon is running in the degraded shape (§6.6's honesty rule, applied to
 * something other than a process for once).
 */
export interface HomeManagerOptions {
  readonly dataDir: string;
  readonly logger?: Logger;
}

/**
 * A link is replaced by writing beside it and RENAMING over it, never by unlink-then-create.
 *
 * The window in unlink-then-create is a live agent reading `<home>/auth.json` and finding nothing
 * there — which on codex-acp is a `-32000 Authentication required` for a credential that was
 * perfectly fine a millisecond earlier, and on claude-acp (which re-reads the file per request,
 * measured) is the same thing on the very next prompt. `rename` over an existing path is atomic on
 * POSIX and on NTFS, so there is no such instant.
 */
async function placeLink(
  target: string,
  at: string,
  mode: "symlink" | "hardlink" | "copy",
): Promise<void> {
  const temp = `${at}.omni-${String(process.pid)}-${Date.now().toString(36)}`;
  try {
    if (mode === "symlink") await symlink(target, temp);
    else if (mode === "hardlink") await link(target, temp);
    else {
      await copyFile(target, temp);
      // Only the COPY carries a mode of its own; a symlink's mode is meaningless and a hard link
      // shares the target's inode (and therefore the store's own 0600).
      await chmod(temp, FILE_MODE).catch(() => {});
    }
    await rename(temp, at);
  } catch (e) {
    await rm(temp, { force: true }).catch(() => {});
    throw e;
  }
}

export function createHomeManager(o: HomeManagerOptions): HomeManager {
  const logger = o.logger;

  return {
    async create(workerId: WorkerId): Promise<string> {
      const dir = homeDir(o.dataDir, workerId);
      // `recursive: true` so an adopted home (a wake, a restart, a rehydrated worker) is a no-op
      // rather than an `EEXIST` — reusing the directory IS the contract (E7). `mkdir`'s mode is
      // umask-masked and is not applied to a pre-existing directory, so the `chmod` is the half
      // that actually bites; it is the same posture `create-daemon.ts` takes on the data dir.
      await mkdir(dir, { recursive: true, mode: DIR_MODE });
      await chmod(dir, DIR_MODE).catch(() => {});
      return dir;
    },

    async link(spec): Promise<{
      readonly mode: "symlink" | "hardlink" | "copy";
      readonly files: readonly string[];
    }> {
      const placed: string[] = [];
      // ONE mode for the whole home, decided by the FIRST file that succeeds. A home with one
      // symlink and one copy is a home whose refresh behaviour depends on which file the agent
      // happened to rewrite, which is exactly the kind of thing nobody would ever debug.
      let mode: "symlink" | "hardlink" | "copy" | null = null;

      for (const file of spec.files) {
        // The file name is the descriptor's, not the client's — but it is joined onto a directory
        // we own, so it goes through the same segment rule everything else does. A descriptor
        // naming `../../.ssh/id_rsa` would otherwise write outside the home.
        const at = join(spec.home, segment(file));
        const target = join(spec.sourceDir, segment(file));

        const ladder: ("symlink" | "hardlink" | "copy")[] =
          mode === null ? ["symlink", "hardlink", "copy"] : [mode];
        let lastError: unknown = null;
        let done = false;
        for (const attempt of ladder) {
          try {
            await placeLink(target, at, attempt);
            mode = attempt;
            placed.push(file);
            done = true;
            break;
          } catch (e) {
            lastError = e;
          }
        }
        if (!done) {
          throw new OmniError(
            "internal",
            `could not place the credential file ${JSON.stringify(file)} into this worker's home`,
            { cause: lastError, detail: { file, home: spec.home } },
          );
        }
      }

      if (mode === "copy") {
        // Reported, not silent. A copy does not carry the agent's own token refresh back to the
        // canonical file, so the credential in this home will DIVERGE from the store (E3) — an
        // operator has to be able to see that in a log line rather than discover it as "the other
        // workers stopped working".
        logger?.warn("this filesystem allows neither a symlink nor a hard link", {
          home: spec.home,
          consequence: "credential files are COPIES; an agent's token refresh will not write back",
        });
      }
      return { mode: mode ?? "symlink", files: placed };
    },

    async unlink(spec): Promise<void> {
      // The credential files ONLY. Everything else in the home is the agent's own session state
      // (E7), and a `setCredential` that swept it would silently destroy the conversation the
      // whole home exists to preserve.
      for (const file of spec.files) {
        await rm(join(spec.home, segment(file)), { force: true }).catch(() => {});
      }
    },

    async remove(workerId: WorkerId): Promise<void> {
      await rm(homeDir(o.dataDir, workerId), { recursive: true, force: true });
    },

    /**
     * Homes on disk that belong to no worker row, snapshotted ONCE at boot.
     *
     * THE RACE THIS CLOSES, found by the real-agent acceptance run: a home is created BEFORE the
     * agent is spawned, and the worker only enters the registry once its handshake has returned —
     * so for the whole of a ~7 s `npx` cold start there is a home with no row. A sweep that treated
     * "no row" as "orphan" deleted a LIVE worker's credential link mid-create, and the worker then
     * failed to authenticate on its next request with nothing in the log connecting the two.
     *
     * Taking the set once, before any worker of this boot can be mid-create, makes the distinction
     * structural rather than a timing guess.
     */
    async orphansAtBoot(rows): Promise<ReadonlySet<WorkerId>> {
      const known = new Set([...rows].map((id) => segment(id)));
      const orphans = new Set<WorkerId>();
      try {
        for (const entry of await readdir(homesRoot(o.dataDir), { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          if (!known.has(entry.name)) orphans.add(entry.name as WorkerId);
        }
      } catch {
        // No homes directory is the normal state of a daemon that has never isolated a home.
      }
      if (orphans.size > 0) {
        logger?.info("worker homes from a previous boot belong to no row", { count: orphans.size });
      }
      return orphans;
    },

    /**
     * The retention sweep (§Home 隔离: home 随 worker 记录保留，close + retention 后删除).
     *
     * TWO sources, and neither is "I have not heard of it": a home whose worker CLOSED longer ago
     * than `homeRetentionDays`, and a home `orphansAtBoot` already established belongs to no row.
     * Anything else is LEFT ALONE — see `orphansAtBoot` for the create-window race that rule
     * exists to close.
     *
     * A home in `keep` is never touched, whatever the other two say: `keep` is every row that still
     * exists, hibernated ones included, and those may sleep for a month before waking into the
     * session files the directory holds (E7).
     */
    async sweep(spec): Promise<{ readonly removed: readonly WorkerId[] }> {
      let entries: string[];
      try {
        entries = (await readdir(homesRoot(o.dataDir), { withFileTypes: true }))
          .filter((e) => e.isDirectory())
          .map((e) => e.name);
      } catch {
        // No homes directory yet is the normal state of a daemon that has never isolated a home.
        return { removed: [] };
      }

      const cutoff = spec.nowMs - spec.retentionDays * 86_400_000;
      const removed: WorkerId[] = [];
      // Every index is by SEGMENT, because that is what a directory name is: a worker id that
      // needed hex-encoding would never match a raw comparison.
      const keep = new Set([...spec.keep].map((id) => segment(id)));
      const closedAt = new Map([...spec.closedAtMs].map(([id, ms]) => [segment(id), ms]));
      const orphans = new Set([...spec.orphans].map((id) => segment(id)));

      for (const entry of entries) {
        if (keep.has(entry)) continue;
        const closed = closedAt.get(entry);
        const retired = closed !== undefined && closed <= cutoff;
        if (!retired && !orphans.has(entry)) continue;
        try {
          await rm(join(homesRoot(o.dataDir), entry), { recursive: true, force: true });
          removed.push(entry as WorkerId);
        } catch (e) {
          logger?.warn("removing a retired worker home failed", { home: entry, error: String(e) });
        }
      }
      return { removed };
    },
  };
}

/**
 * Whether `<home>/<file>` is a SYMLINK, and where it points. Test-only, and exported because the
 * acceptance asserts the link rather than the file's contents: "两个 worker 各自 home，凭据软链同
 * 一规范文件" is a claim about the filesystem, and reading both files and comparing bytes would
 * pass just as happily for two copies.
 */
export async function linkTargetOf(home: string, file: string): Promise<string | null> {
  try {
    const stat = await lstat(join(home, segment(file)));
    if (!stat.isSymbolicLink()) return null;
    const { readlink } = await import("node:fs/promises");
    return await readlink(join(home, segment(file)));
  } catch {
    return null;
  }
}
