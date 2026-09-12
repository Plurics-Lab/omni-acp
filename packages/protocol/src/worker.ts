import type { PermissionOption, PromptCapabilities } from "./acp.js";
import type {
  InteractionActor,
  InteractionKind,
  InteractionMethod,
  InteractionPayload,
  InteractionStatus,
  OrphanRecord,
  ParkTimeoutAction,
  WorkerCloseReason,
  WorkerState,
} from "./events.js";
import type {
  DaemonId,
  InteractionId,
  SessionId,
  Seq,
  TokenId,
  TurnId,
  WorkerId,
  WorkerRef,
} from "./ids.js";
import type { LeaseSnapshot } from "./lease.js";
import type { ResumeMethod, ResumeReport } from "./resume.js";
import type { PolicyAction } from "./config.js";

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
   *
   * FROZEN AT HANDSHAKE from M2 on — the historical record of what the agent offered when the
   * session opened. The LIVE list is `WorkerSnapshot.configOptions`, because F34 shows the
   * returned list is a full replacement whose MEMBERSHIP CAN SHRINK (four → two) while F35 shows
   * another agent's does not.
   */
  readonly configOptions: readonly unknown[] | null;
  /**
   * M2, D10's gate, AS SENT, verbatim. F28: `initialize`'s `agentCapabilities` never mentions
   * elicitation either way, so our own declaration is the only record of why an agent asked in
   * prose instead of calling `elicitation/create`. Not recording it makes D10 unauditable.
   *
   * OPTIONAL at the Land step for the reason `CreateWorkerDeps.session` is (M1-PLAN §1.2): every
   * M1 construction site of this snapshot compiles unedited, and M2-A-WP-I fills it in from
   * `clientCapabilitiesFor()` without a migration. Absent reads as M1's literal `{}`.
   */
  readonly clientCapabilities?: Readonly<Record<string, unknown>>;
  /** v1 `NewSessionResponse.modes`. The source for the synthesized `mode` config option. */
  readonly modes: Readonly<Record<string, unknown>> | null;
  /** Method names the probe or the registry proved live, in descriptor preference order. */
  readonly extensions: readonly string[];
}

/**
 * One entry of the agent's live config catalogue, addressable without reshaping it (M2, §5.8.4).
 *
 * F34: the entry's own key is `id` while the REQUEST parameter is `configId` — two different
 * words for the same thing. Only the REQUEST word is a quirk (`Quirks.configIdField`, §17.3); the
 * entry key is `id` on BOTH agents, measured in claude-acp transcript `15` and codex-acp
 * transcript `07` (review R3), so `viewConfigOptions` reads `id` and there is no second quirk to
 * keep in sync. `raw` is the agent's object BY IDENTITY (§7.5):
 * codex spells its model id two ways (`models.availableModels[].modelId: "gpt-5.6-sol[low]"` vs
 * `configOptions[model].currentValue: "gpt-5.6-sol"`), so anything that normalized `currentValue`
 * would make a snapshot fail to match itself.
 */
export interface ConfigOptionView {
  readonly id: string;
  readonly currentValue: unknown;
  readonly raw: Readonly<Record<string, unknown>>;
}

/** One property of an `elicitation/create` `requestedSchema`, after mapping (F30). */
export interface ElicitationField {
  /** The PROPERTY NAME (`question_0`). Answers are keyed by QUESTION id, which is this. */
  readonly id: string;
  readonly title: string | null;
  readonly type: "string" | "integer" | "number" | "boolean" | "array";
  /** `oneOf[].const` ∪ `enum`, in wire order. F30: claude-acp sends `oneOf`, and a reader that
   *  knows only `enum` sees every question as unconstrained free text. */
  readonly options: readonly {
    value: string;
    title: string | null;
    description: string | null;
  }[];
  /** No `required` array was observed in either elicitation (F29) ⇒ false unless one appears. */
  readonly required: boolean;
  /**
   * The paired free-text property (`question_0_custom`), identified by
   * `_meta._askUserQuestionCustomAnswer.{questionId, isCustomAnswer}`. F30 is the whole reason
   * this field exists: filling BOTH made the agent use the CUSTOM value and create the wrong file.
   */
  readonly customField: string | null;
  /** Set when THIS property is somebody else's custom slot; it is never answered directly. */
  readonly isCustomFor: string | null;
  /** `minLength`/`maxLength`/`minimum`/`maximum`/`minItems`/`maxItems`, verbatim, when present. */
  readonly constraints: Readonly<Record<string, number>>;
}

/** One InteractionRequest, as a route and an SDK see it (M2, §5.8.4). */
export interface InteractionSnapshot {
  readonly requestId: InteractionId;
  readonly workerId: WorkerId;
  readonly kind: InteractionKind;
  readonly method: InteractionMethod;
  readonly status: InteractionStatus;
  readonly title: string;
  readonly message: string | null;
  readonly turnId: TurnId | null;
  readonly toolCallId: string | null;
  readonly createdAt: string;
  /** permission: the agent's offered options, verbatim (D4 rule 1's input). `[]` for an
   *  elicitation. */
  readonly options: readonly PermissionOption[];
  /** elicitation: `requestedSchema` normalized for a UI. `[]` for a permission. Never a
   *  substitute for `InteractionPayload.raw`. */
  readonly fields: readonly ElicitationField[];
  /** null once settled, and null while parked forever. NEVER a lie: cleared the moment the timer
   *  is disarmed, exactly as `LeaseSnapshot.expiresAt` is under a pin. */
  readonly expiresAt: string | null;
  readonly settledAt: string | null;
  readonly settledBy: InteractionActor | null;
  readonly answer: NonNullable<InteractionPayload["answer"]> | null;
}

