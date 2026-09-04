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
  NormalizedSessionUpdate,
  PermissionOption,
  RequestPermissionResponse,
  StopReason,
} from "./acp.js";
import type {
  AgentCatalogEntry,
  CreateWorkerRequest,
  DaemonInfo,
  LeaseRequestBody,
  ProbeRequestBody,
  ProbeResponse,
  PromptAccepted,
  PromptRequestBody,
  WhoAmIResponse,
} from "./control-plane.js";
import type {
  AgentDescriptor,
  ResolvedDaemonConfig,
  ResolvedEventLogConfig,
  ResolvedLeaseConfig,
} from "./config.js";
import type { AcpErrorDetail, OmniErrorBody } from "./errors.js";
import type {
  EventEnvelope,
  EventInput,
  OrphanRecord,
  PolicyDecisionPayload,
  WorkerCloseReason,
  WorkerState,
} from "./events.js";
import type { ClientId, DaemonId, Seq, SessionId, TokenId, TurnId, WorkerId } from "./ids.js";
import type { LeaseEventPayload, LeaseSnapshot } from "./lease.js";
import type { ResumeHint, ResumeOutcome, ResumeReport } from "./resume.js";
import type { RuntimeDescriptor } from "./runtime.js";
import type { TurnStatus } from "./turn.js";
import type {
  AgentCapabilitiesSnapshot,
  CloseResult,
  ProcessInfo,
  WorkerSnapshot,
} from "./worker.js";

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

/**
 * A short-lived utility process whose stdout we read to completion — `taskkill /PID <pid> /T /F`
 * and `tasklist /FI "PID eq <pid>" /NH` on Windows (CONTRACTS.md §6.4).
 *
 * It exists because §6.1 makes `core/src/process/spawn.ts` the ONLY file allowed to call
 * `node:child_process`, while `platform-windows.ts` needs those two commands, and
 * `Supervisor.spawn()` is the wrong shape for them (it wires an ACP ndJSON stream, a frame
 * limiter and a stderr tail). `platform-windows.ts` receives this by INJECTION rather than
 * importing `spawn.ts`, because `spawn.ts` consumes `PlatformOps` and the import would be a
 * cycle (review R8). `spawn.ts` exports the real implementation.
 */
export type RunUtility = (
  file: string,
  args: readonly string[],
  o: { timeoutMs: number },
) => Promise<{ code: number | null; stdout: string }>;

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
  /** The incarnation token for a live pid, or null where this platform cannot take one (§15.7). */
  fingerprint(pid: number): Promise<string | null>;
  /** Signal a tree we did NOT spawn, addressed by its recorded group id. */
  signalTreeByGroup(groupId: number, sig: "SIGTERM" | "SIGKILL"): Promise<TerminationRung>;
  isGroupGone(groupId: number): Promise<boolean>;
}

export interface Supervisor {
  readonly platform: PlatformOps;
  /** THE ONLY caller of node:child_process in this repository (test-enforced, F10). */
  spawn(spec: SpawnSpec, signal?: AbortSignal): Promise<AgentProcess>;
  readonly live: ReadonlySet<AgentProcess>;
  /** Kill everything still owned, in parallel, bounded. Called by daemon.stop(). */
  shutdown(opts?: { gracefulMs?: number; timeoutMs?: number }): Promise<KillOutcome[]>;
  /**
   * Kill a process this daemon did NOT spawn, gated on the fingerprint a previous boot captured.
   * NEVER signals when `fingerprint` is null or does not match — a recycled pid is somebody
   * else's process. ALWAYS resolves: a reap failure is data (`reapSkipped`), not an exception.
   */
  reapOrphan(o: OrphanRecord): Promise<OrphanRecord>;
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
  /**
   * Called once, right after `session/new`; envelopes appended FROM THIS POINT carry the
   * sessionId. Earlier envelopes stay frozen with `sessionId: null` — they precede the session's
   * existence, and back-filling them would contradict CONTRACTS.md §8.2 rule 3 (review R16).
   */
  setSessionId(id: SessionId): void;
  /** true ⇒ survives a daemon restart; `tail` is bounded by retention, not by the ring (§14.1). */
  readonly persistent: boolean;
  /** sqlite: commit anything pending. memory: no-op. Called before `daemon.stop()` returns. */
  flush(): void;
}

// ── persistence (M1-WP-A implements) ─────────────────────────────────────────

