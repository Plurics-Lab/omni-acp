import type { PromptCapabilities } from "./acp.js";
import type { OrphanRecord, WorkerCloseReason, WorkerState } from "./events.js";
import type { DaemonId, SessionId, Seq, TokenId, TurnId, WorkerId, WorkerRef } from "./ids.js";
import type { LeaseSnapshot } from "./lease.js";
import type { ResumeMethod, ResumeReport } from "./resume.js";

export interface ProcessInfo {
  readonly pid: number;
  /** POSIX process-group id (== pid). `null` on Windows: no addressable group. */
  readonly groupId: number | null;
  readonly startedAt: string;
  readonly command: string;
  readonly argsRedacted: readonly string[];
  /**
   * A platform token identifying THIS process incarnation, captured at spawn (§15.7).
   * Linux `"linux:<btime>:<starttime-ticks>"`, darwin `"darwin:<lstart-epoch>"`, `null` on win32
   * and on any failure. A null fingerprint means we will NEVER signal this pid after a restart:
   * pid reuse would make the kill a coin flip on an unrelated process.
   */
  readonly fingerprint: string | null;
}

export interface AgentCapabilitiesSnapshot {
  /** M1 still negotiates 1; widened so a v2 agent is a data change, not a type change (F24). */
  readonly protocolVersion: 1 | 2;
  /** Verbatim `agentCapabilities` from initialize. Never reshaped, never cached. */
  readonly raw: Readonly<Record<string, unknown>>;
  readonly loadSession: boolean;
  readonly promptCapabilities: PromptCapabilities | null;
  /** sessionCapabilities?.close */
  readonly supportsSessionClose: boolean;
  /**
   * Resolved ONCE at handshake from the descriptor's preference order (F18).
   * `method: null` means this worker can NEVER hibernate: the idle timer refuses to fire, or
   * closes, per `hibernate.whenNotResumable` (ruling M1-R15).
   */
  readonly resume: {
    readonly method: ResumeMethod | null;
    readonly replayFrom: boolean;
    readonly requiresSameCwd: boolean;
  };
  readonly supportsSessionList: boolean;
  /**
   * Verbatim `configOptions` from `session/new` — and from `session/load`/`session/resume`, which
   * return a body contrary to the v1 schema (F18). `null` when the agent returned none. Kept
   * because `current_mode_update -> config_option_update` cannot be built without the catalogue.
   */
  readonly configOptions: readonly unknown[] | null;
  /** v1 `NewSessionResponse.modes`. The source for the synthesized `mode` config option. */
  readonly modes: Readonly<Record<string, unknown>> | null;
  /** Method names the probe or the registry proved live, in descriptor preference order. */
  readonly extensions: readonly string[];
}

export interface WorkerSnapshot {
  readonly workerId: WorkerId;
  readonly daemonId: DaemonId;
  readonly ref: WorkerRef;
  /** null while `starting`. */
  readonly sessionId: SessionId | null;
  readonly agentId: string;
  readonly state: WorkerState;
  /** realpath'd. */
  readonly cwd: string;
  readonly label: string | null;
  readonly ownerTokenId: TokenId;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly headSeq: Seq;
  readonly currentTurnId: TurnId | null;
  readonly capabilities: AgentCapabilitiesSnapshot | null;
  /** null once closed. */
  readonly process: ProcessInfo | null;
  readonly closeReason: WorkerCloseReason | null;
  /** ALWAYS present. `holder: null` is a real, actionable state, not "no lease feature". */
  readonly lease: LeaseSnapshot;
  /** ISO-8601 of the transition into `hibernated`; null in every other state. */
  readonly hibernatedAt: string | null;
  /** Sticky. Set by any abnormal death, including "a previous boot owned this row". */
  readonly crashed: boolean;
  /** The LAST wake attempt's classification. null before the first wake. */
  readonly resume: ResumeReport | null;
  readonly wakeCount: number;
  /** Consecutive transient failures; reset to 0 by a successful wake. */
  readonly wakeFailures: number;
  readonly orphan: OrphanRecord | null;
  /** Processes this worker has had. 1 after the first handshake. */
  readonly generation: number;
  /** Descriptor identity: `"<agentId>@<fingerprint12>"`. Which quirk table governed this worker. */
  readonly runtimeId: string;
  /**
   * "memory"   — nothing here survives a restart, and we say so.
   * "durable"  — write-through is healthy.
   * "degraded" — a durable write FAILED. The log is still correct in RAM; a restart will not help.
   */
  readonly persistence: "memory" | "durable" | "degraded";
}

export interface CloseResult {
  readonly workerId: WorkerId;
  readonly state: "closed";
  readonly reason: WorkerCloseReason;
  readonly leaderExited: boolean;
  /**
   * true ONLY when the whole tree is provably gone.
   * Always false on Windows in M0 (CONTRACTS.md §6.4, D10).
   */
  readonly treeGone: boolean;
  /**
   * Whether `session/close` was actually sent and acknowledged. FALSE for every close of a
   * `hibernated` worker: we do not spawn a process in order to politely close a session (§15.6).
   * The daemon guarantees it stops referencing the session, not that the agent deleted it.
   */
  readonly sessionClosed: boolean;
}
