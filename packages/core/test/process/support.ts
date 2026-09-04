import {
  SupervisorConfig,
  type AgentProcess,
  type Clock,
  type Logger,
  type PlatformOps,
  type PlatformOwnership,
  type ProcessExit,
  type ProcessInfo,
  type ResolvedSupervisorConfig,
  type RunUtility,
  type SpawnSpec,
  type Supervisor,
  type TerminationRung,
  type TimerHandle,
} from "@omni-acp/protocol";
import { fixtureAgentPath, memoryStreamPair, type FixtureAgentName } from "@omni-acp/testkit";
import { EventEmitter } from "node:events";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { createAgentProcess, createTerminationLadder } from "../../src/process/agent-process.js";
import { createStderrTail } from "../../src/process/stderr-tail.js";
import { createSupervisor } from "../../src/process/supervisor.js";

/**
 * Shared fixtures for the WP-2 suite.
 *
 * Not a `*.test.ts` file, so vitest does not collect it (`include: ["test/**\/*.test.ts"]`).
 */

/** Wall-clock `Clock`. The process layer's waits are real timeouts, so a fake clock would only
 * mean the ladder never advances. */
export function realClock(): Clock {
  return {
    now: () => Date.now(),
    iso: () => new Date().toISOString(),
    setTimer(delayMs: number, fn: () => void): TimerHandle {
      const handle = setTimeout(fn, Math.max(0, delayMs));
      return {
        cancel(): void {
          clearTimeout(handle);
        },
      };
    },
  };
}

export interface LoggedLine {
  readonly level: "debug" | "info" | "warn" | "error";
  readonly msg: string;
  readonly fields: Record<string, unknown> | undefined;
}

export interface RecordingLogger extends Logger {
  readonly lines: readonly LoggedLine[];
}

export function recordingLogger(): RecordingLogger {
  const lines: LoggedLine[] = [];
  const at =
    (level: LoggedLine["level"]) =>
    (msg: string, fields?: Record<string, unknown>): void => {
      lines.push({ level, msg, fields });
    };
  const logger: RecordingLogger = {
    lines,
    child: () => logger,
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
  };
  return logger;
}

export function supervisorConfig(
  overrides?: Partial<ResolvedSupervisorConfig>,
): ResolvedSupervisorConfig {
  return SupervisorConfig.parse({ ...overrides });
}

// ── a PlatformOps double ─────────────────────────────────────────────────────

export const POSIX_OWNERSHIP: PlatformOwnership = {
  kind: "posix-process-group",
  confirmsTreeGone: true,
  survivesDaemonKill: true,
  caveat: null,
};

export const WINDOWS_OWNERSHIP: PlatformOwnership = {
  kind: "windows-taskkill-tree",
  confirmsTreeGone: false,
  survivesDaemonKill: true,
  caveat: "windows cannot prove it",
};

export interface StubPlatform extends PlatformOps {
  readonly signals: readonly ("SIGTERM" | "SIGKILL")[];
  readonly leaderProbes: { count: number };
  treeGone: boolean;
  leaderGone: boolean;
}

/**
 * A `PlatformOps` with no operating system behind it: the ladder's rungs become observable
 * without a process, which is the only way the Windows rungs can be exercised on Linux.
 */
export function stubPlatform(o?: {
  ownership?: PlatformOwnership;
  treeGone?: boolean;
  leaderGone?: boolean;
  /** Runs when a signal is delivered — how a test says "SIGTERM actually reaped the tree". */
  onSignal?: (sig: "SIGTERM" | "SIGKILL", platform: StubPlatform) => void;
}): StubPlatform {
  const ownership = o?.ownership ?? POSIX_OWNERSHIP;
  const windows = ownership.kind === "windows-taskkill-tree";
  const signals: ("SIGTERM" | "SIGKILL")[] = [];
  const leaderProbes = { count: 0 };

  const platform: StubPlatform = {
    ownership,
    signals,
    leaderProbes,
    treeGone: o?.treeGone ?? false,
    leaderGone: o?.leaderGone ?? false,
    spawnOptions: ({ windowsHide }) =>
      windows ? { detached: false, windowsHide } : { detached: true, windowsHide: false },
    resolveLaunch: (command, args) =>
      Promise.resolve({ file: command, args: [...args], windowsVerbatimArguments: false }),
    signalTree(_p: AgentProcess, sig: "SIGTERM" | "SIGKILL"): Promise<TerminationRung> {
      signals.push(sig);
      o?.onSignal?.(sig, platform);
      if (sig === "SIGTERM") return Promise.resolve(windows ? "stdin_eof" : "sigterm");
      return Promise.resolve(windows ? "taskkill" : "sigkill");
    },
    isTreeGone: () => Promise.resolve(ownership.confirmsTreeGone && platform.treeGone),
    isLeaderGone: () => {
      leaderProbes.count += 1;
      return Promise.resolve(platform.leaderGone);
    },

    // ── M1 (§15.7) ──────────────────────────────────────────────────────────
    //
    // The double models the PLATFORM SPLIT and nothing else, exactly as testkit's fake does: a
    // POSIX stub takes a token (so "reap only on a match" has something to match) and a Windows
    // stub returns null (so "never signal without one" has the real refusal behind it). Nothing
    // here talks to `/proc` or to `ps`.
    fingerprint: (pid: number) => Promise.resolve(windows ? null : `stub:${String(pid)}`),
    signalTreeByGroup: (_groupId: number, sig: "SIGTERM" | "SIGKILL") => {
      signals.push(sig);
      return Promise.resolve<TerminationRung>(
        sig === "SIGTERM" ? "sigterm" : windows ? "taskkill" : "sigkill",
      );
    },
    isGroupGone: () => Promise.resolve(ownership.confirmsTreeGone && platform.treeGone),
  };
  return platform;
}