/**
 * The durable side of an EventLog. SYNCHRONOUS, for exactly the reason `EventLog.append` is:
 * `DatabaseSync` is synchronous, and an async `put` reintroduces the interleave that a
 * non-monotonic `seq` is (§8.1). Nothing here assigns a `seq` — the store is TOLD what it is.
 */
export interface EventStore {
  /** `max(seq)` ever assigned, INCLUDING rows retention has already evicted (§14.4). */
  headOf(workerId: WorkerId): Seq;
  /** Lowest RETAINED seq; `head + 1` when everything for this worker is gone. Never 1 by default. */
  tailOf(workerId: WorkerId): Seq;
  put(e: EventEnvelope): void;
  /** seq > since, ascending, at most `limit`. Deserialized — object identity is NOT preserved,
   *  which is exactly why the ring stays in front of it (F11). */
  read(workerId: WorkerId, since: Seq, limit: number): readonly EventEnvelope[];
  /** Delete `seq <= upTo` for one worker AND raise its durable tail, in ONE transaction. */
  evict(workerId: WorkerId, upTo: Seq): number;
  /** The nth-oldest retained seq, or null — the row-cap sweep without `DELETE … LIMIT`. */
  seqAtOffset(workerId: WorkerId, offset: number): Seq | null;
  workersWithEvents(): readonly WorkerId[];
  readonly diagnostics: EventStoreDiagnostics;
}

export interface EventStoreDiagnostics {
  readonly driver: "sqlite" | "memory";
  readonly file: string | null;
  readonly schemaVersion: number;
  readonly sizeBytes: number;
  /** Non-zero after any `put` failure; surfaced in `GET /v1/info` (§14.3). */
  readonly writeFailures: number;
}

/** The durable half of the Worker Registry — D2's `workerId → (agentId, sessionId, cwd, …)`. */
export interface WorkerStore {
  upsert(row: WorkerRow): void;
  get(id: WorkerId): WorkerRow | null;
  /** Newest `updatedAt` first. Visibility is the REGISTRY's job, never the store's. */
  list(): readonly WorkerRow[];
  /** Rows whose `bootId` is not the current one AND whose state is live — §15.7's orphans. */
  abandoned(currentBootId: string): readonly WorkerRow[];
  delete(id: WorkerId): void;
  closedBefore(cutoffMs: number): readonly WorkerRow[];
}

/** A snapshot plus what a snapshot does not carry because it is not client-facing. */
export interface WorkerRow {
  readonly snapshot: WorkerSnapshot;
  readonly agentId: string;
  /** The daemon INSTANCE that last wrote this row. Not `daemonId`, which is stable across boots. */
  readonly bootId: string;
  /** Persisted so `DELETE` is idempotent ACROSS a restart, byte-for-byte (§15.6). */
  readonly closeResult: CloseResult | null;
  readonly lastActiveMs: number;
  readonly closedAtMs: number | null;
  readonly hibernateIdleMs: number | null;
}

export interface RetentionReport {
  readonly workersDropped: number;
  readonly eventsDeleted: number;
  readonly byAge: number;
  readonly byRowCap: number;
  readonly durationMs: number;
}

/**
 * The three bounds of §14.5, resolved into one plan BEFORE anything is deleted. Pure input →
 * pure plan → one transactional apply: that is what makes retention table-testable.
 */
export interface RetentionInput {
  readonly nowMs: number;
  readonly retentionDays: number;
  readonly maxPersistedEventsPerWorker: number;
  readonly rows: readonly {
    readonly workerId: WorkerId;
    readonly state: WorkerState;
    readonly closedAtMs: number | null;
    readonly head: Seq;
    readonly tail: Seq;
  }[];
}

export interface RetentionPlan {
  /** Workers whose rows AND events go entirely: closed longer ago than the age bound. */
  readonly dropWorkers: readonly WorkerId[];
  /** Per worker, delete `seq <= upTo` and raise the durable tail to `upTo + 1`. */
  readonly evictTo: readonly { readonly workerId: WorkerId; readonly upTo: Seq }[];
}

/** What `createDaemon()` opens once and hands to the registry. `null` for the memory driver. */
export interface PersistenceHandle {
  readonly events: EventStore;
  readonly workers: WorkerStore;
  readonly bootId: string;
  /** One bounded retention pass. Returns what it deleted, for the log line and the test. */
  sweep(nowMs: number): RetentionReport;
  close(): void;
}

