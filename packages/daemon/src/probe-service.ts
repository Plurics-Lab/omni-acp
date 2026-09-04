import { tmpdir } from "node:os";
import { descriptorFingerprint, probeAgent } from "@omni-acp/core";
import {
  OmniError,
  type AgentDescriptor,
  type AuthContext,
  type Clock,
  type Logger,
  type ProbeRequestBody,
  type ProbeResponse,
  type ProbeSummary,
  type ResolvedDaemonConfig,
  type ResolvedProbeConfig,
  type RuntimeDescriptor,
  type Supervisor,
} from "@omni-acp/protocol";
import type { Catalog } from "./types.js";
import type { ProbeCache } from "./probe-cache.js";

/**
 * The probe, as a service: cache lookup, descriptor resolution, and ONE throwaway process
 * through `Supervisor.spawn` (never a second spawn site, F10).
 *
 * Concurrent probes of one agent SHARE one in-flight process — otherwise `POST /probe` becomes a
 * way to start N `npx` cold starts with N HTTP requests. Probes do not consume `maxWorkers`
 * slots, but they do reclaim their tree on every edge and are bounded by `probe.maxConcurrent`.
 *
 * Owned by M1-WP-E.
 */
export interface ProbeService {
  probe(id: string, o: ProbeRequestBody, auth: AuthContext): Promise<ProbeResponse>;
  descriptor(id: string): RuntimeDescriptor;
  /** `probe.onStart` = `"cached"` / `"always"`; a no-op for `"never"`. */
  warmup(): Promise<void>;
  /** The loaded summary for an agent, for `Catalog.list()`'s `probed`. NEVER fabricated (H4). */
  cached(agentId: string): ProbeSummary | null;
}

const HOUR_MS = 3_600_000;

/**
 * The fingerprint a summary is a claim ABOUT: command ⊕ args ⊕ version ⊕ the `agentInfo` the
 * probe itself discovered (§17.2).
 *
 * ONE function, used by both the stamp and the freshness check, because two computations of one
 * digest is how a cache comes to reject every entry it ever wrote — `probeAgent` is handed a
 * pre-probe fingerprint (it has no `agentInfo` yet), and the summary is re-stamped with this
 * once the agent has named itself.
 */
function fingerprintOfProbed(
  agent: AgentDescriptor,
  summary: Pick<ProbeSummary, "agentInfo">,
): string {
  const agentInfo = summary.agentInfo;
  if (agentInfo === null) return descriptorFingerprint(agent, {});
  const name = agentInfo["name"];
  const version = agentInfo["version"];
  return descriptorFingerprint(agent, {
    ...(typeof name === "string" ? { name } : {}),
    ...(typeof version === "string" ? { version } : {}),
  });
}

/**
 * Per-agent overrides on top of the daemon-wide block, plus the per-request ones.
 *
 * The ORDER is daemon ⊕ agent ⊕ request, and `ProbeOverrides` is spelled out in the schema
 * (rather than `ProbeConfig.partial()`) precisely so that an absent per-agent field does not
 * silently beat the daemon-wide value with a zod default.
 */
function effectiveConfig(
  config: ResolvedDaemonConfig,
  agentProbe: Partial<ResolvedProbeConfig>,
  request: ProbeRequestBody,
): ResolvedProbeConfig {
  return {
    onStart: agentProbe.onStart ?? config.probe.onStart,
    ttlHours: agentProbe.ttlHours ?? config.probe.ttlHours,
    timeoutMs: request.timeoutMs ?? agentProbe.timeoutMs ?? config.probe.timeoutMs,
    maxConcurrent: agentProbe.maxConcurrent ?? config.probe.maxConcurrent,
    deep: request.deep ?? agentProbe.deep ?? config.probe.deep,
  };
}

