import {
  type AcpStream,
  type AgentProcess,
  type Clock,
  type KillOutcome,
  type Logger,
  type PlatformOps,
  type ProcessExit,
  type ProcessInfo,
  type StderrTail,
  type TerminationRung,
} from "@omni-acp/protocol";

/**
 * Everything `spawn.ts` has already wired, handed over as one object.
 *
 * Internal to WP-2 and deliberately structural: this file must NOT type-import
 * `node:child_process` — only `spawn.ts` may name that module at all (CONTRACTS.md §6.1).
 */
export interface AgentProcessParts {
  readonly pid: number | null;
  readonly info: ProcessInfo;
  readonly stream: AcpStream;
  readonly stderr: StderrTail;
  readonly exited: Promise<ProcessExit>;
  readonly stdoutEnded: Promise<void>;
  closeStdin(): void;
  terminate(opts?: { gracefulMs?: number; force?: boolean }): Promise<KillOutcome>;
}

/**
 * Assembles the `AgentProcess` contract: the idempotent, concurrency-safe `terminate()` ladder
 * and the two independent death signals (`exited`, `stdoutEnded`) live behind this.
 *
 * `pid` is read through a getter so the parts object may keep reporting the live pid and drop it
 * to `null` on exit, which is the shape `testkit`'s `FakeAgentProcess` already has and the shape
 * `PlatformOps.isLeaderGone` reads.
 */
export function createAgentProcess(parts: AgentProcessParts): AgentProcess {
  /** One ladder run, shared: a second caller awaits the first and gets the same KillOutcome. */
  let run: Promise<KillOutcome> | null = null;

  return {
    get pid(): number | null {
      return parts.pid;
    },
    info: parts.info,
    stream: parts.stream,
    stderr: parts.stderr,
    exited: parts.exited,
    stdoutEnded: parts.stdoutEnded,
    closeStdin: () => {
      parts.closeStdin();
    },
    terminate(opts) {
      if (run !== null) return run;
      const started = parts.terminate(opts);
      run = started.catch((e: unknown) => {
        // A rejection is not an outcome, so it must not be memoized as one: a later caller is
        // entitled to try the ladder again rather than inherit a failure it cannot inspect.
        run = null;
        throw e;
      });
      return run;
    },
  };
}

/** How often the ladder re-checks its proofs. CONTRACTS.md §6.5 step 4 fixes this at 10 ms. */
const POLL_MS = 10;

export interface TerminationLadderDeps {
  readonly platform: PlatformOps;
  readonly clock: Clock;
  readonly logger: Logger;
  /**
   * The process the ladder acts on. Lazy because the `AgentProcess` is assembled AROUND this
   * ladder — `PlatformOps` takes the process, not a pid, so the two are mutually recursive by
   * construction and one of them has to be a thunk.
   */
  target(): AgentProcess;
  closeStdin(): void;
  /** Resolves on the child's `exit`. NEVER rejects. */
  readonly exited: Promise<ProcessExit>;
  /** The synchronous view of `exited`: `null` until the child has actually gone. */
  exitNow(): ProcessExit | null;
  /** Marks every exit from this moment on as one WE asked for (`ProcessExit.requested`). */
  markRequested(): void;
  readonly gracefulMs: number;
  readonly killConfirmMs: number;
  readonly exitGraceMs: number;
}

interface Confirmation {
  /** Everything this platform is able to prove has been proven. */
  readonly settled: boolean;
  readonly leaderExited: boolean;
  readonly treeGone: boolean;
}

/**
 * CONTRACTS.md §6.5, one ladder, both platforms, different rungs.
 *
 * ```
 * 0. already exited            -> already_exited (unless force: a tree we cannot prove gone)
 * 1. closeStdin()                                  # ACP agents exit on stdin EOF
 * 2. POSIX: SIGTERM to the group / Windows: no rung to send
 * 3. POSIX: SIGKILL to the group / Windows: taskkill /PID <pid> /T /F
 * 4. confirm: poll isLeaderGone() and isTreeGone() every 10 ms, up to killConfirmMs
 * ```
 *
 * Two things are deliberate and easy to "fix" into bugs:
 *
 *  - Step 1 is FIRST because killing at the response boundary truncates the agent's last output
 *    (L5, DESIGN §6.2), and because "the leader exited" is not "the work is done" while a
 *    grandchild still holds the inherited stdout.
 *  - Each rung waits for the whole TREE, not just the leader. An agent that exits politely on
 *    stdin EOF while its grandchild keeps running has not been reclaimed, so the ladder keeps
 *    climbing — that is the `orphan.mjs` case (WP-2 acceptance 5).
 *
 * Returned separately from `createAgentProcess` so it can be unit-tested against an injected
 * `PlatformOps` with no process anywhere in sight — which is the only way the Windows rungs can
 * be exercised at all on a POSIX machine.
 */
