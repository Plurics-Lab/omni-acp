/**
 * The cross-package seam.
 *
 * `tsc -b` project references must be acyclic. `testkit` must produce values typed as
 * `Supervisor` / `AgentProcess` / `EventLog` / `Daemon`, while `core`'s and `daemon`'s tests
 * consume `testkit`. Putting those interfaces in `core` (or `Daemon` in `daemon`) forces a cycle.
 * So this file holds EVERY interface that crosses a package boundary; `core` and `daemon`
 * implement and re-export them (CONTRACTS.md §4).
 *
 * TYPES ONLY — no runtime values, no imports from any other @omni-acp package. FROZEN by the
 * scaffold (M0-PLAN.md §1.2).
 */

import type {
  AcpStream,
  RequestPermissionRequest,
  RequestPermissionResponse,
  StopReason,
} from "./acp.js";
import type {
  AgentCatalogEntry,
  CreateWorkerRequest,
  DaemonInfo,
  PromptAccepted,
  WhoAmIResponse,
} from "./control-plane.js";
import type { AgentDescriptor, ResolvedDaemonConfig } from "./config.js";
import type { OmniErrorBody } from "./errors.js";
import type {
  EventEnvelope,
  EventInput,
  PolicyDecisionPayload,
  WorkerCloseReason,
  WorkerState,
} from "./events.js";
import type { ClientId, DaemonId, Seq, SessionId, TokenId, TurnId, WorkerId } from "./ids.js";
import type { TurnStatus } from "./turn.js";
import type { CloseResult, ProcessInfo, WorkerSnapshot } from "./worker.js";

// ── ambient ──────────────────────────────────────────────────────────────────

export interface TimerHandle {
  cancel(): void;
}

export interface Clock {
  /** epoch ms */
  now(): number;
  /** ISO-8601 of now(), with milliseconds */
  iso(): string;
  setTimer(delayMs: number, fn: () => void): TimerHandle;
}

export interface IdGen {
  daemon(): DaemonId;
  worker(): WorkerId;
  turn(): TurnId;
  request(): string;
}

export interface Logger {
  child(bindings: Record<string, unknown>): Logger;
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

// ── process layer (WP-2 implements) ──────────────────────────────────────────

export interface SpawnSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** The COMPLETE environment. The Supervisor adds nothing and removes nothing. */
  readonly env: Readonly<Record<string, string>>;
  readonly gracefulMs?: number;
  readonly killConfirmMs?: number;
  readonly exitGraceMs?: number;
  readonly maxFrameBytes?: number;
  readonly stderrTailBytes?: number;
  readonly shutdownSignal?: string;
  /** Diagnostics only. */
  readonly label?: string;
}

export interface ProcessExit {
  readonly code: number | null;
  readonly signal: string | null;
  readonly at: number;
  /** true when we initiated the exit, not the agent. */
  readonly requested: boolean;
}

export type TerminationRung = "already_exited" | "stdin_eof" | "sigterm" | "sigkill" | "taskkill";

export interface KillOutcome {
  readonly exit: ProcessExit | null;
  /** The leader is confirmed absent. */
  readonly leaderExited: boolean;
  /**
   * The WHOLE tree is provably gone. POSIX: kill(-pgid,0) === ESRCH within killConfirmMs.
   * Windows M0: ALWAYS false — taskkill /T cannot prove it. Never optimistic.
   */
  readonly treeGone: boolean;
  readonly escalatedTo: TerminationRung;
  readonly durationMs: number;
}

export interface StderrTail {
  /** Last N bytes as valid UTF-8; an incomplete trailing rune is hidden. */
  snapshot(): string;
  /** Complete lines only. Returns an unsubscribe. */
  onLine(cb: (line: string) => void): () => void;
  /** Flush a trailing unterminated line at EOF. Idempotent — this is the crash reason. */
  finalize(): void;
}

export interface AgentProcess {
  readonly pid: number | null;
  readonly info: ProcessInfo;
  /** The ACP transport seam (CONTRACTS.md F7). FakeAgentProcess supplies an in-memory pair. */
  readonly stream: AcpStream;
  readonly stderr: StderrTail;
  /** Resolves on the child's `exit`. NEVER rejects. */
  readonly exited: Promise<ProcessExit>;
  /**
   * Resolves when stdout EOFs. May fire BEFORE `exited` (transport dies first) or long
   * AFTER it (a grandchild inherited the pipe and holds it open). Both are handled by Worker.
   */
  readonly stdoutEnded: Promise<void>;
  /** Graceful: EOF on stdin. Never blocks, never throws. */
  closeStdin(): void;
  /** The full escalation ladder (CONTRACTS.md §6.5). Idempotent; concurrent callers share one run. */
  terminate(opts?: { gracefulMs?: number; force?: boolean }): Promise<KillOutcome>;
}

export interface PlatformOwnership {
  readonly kind: "posix-process-group" | "windows-taskkill-tree";
  /** Can terminate() positively prove the whole tree is gone? */
  readonly confirmsTreeGone: boolean;
  /** Do descendants survive a SIGKILL of the daemon itself? */
  readonly survivesDaemonKill: boolean;
  /** Human-readable caveat, surfaced verbatim in GET /v1/info. */
  readonly caveat: string | null;
}

