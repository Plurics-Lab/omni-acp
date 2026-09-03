import {
  OmniError,
  type AgentProcess,
  type KillOutcome,
  type PlatformOps,
  type PlatformOwnership,
  type ProcessExit,
  type ProcessInfo,
  type SpawnSpec,
  type StderrTail,
  type Supervisor,
  type TerminationRung,
} from "@omni-acp/protocol";
import { scriptedAgent, type ScriptedAgent } from "./scripted-agent.js";

export interface FakeAgentProcess extends AgentProcess {
  simulateExit(code: number | null, signal?: string | null): void;
  writeStderr(s: string): void;
  readonly terminateCalls: readonly { gracefulMs?: number; force?: boolean }[];
}

export interface FakeSupervisor extends Supervisor {
  readonly spawnCalls: readonly SpawnSpec[];
  /** Registers the ScriptedAgent the next spawn() will be wired to. */
  enqueue(agent: ScriptedAgent | { failWith: Error }): void;
  allTreesReclaimed(): boolean;
}

const POSIX_OWNERSHIP: PlatformOwnership = {
  kind: "posix-process-group",
  confirmsTreeGone: true,
  survivesDaemonKill: true,
  caveat: null,
};

/** Obviously synthetic: a four-digit pid would be mistaken for a real one in a failure message. */
let nextPid = 424_242;

/**
 * Decodes a byte ring the way CONTRACTS.md contracts.ts:112 specifies: an incomplete rune at
 * either end is hidden rather than surfaced as U+FFFD or a lone surrogate.
 */
function decodeTail(buf: Buffer): string {
  let start = 0;
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start += 1; // dangling continuation
  let end = buf.length;
  for (let i = end - 1; i >= start && end - i <= 4; i -= 1) {
    const b = buf[i]!;
    if ((b & 0xc0) === 0x80) continue; // a continuation byte: keep walking back to its lead
    const needed = b < 0x80 ? 1 : (b & 0xe0) === 0xc0 ? 2 : (b & 0xf0) === 0xe0 ? 3 : 4;
    if (needed > end - i) end = i; // the rune's tail bytes have not arrived
    break;
  }
  return new TextDecoder("utf-8").decode(buf.subarray(start, end));
}