/** Options for the shared ring/subscriber core every driver sits on (§14.1). */
export interface EventLogCoreOptions {
  readonly workerId: WorkerId;
  readonly daemonId: DaemonId;
  readonly clock: Clock;
  readonly maxEvents?: number;
  readonly queueSize?: number;
  /** Seeds `head` on a rehydrated worker so `seq` never restarts at 1 (§14.4, L15). */
  readonly startSeq?: Seq;
  /** Write-through sink. Absent ⇒ a pure in-memory log. Never assigns a `seq`. */
  readonly store?: EventStore;
  readonly logger?: Logger;
}

export interface PersistedEventLogOptions extends EventLogCoreOptions {
  readonly store: EventStore;
  readonly config: ResolvedEventLogConfig;
}

// ── normalizer (M1-WP-B implements) ──────────────────────────────────────────

export type TurnInput =
  | { readonly type: "prompt_sent"; readonly turnId: TurnId; readonly at: number }
  | {
      readonly type: "agent_update";
      readonly update: unknown;
      readonly at: number;
      /** D6. Set by the WORKER for every update inside the replay window; the reducer copies it
       *  onto every `EventInput` it emits for this update and carries no window state (§15.3). */
      readonly replay?: true;
    }
  | {
      readonly type: "prompt_result";
      readonly stopReason: StopReason;
      /** v1 `PromptResponse.usage` (F21). Lands on `state_update{idle}.usage`. */
      readonly usage?: unknown;
      readonly at: number;
    }
  | { readonly type: "prompt_error"; readonly error: OmniErrorBody; readonly at: number }
  | {
      readonly type: "process_gone";
      readonly error: OmniErrorBody;
      readonly stderrTail: string;
      readonly at: number;
    }
  /** Starts the FORCED close-out ladder. The reducer decides which rung is next (§13.2). */
  | { readonly type: "close_requested"; readonly at: number }
  /** stdout EOF observed during the drain rung. */
  | { readonly type: "drained"; readonly at: number }
  /** One COMPLETE stderr line, for `end_turn`-with-fatal-stderr promotion (§13.4). */
  | { readonly type: "stderr_line"; readonly line: string; readonly at: number }
  | { readonly type: "tick"; readonly at: number };

export type SettleReason = "quiet" | "hard" | "error" | "gone" | "drained" | "cancelled";

/**
 * The rung the Worker must perform next. `null` = do nothing. The ONLY side effect the reducer
 * requests, which is what keeps the whole ladder unit-testable with a fake clock and no process.
 */
export type CloseOutAction = "close_stdin" | "drain" | "cancel" | "terminate";

export interface TurnOutput {
  /** Appended to the log in array order, in one synchronous loop. */
  readonly emit: readonly EventInput[];
  /** Absolute epoch-ms at which the Worker must deliver a `tick`, or null. */
  readonly scheduleTickAt: number | null;
  readonly state: "idle" | "running" | "settling" | "closing";
  readonly turnId: TurnId | null;
  readonly settled: SettleReason | null;
  readonly action: CloseOutAction | null;
}

export interface MappedUpdate {
  readonly payload: NormalizedSessionUpdate;
  /** 2 when the mapper landed on a KNOWN v2 arm; 1 when it passed an unrecognized kind through. */
  readonly payloadVersion: 1 | 2;
  /** Which table row fired, e.g. "tool_call->tool_call_update". "" for identity. Golden-tested. */
  readonly rule: string;
  /** For chunk kinds: the messageId in force after mapping, real or synthesized. */
  readonly messageId: string | null;
  /** false ⇒ the descriptor says drop this kind; it is never appended and consumes no seq (§14.6). */
  readonly keep: boolean;
}

export interface MappedPermissionRequest {
  readonly sessionId: string;
  readonly title: string;
  /** v2's TAGGED subject. `tool_call` is the only arm a v1 agent can produce; `toolCall` is
   *  passed BY IDENTITY so `kind`/`locations`/`content`/`rawInput` — what M2's rule engine
   *  matches on — arrive unmodified. */
  readonly subject: Readonly<Record<string, unknown>> | null;
  readonly options: readonly PermissionOption[];
  readonly toolCallId: string | null;
  readonly _meta?: Readonly<Record<string, unknown>>;
}

export interface OutboundCall {
  readonly method: string;
  readonly params: Record<string, unknown>;
  /** null when every spelling is exhausted; the caller reports `unsupported`. */
  readonly spelling: string | null;
  readonly onFailure: "fail" | "warn";
}

