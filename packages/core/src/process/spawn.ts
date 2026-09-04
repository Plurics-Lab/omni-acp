import { ndJsonStream } from "@agentclientprotocol/sdk";
import {
  OmniError,
  redactArgs,
  type AgentProcess,
  type Clock,
  type Logger,
  type PlatformOps,
  type ProcessExit,
  type ProcessInfo,
  type RunUtility,
  type SpawnSpec,
} from "@omni-acp/protocol";
import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { createAgentProcess, createTerminationLadder } from "./agent-process.js";
import { createFrameLimit } from "./frame-limit.js";
import { createStderrTail } from "./stderr-tail.js";

/**
 * THE ONLY file in this repository allowed to import `node:child_process`.
 *
 * A vitest guard (`no-direct-spawn`, WP-2) walks every TypeScript source file under `packages/` and fails on any other
 * import of that module, and separately on any `spawn(` / `exec(` / `execFile(` / `fork(` call
 * site outside this file. It is multica's `TestOnlyLaunchGoSpawnsRuntimeProcesses`, ported,
 * and it exists because per-backend opt-in left 19 of 27 spawn sites without a process group
 * (multica GH #7522, CONTRACTS.md F10).
 *
 * The launch sequence is CONTRACTS.md §6.2. Two details that a reader will otherwise get wrong:
 *
 *  - `stdio: ["pipe","pipe","pipe"]` — never "inherit", because stderr must stay sniffable, and
 *    `shell: false` — never true, because a shell is both an injection surface and an extra
 *    process layer that breaks tree kill.
 *  - `acp.ndJsonStream(output, input)` takes what WE WRITE first (the child's stdin) and what we
 *    READ second (the child's stdout). The SDK's own example names these locals misleadingly
 *    (CONTRACTS.md F6); a test pins the order.
 */

/** Mirrors `SupervisorConfig`'s defaults so a bare `SpawnSpec` is still fully specified. */
const DEFAULTS = {
  gracefulMs: 5_000,
  killConfirmMs: 2_000,
  exitGraceMs: 1_000,
  maxFrameBytes: 32 * 1024 * 1024,
  stderrTailBytes: 32 * 1024,
} as const;

/** Utility stdout is a diagnostic, not a payload: past this it is a bug, not information. */
const UTILITY_STDOUT_CAP = 1024 * 1024;