export function createTerminationLadder(
  deps: TerminationLadderDeps,
): (opts?: { gracefulMs?: number; force?: boolean }) => Promise<KillOutcome> {
  const { platform, clock } = deps;
  /** A branch on OWNERSHIP, not on `process.platform` (§6.1): what can be proven, not who we are. */
  const canProveTree = platform.ownership.confirmsTreeGone;

  const sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      clock.setTimer(ms, () => {
        resolve();
      });
    });

  const raceExit = (ms: number): Promise<ProcessExit | null> => {
    const already = deps.exitNow();
    if (already !== null || ms <= 0) return Promise.resolve(already);
    return new Promise<ProcessExit | null>((resolve) => {
      let done = false;
      const timer = clock.setTimer(ms, () => {
        if (done) return;
        done = true;
        resolve(null);
      });
      void deps.exited.then((e) => {
        if (done) return;
        done = true;
        timer.cancel();
        resolve(e);
      });
    });
  };

  /**
   * Polls until every provable fact is proven, or `ms` elapses.
   *
   * The cheap signal — our own child's `exit` event — is consulted every tick; the OS probe runs
   * only at the deadline, because on Windows `isLeaderGone()` is a `tasklist` PROCESS and a
   * 10 ms cadence would spawn hundreds of them per teardown.
   */
  const settleWithin = async (ms: number): Promise<Confirmation> => {
    const deadline = clock.now() + Math.max(0, ms);
    for (;;) {
      const treeGone = canProveTree ? await platform.isTreeGone(deps.target()) : false;
      const leaderExited = deps.exitNow() !== null;
      if (leaderExited && (treeGone || !canProveTree)) {
        return { settled: true, leaderExited, treeGone };
      }
      if (clock.now() >= deadline) {
        const probed = leaderExited || (await platform.isLeaderGone(deps.target()));
        return {
          settled: probed && (treeGone || !canProveTree),
          leaderExited: probed,
          treeGone,
        };
      }
      await sleep(POLL_MS);
    }
  };

  return async function terminate(opts): Promise<KillOutcome> {
    const startedAt = clock.now();
    const gracefulMs = Math.max(0, opts?.gracefulMs ?? deps.gracefulMs);
    const force = opts?.force === true;
    deps.markRequested();

    const outcome = (escalatedTo: TerminationRung, c: Confirmation): KillOutcome => ({
      exit: deps.exitNow(),
      leaderExited: c.leaderExited,
      // Never optimistic: this is only ever the value a probe actually returned, so a
      // confirmation that timed out reports false (WP-2 acceptance 7).
      treeGone: c.treeGone,
      escalatedTo,
      durationMs: clock.now() - startedAt,
    });

    if (deps.exitNow() !== null) {
      // Rung 0. The leader is already gone; the only open question is its tree.
      const treeGone = canProveTree ? await platform.isTreeGone(deps.target()) : false;
      if (treeGone || !force) {
        return outcome("already_exited", { settled: true, leaderExited: true, treeGone });
      }
      // `force` on a leader that has already exited is §6.7's zombie path: stdout never EOF'd
      // because a grandchild inherited it. Skip the cooperative rungs — there is nobody left to
      // cooperate — and go straight to reclaiming what is still running.
    } else if (!force) {
      // Rung 1 — an ACP agent exits on stdin EOF, and this is the only place stdin is closed
      // (§6.5: closing it at turn end would kill a long-lived Worker).
      deps.closeStdin();
      const half = Math.floor(gracefulMs / 2);
      let confirmation = await settleWithin(half);
      if (confirmation.settled) return outcome("stdin_eof", confirmation);

      // Rung 2 — cooperative signal. On Windows this sends nothing and reports the rung we are
      // still on, which is why no call site here branches on the platform.
      const rung = await platform.signalTree(deps.target(), "SIGTERM");
      confirmation = await settleWithin(half);
      if (confirmation.settled) return outcome(rung, confirmation);
    }

    // Rung 3 — force. POSIX: SIGKILL to the group. Windows: taskkill /T /F.
    const rung = await platform.signalTree(deps.target(), "SIGKILL");
    // Rung 4 — confirm.
    const confirmation = await settleWithin(deps.killConfirmMs);
    if (deps.exitNow() === null && confirmation.leaderExited) {
      // The OS says the leader is gone but libuv has not delivered `exit` yet. A bounded wait
      // here is what makes `KillOutcome.exit` a fact rather than a race.
      await raceExit(deps.exitGraceMs);
    }
    if (!confirmation.settled) {
      deps.logger.warn("process tree not confirmed reclaimed", {
        pid: deps.target().info.pid,
        leaderExited: confirmation.leaderExited,
        treeGone: confirmation.treeGone,
        escalatedTo: rung,
      });
    }
    return outcome(rung, confirmation);
  };
}