export type ErrorClass =
  | { readonly kind: "bad_request" }
  | { readonly kind: "agent_error" }
  | { readonly kind: "unsupported_method"; readonly method: string | null }
  | { readonly kind: "resume"; readonly outcome: ResumeOutcome; readonly hint: ResumeHint }
  | { readonly kind: "unclassified" };

export interface Normalizer {
  /** Reporting only; NO mapping rule reads it (F24). */
  readonly sourceProtocolVersion: 1 | 2;
  readonly slice: "m1-full";
  readonly descriptor: RuntimeDescriptor;
  /** PURE. No timers, no I/O, no async. Same inputs => same outputs, forever. */
  step(input: TurnInput): TurnOutput;
  /**
   * The v1→v2 map as a free function on the interface, so it is testable without a turn and
   * reusable by the compat suite and the golden generator. PURE, TOTAL and IDEMPOTENT:
   * `mapUpdate(mapUpdate(x).payload).payload` is deep-equal to `mapUpdate(x).payload` for every
   * input, and an unrecognized kind comes back BY IDENTITY with `payloadVersion: 1` (§12).
   */
  mapUpdate(update: unknown): MappedUpdate;
  /** v1 `{sessionId, toolCall, options}` → v2 `{title, subject, options}`. PURE, idempotent. */
  mapPermissionRequest(req: unknown): MappedPermissionRequest;
  /** Canonical (v2) client→agent call → the spelling THIS runtime answers (§17.3). PURE. */
  mapRequest(method: string, params: Record<string, unknown>): OutboundCall;
  /** Record a `-32601` so the next `mapRequest` skips that spelling for this process. */
  noteUnsupported(method: string): void;
  /** Classify a JSON-RPC error with the descriptor's rules. NEVER throws. */
  classifyError(e: AcpErrorDetail): ErrorClass;
}

// ── permission responder (M1-WP-B/C implement) ───────────────────────────────

export interface PermissionDecision {
  /** null => the Worker must reply with JSON-RPC -32603 (D4 rule 4). */
  readonly response: RequestPermissionResponse | null;
  readonly record: PolicyDecisionPayload;
}

export interface PermissionResponder {
  /**
   * `req` is the V2-MAPPED request (ruling M1-R14). D4's rule set is written against v2's tagged
   * `subject`, and mapping first is what lets M2's rule engine match `kind` / `path` / `cmd` with
   * no per-agent branch.
   */
  decide(req: MappedPermissionRequest): PermissionDecision;
}

// ── lease (M1-WP-D implements; D5) ───────────────────────────────────────────

export interface ClientRef {
  readonly tokenId: TokenId;
  readonly clientId: ClientId | null;
  /**
   * The FENCING token this call carried (`Omni-Lease-Epoch`, §16.1 rule L7), and seam 3's other
   * half (M1-PLAN §1.2): "the factory `registry.ts` passes in, PLUS the epoch on `ClientRef`".
   *
   * It rides on the identity rather than on each verb's parameters because every gated verb
   * already takes a `ClientRef` and none of them takes an epoch — `prompt(content, who)`,
   * `cancel(who)`, `wake(who, opts)` and `assertHolder(who, opts?)` are frozen exactly as they
   * are, and only the VALUE gains a slot to travel in. `undefined` is "the client sent no
   * fence", which L7 defines as no check; a PRESENT and stale epoch is `423` even from the right
   * client id, which is the difference between a lease and a hint.
   */
  readonly epoch?: number;
}

export interface LeaseOptions {
  readonly workerId: WorkerId;
  readonly clock: Clock;
  readonly config: ResolvedLeaseConfig;
  /** The creator, when `CreateWorkerRequest.lease` is `"take"`; null for `"observe"`. */
  readonly initialHolder?: ClientRef | null;
  /** Where `omni.lease` envelopes go. Absent ⇒ the audit trail is the `onChange` callback only. */
  readonly onEvent?: (e: LeaseEventPayload) => void;
}

export interface Lease {
  readonly holder: ClientRef | null;
  readonly epoch: number;
  snapshot(): LeaseSnapshot;
  /**
   * Throws `lease_held` (423) carrying `snapshot()` in the error body. On an UNHELD lease it
   * implicitly acquires for `who` and emits `omni.lease{acquired, how:"implicit"}` — a worker
   * nobody controls should not 423 the first client that reaches for it (§16.1 rule L5).
   * `opts.epoch` is the optional fencing check from `Omni-Lease-Epoch`.
   */
  assertHolder(who: ClientRef, opts?: { epoch?: number }): LeaseSnapshot;
  acquire(who: ClientRef, opts?: { ttlMs?: number }): LeaseSnapshot;
  release(who: ClientRef): LeaseSnapshot;
  /** D13: admin always; a same-token peer after `stealAfterIdleMs`. Audited, epoch +1. */
  steal(who: ClientRef, opts: { reason: string | null; admin: boolean }): LeaseSnapshot;
  /** Suspends expiry while a turn is live; returns the un-pin. Nested calls refcount (rule L6). */
  pinExpiry(): () => void;
  /** Hibernation releases the lease unconditionally (DESIGN §3.2: 进程回收、lease 释放). */
  releaseForHibernate(): LeaseSnapshot;
  onChange(cb: (e: LeaseEventPayload) => void): () => void;
  close(): void;
}