export interface SpawnDeps {
  readonly clock: Clock;
  readonly logger: Logger;
  readonly allowShimLaunch: boolean;
  /**
   * `supervisor.windowsHide` (CONTRACTS.md §6.4). Not on `SpawnSpec`, which is frozen and
   * describes the AGENT; this is daemon configuration, so the Supervisor passes it down.
   */
  readonly windowsHide?: boolean;
  /**
   * Injected only by unit tests that observe argv without spawning — `SupervisorOptions.spawnFn`,
   * threaded through. A TYPE reference to `node:child_process` is legal everywhere (§6.1); the
   * VALUE lives here and nowhere else, which is why it has to be handed down rather than
   * imported at the call site.
   */
  readonly spawnFn?: typeof spawn;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * A function, not an inline `signal?.aborted === true`: the compiler carries the narrowing from
 * the first check across every `await` in between, and the whole point of the second check is
 * that the answer may have changed while the process was starting.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

function abortError(signal: AbortSignal): OmniError {
  return OmniError.from(signal.reason, "agent_timeout");
}

/**
 * Resolves once the child has actually started, or with the reason it never did.
 *
 * Node emits `spawn` exactly once on success and `error` instead on failure, so this is the one
 * place a launch failure is distinguishable from an agent that starts and then dies — the
 * difference between `spawn_failed` and a crash (§6.7). Both listeners are attached before any
 * `await`, so neither event can be missed and `error` can never go unhandled.
 */
function waitForStart(child: ChildProcess): Promise<Error | null> {
  return new Promise<Error | null>((resolve) => {
    const onSpawn = (): void => {
      child.off("error", onError);
      resolve(null);
    };
    const onError = (e: Error): void => {
      child.off("spawn", onSpawn);
      resolve(e);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

export async function spawnAgentProcess(
  spec: SpawnSpec,
  platform: PlatformOps,
  deps: SpawnDeps,
  signal?: AbortSignal,
): Promise<AgentProcess> {
  if (signal !== undefined && isAborted(signal)) throw abortError(signal);

  const gracefulMs = spec.gracefulMs ?? DEFAULTS.gracefulMs;
  const killConfirmMs = spec.killConfirmMs ?? DEFAULTS.killConfirmMs;
  const exitGraceMs = spec.exitGraceMs ?? DEFAULTS.exitGraceMs;
  const maxFrameBytes = spec.maxFrameBytes ?? DEFAULTS.maxFrameBytes;
  const stderrTailBytes = spec.stderrTailBytes ?? DEFAULTS.stderrTailBytes;

  // 1. PATH/PATHEXT, and the .cmd/.bat refusal (§6.3). Throws `bad_request` on a shim.
  const launch = await platform.resolveLaunch(spec.command, spec.args, deps.allowShimLaunch);
  const ownership = platform.spawnOptions({ windowsHide: deps.windowsHide ?? true });
  const spawnFn = deps.spawnFn ?? spawn;

  // 2. The one spawn of a long-lived agent in this repository.
  let child: ChildProcess;
  try {
    child = spawnFn(launch.file, launch.args, {
      cwd: spec.cwd,
      // The COMPLETE environment: the Supervisor adds nothing and removes nothing (contracts.ts).
      env: { ...spec.env },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      detached: ownership.detached,
      windowsHide: ownership.windowsHide,
      windowsVerbatimArguments: launch.windowsVerbatimArguments,
    });
  } catch (e) {
    // A `.cmd` without a shell throws synchronously on some Node versions and emits `error` on
    // others; §6.7 classifies both the same way.
    throw new OmniError("agent_error", `could not spawn "${launch.file}": ${messageOf(e)}`, {
      cause: e,
      detail: { file: launch.file, cwd: spec.cwd },
    });
  }

  const childStdin = child.stdin;
  const childStdout = child.stdout;
  const childStderr = child.stderr;
  if (childStdin === null || childStdout === null || childStderr === null) {
    throw new OmniError("internal", "spawn returned a child without piped stdio", {
      detail: { file: launch.file },
    });
  }

  // 3. `exit` is wired BEFORE anything can await, so the signal cannot be missed.
  let exit: ProcessExit | null = null;
  let requested = false;
  let livePid: number | null = child.pid ?? null;

  let settleExit!: (e: ProcessExit) => void;
  const exited = new Promise<ProcessExit>((resolve) => {
    settleExit = resolve;
  });
  let settleStdoutEnded!: () => void;
  const stdoutEnded = new Promise<void>((resolve) => {
    settleStdoutEnded = resolve;
  });

  const stderr = createStderrTail({ maxBytes: stderrTailBytes });

  child.on("exit", (code, signalName) => {
    if (exit !== null) return;
    const settled: ProcessExit = {
      code: code ?? null,
      signal: signalName ?? null,
      at: deps.clock.now(),
      requested,
    };
    exit = settled;
    livePid = null;
    // The last unterminated stderr line is usually the crash reason (multica `acp_terminal.go`).
    stderr.finalize();
    settleExit(settled);
  });

  // 4. stdout EOF is a SEPARATE death signal from `exit`: it can precede it by milliseconds or
  //    follow it by forever, when a grandchild inherited the pipe (contracts.ts, §6.7).
  childStdout.once("end", () => {
    settleStdoutEnded();
  });
  childStdout.once("close", () => {
    settleStdoutEnded();
  });

  const failure = await waitForStart(child);
  if (failure !== null) {
    throw new OmniError("agent_error", `could not spawn "${launch.file}": ${failure.message}`, {
      cause: failure,
      detail: { file: launch.file, cwd: spec.cwd },
    });
  }
  // Past the start gate an `error` is a live-process fault, not a launch failure — but it still
  // needs a listener, or Node turns it into an uncaught exception.
  child.on("error", (e: Error) => {
    deps.logger.warn("agent process error", { pid: child.pid, error: e.message });
  });
  livePid = child.pid ?? null;

  // 5. stderr: drained (an undrained pipe eventually blocks the child) into the tail ring.
  childStderr.on("data", (chunk: Buffer) => {
    stderr.write(chunk);
  });
  childStderr.once("end", () => {
    stderr.finalize();
  });

  // 6. The transport. F6: ndJsonStream(what we WRITE, what we READ) — in that order.
  const stream = ndJsonStream(
    Writable.toWeb(childStdin) as WritableStream<Uint8Array>,
    (Readable.toWeb(childStdout) as ReadableStream<Uint8Array>).pipeThrough(
      createFrameLimit(maxFrameBytes),
    ),
  );

  const pid = child.pid ?? null;
  const info: ProcessInfo = {
    // Captured at spawn by M1-WP-C (`process/fingerprint.ts`); until then it is honestly absent,
    // and an absent fingerprint is the value that FORBIDS signalling this pid after a restart.
    fingerprint: null,
    pid: pid ?? -1,
    // POSIX `detached` means setsid(), so pgid === pid. Windows has no addressable group, and
    // this is derived from the ownership decision rather than from `process.platform` (§6.1).
    groupId: ownership.detached ? pid : null,
    startedAt: deps.clock.iso(),
    command: launch.file,
    argsRedacted: redactArgs(launch.args),
  };

  const closeStdin = (): void => {
    try {
      childStdin.end();
    } catch {
      // "Never blocks, never throws" (contracts.ts). A stdin that is already closed, or a child
      // that is already gone, is exactly the state this call is trying to reach.
    }
  };

  // A holder, not a `let`: the ladder needs the `AgentProcess` and the `AgentProcess` is built
  // around the ladder, so exactly one of the two has to be reached through a thunk.
  const holder: { current: AgentProcess | null } = { current: null };
  const ladder = createTerminationLadder({
    platform,
    clock: deps.clock,
    logger: deps.logger,
    target: () => {
      const p = holder.current;
      if (p === null) {
        throw new OmniError("internal", "termination ladder ran before its process existed");
      }
      return p;
    },
    closeStdin,
    exited,
    exitNow: () => exit,
    markRequested: () => {
      requested = true;
    },
    gracefulMs,
    killConfirmMs,
    exitGraceMs,
  });

  const created = createAgentProcess({
    get pid(): number | null {
      return livePid;
    },
    info,
    stream,
    stderr,
    exited,
    stdoutEnded,
    closeStdin,
    terminate: ladder,
  });
  holder.current = created;

  if (signal !== undefined && isAborted(signal)) {
    await created.terminate({ force: true });
    throw abortError(signal);
  }

  return created;
}

/**
 * The second — and last — spawn site in the repository: a short-lived utility process whose
 * stdout is read to completion and whose exit code is returned (CONTRACTS.md §6.4, review R8).
 *
 * `taskkill /PID <pid> /T /F` and `tasklist /FI "PID eq <pid>" /NH` are the only M0 callers.
 * They cannot go through `Supervisor.spawn()`, which wires an ACP ndJSON stream, a frame
 * limiter and a stderr tail around a long-lived agent — the wrong shape entirely.
 *
 * `platform-windows.ts` receives this by injection (`createPlatformOps(platform, { runUtility })`)
 * rather than importing this module, because this module consumes `PlatformOps` and the import
 * would be a cycle. The `no-direct-spawn` guard's allowlist is this file, and this file only.
 *
 * Never throws for a non-zero exit: the code comes back in the result. It rejects only when the
 * process cannot be started at all, or when `timeoutMs` elapses (the child is then killed).
 */
export function runUtility(
  file: string,
  args: readonly string[],
  o: { timeoutMs: number },
): Promise<{ code: number | null; stdout: string }> {
  return new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(file, [...args], {
        // stdin is not offered and stderr is not read: a utility that wants to say something
        // says it with an exit code.
        stdio: ["ignore", "pipe", "ignore"],
        shell: false,
        windowsHide: true,
      });
    } catch (e) {
      reject(new OmniError("internal", `could not run "${file}": ${messageOf(e)}`, { cause: e }));
      return;
    }

    let stdout = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // Nothing left to kill; the rejection below is still the right answer.
      }
      reject(
        new OmniError("internal", `"${file}" did not finish within ${String(o.timeoutMs)}ms`, {
          detail: { file, timeoutMs: o.timeoutMs },
        }),
      );
    }, o.timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < UTILITY_STDOUT_CAP) stdout += chunk;
    });
    child.on("error", (e: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new OmniError("internal", `could not run "${file}": ${e.message}`, { cause: e }));
    });
    // `close`, not `exit`: stdout has to be flushed before the caller reads it.
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? null, stdout });
    });
  });
}

/** The declaration above IS `RunUtility`; this assignment is the compile-time proof. */
const _runUtilityMatchesContract: RunUtility = runUtility;
void _runUtilityMatchesContract;