// ── a process to run the ladder against ──────────────────────────────────────

export interface LadderHarness {
  readonly process: AgentProcess;
  readonly events: readonly string[];
  /** Delivers the child's `exit`, exactly as `spawn.ts` would. */
  die(code: number | null, signal?: string | null): void;
  readonly exitNow: () => ProcessExit | null;
}

export function ladderHarness(
  platform: PlatformOps,
  o?: {
    gracefulMs?: number;
    killConfirmMs?: number;
    exitGraceMs?: number;
    pid?: number;
    /** Runs when the ladder closes stdin — how a test says "the agent exits on EOF". */
    onCloseStdin?: (harness: LadderHarness) => void;
  },
): LadderHarness {
  const pid = o?.pid ?? 424_242;
  const events: string[] = [];
  let exit: ProcessExit | null = null;
  let livePid: number | null = pid;
  let requested = false;

  let settleExit!: (e: ProcessExit) => void;
  const exited = new Promise<ProcessExit>((resolve) => {
    settleExit = resolve;
  });

  const info: ProcessInfo = {
    pid,
    groupId: platform.ownership.kind === "windows-taskkill-tree" ? null : pid,
    startedAt: new Date(0).toISOString(),
    command: "stub",
    argsRedacted: [],
    // §15.7: a double that never spawned has no incarnation token, and `null` is the value
    // that FORBIDS a later boot from signalling this pid.
    fingerprint: null,
  };

  const holder: { process: AgentProcess | null; harness: LadderHarness | null } = {
    process: null,
    harness: null,
  };
  const ladder = createTerminationLadder({
    platform,
    clock: realClock(),
    logger: recordingLogger(),
    target: () => holder.process as AgentProcess,
    closeStdin: () => {
      events.push("closeStdin");
      o?.onCloseStdin?.(holder.harness as LadderHarness);
    },
    exited,
    exitNow: () => exit,
    markRequested: () => {
      requested = true;
    },
    gracefulMs: o?.gracefulMs ?? 40,
    killConfirmMs: o?.killConfirmMs ?? 40,
    exitGraceMs: o?.exitGraceMs ?? 20,
  });

  holder.process = createAgentProcess({
    get pid(): number | null {
      return livePid;
    },
    info,
    stream: memoryStreamPair()[0],
    stderr: createStderrTail({ maxBytes: 256 }),
    exited,
    stdoutEnded: Promise.resolve(),
    closeStdin: () => {
      events.push("closeStdin:public");
    },
    terminate: ladder,
  });

  const harness: LadderHarness = {
    process: holder.process,
    events,
    exitNow: () => exit,
    die(code, signal) {
      if (exit !== null) return;
      exit = { code, signal: signal ?? null, at: Date.now(), requested };
      livePid = null;
      settleExit(exit);
    },
  };
  holder.harness = harness;
  return harness;
}

// ── a bare process handle ────────────────────────────────────────────────────

/**
 * The two fields `PlatformOps` actually reads — `pid` (live, or `null` once `exit` arrived) and
 * `info` — with nothing behind them. Enough to exercise every probe and signal path with no
 * process in existence.
 */
export function processHandle(o: {
  pid: number | null;
  groupId: number | null;
  infoPid?: number;
}): AgentProcess {
  const info: ProcessInfo = {
    pid: o.infoPid ?? o.pid ?? -1,
    groupId: o.groupId,
    startedAt: new Date(0).toISOString(),
    command: "stub",
    argsRedacted: [],
    // §15.7: a double that never spawned has no incarnation token, and `null` is the value
    // that FORBIDS a later boot from signalling this pid.
    fingerprint: null,
  };
  return { pid: o.pid, info } as AgentProcess;
}

// ── a spawn double ───────────────────────────────────────────────────────────

export type SpawnFn = typeof import("node:child_process").spawn;

export interface RecordedSpawn {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: Record<string, unknown>;
}

export interface FakeChild extends EventEmitter {
  pid: number;
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill(signal?: string): boolean;
  killed: boolean;
}

export interface SpawnRecorder {
  readonly calls: readonly RecordedSpawn[];
  readonly children: readonly FakeChild[];
  readonly fn: SpawnFn;
}