// ── session strategy: the seam that keeps `worker.ts` frozen (M1-WP-C) ───────

/**
 * The subset of `core`'s `AcpLink` a `SessionStrategy` may touch. Declared here, and narrowly,
 * because `protocol` may not import `core` (§4) and because a strategy that could reach the
 * whole link would be able to send a prompt.
 */
export interface AcpLinkLike {
  request<T = unknown>(method: string, params: unknown): Promise<T>;
  notify(method: string, params: unknown): void;
  readonly closed: boolean;
}

export interface SessionOpenOptions {
  readonly cwd: string;
  readonly descriptor: RuntimeDescriptor;
  /** Always `[]` in M1 (DESIGN §8 — presets are M2). */
  readonly mcpServers: readonly unknown[];
  readonly budgetMs: number;
  readonly signal?: AbortSignal;
}

export interface SessionReopenOptions extends SessionOpenOptions {
  /** The pointer being preserved. A reopen without one is a programming error, not a resume. */
  readonly sessionId: SessionId;
  readonly capabilities: AgentCapabilitiesSnapshot | null;
  /** Opens D6's replay window and returns the closer; the Worker sets the flag, the strategy
   *  decides when. The reducer stays pure. */
  readonly controls: { replayWindow(): () => void };
}

export interface SessionOpenResult {
  readonly capabilities: AgentCapabilitiesSnapshot;
  readonly sessionId: SessionId;
  readonly resume: ResumeReport | null;
}

/**
 * After M1, `Worker` never names `initialize`, `session/new`, `session/load` or `session/resume`
 * again: it holds a `SessionStrategy` and calls `open` on create and `reopen` on wake. This is
 * the seam that lets the resume work package and the daemon work package own disjoint files while
 * `worker.ts` itself is edited exactly once, by the Land step, and then frozen (M1-PLAN §1).
 */
export interface SessionStrategy {
  open(link: AcpLinkLike, o: SessionOpenOptions): Promise<SessionOpenResult>;
  reopen(link: AcpLinkLike, o: SessionReopenOptions): Promise<SessionOpenResult>;
  /** Best-effort `session/close` when advertised. NEVER throws. */
  close(link: AcpLinkLike, sessionId: SessionId): Promise<void>;
}

/** The idle timer that drives `ready -> hibernated` (§15.2). Owned by M1-WP-C. */
export interface HibernateTimer {
  /** Restart the countdown. Called on every turn boundary. */
  touch(): void;
  /** Suspend while a turn is live; `touch()` resumes it. */
  pause(): void;
  cancel(): void;
  readonly armed: boolean;
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
  /**
   * ready → hibernated. Idempotent; throws `worker_busy` while a turn is live. Reclaims the
   * process tree, RELEASES the lease, keeps the record and the session pointer, and NEVER sends
   * `session/close` — the pointer is the entire value being preserved (§15.2).
   */
  hibernate(reason: "idle_timeout" | "client_request"): Promise<WorkerSnapshot>;
  /**
   * hibernated → ready. Idempotent and SINGLE-FLIGHT: concurrent callers share one attempt.
   * Throws `not_resumable` (422) carrying the `ResumeReport`, `agent_error` (502),
   * `agent_timeout` (504), `worker_limit` (429) or `worker_closed` (410) — the table is §15.5.
   */
  wake(who: ClientRef, opts?: { timeoutMs?: number }): Promise<WorkerSnapshot>;
  /** Processes this worker has had. 0 = it has never run. */
  readonly generation: number;
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
  /**
   * `Omni-Lease-Epoch` as this request sent it (§16.1 rule L7), or null when it sent none.
   *
   * It is parsed once, next to the client id, and travels to the lease inside `asClientRef()`.
   * A non-numeric header is `bad_request` at the boundary rather than a silently ignored fence.
   */
  readonly leaseEpoch: number | null;
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