/**
 * A counting semaphore over `probe.maxConcurrent`.
 *
 * Probes do NOT consume `maxWorkers` slots (§17.4 rule 3) — a probe is not a worker and holding a
 * worker slot for one would make capability discovery compete with the work. They are bounded on
 * their own axis instead, because an `npx` cold start is ~7 s of CPU and network per process and
 * N concurrent HTTP requests must not become N of those.
 */
function semaphore(limit: number): { acquire(): Promise<() => void> } {
  let inFlight = 0;
  const waiting: (() => void)[] = [];

  const release = (): void => {
    inFlight -= 1;
    const next = waiting.shift();
    if (next !== undefined) {
      inFlight += 1;
      next();
    }
  };

  return {
    async acquire(): Promise<() => void> {
      if (inFlight < limit) {
        inFlight += 1;
      } else {
        await new Promise<void>((resolve) => waiting.push(resolve));
      }
      let released = false;
      return () => {
        // Idempotent: a caller that releases twice must not hand a permit away twice.
        if (released) return;
        released = true;
        release();
      };
    },
  };
}

export function createProbeService(o: {
  config: ResolvedDaemonConfig;
  catalog: Catalog;
  supervisor: Supervisor;
  cache: ProbeCache;
  clock: Clock;
  logger: Logger;
}): ProbeService {
  const logger = o.logger.child({ mod: "probe" });
  const gate = semaphore(o.config.probe.maxConcurrent);

  /**
   * What `Catalog.list()` serves as `probed`, and what `Catalog.descriptor()` merges.
   *
   * In MEMORY rather than read from disk per request, because both callers are synchronous
   * (`AgentCatalogEntry` is a value, not a promise) and because a `GET /v1/agents` that hit the
   * filesystem once per configured agent would make a listing an I/O storm. `warmup()` fills it;
   * every completed probe refreshes it.
   */
  const loaded = new Map<string, ProbeSummary>();

  /** Concurrent probes of ONE agent share one in-flight process (§17.4 rule 6). */
  const inFlight = new Map<string, Promise<ProbeSummary>>();

  /**
   * Is this cached summary still a claim about the program that is there NOW?
   *
   * Two independent checks, and both are needed. The FINGERPRINT catches an operator repointing
   * the agent — a new command, new args, a rotated credential — and is exact. The TTL catches the
   * agent upgrading itself underneath us, which the fingerprint cannot see: the cached
   * `agentInfo` is what the fingerprint was computed over, so recomputing with it always matches
   * by construction. `ttlHours` (default 168 = one week) is the bound on how long we may believe
   * a capability table across a self-upgrade.
   */
  const isFresh = (
    agentId: string,
    summary: ProbeSummary,
    config: ResolvedProbeConfig,
  ): boolean => {
    const agent = o.catalog.get(agentId);
    if (fingerprintOfProbed(agent, summary) !== summary.descriptorFingerprint) return false;

    const at = Date.parse(summary.at);
    if (Number.isNaN(at)) return false;
    return o.clock.now() - at < config.ttlHours * HOUR_MS;
  };

  const runProbe = async (agentId: string, config: ResolvedProbeConfig): Promise<ProbeSummary> => {
    const existing = inFlight.get(agentId);
    // The shared in-flight probe is keyed by agent id and NOT by config: two callers asking for
    // the same agent at the same moment want the same answer, and starting a second `npx` cold
    // start because one of them passed a different `timeoutMs` is exactly the cost rule 6 exists
    // to avoid.
    if (existing !== undefined) return await existing;

    const started = (async (): Promise<ProbeSummary> => {
      const release = await gate.acquire();
      try {
        const agent = o.catalog.get(agentId);
        /**
         * The descriptor as it stands NOW — which is builtin ⊕ config, with no probe layer,
         * because every path that reaches here has already dropped the loaded summary: `force`
         * drops it explicitly, a stale one is dropped when it fails `isFresh`, and a fresh one
         * returned before this line. `warmup("always")` runs before anything is loaded.
         *
         * That is the state the battery wants: it reads `prefer.resume.spellings` to decide
         * which resume spellings to try, and a previous run's reordering pinning the next one is
         * exactly the feedback loop a re-probe exists to break.
         */
        const descriptor = o.catalog.descriptor(agentId);
        // `tmpdir()` is a placeholder the probe REPLACES with its own `mkdtemp` (§17.4 rule 4);
        // the catalog is still the one producer of the SpawnSpec, which is what keeps
        // `no-direct-spawn` and the env-composition guarantee intact.
        const spec = o.catalog.toSpawnSpec(agent, { cwd: tmpdir() });
        const raw = await probeAgent({
          agentId,
          spec,
          descriptor,
          config,
          supervisor: o.supervisor,
          clock: o.clock,
          logger,
          // What we knew before the process answered. Re-stamped below with what it told us —
          // `probeAgent` cannot compute this itself: it never sees the `AgentDescriptor`.
          fingerprint: descriptorFingerprint(agent),
        });
        const summary: ProbeSummary = {
          ...raw,
          descriptorFingerprint: fingerprintOfProbed(agent, raw),
        };
        loaded.set(agentId, summary);
        await o.cache.write(agentId, summary);
        logger.info("probe complete", {
          agent: agentId,
          protocolVersion: summary.protocolVersion,
          supported: summary.supportedMethods.length,
          unsupported: summary.unsupportedMethods.length,
          resumeMethod: summary.resumeMethod,
          ms: summary.timings["total"] ?? null,
        });
        return summary;
      } finally {
        release();
        inFlight.delete(agentId);
      }
    })();

    inFlight.set(agentId, started);
    return await started;
  };

  return {
    cached: (agentId) => loaded.get(agentId) ?? null,

    descriptor: (id) => o.catalog.descriptor(id),

    async probe(id, body, auth): Promise<ProbeResponse> {
      // ACL FIRST, before the catalog and long before anything spawns (§17.4 rule 1): a token
      // that may not use an agent must get its `403` without a process ever existing — and
      // without learning whether that agent is configured on this machine at all.
      auth.assertAgent(id);
      const agent = o.catalog.get(id);
      const config = effectiveConfig(o.config, agent.probe, body);

      if (body.force === true) {
        loaded.delete(id);
        await o.cache.drop(id);
      } else {
        const cached = loaded.get(id) ?? (await o.cache.read(id));
        if (cached !== null && isFresh(id, cached, config)) {
          loaded.set(id, cached);
          return { probe: cached, cached: true };
        }
        if (cached !== null) {
          // A stale entry is dropped rather than left to be re-read and re-rejected on every
          // request: the fingerprint no longer describes what is on disk.
          loaded.delete(id);
          await o.cache.drop(id);
        }
      }

      return { probe: await runProbe(id, config), cached: false };
    },

    async warmup(): Promise<void> {
      if (o.config.probe.onStart === "never") return;

      for (const agent of o.config.agents) {
        const config = effectiveConfig(o.config, agent.probe, {});
        if (config.onStart === "never") continue;

        if (config.onStart === "cached") {
          // LOADS, never spawns. `createDaemon()` must keep a cheap, quiet startup (ruling
          // M1-R17's spirit): an operator with eight agents configured should not pay eight
          // `npx` cold starts to bind a port, and `probe.onStart: "always"` is the explicit
          // lever for the operator who wants exactly that.
          const cached = await o.cache.read(agent.id);
          if (cached !== null && isFresh(agent.id, cached, config)) loaded.set(agent.id, cached);
          else if (cached !== null) await o.cache.drop(agent.id);
          continue;
        }

        try {
          await runProbe(agent.id, config);
        } catch (e) {
          // A daemon must start even when one agent is broken: the operator sees the log line and
          // `GET /v1/agents` reports `probed: null`, which is the honest "we do not know".
          logger.warn("probe on start failed", {
            agent: agent.id,
            error: e instanceof OmniError ? e.message : String(e),
          });
        }
      }
    },
  };
}