/**
 * A `spawnFn` that starts no process: argv, cwd, env and the ownership flags become assertions
 * instead of behaviour, on every OS (WP-2 acceptance 3).
 */
export function recordingSpawn(o?: { pid?: number }): SpawnRecorder {
  const calls: RecordedSpawn[] = [];
  const children: FakeChild[] = [];
  let nextPid = o?.pid ?? 4242;

  const fn = ((file: string, args: readonly string[], options: Record<string, unknown>) => {
    calls.push({ file, args: [...args], options });
    const child = new EventEmitter() as FakeChild;
    child.pid = nextPid++;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = (): boolean => {
      child.killed = true;
      return true;
    };
    children.push(child);
    setImmediate(() => child.emit("spawn"));
    return child;
  }) as unknown as SpawnFn;

  return { calls, children, fn };
}

/** Ends a fake child's stdio and delivers its `exit`, so nothing is left holding the loop. */
export function finishFakeChild(child: FakeChild, code = 0): void {
  child.stdout.end();
  child.stderr.end();
  child.emit("exit", code, null);
}

// ── real processes ───────────────────────────────────────────────────────────

/**
 * macOS runners are measurably slower at process teardown; CONTRACTS.md §10.3 gives them a
 * multiplier rather than a second set of numbers.
 */
export const SLOW = Math.max(1, Number(process.env["OMNI_TEST_SLOW_FACTOR"] ?? "1"));

export function slow(ms: number): number {
  return Math.round(ms * SLOW);
}

export function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** `process.env` with the `undefined`s dropped — `SpawnSpec.env` is a complete string map. */
export function inheritedEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  return { ...env, ...extra };
}

/**
 * A Tier-2 launch spec: `process.execPath <fixture>`, never through a `.bin` shim, which is what
 * CONTRACTS.md §6.3 wants on every OS and what Windows requires.
 */
export function fixtureSpec(
  name: FixtureAgentName,
  o?: { env?: Record<string, string>; cwd?: string } & Partial<
    Pick<
      SpawnSpec,
      "gracefulMs" | "killConfirmMs" | "exitGraceMs" | "maxFrameBytes" | "stderrTailBytes"
    >
  >,
): SpawnSpec {
  const { env, cwd, ...limits } = o ?? {};
  return {
    command: process.execPath,
    args: [fixtureAgentPath(name)],
    cwd: cwd ?? tmpdir(),
    env: inheritedEnv(env),
    label: name,
    ...limits,
  };
}

export function realSupervisor(config?: Partial<ResolvedSupervisorConfig>): Supervisor {
  return createSupervisor({
    config: supervisorConfig(config),
    clock: realClock(),
    logger: recordingLogger(),
  });
}

/**
 * The portable tree-kill oracle (WP-2 acceptance 5): the grandchild appends to `$MARKER_FILE`
 * every 100 ms, so "the tree is gone" becomes "this file stopped growing" — an observation that
 * needs no pid introspection, which is precisely what Windows cannot give us.
 */
export async function markerStopsGrowingWithin(marker: string, budgetMs: number): Promise<boolean> {
  const size = (): number => {
    try {
      return statSync(marker).size;
    } catch {
      return -1;
    }
  };
  const deadline = Date.now() + budgetMs;
  let stable = 0;
  let last = size();
  while (Date.now() < deadline) {
    await sleep(100);
    const now = size();
    stable = now === last ? stable + 1 : 0;
    last = now;
    // Three consecutive quiet samples over 300 ms, against a writer with a 100 ms period.
    if (stable >= 3) return true;
  }
  return false;
}

export async function markerStartsGrowing(marker: string, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  let first = -1;
  while (Date.now() < deadline) {
    try {
      const size = statSync(marker).size;
      if (first === -1) first = size;
      else if (size > first) return true;
    } catch {
      /* not created yet */
    }
    await sleep(50);
  }
  return false;
}

// ── a RunUtility double ──────────────────────────────────────────────────────

export interface RecordedUtility {
  readonly file: string;
  readonly args: readonly string[];
}

export interface UtilityRecorder {
  readonly calls: readonly RecordedUtility[];
  readonly fn: RunUtility;
  /** Answers the next `tasklist` with this stdout. */
  tasklistStdout: string;
  taskkillCode: number;
  failWith: Error | null;
}

export function recordingUtility(): UtilityRecorder {
  const calls: RecordedUtility[] = [];
  const recorder: UtilityRecorder = {
    calls,
    tasklistStdout: "",
    taskkillCode: 0,
    failWith: null,
    fn: (file, args) => {
      calls.push({ file, args: [...args] });
      if (recorder.failWith !== null) return Promise.reject(recorder.failWith);
      return Promise.resolve(
        file === "tasklist"
          ? { code: 0, stdout: recorder.tasklistStdout }
          : { code: recorder.taskkillCode, stdout: "" },
      );
    },
  };
  return recorder;
}