/** Platform-specific operations. Chosen ONCE, at Supervisor construction — never at kill time. */
export interface PlatformOps {
  readonly ownership: PlatformOwnership;
  /** POSIX {detached:true, windowsHide:false}; Windows {detached:false, windowsHide:true}. */
  spawnOptions(cfg: { windowsHide: boolean }): { detached: boolean; windowsHide: boolean };
  /** Resolve command+args through PATH/PATHEXT; refuse .cmd/.bat unless allowShim (§6.3). */
  resolveLaunch(
    command: string,
    args: readonly string[],
    allowShim: boolean,
  ): Promise<{ file: string; args: string[]; windowsVerbatimArguments: boolean }>;
  /** POSIX: kill(-pgid, sig). Windows: no-op for SIGTERM; taskkill /T /F for SIGKILL. */
  signalTree(p: AgentProcess, sig: "SIGTERM" | "SIGKILL"): Promise<TerminationRung>;
  /** POSIX: kill(-pgid,0) === ESRCH. Windows: always false. */
  isTreeGone(p: AgentProcess): Promise<boolean>;
  /** POSIX: kill(pid,0). Windows: tasklist /FI. */
  isLeaderGone(p: AgentProcess): Promise<boolean>;
}

export interface Supervisor {
  readonly platform: PlatformOps;
  /** THE ONLY caller of node:child_process in this repository (test-enforced, F10). */
  spawn(spec: SpawnSpec, signal?: AbortSignal): Promise<AgentProcess>;
  readonly live: ReadonlySet<AgentProcess>;
  /** Kill everything still owned, in parallel, bounded. Called by daemon.stop(). */
  shutdown(opts?: { gracefulMs?: number; timeoutMs?: number }): Promise<KillOutcome[]>;
}

// ── event log (WP-3 implements) ──────────────────────────────────────────────

export type EventListener = (e: EventEnvelope) => void;

export interface Subscription {
  close(): void;
  readonly closed: boolean;
}

export interface EventLog {
  readonly workerId: WorkerId;
  /** Highest assigned seq. 0 when empty. */
  readonly head: Seq;
  /** Lowest retained seq. 1 until the ring evicts. */
  readonly tail: Seq;
  readonly subscriberCount: number;
  /**
   * SYNCHRONOUS by contract, even for a future persisting driver.
   * The ONLY place a `seq` is ever assigned (CONTRACTS.md §8.2, test-enforced).
   */
  append(input: EventInput): EventEnvelope;
  appendAll(inputs: readonly EventInput[]): EventEnvelope[];
  /** Exclusive lower bound: returns seq > since, ascending. */
  read(since: Seq, limit?: number): readonly EventEnvelope[];
  /**
   * Replays read(since) into `listener`, then attaches the live tail, in ONE synchronous
   * critical section — no event can slip between replay and live. `listener` MUST be
   * synchronous and MUST NOT throw.
   */
  subscribe(
    since: Seq,
    listener: EventListener,
    opts?: { onOverflow?: (lastDelivered: Seq) => void; queueSize?: number },
  ): Subscription;
  /** Closes every subscription. Idempotent. */
  close(): void;
  /** Called once, right after session/new, so replayed envelopes carry the sessionId. */
  setSessionId(id: SessionId): void;
}

// ── normalizer (WP-3 implements) ─────────────────────────────────────────────

export type TurnInput =
  | { readonly type: "prompt_sent"; readonly turnId: TurnId; readonly at: number }
  | { readonly type: "agent_update"; readonly update: unknown; readonly at: number }
  | { readonly type: "prompt_result"; readonly stopReason: StopReason; readonly at: number }
  | { readonly type: "prompt_error"; readonly error: OmniErrorBody; readonly at: number }
  | {
      readonly type: "process_gone";
      readonly error: OmniErrorBody;
      readonly stderrTail: string;
      readonly at: number;
    }
  | { readonly type: "tick"; readonly at: number };

export type SettleReason = "quiet" | "hard" | "error" | "gone";

export interface TurnOutput {
  /** Appended to the log in array order, in one synchronous loop. */
  readonly emit: readonly EventInput[];
  /** Absolute epoch-ms at which the Worker must deliver a `tick`, or null. */
  readonly scheduleTickAt: number | null;
  readonly state: "idle" | "running" | "settling";
  readonly turnId: TurnId | null;
  readonly settled: SettleReason | null;
}

export interface Normalizer {
  readonly sourceProtocolVersion: 1;
  readonly slice: "m0-lifecycle";
  /** PURE. No timers, no I/O, no async. Same inputs => same outputs, forever. */
  step(input: TurnInput): TurnOutput;
}

// ── permission responder (WP-4 implements) ───────────────────────────────────

export interface PermissionDecision {
  /** null => the Worker must reply with JSON-RPC -32603 (D4 rule 4). */
  readonly response: RequestPermissionResponse | null;
  readonly record: PolicyDecisionPayload;
}

export interface PermissionResponder {
  decide(req: RequestPermissionRequest): PermissionDecision;
}

