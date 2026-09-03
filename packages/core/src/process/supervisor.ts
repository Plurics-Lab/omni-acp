import {
  type AgentProcess,
  type Clock,
  type KillOutcome,
  type Logger,
  type PlatformOps,
  type ResolvedSupervisorConfig,
  type SpawnSpec,
  type Supervisor,
} from "@omni-acp/protocol";
import { createPlatformOps } from "./platform.js";
import { spawnAgentProcess } from "./spawn.js";

export interface SupervisorOptions {
  /** `z.output<typeof SupervisorConfig>` — named through protocol so core stays zod-free. */
  readonly config: ResolvedSupervisorConfig;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Injectable for tests. */
  readonly platform?: PlatformOps;
  /**
   * Injected only by unit tests that observe argv without spawning.
   *
   * NOTE for the `no-direct-spawn` guard: this is a TYPE position — `typeof import(...)` emits
   * nothing and calls nothing. The guard must exempt type-only references and fail on value
   * imports and call sites, which is the rule it is actually there to enforce.
   */
  readonly spawnFn?: typeof import("node:child_process").spawn;
}

/** The headroom `shutdown()` allows a ladder that is behaving, before it stops waiting. */
const SHUTDOWN_SLACK_MS = 1_000;

/**
 * The single spawn entry point. `PlatformOps` is chosen HERE, at construction — never at kill
 * time, and never by a call site branching on `process.platform` (CONTRACTS.md §6.1).
 */
export function createSupervisor(o: SupervisorOptions): Supervisor {
  const platform = o.platform ?? createPlatformOps();
  const config = o.config;
  const live = new Set<AgentProcess>();

  /**
   * `SpawnSpec`'s knobs are per-agent OVERRIDES; the daemon's `supervisor` block is the default
   * for each. Resolving here rather than in `spawn.ts` keeps the config in one place and leaves
   * the launch path taking a fully-specified spec.
   */
  const withConfigDefaults = (spec: SpawnSpec): SpawnSpec => ({
    ...spec,
    gracefulMs: spec.gracefulMs ?? config.gracefulMs,
    killConfirmMs: spec.killConfirmMs ?? config.killConfirmMs,
    exitGraceMs: spec.exitGraceMs ?? config.exitGraceMs,
    maxFrameBytes: spec.maxFrameBytes ?? config.maxFrameBytes,
    stderrTailBytes: spec.stderrTailBytes ?? config.stderrTailBytes,
  });

  const forget = (p: AgentProcess): void => {
    live.delete(p);
  };

  return {
    platform,
    live,

    async spawn(spec: SpawnSpec, signal?: AbortSignal): Promise<AgentProcess> {
      const process_ = await spawnAgentProcess(
        withConfigDefaults(spec),
        platform,
        {
          clock: o.clock,
          logger: o.logger,
          allowShimLaunch: config.allowShimLaunch,
          windowsHide: config.windowsHide,
          spawnFn: o.spawnFn,
        },
        signal,
      );
      live.add(process_);
      // A process that dies on its own leaves the ledger too — `live` is what is still running,
      // not what was ever started.
      void process_.exited.then(() => {
        forget(process_);
      });
      return process_;
    },

    async shutdown(opts?: { gracefulMs?: number; timeoutMs?: number }): Promise<KillOutcome[]> {
      const targets = [...live];
      const gracefulMs = opts?.gracefulMs ?? config.gracefulMs;
      const timeoutMs =
        opts?.timeoutMs ??
        gracefulMs + config.killConfirmMs + config.exitGraceMs + SHUTDOWN_SLACK_MS;

      // Each entry leaves the ledger in its own `finally`, so `live` is empty when the last
      // ladder settles — including for a tree whose teardown could not be confirmed. Anything
      // spawned CONCURRENTLY with a shutdown is the caller's race, not a leak this can close.
      const outcomes = await Promise.all(
        targets.map(async (p) => {
          try {
            return await withTimeout(p.terminate({ gracefulMs }), timeoutMs, o.clock, () =>
              unconfirmed(p, platform),
            );
          } catch (e) {
            o.logger.error("terminate failed during shutdown", {
              pid: p.info.pid,
              error: e instanceof Error ? e.message : String(e),
            });
            return unconfirmed(p, platform);
          } finally {
            forget(p);
          }
        }),
      );

      return outcomes;
    },
  };
}

/**
 * The outcome for a tree whose teardown could not be confirmed.
 *
 * Deliberately pessimistic on every field the contract calls non-optimistic: nothing here was
 * proven, so nothing here is claimed. `escalatedTo` names the rung the ladder was on when the
 * clock ran out, which is always the force rung — the earlier ones return on their own.
 */
function unconfirmed(p: AgentProcess, platform: PlatformOps): KillOutcome {
  return {
    exit: null,
    // The one fact still available for free: our own child's `exit` event, or its absence.
    leaderExited: p.pid === null,
    treeGone: false,
    escalatedTo: platform.ownership.kind === "windows-taskkill-tree" ? "taskkill" : "sigkill",
    durationMs: 0,
  };
}

function withTimeout<T>(work: Promise<T>, ms: number, clock: Clock, fallback: () => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const timer = clock.setTimer(ms, () => {
      if (done) return;
      done = true;
      resolve(fallback());
    });
    work.then(
      (value) => {
        if (done) return;
        done = true;
        timer.cancel();
        resolve(value);
      },
      (e: unknown) => {
        if (done) return;
        done = true;
        timer.cancel();
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}