/** The policy document a worker was admitted under, for the audit trail (M2-B, §5.8.4). */
export interface PolicySnapshot {
  /** Preset names in application order, then `"inline"` when the request carried rules. */
  readonly sources: readonly string[];
  readonly default: PolicyAction;
  readonly onUnresolved: "park" | "deny" | "fail";
  readonly ruleCount: number;
  /** The token's ceiling this worker was admitted under, for the audit trail. */
  readonly ceiling: string | null;
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

  // ── M2 (§5.8.4) ────────────────────────────────────────────────────────────
  //
  // OPTIONAL at the Land step, required by CONTRACTS §5.8.4. The reason is M1-PLAN §1.2's, and
  // it is the same reason `CreateWorkerDeps.session` is optional: a `WorkerSnapshot` is built in
  // `worker.ts`, in `rehydrated.ts`, in `boot-recovery.ts` and in a dozen test doubles, and a
  // required field whose only producer throws would take the whole M1 suite with it. Each work
  // package fills its own rows in and the shape is tightened by M2-WP-J at the join.

  /** The LIVE catalogue. Seeded from `capabilities.configOptions`, REPLACED WHOLESALE by every
   *  `POST …/config` from the METHOD's own result (F34, F35), never from the event stream. */
  readonly configOptions?: readonly ConfigOptionView[] | null;
  /** Fixed at creation. It decides whether `clientCapabilities.elicitation` is declared (D10, F28). */
  readonly onUnresolved?: "park" | "deny" | "fail";
  readonly parkTimeoutMs?: number | null;
  readonly parkTimeoutAction?: ParkTimeoutAction;
  /** Pending interactions, oldest first. Non-empty ⟺ `state === "requires_action"` (§19.5). */
  readonly interactions?: readonly InteractionSnapshot[];
  /** The RESOLVED budgets in force, so an operator reads them without re-deriving config.
   *  `null` when `watchdog.enabled:false`. */
  readonly watchdog?: {
    silentMs: number;
    toolMs: number;
    cancelTimeoutMs: number;
    armedAt: string | null;
    budget: "silent" | "tool" | null;
  } | null;
  /** STICKY. True once any `allow_always` was ever selected on this session (F26). Never goes back. */
  readonly policyBlinded?: boolean;
  /** null when this worker runs on the baseline responder (no engine configured) — i.e. M2-A. */
  readonly policy?: PolicySnapshot | null;
  /** Reported, never silent: a preset the agent could not take is a capability the client did not get. */
  readonly mcp?: {
    readonly requested: readonly string[];
    readonly applied: readonly string[];
    readonly dropped: readonly { name: string; reason: string }[];
  };
  /** KEY NAMES ONLY. An env VALUE never reaches a snapshot, a log line or an HTTP body (DESIGN §8). */
  readonly envKeys?: readonly string[];
  readonly patchMode?: "off" | "on_write" | "always";

  // ── M3-WP1 (docs/M3-WP1-CREDENTIALS.md) ────────────────────────────────────
  //
  // OPTIONAL on the same terms as M2's rows above, and for the same reason: a `WorkerSnapshot` is
  // built in `worker.ts`, in `rehydrated.ts`, in `boot-recovery.ts` and in a dozen test doubles.
  // Absent reads as "this daemon has no credential layer wired", which is M2 exactly.

  /**
   * WHICH credential this worker is running on — NAME, METHOD and FINGERPRINT, and nothing else.
   *
   * `null` is `inherit`: the worker took the daemon's own environment, which is M2's behaviour and
   * `credentials.allowInherit`'s default. A snapshot is served to every client that can see the
   * worker, so the only thing here that identifies the credential is a sha256 prefix.
   */
  readonly credential?: {
    readonly name: string | null;
    readonly method: "files" | "token" | "apiKey" | "inherit" | "none";
    readonly fingerprint: string | null;
  } | null;
  /**
   * true ⇒ the LINK was re-pointed at a different credential but this PROCESS has not picked it
   * up — a `reload:"restart"` agent whose swap landed mid-turn (`applied: "on-next-start"`).
   *
   * It is the field that stops `credential.fingerprint` being a lie: the fingerprint says what the
   * worker will use, `stale` says whether it is using it yet.
   */
  readonly credentialStale?: boolean;
  /**
   * This worker's isolated home (`<dataDir>/homes/<workerId>`), or null for `home:"shared"`.
   *
   * E7 is why it is on the snapshot at all: the agent's session files live in there
   * (claude `projects/`, codex `thread_history`), so a hibernate, a wake and a restart must all
   * reuse the SAME directory, and an operator debugging a resume needs to be able to find it.
   */
  readonly home?: string | null;
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
