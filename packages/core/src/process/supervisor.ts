import {
  type AgentProcess,
  type Clock,
  type KillOutcome,
  type Logger,
  type OrphanRecord,
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

    /**
     * §15.7 / L18. Kill a process this daemon did NOT spawn, gated on the incarnation token a
     * previous boot recorded. ALWAYS resolves: a reap failure is data (`reapSkipped`), never an
     * exception.
     *
     * The whole function is one rule, stated four ways: **never signal a pid you cannot prove is
     * the same process.** Linux pid reuse wraps at `pid_max`, so killing a stale pid after a
     * reboot is a coin flip on somebody else's process — which is why every early return below
     * records WHY it declined rather than quietly doing nothing (ruling M1-R9).
     */
    async reapOrphan(record: OrphanRecord): Promise<OrphanRecord> {
      const skip = (reapSkipped: string): OrphanRecord => ({
        ...record,
        reaped: false,
        reapSkipped,
      });

      // 1. `supervisor.reapOrphans: "never"` — the operator said report-only.
      if (config.reapOrphans === "never") return skip("policy");

      // 2. No token was ever taken, so no proof can ever be produced. This is win32 by
      //    construction (§15.7 fixes its fingerprint at null and WP-C acceptance 7 asserts it),
      //    and it is any POSIX spawn whose `/proc` read or `ps` call failed.
      if (record.fingerprint === null) return skip("unsupported_platform");

      // 3. An orphan is a process we have no handle for, so the GROUP id a previous boot wrote
      //    is the only address we have. §6.5's rule — kill the group, not the leader — is why:
      //    the agent's MCP servers and shells are in that group, and killing the leader alone
      //    turns one orphan into several.
      //    `0` is "every process in MY group" — this daemon — and `1` is init; neither is ever a
      //    tree we own, on any platform, and the blast radius of signalling one is the machine.
      //    `platform-posix.ts` refuses them again; this is the belt to that pair of braces, and
      //    it is here so the ladder below cannot report `reaped: true` for a group nothing was
      //    ever sent to.
      const groupId = record.groupId;
      if (groupId === null || !Number.isInteger(groupId) || groupId <= 1) {
        return skip("unsupported_platform");
      }

      try {
        // 4. THE PROOF. A pid whose current token differs from the recorded one is a different
        //    process wearing a recycled number, and a pid with no current token is one we can no
        //    longer identify — both are refusals, and neither is a signal.
        const current = await platform.fingerprint(record.pid);
        if (current === null) return skip("gone");
        if (current !== record.fingerprint) return skip("fingerprint_mismatch");

        // 5. Proven. §6.5's ladder, minus the rungs that need a handle we do not have: SIGTERM,
        //    confirm, then SIGKILL. The agent gets its normal shutdown first — we are reclaiming
        //    a process, not punishing it.
        await platform.signalTreeByGroup(groupId, "SIGTERM");
        if (!(await confirmGone(platform, groupId, o.clock, config.killConfirmMs))) {
          await platform.signalTreeByGroup(groupId, "SIGKILL");
          await confirmGone(platform, groupId, o.clock, config.killConfirmMs);
        }
        o.logger.info("reaped an orphaned agent tree from a previous boot", {
          pid: record.pid,
          groupId,
        });
        return { ...record, reaped: true, reapSkipped: null };
      } catch (e) {
        // "ALWAYS resolves: a reap failure is data, not an exception." An unexpected failure is
        // NOT rounded up to "gone" or down to "policy": both would put a false statement in the
        // adoption envelope an operator reads to decide whether a tree is still running.
        o.logger.error("reaping an orphan failed", {
          pid: record.pid,
          error: e instanceof Error ? e.message : String(e),
        });
        return skip("error");
      }
    },
  };
}

/**
 * Poll `isGroupGone` until it says yes or the budget runs out.
 *
 * `KillOutcome.treeGone` is never optimistic (§6.6) and neither is this: "we could not confirm"
 * returns false and the caller escalates, which is the safe direction in both places.
 */
async function confirmGone(
  platform: PlatformOps,
  groupId: number,
  clock: Clock,
  budgetMs: number,
): Promise<boolean> {
  const deadline = clock.now() + budgetMs;
  for (;;) {
    if (await platform.isGroupGone(groupId)) return true;
    if (clock.now() >= deadline) return false;
    await new Promise<void>((resolve) => {
      // A short poll rather than one long sleep: a tree that dies on SIGTERM usually does so in
      // single-digit milliseconds, and waiting the whole confirm window for it would make every
      // boot adoption pay the worst case.
      clock.setTimer(Math.min(25, Math.max(1, deadline - clock.now())), resolve);
    });
  }
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
