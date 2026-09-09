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
  CreateRunRequest,
  CreateWorkerRequest,
  DaemonInfo,
  DeliveryRecord,
  InteractionAnswerResult,
  InteractionListResponse,
  LeaseRequestBody,
  ProbeRequestBody,
  ProbeResponse,
  PromptAccepted,
  PolicySelection,
  PromptRequestBody,
  RunSnapshot,
  SetConfigBody,
  SetConfigResponse,
  WebhookEvent,
  WebhookTarget,
  WhoAmIResponse,
} from "./control-plane.js";
import type {
  AgentDescriptor,
  McpServerPreset,
  PolicyAction,
  PolicyCeiling,
  ResolvedDaemonConfig,
  ResolvedDiffConfig,
  ResolvedEventLogConfig,
  ResolvedInteractionConfig,
  ResolvedLeaseConfig,
  ResolvedPolicy,
  ResolvedWatchdogConfig,
  ResolvedWebhookConfig,
} from "./config.js";
import type { AcpErrorDetail, OmniErrorBody } from "./errors.js";
import type {
  EventEnvelope,
  EventInput,
  InteractionKind,
  InteractionMethod,
  OrphanRecord,
  ParkTimeoutAction,
  PolicyDecisionPayload,
  RunState,
  WorkerCloseReason,
  WorkerState,
} from "./events.js";
import type {
  ClientId,
  DaemonId,
  DeliveryId,
  InteractionId,
  RunId,
  Seq,
  SessionId,
  TokenId,
  TurnId,
  WorkerId,
} from "./ids.js";
import type { LeaseEventPayload, LeaseSnapshot } from "./lease.js";
import type { ResumeHint, ResumeOutcome, ResumeReport } from "./resume.js";
import type { RuntimeDescriptor } from "./runtime.js";
import type { TurnStatus, TurnWarning } from "./turn.js";
import type {
  AgentCapabilitiesSnapshot,
  CloseResult,
  ConfigOptionView,
  ElicitationField,
  InteractionSnapshot,
  PolicySnapshot,
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
  // ── M2 (§5.8.1) ────────────────────────────────────────────────────────────
  /** DAEMON-MINTED. F33: the two agent→client requests share ONE JSON-RPC id counter, so a
   *  transport id is not an identity a route may address. */
  interaction(): InteractionId;
  run(): RunId;
  delivery(): DeliveryId;
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
  o: {
    timeoutMs: number;
    /**
     * Extra variables for the child, MERGED OVER the parent's environment (never replacing it —
     * `git` needs `PATH`, and a utility that lost it would fail with ENOENT on every platform).
     *
     * M2-WP-J widened this options object by exactly this one optional field, and it is
     * load-bearing rather than convenient: D8's technique is `GIT_INDEX_FILE=$tmp git add -A`,
     * and `GIT_INDEX_FILE` has **no command-line spelling** — the temp index that keeps us off
     * the user's own index is reachable only through the environment (§25.2). Every other flag
     * the provider needs (`-C`, `--no-ext-diff`, `--no-textconv`) is argv, and is spelled there.
     *
     * Optional and additive: an implementation written against the M0 shape (`{timeoutMs}`) is
     * still assignable to this type and simply ignores it.
     */
    env?: Readonly<Record<string, string>>;
  },
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

  // ── M2 (§5.8.8) ────────────────────────────────────────────────────────────
  //
  // Persisted BECAUSE OF THE WAKE PATH, each for a reason a restart makes sharp:
  //  - `onUnresolved` — a `park` worker that hibernated and woke must RE-DECLARE
  //    `clientCapabilities.elicitation`, or F28 says the agent silently degrades to prose and the
  //    park never happens again (F42 is the code that would do exactly that today);
  //  - `env` / `mcpNames` / `policyRef` — a wake must reproduce the environment, or the woken
  //    worker is a different worker wearing the same id.
  // Interactions are deliberately NOT persisted (ruling M2-R10).
  //
  // OPTIONAL at the Land step for the reason `WorkerSnapshot`'s M2 rows are: a `WorkerRow` is
  // built in `registry.ts`, in `boot-recovery.ts` and in five test files, and the v2 CREATE-only
  // migration that stores them is M2-B-WP-R's. Absent reads as the M1 default in every case.

  readonly onUnresolved?: "park" | "deny" | "fail";
  readonly parkTimeoutMs?: number | null;
  readonly parkTimeoutAction?: ParkTimeoutAction;
  readonly mcpNames?: readonly string[];
  readonly policyRef?: string | null;
  /**
   * The `PolicySelection` the worker was CREATED with (review finding V2/V8).
   *
   * `policyRef` is the engine's identity and is an audit trail; it cannot rebuild anything. A
   * wake has to reconstruct the ENGINE — `policyFor(selection, auth, onUnresolved)`, exactly as
   * `create()` runs it — or the woken worker enforces `DEFAULT_VERDICT[onUnresolved]` with no
   * rules and no ceiling clamp while its snapshot still advertises the policy it no longer has.
   * `null` is "this worker asked for no policy", which is not the same fact as an M1 row's absent
   * key.
   */
  readonly policy?: PolicySelection | null;
  /** `null` when `env.persist:false` was requested — which forces `resume.method: null` (§23.3). */
  readonly env?: Readonly<Record<string, string>> | null;
  readonly watchdog?: { silentMs: number; toolMs: number; cancelTimeoutMs: number };
  readonly patchMode?: "off" | "on_write" | "always";
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
      /**
       * M2, SEAM D (M2-PLAN §1.3): merged into `state_update{idle}._meta`. The reducer does not
       * know what any key means — it is the same channel `omni/vendorPatch` and `omni/warnings`
       * already ride (§12.5) — and it is what lets the git provider land with ZERO edits to
       * `turn-lifecycle.ts` (ruling M2-R9).
       */
      readonly meta?: Readonly<Record<string, unknown>>;
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
  /** M2. The turn is suspended on a human. Both watchdog budgets stop; the park timer owns the
   *  deadline (§21.4). */
  | { readonly type: "interaction_parked"; readonly id: InteractionId; readonly at: number }
  | { readonly type: "interaction_resolved"; readonly id: InteractionId; readonly at: number }
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
  /** M2 adds `parked`: a turn suspended on a human is not `running` and is not `settling`. */
  readonly state: "idle" | "running" | "parked" | "settling" | "closing";
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
  /**
   * The agent's params, VERBATIM and by identity. Review R11: `worker.ts` is frozen after the
   * Land step and maps before it hands the request to the strategy (ruling M1-R14), so without
   * this field the raw bytes `InteractionRequest.raw` is contracted to carry — "NEVER reshaped;
   * `acp.interaction.raw` audits the agent, not our mapping" (§7.5) — would be dropped at the
   * seam and could never be recovered. Ruling M2-R3 is exactly "flip `payloadVersion` to 2 with
   * a mapped `request` AND carry the agent's bytes beside it".
   *
   * A second application keeps the FIRST one's `raw`, which is what keeps `map(map(x))` equal to
   * `map(x)` — the same reason `subject` is passed by identity.
   */
  readonly raw: Readonly<Record<string, unknown>>;
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

// ═════════════════════════════════════════════════════════════════════════════
// M2's five seams (§5.8.8). Every one of them is OPTIONAL on `DaemonDeps`, and with all of them
// absent the daemon is M1 — which is what the whole M1 suite proves (ruling M2-R1).
// ═════════════════════════════════════════════════════════════════════════════

// ── interaction (M2-A) ───────────────────────────────────────────────────────

/** v1 `elicitation/create` params, mapped. F29: the scope fields are FLAT in `params`, not nested. */
export interface MappedElicitationRequest {
  readonly mode: "form" | "url";
  readonly sessionId: string;
  readonly toolCallId: string | null;
  readonly requestId: string | null;
  readonly message: string;
  readonly fields: readonly ElicitationField[];
  /** Properties this parse did not fold into a field — kept so an answer that names one is a
   *  `bad_request` with the name in it rather than a silent drop. */
  readonly unmodelled: readonly string[];
  /**
   * The agent's params, VERBATIM and by identity (review R11).
   *
   * It carries the `_meta._askUserQuestionCustomAnswer` marker and the FLAT scope (F29, F30) that
   * a schema parse would strip, and it is what lets M2-A-WP-I's real `mapElicitation` run at all:
   * `worker.ts` maps with a fallback before the strategy sees the request and is frozen
   * afterwards, so the strategy RE-MAPS from `raw` and emits `payload.raw` unchanged.
   */
  readonly raw: Readonly<Record<string, unknown>>;
  readonly _meta?: Readonly<Record<string, unknown>>;
}

/** D10's unification: the two agent→client requests are ONE lifecycle. */
export interface InteractionRequest {
  readonly id: InteractionId;
  readonly kind: InteractionKind;
  readonly method: InteractionMethod;
  readonly title: string;
  readonly message: string | null;
  /** v2's TAGGED subject for a permission; null for an elicitation. The policy engine matches on it. */
  readonly subject: Readonly<Record<string, unknown>> | null;
  readonly options: readonly PermissionOption[];
  readonly fields: readonly ElicitationField[];
  /** Present on BOTH kinds (F29's flat `toolCallId`, F32's mirror). */
  readonly toolCallId: string | null;
  readonly turnId: TurnId | null;
  /** Verbatim params. NEVER reshaped — `acp.interaction.raw` audits the agent, not our mapping (§7.5). */
  readonly raw: Readonly<Record<string, unknown>>;
}

export type InteractionAnswer =
  | { readonly action: "allow"; readonly optionId?: string; readonly note?: string }
  | { readonly action: "deny"; readonly note?: string }
  | {
      readonly action: "answer";
      readonly content: Readonly<Record<string, unknown>>;
      readonly note?: string;
    }
  | { readonly action: "cancel" };

export type InteractionOutcome =
  | { readonly kind: "permission"; readonly optionId: string }
  /** → JSON-RPC -32603 (D4 rule 4). NEVER an invented id (rule 1), never `cancelled` (rule 5). */
  | { readonly kind: "permission_error" }
  | { readonly kind: "elicitation_accept"; readonly content: Readonly<Record<string, unknown>> }
  | { readonly kind: "elicitation_decline" }
  | { readonly kind: "elicitation_cancel" };

export interface InteractionResolution {
  readonly outcome: InteractionOutcome;
  readonly record: PolicyDecisionPayload;
}

/** What the strategy may do to the Worker. Deliberately three verbs. */
export interface InteractionContext {
  readonly turnId: TurnId | null;
  /** Appended in array order, synchronously — the same contract `TurnOutput.emit` has. */
  emit(inputs: readonly EventInput[]): void;
  /**
   * `running → requires_action`. Returns the un-park; REFCOUNTED exactly like
   * `Lease.pinExpiry()`, and the LAST un-park emits `interaction_resolved`. It also pauses the
   * watchdog (§21.4) and holds the lease pin for the whole window.
   */
  park(id: InteractionId): () => void;
  /**
   * `onUnresolved:"fail"` and `parkTimeoutAction:"fail"`: answer the request, cancel the TURN and
   * mark any owning run `failed`. **The worker stays open** — ruling M2-R24, which settles the
   * disagreement between D4's text and DESIGN §3.2's `任意 → closed` row in favour of D4.
   */
  failTurn(reason: string): void;
}

/**
 * The ONE lifecycle. It SUPERSEDES `PermissionResponder` rather than replacing it:
 * `baselineInteractions(responder, clock)` wraps M1's responder verbatim, so a worker with no
 * strategy injected is byte-for-byte M1 — which is what the M1 suite proves (§19.10).
 */
export interface InteractionStrategy {
  /** D10's per-worker gate, read ONCE at handshake and re-read on every WAKE (F42). `{}` unless
   *  `onUnresolved === "park"`. */
  readonly clientCapabilities: Readonly<Record<string, unknown>>;
  /** NEVER rejects for a reason other than `AcpRequestError`: a rejected promise here is an agent
   *  that waits forever on a JSON-RPC id (F1). */
  permission(
    req: MappedPermissionRequest,
    ctx: InteractionContext,
  ): Promise<RequestPermissionResponse>;
  elicitation(req: MappedElicitationRequest, ctx: InteractionContext): Promise<unknown>;
  /** H22. Throws `interaction_not_found` / `interaction_settled` / `bad_request`. */
  answer(
    id: InteractionId,
    a: InteractionAnswer,
    who: ClientRef & { tokenId: TokenId },
  ): InteractionAnswerResult;
  get(id: InteractionId): InteractionSnapshot | null;
  readonly pending: readonly InteractionSnapshot[];
  /**
   * Settle every parked request with `reason`, put a real answer on the wire for each, and RETURN
   * once every held JSON-RPC promise has resolved. Called by `cancel()` **before**
   * `session/cancel`, by `#doClose`, by `#doHibernate` and by `daemon.stop()` — a log that ends
   * on a `pending` interaction is a log that lies, and an agent blocked on our answer may never
   * read the cancel (§19.8). Idempotent.
   */
  settleAll(reason: "shutdown" | "cancel" | "close" | "hibernate" | "timeout"): Promise<void>;
  /** Disposes the strategy's own timers (the park deadline above all). Called from EVERY teardown
   *  path — `#doClose` and `#doHibernate` — beside `Watchdog.cancel()`. Idempotent, and it must
   *  never throw: a close that a dependency can break is a close that leaks a process. */
  close(): void;
}

/** What `DaemonDeps.interactions` is handed to build one strategy per worker (§5.8.9). */
export interface InteractionDeps {
  readonly workerId: WorkerId;
  readonly clock: Clock;
  readonly ids: IdGen;
  readonly logger: Logger;
  readonly config: ResolvedInteractionConfig;
  readonly onUnresolved: "park" | "deny" | "fail";
  readonly parkTimeoutMs: number | null;
  readonly parkTimeoutAction: ParkTimeoutAction;
  /** M2-B's engine, injected. Absent ⇒ the constant `onUnresolved` verdict, which is what makes
   *  WP-I and WP-P file-disjoint and orderable either way (M2-PLAN §1.3 seam A). */
  readonly decide?: (s: PolicySubject) => PolicyVerdict;
  /** M1's responder, for `baselineInteractions` and for option selection under D4 rules 1-6. */
  readonly responder: PermissionResponder;
}

// ── policy (M2-B; D4) ────────────────────────────────────────────────────────

export interface PolicySubject {
  readonly method: InteractionMethod;
  /** v2's tag. An unknown tag falls to `default` (D4: unknown subjects are declined by policy). */
  readonly type: "tool_call" | "command" | string;
  readonly kind: string | null;
  /**
   * REALPATH'd absolutes off `subject.toolCall.locations[]`. For a file that does not exist yet
   * (a create), the deepest existing ancestor is realpath'd and the remainder re-appended —
   * otherwise every `allow` rule for `src/**` fails on exactly the writes it exists to permit.
   *
   * EMPTY IS NOT "NO PATHS": F38 proves `locations[]` under-reports. A `path` clause therefore
   * matches only when this is non-empty AND every entry matches, so an unlisted second path can
   * never launder the first (§20.3).
   */
  readonly paths: readonly string[];
  readonly command: string | null;
  readonly title: string;
  readonly agentId: string;
  readonly cwd: string;
}

export interface PolicyVerdict {
  readonly action: PolicyAction;
  /** `"<policyId>#<ruleId>"` or `"<policyId>#default"`. Goes verbatim into `PolicyDecisionPayload`. */
  readonly rule: string;
  readonly source: "baseline" | "default" | "preset" | "inline" | "ceiling";
  /** Set when the ceiling narrowed the action. NEVER silent (§20.5). */
  readonly clamped: { readonly from: PolicyAction; readonly by: string } | null;
}

/**
 * PURE and TOTAL: same subject in ⇒ deep-equal verdict out, no I/O, no clock.
 *
 * It decides WHAT, never WHICH `optionId` — option selection stays in `permission-responder.ts`,
 * the one place D4 rules 1-6 live. That separation is what makes it structurally impossible for
 * M2-B to break rule 3 by editing the engine, and the `policy-never-names-an-option` guard
 * enforces it.
 */
export interface PolicyEngine {
  decide(s: PolicySubject): PolicyVerdict;
  readonly id: string;
  readonly snapshot: PolicySnapshot;
  /**
   * §20.6's watch list, resolved (the UNION over every applied preset layer).
   *
   * It is on the engine because it has to reach the TURN and the engine is the only thing that
   * resolved it: `worker.ts` stamps it on `state_update{idle}._meta["omni/policy"]`, and
   * `reduceTurn` folds `unpoliced_tool_call` out of it over the tool calls and interactions it
   * already has. That keeps D7 intact — the SDK's local `reduceTurn()` and `GET /turns/{id}` read
   * the same key off the same envelope and cannot disagree — where a daemon-side post-pass could
   * not. `[]` means nothing is watched, which is the default (review finding V9).
   */
  readonly alertOnUnpoliced: readonly string[];
}

/** One chosen option, and why. The ONE place D4 rules 1-6 pick an id (§5.8.9). */
export interface OptionChoice {
  readonly optionId: string | null;
  readonly rule: string;
}

// ── idle watchdog (M2-A; DESIGN §7) ──────────────────────────────────────────

export type WatchdogSignal =
  | { readonly kind: "turn_start"; readonly at: number }
  | { readonly kind: "envelope"; readonly at: number; readonly envelope: EventEnvelope }
  | { readonly kind: "parked"; readonly at: number }
  | { readonly kind: "unparked"; readonly at: number }
  | { readonly kind: "cancel_sent"; readonly at: number }
  | { readonly kind: "turn_end"; readonly at: number };

export interface WatchdogVerdict {
  /** Absolute epoch-ms the Worker must schedule, or null (disarmed). */
  readonly deadlineAt: number | null;
  readonly budget: "silent" | "tool" | null;
  readonly phase: "idle" | "silent" | "tool" | "cancelling" | "paused" | "spent";
  readonly openToolCalls: readonly string[];
}

export interface WatchdogState {
  readonly lastAt: number;
  readonly open: ReadonlySet<string>;
  readonly parked: boolean;
  readonly running: boolean;
  readonly cancelSentAt: number | null;
}

/**
 * PURE STATE + one timer, split exactly as `HibernateTimer` is: `watchdogStep` is the fold and is
 * table-testable with no clock and no process at all; `createWatchdog` wraps it in one
 * `Clock.setTimer`.
 */
export interface Watchdog {
  observe(s: WatchdogSignal): WatchdogVerdict;
  readonly verdict: WatchdogVerdict;
  /**
   * The RESOLVED budgets this watchdog is running under.
   *
   * Added at the Land step beyond §5.8.8's three members, for one reason: `WorkerSnapshot.watchdog`
   * must report `{silentMs, toolMs, cancelTimeoutMs}` "so an operator reads them without
   * re-deriving config" (§5.8.4), `worker.ts` is FROZEN after the Land step, and a worker that had
   * to be handed the numbers a second time is a worker that can disagree with its own watchdog.
   */
  readonly config: ResolvedWatchdogConfig;
  cancel(): void;
}

export interface WatchdogDeps {
  readonly workerId: WorkerId;
  readonly clock: Clock;
  readonly config: ResolvedWatchdogConfig;
  readonly onFire: (budget: "silent" | "tool") => void;
}

// ── diff provider (M2-B; D8) ─────────────────────────────────────────────────

export interface PatchHandle {
  readonly topLevel: string;
  readonly indexFile: string;
  readonly tree: string;
  readonly startedAtMs: number;
}

export interface PatchResult {
  readonly text: string | null;
  readonly source: "git" | null;
  readonly truncated: boolean;
  readonly quality: "exact" | "shared_worktree" | "unavailable";
  readonly warnings: readonly TurnWarning[];
}

export interface DiffProvider {
  /**
   * Called at prompt ADMISSION, **per turn** — never once per worker. F39: codex-acp creates
   * `.git/` in its own cwd mid-session, so "outside a repo ⇒ null" cannot be decided once at
   * worker start. NEVER throws: `null` is D8's honest answer and a git failure is not a failed turn.
   */
  begin(o: { cwd: string; workerId: WorkerId; signal?: AbortSignal }): Promise<PatchHandle | null>;
  /**
   * After settle, BEFORE `idle` is emitted. NEVER throws: a failure is `text: null` + a warning.
   *
   * `wroteFiles` is §25.4's `on_write` input, and it is an OBSERVATION rather than an
   * instruction: the worker reports whether this turn produced a write-ish tool call or a `diff`
   * content block, and the provider — the only party that holds `diff.mode` — decides what to do
   * with it. Absent ⇒ treated as `true`, which is `"always"`, which is what every caller written
   * before review finding V12 already meant.
   */
  end(h: PatchHandle, o?: { signal?: AbortSignal; wroteFiles?: boolean }): Promise<PatchResult>;
  /** Best effort; deletes the temp index when a turn dies without an `end`. NEVER throws. */
  abandon(h: PatchHandle): void;
}

// ── runs and webhooks (M2-B; D9) ─────────────────────────────────────────────

/**
 * D9's thin payload. **Eight keys, not seven**: `workerId` is added because the thin payload must
 * be ADDRESSABLE — `/v1` is keyed on `workerId`, and a receiver holding only `sessionId` cannot
 * pull anything back (ruling M2-R13). The `webhook-body-is-thin` guard pins the key set at
 * exactly these.
 */
export interface WebhookPayload {
  readonly deliveryId: DeliveryId;
  readonly event: WebhookEvent;
  readonly daemonId: DaemonId;
  readonly workerId: WorkerId;
  readonly runId: RunId | null;
  readonly sessionId: SessionId | null;
  readonly seq: Seq;
  readonly ts: string;
}

export interface RunRegistry {
  create(req: CreateRunRequest, auth: AuthContext): Promise<RunSnapshot>;
  get(id: RunId, auth: AuthContext): RunSnapshot;
  list(auth: AuthContext, o?: { limit?: number; cursor?: string }): readonly RunSnapshot[];
  cancel(id: RunId, auth: AuthContext): Promise<RunSnapshot>;
  logFor(id: RunId, auth: AuthContext): EventLog;
  /** Boot: every run whose `bootId` is not ours and whose state is live becomes `abandoned`, with
   *  a terminal `run.failed` delivery enqueued (§24.4). */
  recover(): { readonly abandoned: number };
}

/** One persisted run row (§24). The store half of `RunRegistry`; M2-B-WP-R owns both. */
export interface RunRow {
  readonly snapshot: RunSnapshot;
  readonly tokenId: TokenId;
  readonly bootId: string;
  readonly idempotencyKey: string | null;
  readonly webhook: WebhookTarget | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface RunStore {
  put(row: RunRow): void;
  get(id: RunId): RunRow | null;
  byIdempotencyKey(tokenId: TokenId, key: string): RunRow | null;
  list(o: { tokenId?: TokenId; limit: number; cursor?: string }): {
    rows: readonly RunRow[];
    cursor: string | null;
  };
  /** Boot: rows from a FOREIGN bootId in a live state, for `recoverRuns` to abandon (§24.4). */
  liveFromOtherBoots(bootId: string): readonly RunRow[];
  /** Retention sweeps runs and their deliveries TOGETHER, on M1's existing timer. */
  sweep(o: { olderThanMs: number }): number;
}

export interface DeliveryStore {
  enqueue(r: {
    deliveryId: DeliveryId;
    runId: RunId;
    tokenId: TokenId;
    event: WebhookEvent;
    url: string;
    payload: WebhookPayload;
    nowMs: number;
  }): void;
  /** Rows whose `next_attempt_ms <= nowMs`, oldest first, at most `limit`. */
  due(nowMs: number, limit: number): readonly DeliveryRecord[];
  /** ATOMIC compare-and-set pending→delivering, stamping this boot's id. false ⇒ somebody else
   *  has it. */
  claim(id: DeliveryId, bootId: string, nowMs: number): boolean;
  settle(r: {
    deliveryId: DeliveryId;
    ok: boolean;
    status: number | null;
    error: string | null;
    responseMs: number;
    nextAttemptMs: number | null;
    state: "delivered" | "pending" | "failed";
    nowMs: number;
  }): void;
  /** Boot: `delivering` rows owned by ANOTHER bootId → `pending`, `attempt` UNCHANGED (§24.4). */
  requeueStale(bootId: string, nowMs: number): number;
  list(o: { runId?: RunId; state?: string; limit: number; cursor?: string }): {
    rows: readonly DeliveryRecord[];
    cursor: string | null;
  };
  redeliver(id: DeliveryId, nowMs: number): DeliveryRecord;
}

export interface WebhookDispatcher {
  start(): void;
  /** Enqueues and returns IMMEDIATELY. It NEVER blocks a turn — a slow receiver may not slow an
   *  agent. */
  dispatch(
    p: Omit<WebhookPayload, "deliveryId">,
    target: WebhookTarget,
    tokenId: TokenId,
  ): DeliveryId;
  /**
   * Replays one dead letter, RE-RUNNING the SSRF gate first (review finding V1).
   *
   * `tokenId` is the D13 scope and `undefined` means "no scope", which is admin — the same
   * spelling `DeliveryStore.list` / `.redeliver` already take, so a row a token may not LIST is a
   * row it may not REPLAY. It is a parameter here rather than a second method for exactly that
   * reason: two verbs with one rule cannot drift.
   *
   * This is the ONLY redeliver a caller outside `core/webhook` may use. The store's own
   * `redeliver` flips a row back to `pending` and nothing else, so a route that called it would
   * re-POST hours later to a host whose name now resolves into `denyCidrs` — the create-time
   * check being the only one that ever ran.
   */
  redeliver(id: DeliveryId, tokenId?: TokenId): Promise<DeliveryRecord>;
  /** Drains what is due right now and returns when the in-flight set is empty. Tests and `stop()`. */
  drain(o?: { timeoutMs?: number }): Promise<void>;
  stop(): Promise<void>;
}

/** The `net.Resolver`-shaped seam `assertWebhookUrl` takes, so the SSRF test needs no DNS. */
export type Resolver = (hostname: string) => Promise<readonly string[]>;

/** What `AuthContext.assertEnv` returns: the resolved map, and the KEY NAMES for the snapshot. */
export interface EnvResolution {
  readonly env: Readonly<Record<string, string>>;
  readonly keys: readonly string[];
  /** `false` ⇒ `resume.method` is forced to null and the worker refuses to hibernate (§23.3). */
  readonly persist: boolean;
}

/** What `filterMcpCapabilities` reports; it is never an error (WP-S bullet 3). */
export interface McpResolution {
  readonly servers: readonly unknown[];
  readonly applied: readonly string[];
  readonly dropped: readonly { readonly name: string; readonly reason: string }[];
  readonly warnings: readonly TurnWarning[];
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
  /**
   * The epoch this lease RESUMES from. Ruling M1-R8 drops the HOLDER across a restart — a lease
   * over a dead process is meaningless — but §16.1 rule L7 says the epoch is monotonic per
   * worker, and boot adoption has already written `snapshot.lease.epoch + 1` into the row AND
   * into the in-band `omni.lease{how:"daemon_restart"}` envelope the client reads. A rehydrated
   * lease that restarted the count at 0 would hand the SAME number to two different generations,
   * so a log replay would read 1 → 2 → 1 and `isStaleEpoch`'s exact equality would accept a fence
   * from before the crash. Absent ⇒ 0, which is every non-rehydrated lease.
   */
  readonly initialEpoch?: number;
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
  /** M2-B: RESOLVED preset objects. A strategy never sees a preset NAME. `[]` in M1. */
  readonly mcpServers: readonly unknown[];
  /**
   * M2-A, D10. Computed once by `clientCapabilitiesFor(onUnresolved, cfg)` and passed in, so
   * `handshake.ts` and the WAKE path in `session-open.ts` cannot drift — F42 is that they
   * currently both hard-code `{}` in two different files, and `SessionReopenOptions` MUST be
   * given the same value as `open`.
   *
   * OPTIONAL at the Land step, required by §5.8.8: absent means the literal `{}` both files
   * hard-code today, so M1's behaviour is the default and M2-A-WP-I flips it by passing a value.
   */
  readonly clientCapabilities?: Readonly<Record<string, unknown>>;
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
  /**
   * M2: the catalogue as of THIS open/reopen, typed. Seeds `WorkerSnapshot.configOptions`; a
   * resumed session may report a different one (WP-C bullet 8). Optional at the Land step —
   * `capabilities.configOptions` is still the verbatim list M1 carries.
   */
  readonly configOptions?: readonly ConfigOptionView[] | null;
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

  // ── M2 (§5.8.8) ────────────────────────────────────────────────────────────

  /**
   * H22, and §19.6's check ORDER is this method's contract (review finding V10):
   * worker state → interaction existence → lease → body SHAPE → semantics.
   *
   * `a` is `unknown` for that last reason and no other: the shape is checked here, after the
   * lease, so a malformed body from a non-holder is `423 lease_held` and not `400`. A route that
   * parsed first — or a registry that did — inverts two rows of the table that §19.6 spells out.
   * An in-process caller may pass an `InteractionAnswerBody`; it is parsed again and unchanged.
   *
   * Existence precedes the lease deliberately: the pending set is already public through the
   * UNGATED `GET /interactions` (rule L2), so answering `404 interaction_not_found` for a stale
   * request id leaks nothing and stops a stale id being reported as a lease problem it does not
   * have.
   */
  answerInteraction(
    id: InteractionId,
    a: unknown,
    who: ClientRef & { tokenId: TokenId },
  ): InteractionAnswerResult;
  readonly interactions: readonly InteractionSnapshot[];
  /**
   * §19.8's FIRST rung, reachable from the registry (review finding V11).
   *
   * `daemon.stop()` settles every parked interaction BEFORE it drains the dispatcher and closes
   * the workers: an agent blocked on our answer may never read the shutdown, and a JSON-RPC
   * promise nobody resolved is a process that will not exit. Idempotent, and it never throws —
   * `Worker.close` settles again with `"close"` and finds nothing left to do.
   */
  settleInteractions(reason: "shutdown"): Promise<void>;
  /** H24. `409 worker_busy` unless `ready`; auto-wakes a `hibernated` worker exactly as `prompt`
   *  does. */
  setConfig(body: SetConfigBody, who: ClientRef): Promise<SetConfigResponse>;
  /**
   * DAEMON-initiated cancel, deliberately NOT lease-gated: the lease governs CLIENTS, and the
   * idle watchdog is not one. Without this the daemon's own timer `423`s itself the moment a real
   * `createLease` replaces `alwaysGrantedLease` — the kind of thing discovered in production.
   */
  cancelInternal(reason: "watchdog_silent" | "watchdog_tool"): Promise<void>;
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

  // ── M2-B (§5.8.8) ──────────────────────────────────────────────────────────

  /** D4. Throws `policy_exceeds_ceiling` (403) carrying `{ceiling, offending}`. */
  assertPolicy(sel: PolicySelection | undefined): PolicyEngine;
  /** DESIGN §8's hard blacklist ⊕ `envDeny` ⊕ the token's `envAllow`. Throws `bad_request`
   *  NAMING the key — never a silent drop (ruling M2-R12). */
  assertEnv(env: Readonly<Record<string, string>> | undefined): EnvResolution;
  /** Preset NAMES → resolved server objects. `400` for unknown, `403` for disallowed. */
  assertMcp(names: readonly string[] | undefined): readonly unknown[];
  readonly policyCeiling: PolicyCeiling | null;
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
  /**
   * §19.8 / §24.4 rule 5's first rung: settle every LIVE worker's parked interactions, so
   * `daemon.stop()` can run it before it drains the dispatcher (review finding V11). Best effort
   * over the fleet — one worker that cannot settle must not hold the shutdown open.
   */
  settleAllInteractions(): Promise<void>;

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

  // ── M2 façade rows (H22-H24), same rule: parse -> ONE call -> serialize ────

  /**
   * H22: `200 InteractionAnswerResult`.
   *
   * `body` is `unknown` because §19.6 puts the body SHAPE after the lease (review finding V10):
   * the route hands the raw JSON straight through and `Worker.answerInteraction` parses it at the
   * one point in the order where a `400` is the right answer.
   */
  answer(
    id: WorkerId,
    auth: AuthContext,
    reqId: InteractionId,
    body: unknown,
  ): InteractionAnswerResult;
  /** H23: `200 InteractionListResponse`. UNGATED (rule L2) — reading the pending set is an
   *  observer's right. */
  interactions(id: WorkerId, auth: AuthContext): InteractionListResponse;
  /** H24: `200 SetConfigResponse`. */
  setConfig(id: WorkerId, auth: AuthContext, body: SetConfigBody): Promise<SetConfigResponse>;
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
   * M2-B (D9). Always present; with no dispatcher wired every verb answers `bad_request` naming
   * M2-B-WP-R, which is D29's honest "not implemented yet" rather than a 500 (the M1 Land
   * precedent S8).
   */
  readonly runs: RunRegistry;
  readonly deliveries: DeliveryStore;
  /**
   * M2-B (D9). Always present, beside `deliveries` and for the reason review finding V1 found:
   * `POST /v1/webhooks/deliveries/{id}/redeliver` must go through the DISPATCHER, which re-runs
   * `assertWebhookUrl` before a replay, and never through a bare store write. With no dispatcher
   * wired every verb answers `bad_request` naming M2-B-WP-R — D29's honest "not implemented yet".
   */
  readonly dispatcher: WebhookDispatcher;

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

  // ── M2's five seams (§5.8.8). ABSENT means M1, for every one of them. ──────

  /** M2-A. Absent ⇒ `baselineInteractions(responder, clock)` — byte-for-byte M1. */
  readonly interactions?: (o: InteractionDeps) => InteractionStrategy;
  /** M2-A. Absent ⇒ no watchdog, which is M1. */
  readonly watchdog?: (o: WatchdogDeps) => Watchdog;
  /** M2-B. Absent ⇒ `createBaselineResponder`'s constant verdict — M1 unchanged. */
  readonly policy?: (sel: PolicySelection | null, ceiling: PolicyCeiling | null) => PolicyEngine;
  /** M2-B, D8. Absent ⇒ `TurnResult.patch` stays null, which is M1 (ruling M1-R11). */
  readonly diff?: DiffProvider;
  /** M2-B, D9. Absent ⇒ `POST /v1/runs` answers `400 unknown route` (the M1 Land precedent S8). */
  readonly webhooks?: WebhookDispatcher;
  readonly runs?: RunRegistry;
}