// ── lease (WP-4 implements; D5 enforcement is M1) ────────────────────────────

export interface ClientRef {
  readonly tokenId: TokenId;
  readonly clientId: ClientId | null;
}

export interface Lease {
  readonly holder: ClientRef | null;
  /** M0: never throws. M1: throws OmniError("lease_held"). Callers already branch today. */
  assertHolder(who: ClientRef): void;
  /** M0: throws bad_request. */
  acquire(who: ClientRef, opts?: { steal?: boolean }): void;
  /** M0: throws bad_request. */
  release(who: ClientRef): void;
}

// ── worker handle (WP-4 implements; WP-5 consumes) ───────────────────────────

export interface WorkerHandle {
  readonly id: WorkerId;
  readonly log: EventLog;
  readonly lease: Lease;
  snapshot(): WorkerSnapshot;
  /** Returns once `state_update{running}` is appended and session/prompt is on the wire. */
  prompt(content: readonly unknown[], who: ClientRef): Promise<PromptAccepted>;
  cancel(who: ClientRef): Promise<void>;
  /** Idempotent: session/close (if advertised) -> kill tree -> state closed. */
  close(reason: WorkerCloseReason): Promise<CloseResult>;
  turn(turnId: TurnId): TurnStatus;
  onStateChange(cb: (s: WorkerState, prev: WorkerState | null) => void): () => void;
  readonly closed: Promise<CloseResult>;
}

// ── daemon (WP-5 implements; testkit's stubDaemon() produces one) ────────────
//
// These live here rather than in @omni-acp/daemon for the DAG reason above: testkit must be
// able to hand a `Daemon` to daemon's own HTTP tests. `@omni-acp/daemon` re-exports them from
// `src/types.ts`, which is the import path every consumer uses.

export interface AuthContext {
  readonly tokenId: TokenId;
  readonly role: "user" | "admin";
  readonly clientId: ClientId | null;
  readonly agents: readonly string[] | "*";
  readonly cwdRoots: readonly string[];
  readonly maxWorkers: number;
  /** Throws forbidden when the agent id is out of bounds. */
  assertAgent(agentId: string): void;
  /** realpath + containment. Returns the canonical cwd. Throws forbidden. */
  assertCwd(cwd: string): Promise<string>;
  /** D13: admin sees all; otherwise same ownerTokenId only. */
  canSee(w: WorkerSnapshot): boolean;
  asClientRef(): ClientRef;
}

export interface WorkerRegistry {
  readonly size: number;
  /** In-process path — no HTTP, no headers (D15). */
  create(req: CreateWorkerRequest, auth: AuthContext, signal?: AbortSignal): Promise<WorkerHandle>;
  /** Throws worker_not_found when absent OR invisible — never leak existence. */
  get(id: WorkerId, auth: AuthContext): WorkerHandle;
  list(auth: AuthContext): readonly WorkerSnapshot[];
  delete(id: WorkerId, auth: AuthContext): Promise<CloseResult>;
  closeAll(reason: WorkerCloseReason, opts?: { timeoutMs?: number }): Promise<void>;
}

export interface Catalog {
  list(): readonly AgentCatalogEntry[];
  /** Throws bad_request(`unknown agent "<id>"`). */
  get(id: string): AgentDescriptor;
  /** Descriptor + cwd -> SpawnSpec. The ONLY producer of SpawnSpec. */
  toSpawnSpec(d: AgentDescriptor, o: { cwd: string }): SpawnSpec;
}

export type DaemonEvent =
  | { readonly type: "worker.state"; readonly workerId: WorkerId; readonly envelope: EventEnvelope }
  | {
      readonly type: "worker.event";
      readonly workerId: WorkerId;
      readonly envelope: EventEnvelope;
    };

export interface Daemon {
  readonly id: DaemonId;
  readonly config: ResolvedDaemonConfig;
  readonly info: DaemonInfo;
  /** null until start(), and forever when config.listen is null. */
  readonly url: string | null;
  readonly workers: WorkerRegistry;
  readonly catalog: Catalog;
  readonly supervisor: Supervisor;

  /** Throws unauthorized. Re-evaluated every call; no decision cache (DESIGN §8). */
  authenticate(headers: Headers): AuthContext;
  whoami(auth: AuthContext): WhoAmIResponse;

  /** D15 constraint 1, made testable: a web-standard handler that needs no socket. */
  readonly fetch: (req: Request) => Promise<Response>;

  on(type: DaemonEvent["type"], handler: (e: DaemonEvent) => void): () => void;

  /** Binds the socket when listen != null; otherwise a no-op that marks started. */
  start(): Promise<void>;
  /** SSE subs -> workers (killing trees) -> socket. Idempotent. */
  stop(opts?: { graceful?: boolean; timeoutMs?: number }): Promise<void>;
}

export interface DaemonDeps {
  /** Tests inject fakeSupervisor(); nothing else is needed. */
  readonly supervisor?: Supervisor;
  readonly clock?: Clock;
  readonly ids?: IdGen;
  readonly logger?: Logger;
  readonly responder?: PermissionResponder;
}
