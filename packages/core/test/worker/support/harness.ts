import { createBaselineResponder, createWorker, type CreateWorkerDeps } from "@omni-acp/core";
import type {
  AcpStream,
  AgentDescriptor,
  AgentProcess,
  ClientRef,
  DaemonId,
  KillOutcome,
  Lease,
  Logger,
  ProcessExit,
  ProcessInfo,
  SpawnSpec,
  StderrTail,
  Supervisor,
  TokenId,
  WorkerHandle,
  WorkerId,
} from "@omni-acp/protocol";
import {
  fakeClock,
  fakeSupervisor,
  nullLogger,
  seqIds,
  type FakeAgentProcess,
  type FakeClock,
  type FakeSupervisor,
} from "@omni-acp/testkit";
import { arrayLog, type ArrayLog } from "./array-log.js";
import { lifecycleNormalizer, type RecordingNormalizer } from "./lifecycle-normalizer.js";

export const DAEMON_ID = "d_00000000000000000000000001" as DaemonId;
export const WORKER_ID = "w_00000000000000000000000001" as WorkerId;

export const OWNER: ClientRef = { tokenId: "tok_test" as TokenId, clientId: "cli_test" };

export const DESCRIPTOR: AgentDescriptor = {
  id: "test-agent",
  command: "/usr/bin/true",
  args: ["--acp"],
  env: { OMNI_TEST: "1" },
  protocolVersion: 1,
  shutdown: { signal: "SIGTERM", graceMs: 5_000 },
};

export const LIMITS = {
  handshakeTimeoutMs: 60_000,
  cancelGraceMs: 10_000,
  exitGraceMs: 1_000,
  gracefulMs: 5_000,
};

export const TEXT = (text: string): { type: "text"; text: string } => ({ type: "text", text });

export interface Harness {
  readonly clock: FakeClock;
  readonly supervisor: FakeSupervisor;
  readonly log: ArrayLog;
  readonly normalizer: RecordingNormalizer;
  /** `append:<kind>` and `write:<method>` in the order they actually happened. */
  readonly trace: string[];
  readonly logger: Logger;
  deps(overrides?: Partial<CreateWorkerDeps>): CreateWorkerDeps;
  create(o?: {
    signal?: AbortSignal;
    overrides?: Partial<CreateWorkerDeps>;
  }): Promise<WorkerHandle>;
  /** The `FakeAgentProcess` the (single) spawn produced. */
  process(): FakeAgentProcess;
}

/** A lease that records every `assertHolder`, so the "who" plumbing is observable. */
export interface RecordingLease extends Lease {
  readonly asserted: readonly ClientRef[];
}

export function recordingLease(holder: ClientRef): RecordingLease {
  const asserted: ClientRef[] = [];
  return {
    holder,
    assertHolder(who: ClientRef): void {
      asserted.push(who);
    },
    acquire(): void {
      throw new Error("acquire is M1");
    },
    release(): void {
      throw new Error("release is M1");
    },
    asserted,
  };
}

export function harness(o?: { quietMs?: number; hardMs?: number }): Harness {
  const clock = fakeClock();
  const supervisor = fakeSupervisor();
  const trace: string[] = [];
  const log = arrayLog({ workerId: WORKER_ID, daemonId: DAEMON_ID, clock, trace });
  const normalizer = lifecycleNormalizer({
    quietMs: o?.quietMs ?? 250,
    hardMs: o?.hardMs ?? 5_000,
  });
  const logger = nullLogger();

  const base = (): CreateWorkerDeps => ({
    workerId: WORKER_ID,
    daemonId: DAEMON_ID,
    descriptor: DESCRIPTOR,
    cwd: "/tmp/omni-acp-test",
    label: "unit",
    owner: OWNER,
    supervisor,
    log,
    normalizer,
    // M0 wires exactly this one (L7, §7.4); a test that wants the allow branch overrides it.
    responder: createBaselineResponder("deny", clock),
    lease: recordingLease(OWNER),
    clock,
    ids: seqIds(),
    logger,
    limits: LIMITS,
  });

  return {
    clock,
    supervisor,
    log,
    normalizer,
    trace,
    logger,
    deps(overrides) {
      return { ...base(), ...overrides };
    },
    create(opts) {
      return createWorker({ ...base(), ...opts?.overrides }, opts?.signal);
    },
    process(): FakeAgentProcess {
      const first = [...supervisor.live][0];
      if (first === undefined) throw new Error("no live process");
      return first as FakeAgentProcess;
    },
  };
}

