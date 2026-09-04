import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Logger, type ProbeSummary } from "@omni-acp/protocol";

/**
 * `<dataDir>/probes/<id>.json`, mode `0600`, invalidated by the DESCRIPTOR FINGERPRINT
 * (CONTRACTS.md §17.4, H16).
 *
 * The fingerprint is the invalidation key rather than a TTL alone, because the thing a cached
 * probe describes is a specific command ⊕ args ⊕ agent version — change any of them and the
 * cached capabilities are a claim about a program that is no longer there.
 *
 * Owned by M1-WP-E.
 */
export interface ProbeCache {
  read(agentId: string): Promise<ProbeSummary | null>;
  write(agentId: string, p: ProbeSummary): Promise<void>;
  /** Forget one agent's cached probe. Used by `force`, and by a fingerprint that no longer matches. */
  drop(agentId: string): Promise<void>;
  /** The file this agent's probe lives in — published in no API, useful in a log line and a test. */
  fileFor(agentId: string): string;
}

/**
 * Owner-only, on the file AND on the directory.
 *
 * A `ProbeSummary` carries an agent's capability block and, on some agents, its `_meta` — not a
 * credential, but not something a multi-user box's other accounts have any business reading
 * either. `0600`/`0700` is the same posture `ids-file.ts` takes, for the same reason. On Windows
 * the mode is advisory and `chmod` is a near-no-op; that is a platform fact, not a silent
 * failure, and it is why the write also uses an exclusive-ish rename rather than relying on the
 * mode alone.
 */
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/**
 * A file name that is always inside `<dataDir>/probes/` and always maps 1:1 to an agent id.
 *
 * Agent ids come from operator config and are otherwise unconstrained, so `<id>.json` alone
 * would let `id: "../../etc/cron.d/x"` write outside the data directory. Ordinary ids keep the
 * literal `<id>.json` shape §17.4 names; anything else is hex-encoded, which is reversible,
 * collision-free and obviously not a path.
 */
function fileNameFor(agentId: string): string {
  const plain = /^[A-Za-z0-9._-]{1,64}$/.test(agentId) && agentId !== "." && agentId !== "..";
  return plain ? `${agentId}.json` : `x-${Buffer.from(agentId, "utf8").toString("hex")}.json`;
}

interface CacheFile {
  /** The on-disk format's own version, so a future field is not read as if it were this one. */
  readonly v: 1;
  readonly probe: ProbeSummary;
}

export function createProbeCache(o: { dataDir: string; logger?: Logger }): ProbeCache {
  const dir = join(o.dataDir, "probes");
  const logger = o.logger;

  const fileFor = (agentId: string): string => join(dir, fileNameFor(agentId));

  return {
    fileFor,

    async read(agentId): Promise<ProbeSummary | null> {
      let raw: string;
      try {
        raw = await readFile(fileFor(agentId), "utf8");
      } catch {
        // A missing cache is the normal state, not a fault: `probed` is `null` until probed (H4).
        return null;
      }
      try {
        const parsed = JSON.parse(raw) as CacheFile;
        if (parsed.v !== 1 || typeof parsed.probe !== "object" || parsed.probe === null)
          return null;
        // `agentId` is re-checked rather than trusted: a hex-encoded name is reversible, and a
        // file copied between data dirs must not be served for the wrong agent.
        if (parsed.probe.agentId !== agentId) return null;
        return parsed.probe;
      } catch {
        // A truncated or hand-edited file is a cache miss, never a startup failure — the worst a
        // corrupt probe cache may cost is one re-probe.
        logger?.warn("probe cache: unreadable entry, re-probing", { agentId });
        return null;
      }
    },

    async write(agentId, probe): Promise<void> {
      const body: CacheFile = { v: 1, probe };
      const target = fileFor(agentId);
      // Written to a sibling and renamed: a reader must never see half a JSON document, and a
      // crash mid-write must leave the PREVIOUS probe intact rather than an unparseable one.
      // The temp name carries a hash of the target so two concurrent writers of DIFFERENT agents
      // cannot collide, and `process.pid` so two daemons cannot either.
      const scratch = `${target}.${String(process.pid)}.${createHash("sha256")
        .update(agentId)
        .digest("hex")
        .slice(0, 8)}.tmp`;
      try {
        // INSIDE the guard, along with the write: a data dir that cannot hold a `probes/`
        // directory at all — read-only, out of inodes, a plain file in the way — must cost a log
        // line and a re-probe next time, never the result of the probe that just succeeded.
        await mkdir(dir, { recursive: true, mode: DIR_MODE });
        // `mkdir`'s mode is masked by the umask, so it is asserted afterwards. On a pre-existing
        // directory `mkdir` sets no mode at all, which is the case that actually matters.
        await chmod(dir, DIR_MODE).catch(() => {});

        await writeFile(scratch, `${JSON.stringify(body, null, 2)}\n`, {
          encoding: "utf8",
          mode: FILE_MODE,
        });
        await chmod(scratch, FILE_MODE).catch(() => {});
        await rename(scratch, target);
      } catch (e) {
        await rm(scratch, { force: true }).catch(() => {});
        // A probe that could not be cached is still a probe: the caller has the summary, and
        // failing the request over a disk problem would make `POST /probe` less reliable than
        // the thing it is probing. It is logged, loudly, because a cache that never writes turns
        // every daemon start into N cold `npx` spawns.
        logger?.warn("probe cache: write failed; the result was not cached", {
          agentId,
          error: String(e),
        });
      }
    },

    async drop(agentId): Promise<void> {
      await rm(fileFor(agentId), { force: true }).catch(() => {});
    },
  };
}