  // ── result-returning façade (review R11) ──────────────────────────────────
  //
  // Each of these is `get(id, auth)` followed by one call on the handle. They exist so that an
  // HTTP route really is "parse -> call ONE daemon method -> serialize" (D15 constraint 1)
  // instead of a get-then-act orchestration in the adapter, which is the one place that
  // constraint genuinely leaked. In-process callers may still use `get()` and hold the handle.

  /** H7: `200 WorkerSnapshot`. Throws worker_not_found when absent or invisible. */
  snapshot(id: WorkerId, auth: AuthContext): WorkerSnapshot;
  /** H8: `202 PromptAccepted`. */
  prompt(id: WorkerId, auth: AuthContext, body: PromptRequestBody): Promise<PromptAccepted>;
  /** H9: `202 {}`. Idempotent; a no-op when the worker is not running. */
  cancel(id: WorkerId, auth: AuthContext): Promise<void>;
  /** H11: `200 TurnStatus`. An unknown turn is `state:"unknown"`, never a 404 (D29). */
  turn(id: WorkerId, auth: AuthContext, turnId: TurnId): TurnStatus;
  /** H10: the log the SSE writer subscribes to. Visibility is checked here, not in `http/`. */
  logFor(id: WorkerId, auth: AuthContext): EventLog;

  // ── M1 façade rows (H17-H19), same rule: parse -> ONE call -> serialize ────

  /** Workers occupying NO process. Bounded by `hibernate.maxHibernated`, not `maxWorkers`. */
  readonly hibernatedSize: number;
  /** H17: `200 LeaseSnapshot`; `423 lease_held` carries the holder and the epoch. */
  lease(
    id: WorkerId,
    auth: AuthContext,
    op: "acquire" | "release" | "steal",
    body: LeaseRequestBody,
  ): LeaseSnapshot;
  /** H18: `200 WorkerSnapshot{state:"hibernated"}`. */
  hibernate(id: WorkerId, auth: AuthContext): Promise<WorkerSnapshot>;
  /** H19: `200 WorkerSnapshot{state:"ready"}`; the outcome table is §15.5. */
  wake(id: WorkerId, auth: AuthContext): Promise<WorkerSnapshot>;
  /** Boot adoption: every live-state row from a previous boot becomes `hibernated` or `closed`. */
  adopt(): Promise<{ hibernated: number; closed: number; orphans: readonly OrphanRecord[] }>;
}

export interface Catalog {
  list(): readonly AgentCatalogEntry[];
  /** Throws bad_request(`unknown agent "<id>"`). */
  get(id: string): AgentDescriptor;
  /** Descriptor + cwd -> SpawnSpec. The ONLY producer of SpawnSpec. */
  toSpawnSpec(d: AgentDescriptor, o: { cwd: string }): SpawnSpec;
  /** Merged builtin ⊕ config ⊕ cached-probe descriptor. NEVER throws; falls back to the v1 profile. */
  descriptor(id: string): RuntimeDescriptor;
  /** H16. `auth.assertAgent(id)` FIRST, so a forbidden agent 403s before a process exists. */
  probe(id: string, o: ProbeRequestBody, auth: AuthContext): Promise<ProbeResponse>;
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

  /**
   * The in-process entry to everything `AuthContext` gates (D15's library-first path).
   * Throws `unauthorized` for an unknown token id. `authenticate(headers)` is the HTTP
   * adapter's thin wrapper over this — an embedder running with `listen: null` must not have to
   * forge a `Bearer` header to reach `workers.create()` (review R10).
   */
  authContextFor(tokenId: TokenId, clientId?: ClientId | null): AuthContext;

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
  /** Opened once by `createDaemon()`; absent for the memory driver (§14.1, M1-WP-A/E). */
  readonly persistence?: PersistenceHandle;
  /** Injected so `worker.ts` never names `initialize` / `session/new` again (seam 2, M1-WP-C). */
  readonly session?: SessionStrategy;
  /**
   * SEAM 3 (M1-PLAN §1.2, review R14): the `Lease` factory the registry hands each new worker.
   * Absent ⇒ `alwaysGrantedLease`, which is M0's behaviour. M1-WP-D lands `createLease` in its
   * own files and M1-WP-E flips this default in `create-daemon.ts`, so D5 enforcement costs
   * `worker.ts` and `registry.ts` zero further edits.
   */
  readonly leaseFactory?: (owner: ClientRef, workerId: WorkerId) => Lease;
}