/**
 * A `Supervisor` that hands back exactly the process it was given.
 *
 * `fakeSupervisor()` covers every case where the process is ordinary. This one exists for the
 * two where it is not: the zombie (stdout EOF with no `exit`) and the interleaving oracle, both
 * of which need control the testkit fake deliberately does not expose.
 */
export function fixedSupervisor(
  proc: AgentProcess,
  platform: Supervisor["platform"],
): Supervisor & { readonly specs: readonly SpawnSpec[] } {
  const live = new Set<AgentProcess>([proc]);
  const specs: SpawnSpec[] = [];
  return {
    platform,
    specs,
    live,
    spawn(spec) {
      specs.push(spec);
      return Promise.resolve(proc);
    },
    async shutdown() {
      const outcome = await proc.terminate({ force: true });
      live.clear();
      return [outcome];
    },
  };
}

export interface ControlledProcess extends AgentProcess {
  /** stdout EOF WITHOUT an exit — the grandchild-holds-the-pipe case. */
  endStdout(): void;
  emitExit(code: number | null, signal?: string | null, requested?: boolean): void;
  writeStderr(s: string): void;
  readonly terminateCalls: readonly { gracefulMs?: number; force?: boolean }[];
  readonly finalizeCalls: number;
}

/** An `AgentProcess` whose `stdoutEnded` and `exited` settle INDEPENDENTLY (§6.7). */
export function controlledProcess(stream: AcpStream): ControlledProcess {
  const terminateCalls: { gracefulMs?: number; force?: boolean }[] = [];
  let livePid: number | null = 909_090;
  let exit: ProcessExit | null = null;
  let stderrBuffer = "";
  let finalizeCalls = 0;

  let settleExit!: (e: ProcessExit) => void;
  let settleStdout!: () => void;
  const exited = new Promise<ProcessExit>((r) => {
    settleExit = r;
  });
  const stdoutEnded = new Promise<void>((r) => {
    settleStdout = r;
  });

  const stderr: StderrTail = {
    snapshot: () => stderrBuffer,
    onLine: () => () => {},
    finalize: () => {
      finalizeCalls += 1;
    },
  };

  const info: ProcessInfo = {
    pid: 909_090,
    groupId: 909_090,
    startedAt: new Date(0).toISOString(),
    command: "controlled",
    argsRedacted: [],
  };

  const finish = (code: number | null, signal: string | null, requested: boolean): void => {
    if (exit !== null) return;
    exit = { code, signal, at: 0, requested };
    livePid = null;
    settleStdout();
    settleExit(exit);
  };

  return {
    get pid() {
      return livePid;
    },
    info,
    stream,
    stderr,
    exited,
    stdoutEnded,
    closeStdin() {},
    terminate(opts) {
      terminateCalls.push(opts ?? {});
      finish(null, "SIGKILL", true);
      return Promise.resolve<KillOutcome>({
        exit,
        leaderExited: true,
        treeGone: true,
        escalatedTo: "sigkill",
        durationMs: 1,
      });
    },
    endStdout() {
      settleStdout();
    },
    emitExit(code, signal, requested) {
      finish(code, signal ?? null, requested ?? false);
    },
    writeStderr(s) {
      stderrBuffer += s;
    },
    terminateCalls,
    get finalizeCalls() {
      return finalizeCalls;
    },
  };
}

/** Records the method name of every message written towards the agent, in order. */
export function tapWrites(stream: AcpStream, trace: string[]): AcpStream {
  const writer = stream.writable.getWriter();
  const writable = new WritableStream({
    write(chunk: unknown) {
      const method = (chunk as { method?: unknown }).method;
      trace.push(`write:${typeof method === "string" ? method : "response"}`);
      return writer.write(chunk as never);
    },
    close() {
      return writer.close();
    },
    abort(reason: unknown) {
      return writer.abort(reason);
    },
  });
  return { writable, readable: stream.readable } as AcpStream;
}

/** Lets a test wait for the agent side to have observed something, without sleeping. */
export async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
  await new Promise<void>((r) => setImmediate(r));
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}