function fakeStderrTail(maxBytes: number): StderrTail & { write(s: string): void } {
  let buffered = Buffer.alloc(0);
  let pendingLine = "";
  let finalized = false;
  const listeners = new Set<(line: string) => void>();

  const emit = (line: string): void => {
    for (const cb of listeners) cb(line);
  };

  return {
    write(s: string): void {
      // BYTES, not UTF-16 code units: `stderrTailBytes` is a byte budget, and slicing a string
      // can also cut a surrogate pair in half.
      const next = Buffer.concat([buffered, Buffer.from(s, "utf8")]);
      buffered = next.length > maxBytes ? next.subarray(next.length - maxBytes) : next;
      pendingLine += s;
      for (;;) {
        const at = pendingLine.indexOf("\n");
        if (at === -1) break;
        emit(pendingLine.slice(0, at));
        pendingLine = pendingLine.slice(at + 1);
      }
    },
    snapshot: () => decodeTail(buffered),
    onLine(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    finalize() {
      if (finalized) return;
      finalized = true;
      if (pendingLine !== "") {
        emit(pendingLine);
        pendingLine = "";
      }
    },
  };
}

function fakePlatformOps(ownership: PlatformOwnership): PlatformOps {
  const windows = ownership.kind === "windows-taskkill-tree";
  return {
    ownership,
    spawnOptions: ({ windowsHide }) =>
      windows ? { detached: false, windowsHide } : { detached: true, windowsHide: false },
    resolveLaunch: (command, args) =>
      Promise.resolve({ file: command, args: [...args], windowsVerbatimArguments: false }),
    signalTree: (_p, sig) =>
      Promise.resolve<TerminationRung>(
        sig === "SIGTERM" ? "sigterm" : windows ? "taskkill" : "sigkill",
      ),
    isTreeGone: (p) =>
      Promise.resolve(ownership.confirmsTreeGone && (p as FakeAgentProcess).pid === null),
    isLeaderGone: (p) => Promise.resolve((p as FakeAgentProcess).pid === null),
  };
}

interface ProcessState {
  exited: boolean;
  terminated: boolean;
}

function createFakeAgentProcess(
  spec: SpawnSpec,
  agent: ScriptedAgent,
  ownership: PlatformOwnership,
  onExit: (p: FakeAgentProcess) => void,
): { process: FakeAgentProcess; state: ProcessState } {
  const pid = nextPid++;
  const windows = ownership.kind === "windows-taskkill-tree";
  const startedAt = new Date().toISOString();
  const stderr = fakeStderrTail(spec.stderrTailBytes ?? 32 * 1024);
  const state = { exited: false, terminated: false };
  const terminateCalls: { gracefulMs?: number; force?: boolean }[] = [];

  let livePid: number | null = pid;
  let exit: ProcessExit | null = null;
  let settleExit!: (e: ProcessExit) => void;
  let settleStdout!: () => void;
  const exited = new Promise<ProcessExit>((resolve) => {
    settleExit = resolve;
  });
  const stdoutEnded = new Promise<void>((resolve) => {
    settleStdout = resolve;
  });

  const finish = (code: number | null, signal: string | null, requested: boolean): void => {
    if (exit !== null) return;
    exit = { code, signal, at: Date.now(), requested };
    state.exited = true;
    livePid = null;
    stderr.finalize();
    agent.die();
    settleStdout();
    settleExit(exit);
    onExit(process_);
  };

  let killRun: Promise<KillOutcome> | null = null;

  const info: ProcessInfo = {
    pid,
    groupId: windows ? null : pid,
    startedAt,
    command: spec.command,
    argsRedacted: [...spec.args],
  };

  const process_: FakeAgentProcess = {
    get pid() {
      return livePid;
    },
    info,
    stream: agent.stream,
    stderr,
    exited,
    stdoutEnded,
    closeStdin() {
      // A real ACP agent exits on stdin EOF; the fake models that as an ordinary requested exit.
      finish(0, null, true);
    },
    terminate(opts) {
      terminateCalls.push(opts ?? {});
      state.terminated = true;
      if (killRun !== null) return killRun; // idempotent: concurrent callers share one run
      const startedAtMs = Date.now();
      const alreadyExited = exit !== null;
      killRun = (async () => {
        if (!alreadyExited)
          finish(opts?.force === true ? null : 0, opts?.force === true ? "SIGKILL" : null, true);
        const escalatedTo: TerminationRung = alreadyExited
          ? "already_exited"
          : opts?.force === true
            ? windows
              ? "taskkill"
              : "sigkill"
            : "sigterm";
        return {
          exit,
          leaderExited: true,
          // Never optimistic: Windows cannot prove it, so the fake will not either (D10).
          treeGone: ownership.confirmsTreeGone,
          escalatedTo,
          durationMs: Date.now() - startedAtMs,
        } satisfies KillOutcome;
      })();
      return killRun;
    },
    simulateExit(code, signal) {
      finish(code, signal ?? null, false);
    },
    writeStderr(s) {
      stderr.write(s);
    },
    terminateCalls,
  };

  return { process: process_, state };
}

/**
 * A Supervisor that spawns no process.
 *
 * `spawn()` wires the next enqueued `ScriptedAgent` — or, when the queue is empty, a fresh one,
 * so a lifecycle test that does not care about the conversation still gets a working handshake.
 */
export function fakeSupervisor(opts?: { ownership?: PlatformOwnership }): FakeSupervisor {
  const ownership = opts?.ownership ?? POSIX_OWNERSHIP;
  const platform = fakePlatformOps(ownership);
  const spawnCalls: SpawnSpec[] = [];
  const queue: (ScriptedAgent | { failWith: Error })[] = [];
  const tracked: ProcessState[] = [];
  const live = new Set<AgentProcess>();

  return {
    platform,
    spawnCalls,
    live,

    enqueue(agent) {
      queue.push(agent);
    },

    spawn(spec, signal) {
      spawnCalls.push(spec);
      if (signal?.aborted === true) {
        return Promise.reject(OmniError.from(signal.reason, "agent_timeout"));
      }
      const next = queue.shift();
      if (next !== undefined && "failWith" in next) return Promise.reject(next.failWith);

      const agent = next ?? scriptedAgent({ name: spec.label ?? "fake" });
      const { process: created, state } = createFakeAgentProcess(spec, agent, ownership, (p) => {
        live.delete(p);
      });
      tracked.push(state);
      live.add(created);
      return Promise.resolve(created as AgentProcess);
    },

    async shutdown(o) {
      const outcomes = await Promise.all(
        [...live].map((p) =>
          p.terminate({
            force: true,
            ...(o?.gracefulMs === undefined ? {} : { gracefulMs: o.gracefulMs }),
          }),
        ),
      );
      live.clear();
      return outcomes;
    },

    allTreesReclaimed() {
      return live.size === 0 && tracked.every((t) => t.exited);
    },
  };
}
