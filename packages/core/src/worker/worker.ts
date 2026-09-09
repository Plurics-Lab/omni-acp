import {
  AcpRequestError,
  OmniError,
  turnStatus,
  workerRef,
  type AgentCapabilitiesSnapshot,
  type AgentDescriptor,
  type AgentProcess,
  type Clock,
  type ClientRef,
  type CloseResult,
  type DaemonId,
  type EventEnvelope,
  type EventInput,
  type EventLog,
  type IdGen,
  type KillOutcome,
  type Lease,
  type Logger,
  type Normalizer,
  type OmniErrorBody,
  type PermissionResponder,
  type ProcessExit,
  type PromptAccepted,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionId,
  type SpawnSpec,
  type StopReason,
  type Supervisor,
  type TimerHandle,
  type TurnId,
  type TurnOutput,
  type TurnStatus,
  type WorkerCloseReason,
  type WorkerHandle,
  type CloseOutAction,
  type MappedPermissionRequest,
  type PermissionDecision,
  type AcpLinkLike,
  // ── M2's seams (§5.8.8) ────────────────────────────────────────────────────
  type DiffProvider,
  type InteractionAnswer,
  type InteractionAnswerResult,
  type InteractionContext,
  type InteractionId,
  type InteractionSnapshot,
  type InteractionStrategy,
  type MappedElicitationRequest,
  type PatchHandle,
  type SetConfigBody,
  type SetConfigResponse,
  type TokenId,
  type Watchdog,
  type WatchdogSignal,
  type OrphanRecord,
  type ResumeReport,
  type RuntimeDescriptor,
  type SessionOpenResult,
  type SessionReopenOptions,
  type SessionStrategy,
  type WorkerId,
  type WorkerRow,
  type WorkerSnapshot,
  type WorkerState,
  type WorkerStatePayload,
} from "@omni-acp/protocol";
import { openAcpLink, type AcpLink } from "../acp/link.js";
import type { EventLogCore } from "../event-log/log-core.js";
import type { ReplayCounts } from "./session-open.js";
import { DEFAULT_V1_PROFILE } from "../runtime/known.js";
import { runHandshake } from "./handshake.js";

export interface CreateWorkerDeps {
  readonly workerId: WorkerId;
  readonly daemonId: DaemonId;
  readonly descriptor: AgentDescriptor;
  /** Already realpath'd and ACL-checked. */
  readonly cwd: string;
  readonly label: string | null;
  readonly owner: ClientRef;
  readonly supervisor: Supervisor;
  readonly log: EventLog;
  readonly normalizer: Normalizer;
  readonly responder: PermissionResponder;
  readonly lease: Lease;
  readonly clock: Clock;
  readonly ids: IdGen;
  readonly logger: Logger;
  readonly limits: {
    handshakeTimeoutMs: number;
    cancelGraceMs: number;
    exitGraceMs: number;
    gracefulMs: number;
    /**
     * Budget for a WAKE's spawn + initialize + resume. Separate from `handshakeTimeoutMs`
     * because a wake is warm (claude-acp ~0.94 s initialize + ~0.55 s load) where a create may be
     * cold (~7 s). Absent ⇒ `handshakeTimeoutMs`, so an M0 caller keeps its one budget.
     */
    wakeTimeoutMs?: number;
    /**
     * Consecutive TRANSIENT wake failures before the pointer is abandoned (`wake_failed`, §15.5).
     * Absent ⇒ `hibernate.maxWakeFailures`'s own default. It lives here because the counter is a
     * private field of this class, and this file is frozen after the Land step (review R13).
     */
    maxWakeFailures?: number;
    /**
     * BACKSTOP for §13.2's CLOSE_OUT ladder, and nothing more. The reducer owns every rung's
     * deadline (rung 1's quiet window capped by `hardMs`, rung 3's `drainGraceMs`, rung 4's
     * `cancelGraceMs`), and this only stops a reducer that never settles from holding
     * `DELETE /v1/workers/{wid}` open forever. It must therefore be LARGER than the reducer's
     * own budget: M1-WP-E passes `turn.hardMs + drainGraceMs + cancelGraceMs`.
     *
     * Optional for the same reason `wakeTimeoutMs` is: an M0 caller keeps its one budget, and
     * the M0 slice never enters the ladder at all.
     */
    closeOutMs?: number;
    /**
     * M2-A. How long a parked interaction may wait for a human before `parkTimeoutAction` fires.
     * `0` ⇒ a park never expires (a human is genuinely expected). Absent ⇒
     * `interaction.parkTimeoutMs`'s own default, resolved by the registry.
     */
    parkTimeoutMs?: number;
  };
  /**
   * Optional, and the ONLY addition to CONTRACTS.md §5.3's `CreateWorkerDeps`.
   *
   * §5.3 hands `createWorker` a descriptor and a cwd, while `contracts.ts` calls
   * `Catalog.toSpawnSpec` "the ONLY producer of SpawnSpec". Both can be true only if the
   * assembled daemon passes its catalog's producer in, so it does — and a unit test that has no
   * catalog gets the derivation below. Every field §5.3 declares is unchanged and still
   * required, so a caller written against the document compiles untouched.
   */
  readonly toSpawnSpec?: (d: AgentDescriptor, o: { cwd: string }) => SpawnSpec;
  /**
   * SEAM 2 (M1-PLAN §1.2). Once M1-WP-C lands `createSessionStrategy`, the Worker holds one and
   * calls `open()` on create and `reopen()` on wake, and never names `initialize`,
   * `session/new`, `session/load` or `session/resume` again.
   *
   * It is OPTIONAL at the Land step and absent means "M0's inline `runHandshake` path", because
   * a required dependency whose only implementation throws would take all 978 M0 tests with it.
   * The injection point is what matters here: WP-C fills it in without editing this frozen file.
   */
  readonly session?: SessionStrategy;
  /**
   * The RESOLVED quirk table for this agent (builtin ⊕ config ⊕ probe, §17.2), handed to the
   * `SessionStrategy` on every `open` / `reopen`. Optional for the same reason `session` is: a
   * unit test with no catalog gets `DEFAULT_V1_PROFILE`, which is the documented fallback rather
   * than a failure (`Catalog.descriptor()` "NEVER throws"). M1-WP-E passes the real one.
   */
  readonly runtime?: RuntimeDescriptor;
  /**
   * Descriptor identity for `WorkerSnapshot.runtimeId` — "which quirk table governed this
   * worker". M1-WP-E computes it as `"<agentId>@<fingerprint12>"` from the resolved descriptor;
   * absent, the snapshot reports the agent id against the `unresolved` fingerprint sentinel
   * rather than a hex string that would look authoritative (see `runtime/known.ts`).
   */
  readonly runtimeId?: string;

  // ═══════════════════════════════════════════════════════════════════════════
  // M2's SIX SEAMS (M2-PLAN §1.2, the nine named hunks). Every one is OPTIONAL,
  // and with all of them ABSENT this file compiles and `core/test/worker/**`
  // passes unedited — Land exit criterion 8, and the proof that M1 behaviour is
  // the default rather than a migration.
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * SEAM A (M2-A-WP-I). The ONE interaction lifecycle, which SUPERSEDES `responder` by wrapping
   * it: `baselineInteractions(responder, clock)` is byte-for-byte M1 (§19.10). Absent ⇒ hunk 2's
   * inline baseline below, which is M1's code moved nowhere at all.
   */
  readonly interactions?: InteractionStrategy;
  /** SEAM B (M2-A-WP-W). Absent ⇒ disarmed, which is M1: no watchdog existed. */
  readonly watchdog?: Watchdog;
  /** SEAM C (M2-WP-J, D8). Absent ⇒ no `omni/patch` key on `idle`, so `TurnResult.patch` stays
   *  `null` — M1 exactly (ruling M1-R11). */
  readonly diff?: DiffProvider;
  /**
   * M2-B-WP-S. Absent ⇒ `assertPromptContent`, M0's text-only whitelist, unchanged. The gate
   * MOVED here from `PromptRequestBody`'s deleted `.refine` (§5.8.6): zod holds no worker, so it
   * can enforce neither this agent's `promptCapabilities` nor this token's `cwdRoots`.
   */
  readonly validateContent?: (content: readonly unknown[]) => void | Promise<void>;
  /**
   * M2-A, D10. Computed ONCE by `clientCapabilitiesFor()` and threaded through to BOTH `open`
   * and `reopen` — F42 is that `handshake.ts` and `session-open.ts` currently hard-code `{}` in
   * two different files, so a woken `park` worker silently stops declaring elicitation. Absent ⇒
   * the literal `{}` both files hard-code today.
   */
  readonly clientCapabilities?: Readonly<Record<string, unknown>>;
  /**
   * M2-B, DESIGN §8. The RESOLVED MCP preset objects for this worker — a strategy never sees a
   * preset NAME, and a client can never put a `command` on the wire at all (the type of
   * `CreateWorkerRequest.mcp` is `string[]`). Absent ⇒ `[]`, which is M1.
   */
  readonly mcpServers?: readonly unknown[];
}

/**
 * The states this kernel can actually occupy (`events.ts` `M2_WORKER_STATES`).
 *
 * M2 admits `requires_action`, which stopped being wire-stable-and-unemitted the moment
 * `onUnresolved:"park"` had somewhere to park (F43, hunk 4). The rule the M1 comment stated is
 * unchanged and still the reason this union exists: a state the kernel cannot enter must not
 * typecheck as one it can — and `requires_action` is only reachable through `#park`, which is
 * only reachable through an injected strategy.
 */
type M1State = "starting" | "ready" | "running" | "requires_action" | "hibernated" | "closed";

/**
 * `hibernate.maxWakeFailures`'s own default (`config.ts`), restated for a `createWorker` caller
 * that passes no limit. Restated rather than imported because `protocol`'s zod default is a
 * config-parse concern and this class must behave the same for a unit test that has no config.
 */
const DEFAULT_MAX_WAKE_FAILURES = 3;

/**
 * `limits.closeOutMs`'s fallback: the backstop on §13.2's ladder for a caller that passes no
 * budget. Deliberately generous — it is not a rung deadline, it is the answer to "the reducer
 * never said `settled`", and a value below the reducer's own ladder budget would truncate a
 * ladder that was working.
 */
const DEFAULT_CLOSE_OUT_MS = 10_000;

/**
 * M2, seam D (M2-PLAN §1.3). The one key the diff provider's result rides under, on
 * `TurnInput.prompt_result.meta` → `state_update{idle}._meta` → `TurnResult.patch`.
 *
 * It is spelled in `protocol/src/turn.ts` (the reader) and here (the writer) and nowhere else;
 * `turn-lifecycle.ts` in between merges the record without reading a single key of it, which is
 * exactly what lets the git provider land with zero edits to the reducer (ruling M2-R9).
 */
const PATCH_META = "omni/patch";

/**
 * The `elicitation/create` mapper's Land-step stand-in.
 *
 * `Normalizer.mapElicitation` is M2-A-WP-I's (§5.8.9) and does the real work — the FLAT scope
 * (F29), `oneOf[].const` ∪ `enum` (F30), the `_custom` pairing. Until it exists, an unparseable
 * schema's honest shape is exactly what this returns: `fields: []` with every property in
 * `unmodelled`, which makes `answer` impossible and `deny`/`cancel` still possible, instead of a
 * form that lies about itself.
 */
function mapElicitationFallback(params: unknown): MappedElicitationRequest {
  const p =
    typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {};
  const schema =
    typeof p["requestedSchema"] === "object" && p["requestedSchema"] !== null
      ? (p["requestedSchema"] as Record<string, unknown>)
      : {};
  const properties =
    typeof schema["properties"] === "object" && schema["properties"] !== null
      ? (schema["properties"] as Record<string, unknown>)
      : {};
  return {
    mode: "form",
    // F29: the scope fields are FLAT in `params`, not nested under `scope`.
    sessionId: typeof p["sessionId"] === "string" ? p["sessionId"] : "",
    toolCallId: typeof p["toolCallId"] === "string" ? p["toolCallId"] : null,
    requestId: typeof p["requestId"] === "string" ? p["requestId"] : null,
    message: typeof p["message"] === "string" ? p["message"] : "",
    fields: [],
    unmodelled: Object.keys(properties),
    ...(typeof p["_meta"] === "object" && p["_meta"] !== null
      ? { _meta: p["_meta"] as Record<string, unknown> }
      : {}),
  };
}

/** Close reasons whose meaning is "the agent process is gone", as opposed to "we asked". */
const DEATH_REASONS: ReadonlySet<WorkerCloseReason> = new Set<WorkerCloseReason>([
  "agent_crashed",
  "agent_exited",
  "protocol_error",
]);

interface CloseExtras {
  readonly error?: OmniError;
  readonly stderrTail?: string;
  readonly exit?: ProcessExit | null;
  /** Skip the cooperative rungs: the agent has already had its chance (§6.5). */
  readonly force?: boolean;
}

/** The complete environment for the child, composed once (SpawnSpec: "the Supervisor adds nothing"). */
function inheritedEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function defaultSpawnSpec(d: AgentDescriptor, o: { cwd: string }, label: string | null): SpawnSpec {
  return {
    command: d.command,
    args: d.args,
    cwd: o.cwd,
    env: { ...inheritedEnv(), ...d.env },
    // Per-agent shutdown beats the daemon default: a descriptor sets it precisely because that
    // runtime needs longer (or shorter) than everything else on the machine.
    gracefulMs: d.shutdown.graceMs,
    shutdownSignal: d.shutdown.signal,
    label: label ?? d.id,
  };
}

/**
 * M0 accepts `type:"text"` and nothing else (CONTRACTS.md §2.3, review R12).
 *
 * The check lives here rather than only in the HTTP layer because this is where the handshake's
 * `promptCapabilities` is held: when M2 admits `image` / `audio` / `resource_link`, the
 * per-agent gate is a few lines below this one, and no route has to learn about capabilities.
 */
function assertPromptContent(content: readonly unknown[]): void {
  if (content.length === 0) {
    throw new OmniError("bad_request", "prompt content is empty");
  }
  for (const [i, block] of content.entries()) {
    if (typeof block !== "object" || block === null) {
      throw new OmniError("bad_request", `prompt content block ${String(i)} is not an object`);
    }
    const type = (block as { type?: unknown }).type;
    if (type !== "text") {
      throw new OmniError(
        "bad_request",
        `prompt content block ${String(i)} has type ${JSON.stringify(type)}; M0 accepts only "text"`,
      );
    }
    if (typeof (block as { text?: unknown }).text !== "string") {
      throw new OmniError("bad_request", `prompt content block ${String(i)} has no text`);
    }
  }
}

/**
 * `WorkerSnapshot.watchdog` (§5.8.4): the RESOLVED budgets plus the deadline in force.
 *
 * `null` for a worker with no watchdog and for one whose watchdog is disabled, because those are
 * the same fact — nothing will cancel this turn on a timer — and reporting numbers for a
 * disarmed timer is exactly the kind of snapshot that reads true and is not.
 */
function watchdogViewOf(
  watchdog: Watchdog | undefined,
  armedAtMs: number | null,
): WorkerSnapshot["watchdog"] {
  if (watchdog === undefined || !watchdog.config.enabled) return null;
  return {
    silentMs: watchdog.config.silentMs,
    toolMs: watchdog.config.toolMs,
    cancelTimeoutMs: watchdog.config.cancelTimeoutMs,
    armedAt: armedAtMs === null ? null : new Date(armedAtMs).toISOString(),
    budget: watchdog.verdict.budget,
  };
}

function isRunningStateUpdate(e: EventInput): boolean {
  if (e.kind !== "acp.session_update") return false;
  const p = e.payload as unknown as Record<string, unknown>;
  return p["sessionUpdate"] === "state_update" && p["state"] === "running";
}

function stopReasonOf(response: unknown): StopReason {
  if (typeof response === "object" && response !== null) {
    const s = (response as { stopReason?: unknown }).stopReason;
    if (typeof s === "string") return s as StopReason;
  }
  // v1 makes `stopReason` mandatory; an agent that omits it has still ended the turn, and
  // `end_turn` is the only reading that is not a fabricated failure.
  return "end_turn" as StopReason;
}

/**
 * A persisted `WorkerSnapshot.state` narrowed to the states this class can occupy.
 *
 * `requires_action` is wire-stable and unemitted until M2, so a row carrying it did not come
 * from this kernel; a state the kernel cannot enter must not be restored as one it can.
 */
function restoredState(state: WorkerState): M1State {
  switch (state) {
    case "starting":
    case "ready":
    case "running":
    case "hibernated":
    case "closed":
      return state;
    case "requires_action":
      // Interactions are deliberately NOT persisted (ruling M2-R10), so a row that says
      // `requires_action` describes a park whose JSON-RPC promise died with its boot. There is
      // nothing left to answer, so it is restored as the state the answer would have produced.
      return "ready";
    default:
      throw new OmniError("internal", `cannot restore a worker in state "${state}"`);
  }
}

/**
 * The §15.6 fallback body for a `closed` row whose `closeResult` is missing — a boot that died
 * mid-close. Deliberately PESSIMISTIC: we never proved the leader exited and never proved the
 * tree was gone, and a `treeGone: true` we did not observe is the one thing §6.6 forbids.
 */
function pessimisticCloseResult(workerId: WorkerId, reason: WorkerCloseReason | null): CloseResult {
  return {
    workerId,
    state: "closed",
    // `orphaned` is the honest reading when the row carries none: a previous boot owned this
    // worker and left no record of how it ended.
    reason: reason ?? "orphaned",
    leaderExited: false,
    treeGone: false,
    sessionClosed: false,
  };
}

/**
 * §14.8's "a rehydrated worker is the SAME `Worker` class, constructed in a non-`starting`
 * initial state".
 *
 * EXPORTED for exactly that reason (review round 1, item 1): `worker/rehydrated.ts` cannot honour
 * §14.8 by writing a second class — a second `close()` / `wake()` / `snapshot()` is precisely
 * where the "DELETE after a restart returns a different body" bug lives — and it cannot reach
 * this one without a name. It is NOT on `@omni-acp/core`'s barrel: `createWorker` and
 * `createRehydratedWorker` stay the only two ways a consumer gets a `WorkerHandle`.
 */
export class Worker implements WorkerHandle {
  readonly #deps: CreateWorkerDeps;
  readonly #logger: Logger;
  readonly #createdAt: string;
  readonly #listeners = new Set<(s: WorkerState, prev: WorkerState | null) => void>();

  /** The authoritative state. `prompt()` flips it during its synchronous admission check. */
  #state: M1State = "starting";

  /**
   * M2, hunk 4. The parked interaction ids, REFCOUNTED: `interactions.length > 0 ⟺ state ===
   * "requires_action"` is the invariant (§19.5), and this set is the left-hand side of it.
   */
  readonly #parked = new Set<InteractionId>();

  /** M2, hunk 7. The watchdog's current deadline, for `WorkerSnapshot.watchdog.armedAt`. */
  #watchdogArmedAt: number | null = null;
  /**
   * The last state actually WRITTEN to the log, which is what `previous` means to a reader.
   * It is a separate field because `prompt()` claims "running" before the envelope that
   * announces it exists — otherwise the announcement would report `previous: "running"`.
   */
  #emittedState: WorkerState | null = null;
  #updatedAt: string;
  #sessionId: SessionId | null = null;
  #capabilities: AgentCapabilitiesSnapshot | null = null;
  #proc: AgentProcess | null = null;
  #link: AcpLink | null = null;
  #linkClosed = false;
  /**
   * "The agent process is gone", observed from the PROCESS rather than from the SDK.
   *
   * §6.7's rule — a rejection with no JSON-RPC code is a dead transport, so do not classify from
   * it — was enforced only by `#linkClosed`, which is set from a `.then()` on the SDK's
   * `connection.closed`. That made correctness depend on the SDK resolving `closed` BEFORE it
   * rejects pending requests. It does today, but nothing in this repo owns that ordering, and the
   * cost if it ever inverted is a fabricated clean turn end for a dead process (§7.3).
   */
  #agentGone = false;
  #currentTurnId: TurnId | null = null;
  #closeReason: WorkerCloseReason | null = null;

  // ── M1 record fields (§15.1, §5.1 `WorkerSnapshot`) ────────────────────────
  //
  // Every one of them is reported by `snapshot()`, so each is maintained here rather than
  // guessed at the boundary. The transitions that MOVE them are M1-WP-C's (`hibernate.ts`,
  // `wake.ts`); what the Land step owns is that they exist, are honest from the first call, and
  // have exactly one home.

  /** Processes this worker has had. 1 after the first handshake; +1 on every wake. */
  #generation = 0;
  /** Sticky: set by any abnormal death, and it NEVER goes back to false (D2). */
  #crashed = false;
  /** ISO-8601 of the transition into `hibernated`; null in every other state. */
  #hibernatedAt: string | null = null;
  #wakeCount = 0;
  /** Consecutive TRANSIENT wake failures; reset to 0 by a successful wake. */
  #wakeFailures = 0;
  /** The LAST wake attempt's classification. null before the first wake. */
  #resume: ResumeReport | null = null;
  #orphan: OrphanRecord | null = null;
  /**
   * D6's replay window, as a REFCOUNT rather than a boolean: `SessionStrategy.reopen` opens it
   * and closes it in a `finally`, and a refcount is what keeps a nested or re-entered open from
   * closing a window somebody else still holds. Non-zero ⇒ every `agent_update` fed to the
   * reducer carries `replay: true` (§15.3).
   */
  #replayWindow = 0;
  /**
   * F16's counter: how many `session/update` notifications have arrived inside a replay window,
   * cumulative for the life of this worker. `ResumeReport.replayedEvents` wants a DELTA over one
   * wake, which the strategy takes by reading this before and after — see `controls.replayCounts`
   * in `#doWake`.
   */
  #replayEvents = 0;

  /**
   * True only while §13.2's CLOSE_OUT ladder is being driven. It exists because `#closing` gates
   * tick delivery, and the ladder ADVANCES on ticks: without this flag the reducer would ask for
   * a rung deadline the Worker has already stopped honouring, and every ladder would hang until
   * its backstop.
   */
  #closeOutActive = false;
  /** Resolved by `#afterStep` the moment the ladder reports `settled`. */
  #closeOutWaiter: (() => void) | null = null;
  /** `StderrTail.onLine`'s unsubscribe for the CURRENT process; null when there is none. */
  #stderrUnsub: (() => void) | null = null;

  /**
   * §16.1 rule L6: "Expiry never fires mid-turn. `pinExpiry()` is taken when the turn goes
   * `running` and released when it settles."
   *
   * The un-pin handle for the CURRENT turn, or null when no turn is running. It lives here
   * rather than in the Normalizer because the LEASE is the Worker's dependency and the turn's
   * lifetime is exactly `#state === "running"` — the window in which no gated verb is called, so
   * `renewOnUse` renews nothing and a 15-minute default TTL would otherwise expire under a
   * 16-minute turn, hand the worker to a peer mid-answer, and 423 the client that is still
   * reading the stream it started.
   */
  #leasePin: (() => void) | null = null;

  #tickTimer: TimerHandle | null = null;
  #cancelTimer: TimerHandle | null = null;
  #exitGraceTimer: TimerHandle | null = null;

  /**
   * Set SYNCHRONOUSLY, before `#doClose` runs a single line.
   *
   * `#closePromise` cannot serve as the flag: an async function body executes up to its first
   * `await` during the call itself, so `#closePromise` is still null while `#doClose` is already
   * appending the close envelopes — and every "are we closing?" guard would answer no. The bug
   * that costs is a `worker_state{ready, turn_end}` written into a log whose next line says the
   * agent crashed.
   */
  #closing = false;
  #closePromise: Promise<CloseResult> | null = null;
  /**
   * §15.2's flag, set SYNCHRONOUSLY before the first `await` of a hibernate, exactly like
   * `#closing` and for the same reason: a `prompt()` arriving in the window between "we decided to
   * reclaim the process" and "the state says hibernated" must already see busy.
   */
  #hibernating = false;
  #hibernatePromise: Promise<WorkerSnapshot> | null = null;
  /** Single-flight: five racing prompts on a hibernated worker are ONE npx cold start (§15.3). */
  #wakePromise: Promise<WorkerSnapshot> | null = null;
  #resolveClosed!: (r: CloseResult) => void;
  readonly closed: Promise<CloseResult>;

  /**
   * `restore` is §14.8's second construction: a handle over a PERSISTED row and its log, with no
   * process and no `start()`. Absent, this is M0's constructor line for line — which is why no M0
   * test moves.
   */
  constructor(deps: CreateWorkerDeps, restore?: { readonly row: WorkerRow }) {
    this.#deps = deps;
    this.#logger = deps.logger.child({ component: "worker", workerId: deps.workerId });
    const row = restore?.row ?? null;
    // A restored worker keeps the row's timestamps: `createdAt` is when the worker was created,
    // not when this process happened to read it back.
    this.#createdAt = row?.snapshot.createdAt ?? deps.clock.iso();
    this.#updatedAt = row?.snapshot.updatedAt ?? this.#createdAt;
    this.closed = new Promise<CloseResult>((resolve) => {
      this.#resolveClosed = resolve;
    });
    if (row === null) return;

    const s = row.snapshot;
    this.#state = restoredState(s.state);
    // The row's state IS the last state written to the log, so the next transition reports the
    // right `previous` — a rehydrated worker whose `previous` read null would announce itself as
    // a brand-new worker in the middle of its own log.
    this.#emittedState = s.state;
    this.#sessionId = s.sessionId;
    this.#capabilities = s.capabilities;
    this.#currentTurnId = s.currentTurnId;
    this.#closeReason = s.closeReason;
    this.#generation = s.generation;
    this.#crashed = s.crashed;
    this.#hibernatedAt = s.hibernatedAt;
    this.#wakeCount = s.wakeCount;
    this.#wakeFailures = s.wakeFailures;
    this.#resume = s.resume;
    this.#orphan = s.orphan;

    if (this.#state !== "closed") return;
    // §15.6 level 3: `DELETE` after a restart returns the PERSISTED body byte-for-byte. Pre-
    // resolving `#closePromise` is what makes that automatic — `close()` replays this object
    // instead of running `#doClose` again and recomputing `treeGone: true` for a tree this
    // process never proved gone, which is exactly the optimism §6.6 forbids.
    this.#closing = true;
    const result = row.closeResult ?? pessimisticCloseResult(deps.workerId, s.closeReason);
    this.#closePromise = Promise.resolve(result);
    this.#resolveClosed(result);
  }

  // ── identity ───────────────────────────────────────────────────────────────

  get id(): WorkerId {
    return this.#deps.workerId;
  }

  get log(): EventLog {
    return this.#deps.log;
  }

  get lease(): Lease {
    return this.#deps.lease;
  }

  snapshot(): WorkerSnapshot {
    return {
      workerId: this.#deps.workerId,
      daemonId: this.#deps.daemonId,
      ref: workerRef(this.#deps.daemonId, this.#deps.workerId),
      sessionId: this.#sessionId,
      agentId: this.#deps.descriptor.id,
      state: this.#state,
      cwd: this.#deps.cwd,
      label: this.#deps.label,
      ownerTokenId: this.#deps.owner.tokenId,
      createdAt: this.#createdAt,
      updatedAt: this.#updatedAt,
      headSeq: this.#deps.log.head,
      currentTurnId: this.#currentTurnId,
      capabilities: this.#capabilities,
      // null once closed: a pid that has been reaped is a pid that can be reused.
      process: this.#state === "closed" ? null : (this.#proc?.info ?? null),
      closeReason: this.#closeReason,
      // ALWAYS present: `holder: null` is a real, actionable state, not "no lease feature".
      lease: this.#deps.lease.snapshot(),
      hibernatedAt: this.#hibernatedAt,
      crashed: this.#crashed,
      resume: this.#resume,
      wakeCount: this.#wakeCount,
      wakeFailures: this.#wakeFailures,
      orphan: this.#orphan,
      generation: this.#generation,
      runtimeId: this.#deps.runtimeId ?? `${this.#deps.descriptor.id}@unresolved`,
      // The log knows whether it has a durable side; the worker must not restate the answer.
      // "degraded" — a durable write FAILED — is M1-WP-A's, reported through the log it owns.
      persistence: persistenceOf(this.#deps.log),
      // ── M2 (§5.8.4) ────────────────────────────────────────────────────────
      //
      // The invariant §19.5 names is visible right here: `interactions` is the strategy's pending
      // set, and `#park` is the ONLY thing that can make it non-empty — which is also the only
      // thing that can put this worker in `requires_action`.
      interactions: this.#deps.interactions?.pending ?? [],
      // `null` when nothing is injected AND when `watchdog.enabled:false` — the two cases a
      // client cannot tell apart and does not need to: neither will ever cancel a turn. When one
      // IS armed, `armedAt` is the deadline it will actually fire at, never a re-derivation.
      watchdog: watchdogViewOf(this.#deps.watchdog, this.#watchdogArmedAt),
    };
  }

  turn(turnId: TurnId): TurnStatus {
    return turnStatus(turnId, this.#deps.log.read(0));
  }

  onStateChange(cb: (s: WorkerState, prev: WorkerState | null) => void): () => void {
    this.#listeners.add(cb);
    return () => {
      this.#listeners.delete(cb);
    };
  }

  /**
   * Rule L6's release half. Idempotent twice over — the handle `pinExpiry()` returns ignores a
   * second call, and the field is nulled here — so every exit from `running` may call it
   * blindly: the two early returns in `prompt()`, the settle in `#afterStep`, hibernate, and
   * `#doClose`.
   */
  #unpinLease(): void {
    const release = this.#leasePin;
    if (release === null) return;
    this.#leasePin = null;
    try {
      release();
    } catch (e) {
      // A lease that cannot un-pin must not fail a turn that has already ended. The worst case
      // is a lease that outlives its TTL until the next sweep, which is strictly safer than an
      // exception escaping a settle path.
      this.#logger.warn("releasing the turn's lease pin failed", { error: String(e) });
    }
  }

  // ── the wire ───────────────────────────────────────────────────────────────

  async prompt(content: readonly unknown[], who: ClientRef): Promise<PromptAccepted> {
    this.#deps.lease.assertHolder(who);

    // §15.3's first box: a prompt on a hibernated worker AUTO-WAKES. `wake()` performs its own
    // synchronous admission (`#state = "starting"`), so it is entered in this same tick and a
    // second concurrent prompt sees `starting` — a 409 — rather than starting a second npx.
    if (this.#state === "hibernated") await this.wake(who);

    // Check-and-set, with NOTHING async between the two halves: `prompt()` is `async` only
    // because the contract types it that way, and 50 concurrent callers must yield exactly one
    // acceptance. An `await` anywhere above `#state = "running"` reopens that race.
    if (this.#state === "closed") {
      throw new OmniError("worker_closed", `worker ${this.#deps.workerId} is closed`);
    }
    if (this.#state !== "ready" || this.#hibernating) {
      // §15.2: `#hibernating` is the half-open window in which the state still reads `ready` but
      // the process is already being reclaimed. "Busy" is the honest answer for it.
      throw new OmniError(
        "worker_busy",
        `worker ${this.#deps.workerId} is ${this.#hibernating ? "hibernating" : this.#state}`,
      );
    }

    const link = this.#link;
    const sessionId = this.#sessionId;
    if (link === null || sessionId === null) {
      throw new OmniError("internal", "worker reached ready with no session");
    }

    const turnId = this.#deps.ids.turn();
    this.#state = "running";
    this.#currentTurnId = turnId;
    // Rule L6, taken at the same instant the turn becomes `running` and before the first thing
    // that can throw: a pin held over an aborted admission is released by the catch below, but a
    // pin taken after one would leave the window this exists to close.
    this.#leasePin = this.#deps.lease.pinExpiry();

    // HUNK 9 (M2-PLAN §1.2). The content gate is INJECTED; absent it is M0's text-only
    // whitelist, unchanged and still in this file's `assertPromptContent` below. M2-B-WP-S
    // replaces it with the containment check DESIGN §5.1 requires — realpath FIRST, then contain
    // — which needs this worker's `promptCapabilities` and the token's `cwdRoots` and therefore
    // cannot live in a zod schema (§5.8.6's deleted `.refine`).
    //
    // It runs AFTER the check-and-set and BEFORE anything reaches the wire, and that placement is
    // the whole of it. `prompt()` yields exactly one acceptance out of 50 concurrent callers only
    // because nothing awaits BETWEEN the state read and `#state = "running"`; the injected
    // validator may be async (a realpath is I/O), so awaiting it above that line would reopen
    // exactly that race. Awaiting it here cannot: a second caller already sees `running`. A
    // rejection rolls the admission back the same way the `#step` failure below does, so the
    // caller still gets its `400` FROM `prompt()` — H8's status, unmoved — and F37/F38's "the
    // fixture agent recorded ZERO `session/prompt` calls" holds by construction.
    try {
      await (this.#deps.validateContent ?? assertPromptContent)(content);
    } catch (e) {
      this.#state = "ready";
      this.#currentTurnId = null;
      this.#unpinLease();
      throw OmniError.from(e, "bad_request");
    }

    // §7.1: the running marker is appended BEFORE the prompt bytes reach stdin, and `append` is
    // synchronous while the write is not — so appending first is sufficient, and it is what
    // makes `PromptAccepted.seq - 1` a sound subscription cursor.
    //
    // If no marker comes back, there is no turn: `PromptAccepted.seq` would have nothing honest
    // to point at. Hand the admission back rather than stranding the worker as permanently busy
    // over a Normalizer that misbehaved.
    let running: { input: EventInput; seq: number } | undefined;
    try {
      running = this.#step({ type: "prompt_sent", turnId, at: this.#deps.clock.now() }).find((e) =>
        isRunningStateUpdate(e.input),
      );
    } catch (e) {
      this.#state = "ready";
      this.#currentTurnId = null;
      this.#unpinLease();
      throw OmniError.from(e);
    }
    if (running === undefined) {
      this.#state = "ready";
      this.#currentTurnId = null;
      this.#unpinLease();
      throw new OmniError(
        "internal",
        "normalizer did not synthesize state_update{running} for prompt_sent",
      );
    }
    this.#setState("running", "prompt", { turnId });

    // HUNK 7 (M2-PLAN §1.2). The watchdog is fed at prompt admission, at every append, at turn
    // end and at park/unpark. Absent ⇒ every call is a no-op and this file behaves as M1.
    this.#feedWatchdog({ kind: "turn_start", at: this.#deps.clock.now() });

    void this.#drivePrompt(link, sessionId, turnId, content);

    return { turnId, seq: running.seq };
  }

  async #drivePrompt(
    link: AcpLink,
    sessionId: SessionId,
    turnId: TurnId,
    content: readonly unknown[],
  ): Promise<void> {
    // HUNK 8 (M2-PLAN §1.2), the ADMISSION half. `begin` is called PER TURN, never once per
    // worker: F39 says codex-acp creates `.git/` in its own cwd mid-session, so "outside a repo
    // ⇒ null" cannot be decided at worker start. It NEVER throws, and a `null` handle is D8's
    // honest "no patch for this turn".
    let patch: PatchHandle | null = null;
    try {
      patch =
        (await this.#deps.diff?.begin({ cwd: this.#deps.cwd, workerId: this.#deps.workerId })) ??
        null;
    } catch (e) {
      // `begin` is contracted NEVER to throw, and a provider that does anyway must not fail the
      // turn: D8's answer to "we could not diff" is `patch: null`, not a broken prompt.
      this.#logger.warn("the diff provider failed to open a patch handle", { error: String(e) });
    }
    try {
      const res = await link.request<unknown>("session/prompt", {
        sessionId,
        prompt: content,
      });
      if (this.#currentTurnId !== turnId || this.#closing) {
        this.#abandonPatch(patch);
        return;
      }
      // HUNK 8, the SETTLE half: `end` runs IMMEDIATELY BEFORE `prompt_result` is fed, because
      // that is the input whose `meta` the reducer merges into `state_update{idle}._meta` (seam
      // D). Any later and the key would miss the envelope `reduceTurn` reads it from.
      const meta = await this.#endPatch(patch);
      this.#feed({
        type: "prompt_result",
        stopReason: stopReasonOf(res),
        ...(meta === null ? {} : { meta }),
        // F21. `PromptResponse.usage` is the ONLY place a per-turn token count is reported —
        // `usage_update` is a context-window gauge (`{used, size}`), not a cost. Forwarded raw:
        // the reducer decides whether it is the v2 `Usage` shape and drops it when it is not
        // (`ladder.test.ts`, "omits `usage` entirely when the response's block is not the v2
        // shape"), which keeps the type pun §5.1 warns about out of this file.
        usage: (res as { usage?: unknown } | null)?.usage,
        at: this.#deps.clock.now(),
      });
    } catch (e) {
      if (this.#currentTurnId !== turnId || this.#closing) {
        this.#abandonPatch(patch);
        return;
      }
      this.#abandonPatch(patch);

      // §6.7: an in-flight RPC that rejects with a plain `Error("ACP connection closed")` carries
      // NO JSON-RPC code and is not evidence of anything. The authoritative signals are
      // `stdoutEnded` and `exit`, both already wired, so we hand the turn to them rather than
      // classifying from a transport artefact.
      if (!(e instanceof AcpRequestError)) {
        if (this.#linkClosed || this.#agentGone || this.#proc?.pid === null) return;
        this.#logger.warn("session/prompt failed without a JSON-RPC code", { error: String(e) });
      }

      // The agent answered with an error but is still alive: the turn ends CLEANLY (§7.3) —
      // `omni.error` then `state_update{idle, stopReason:null}` — and the worker returns to ready.
      this.#feed({
        type: "prompt_error",
        error: OmniError.from(e, "agent_error").toBody(),
        at: this.#deps.clock.now(),
      });
    }
  }

  async cancel(who: ClientRef): Promise<void> {
    this.#deps.lease.assertHolder(who);
    if (this.#state === "closed") {
      throw new OmniError("worker_closed", `worker ${this.#deps.workerId} is closed`);
    }
    // Idempotent, and a no-op when no turn is live (H9).
    if (this.#state !== "running" || this.#link === null || this.#sessionId === null) return;

    const turnId = this.#currentTurnId;

    // §6.5: the notification goes first and the process stays alive. Killing at the response
    // boundary truncates the agent's last output, and a Worker is long-lived across turns —
    // a second `prompt()` must succeed after this.
    //
    // A failed send is not a failed cancel: `POST /cancel` is a 202 whatever the transport did
    // (H9), and a transport that will not take the notification is a dying process the crash
    // classifier is already watching. The escalation timer below is armed either way.
    // §19.8: every parked request is settled with a REAL answer on the wire, and this RETURNS
    // once every held JSON-RPC promise has resolved — BEFORE `session/cancel` reaches stdin. An
    // agent blocked on our answer may never read the cancel, and a log that ends on a `pending`
    // interaction is a log that lies.
    this.#settleInteractions("cancel");

    try {
      await this.#link.notify("session/cancel", { sessionId: this.#sessionId });
    } catch (e) {
      this.#logger.warn("session/cancel could not be sent", { error: String(e) });
    }

    this.#cancelTimer?.cancel();
    this.#cancelTimer = this.#deps.clock.setTimer(this.#deps.limits.cancelGraceMs, () => {
      this.#cancelTimer = null;
      if (this.#state !== "running" || this.#currentTurnId !== turnId) return;
      // §13.2's fourth trigger. The agent ignored `session/cancel`, so the CLOSE_OUT ladder runs
      // — the reducer decides which rungs are still worth offering, given that rung 4 has just
      // been spent — and only then does the force rung run. With M0's slice `#runCloseOut`
      // returns in the same tick and this is byte-for-byte M0's escalation.
      void this.#runCloseOut(this.#deps.limits.closeOutMs ?? DEFAULT_CLOSE_OUT_MS)
        .then(() =>
          this.#closeWith("cancel_timeout", {
            force: true,
            error: new OmniError(
              "agent_timeout",
              `the agent did not answer session/cancel within ${String(this.#deps.limits.cancelGraceMs)}ms`,
            ),
          }),
        )
        .catch((e: unknown) => {
          this.#logger.error("cancel escalation failed", { error: String(e) });
        });
    });
  }

  get generation(): number {
    return this.#generation;
  }

  /**
   * ready → hibernated (§15.2). SEAM 2, the Land-written half: this is the ordered state
   * transition and nothing else. Reclaims the process tree, RELEASES the lease, keeps the record
   * and the session pointer, and NEVER sends `session/close` — the pointer is the entire value
   * being preserved. The idle timer that CALLS it, and the strategy that reopens the session
   * afterwards, are M1-WP-C's (`worker/hibernate.ts`, `worker/session-open.ts`).
   *
   * Idempotent: a second caller shares the first transition; a worker already `hibernated`
   * answers with its snapshot rather than reclaiming a process twice.
   */
  async hibernate(reason: "idle_timeout" | "client_request"): Promise<WorkerSnapshot> {
    const inflight = this.#hibernatePromise;
    if (inflight !== null) return await inflight;
    if (this.#state === "hibernated") return this.snapshot();
    if (this.#state === "closed") {
      throw new OmniError("worker_closed", `worker ${this.#deps.workerId} is closed`);
    }
    if (this.#closing || this.#state !== "ready") {
      throw new OmniError("worker_busy", `worker ${this.#deps.workerId} is ${this.#state}`);
    }

    // Ruling M1-R15, and invariant 1 of §15.1: a `hibernated` worker MUST have a session pointer
    // and a resolved resume spelling. Hibernating a worker you can never wake is a one-way door
    // that turns a healthy worker into a guaranteed 422 on a timer, so the default
    // `hibernate.whenNotResumable: "keep"` refuses here and the caller keeps its process. The
    // opt-in `"close"` is the timer owner's `close("idle_timeout")`, not a second path in here.
    const strategy = this.#deps.session;
    const sessionId = this.#sessionId;
    const method = this.#capabilities?.resume.method ?? null;
    if (strategy === undefined || sessionId === null || method === null) {
      throw new OmniError(
        "not_resumable",
        `worker ${this.#deps.workerId} cannot hibernate: ${
          strategy === undefined
            ? "no SessionStrategy is wired, so nothing could reopen the session"
            : method === null
              ? "the agent advertises no resume spelling"
              : "the session pointer has already been cleared"
        }`,
      );
    }

    // SYNCHRONOUS, before the first await (§15.2) — see `#hibernating`.
    this.#hibernating = true;
    this.#hibernatePromise = this.#doHibernate(reason);
    try {
      return await this.#hibernatePromise;
    } finally {
      this.#hibernatePromise = null;
      this.#hibernating = false;
    }
  }

  /** §15.2's four steps, in the order that IS the correctness argument. */
  async #doHibernate(reason: "idle_timeout" | "client_request"): Promise<WorkerSnapshot> {
    this.#settleInteractions("hibernate");
    this.#logger.info("hibernating", { reason });
    this.#tickTimer?.cancel();
    this.#tickTimer = null;
    this.#cancelTimer?.cancel();
    this.#cancelTimer = null;
    this.#exitGraceTimer?.cancel();
    this.#exitGraceTimer = null;

    // 1. NO `session/close` — which is why this path does not go through `#doClose`. That call is
    //    the difference between hibernate and close: the pointer is the entire value being
    //    preserved, and `sessionCapabilities.close` on claude-acp is real and destructive.
    // 2. §13.2's CLOSE_OUT ladder (hibernate is its second trigger), then stdin EOF and the
    //    graceful ladder: the agent gets its normal shutdown, and the last chunk it was writing
    //    lands in the log BEFORE the process goes away rather than being cut mid-turn.
    await this.#runCloseOut(this.#deps.limits.closeOutMs ?? DEFAULT_CLOSE_OUT_MS);
    await this.#reclaimProcess({ force: false });

    // 3. The lease is released (DESIGN §3.2: 进程回收、lease 释放、记录保留). A holder cannot
    //    control a worker with no process, and holding a lease across a 30-minute sleep is how a
    //    lease silently becomes permanent.
    this.#deps.lease.releaseForHibernate();

    // 4. The ENVELOPE, then the persist (M1-WP-E's store subscribes to this log). A crash between
    //    them replays as §15.7's adoption path, which converges on the same `hibernated` state;
    //    persisting first and crashing before the envelope would leave a log that never mentions
    //    the transition.
    this.#hibernatedAt = this.#deps.clock.iso();
    this.#setState("hibernated", "hibernate", {
      turnId: null,
      generation: this.#generation,
      ...(this.#crashed ? { crashed: true } : {}),
    });
    return this.snapshot();
  }

  /**
   * hibernated → ready (§15.3, §15.5). SEAM 2's other half: the Land step writes the ladder's
   * STATE TRANSITIONS and delegates the session work to the injected `SessionStrategy.reopen`,
   * which is M1-WP-C's (`worker/wake.ts`, `worker/resume-classify.ts`). Idempotent and
   * single-flight: five racing callers share one attempt, because five racing prompts must not
   * become five `npx` cold starts.
   */
  async wake(who: ClientRef, opts?: { timeoutMs?: number }): Promise<WorkerSnapshot> {
    this.#deps.lease.assertHolder(who);
    const inflight = this.#wakePromise;
    if (inflight !== null) return await inflight;
    if (this.#state === "closed") {
      throw new OmniError("worker_closed", `worker ${this.#deps.workerId} is closed`);
    }
    // Already awake: a wake is a request for a live process, and there is one.
    if (this.#state === "ready" || this.#state === "running") return this.snapshot();
    if (this.#state !== "hibernated") {
      throw new OmniError("worker_busy", `worker ${this.#deps.workerId} is ${this.#state}`);
    }

    // Synchronous admission (§15.3): a second concurrent prompt now sees `starting`, i.e. 409.
    // The ENVELOPE for it is written by `#doWake`, so `previous` still reads `hibernated`.
    this.#state = "starting";
    this.#wakePromise = this.#doWake(opts?.timeoutMs);
    try {
      return await this.#wakePromise;
    } finally {
      this.#wakePromise = null;
    }
  }

  async #doWake(timeoutMs?: number): Promise<WorkerSnapshot> {
    const strategy = this.#deps.session;
    const sessionId = this.#sessionId;
    if (strategy === undefined || sessionId === null) {
      // §15.5 rows 1-2: there is nothing to resume WITH. The worker is closed and the caller gets
      // a 422, because a worker that can never wake must not sit in `hibernated` pretending.
      const error = new OmniError(
        "not_resumable",
        `worker ${this.#deps.workerId} has no session pointer to resume`,
      );
      await this.#closeWith("not_resumable", { error, force: true });
      throw error;
    }

    this.#wakeCount += 1;
    this.#setState("starting", "wake", { turnId: null, generation: this.#generation });

    let opened: SessionOpenResult;
    try {
      const link = await this.#openProcess();
      // D6's replay window: the resume call happens INSIDE it, which is why the wake path is the
      // one that opens it, and `controls.replayWindow()` lets the strategy narrow it to the exact
      // request/response pair (F16). The refcount makes that nesting free.
      /**
       * The strategy is handed an `AcpLinkLike` and cannot see notifications — the Worker routes
       * those — so `ResumeReport.replayedEvents` has no source but this one.
       *
       * `replayCounts` is an ADDITIONAL member on the object `SessionReopenOptions.controls`
       * types, read structurally by `session-open.ts`. A strategy written against the frozen
       * declaration ignores it and reports 0, exactly as before; the frozen type needs no change.
       * `dropped` stays 0 until ruling M1-R5's `resume.replay: "drop_duplicates"` lands in the
       * Normalizer, which is where the drop happens — reporting a number we do not measure would
       * be worse than reporting the zero we do.
       */
      const controls: SessionReopenOptions["controls"] & { replayCounts(): ReplayCounts } = {
        replayWindow: () => this.#openReplayWindow(),
        replayCounts: () => ({ events: this.#replayEvents, dropped: 0 }),
      };
      opened = await this.#withReplayWindow(() =>
        strategy.reopen(this.#asLinkLike(link), {
          cwd: this.#deps.cwd,
          descriptor: this.#runtime(),
          // Always [] in M1 (DESIGN §8 — presets are M2).
          mcpServers: [],
          budgetMs:
            timeoutMs ?? this.#deps.limits.wakeTimeoutMs ?? this.#deps.limits.handshakeTimeoutMs,
          sessionId,
          capabilities: this.#capabilities,
          controls,
        }),
      );
    } catch (e) {
      return await this.#wakeFailed(OmniError.from(e, "agent_error"));
    }

    this.#capabilities = opened.capabilities;
    this.#sessionId = opened.sessionId;
    this.#resume = opened.resume;
    // One more process has handshaken, so this is one more generation of this worker.
    this.#generation += 1;
    this.#wakeFailures = 0;
    this.#hibernatedAt = null;
    this.#deps.log.setSessionId(opened.sessionId);
    this.#setState("ready", "resumed", {
      turnId: null,
      generation: this.#generation,
      ...(opened.resume === null ? {} : { resume: opened.resume }),
      ...(this.#crashed ? { crashed: true } : {}),
    });
    return this.snapshot();
  }

  /**
   * §15.5's failure half, and the ONE place the pointer is abandoned.
   *
   * `not_resumable` from the strategy is D2's `rejected_permanent`: the pointer is worthless, so
   * it is cleared and the worker closes. Everything else is transient — the pointer is KEPT and
   * the worker goes back to `hibernated` — until `maxWakeFailures` consecutive attempts say the
   * agent is not coming back, which is what stops a worker whose agent binary was uninstalled
   * from paying a 7 s spawn on every prompt forever.
   */
  async #wakeFailed(error: OmniError): Promise<never> {
    await this.#reclaimProcess({ force: true });
    const resume = error.resume ?? null;
    if (resume !== null) this.#resume = resume;

    if (error.code === "not_resumable") {
      this.#sessionId = null;
      await this.#closeWith("not_resumable", { error, force: true });
      throw error;
    }

    this.#wakeFailures += 1;
    const max = this.#deps.limits.maxWakeFailures ?? DEFAULT_MAX_WAKE_FAILURES;
    if (this.#wakeFailures >= max) {
      this.#sessionId = null;
      const abandoned = new OmniError(
        "not_resumable",
        `worker ${this.#deps.workerId} abandoned its session pointer after ${String(max)} consecutive failed wakes`,
        { cause: error, ...(resume === null ? {} : { resume }) },
      );
      await this.#closeWith("wake_failed", { error: abandoned, force: true });
      throw abandoned;
    }

    // Back to `hibernated` with the pointer intact (§15.1's `starting -> hibernated` row).
    this.#hibernatedAt = this.#deps.clock.iso();
    this.#setState("hibernated", "wake_retry", {
      turnId: null,
      generation: this.#generation,
      error: error.toBody(),
      ...(resume === null ? {} : { resume }),
      ...(this.#crashed ? { crashed: true } : {}),
    });
    throw error;
  }

  /** The resolved quirk table, or the documented zero-quirk fallback (§17.2). */
  #runtime(): RuntimeDescriptor {
    return this.#deps.runtime ?? DEFAULT_V1_PROFILE;
  }

  /**
   * The narrow view of the link a `SessionStrategy` gets (`AcpLinkLike`, §5.1): request, notify,
   * and whether the transport is gone. Deliberately not the `AcpLink` itself — a strategy has no
   * business closing the link or holding the SDK connection.
   */
  #asLinkLike(link: AcpLink): AcpLinkLike {
    // A closure rather than `this.#linkClosed` inside the getter: `this` in an object literal's
    // getter is the literal, not the Worker, and a private field cannot be reached from there.
    const isClosed = (): boolean => this.#linkClosed;
    return {
      request: <T>(method: string, params: unknown): Promise<T> => link.request<T>(method, params),
      notify: (method: string, params: unknown): void => {
        void link.notify(method, params);
      },
      get closed(): boolean {
        return isClosed();
      },
    };
  }

  /**
   * D6's replay window, as a refcount. Returns the closer, which is idempotent so a strategy that
   * closes twice cannot reopen somebody else's window.
   *
   * The `finally` around it is load-bearing and is an acceptance bullet of its own (M1-PLAN WP-C
   * 3): a REJECTED resume that left the window open would mark the NEXT turn's updates as replay,
   * and a consumer filtering `replay: true` would then silently drop a live turn.
   */
  #openReplayWindow(): () => void {
    this.#replayWindow += 1;
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      this.#replayWindow -= 1;
    };
  }

  /**
   * D6's replay window, opened for the duration of `fn` and closed in a `finally`.
   *
   * It is a REFCOUNT rather than a boolean so a nested or re-entered open cannot close a window
   * somebody else still holds. `SessionReopenOptions.controls.replayWindow()` is the same thing
   * handed to a `SessionStrategy`.
   */
  async #withReplayWindow<T>(fn: () => Promise<T>): Promise<T> {
    const close = this.#openReplayWindow();
    try {
      return await fn();
    } finally {
      close();
    }
  }

  close(reason: WorkerCloseReason): Promise<CloseResult> {
    return this.#closeWith(reason, {});
  }

  // ── the normalizer seam ────────────────────────────────────────────────────

  /**
   * CONTRACTS.md §7.6's coupling, verbatim: step, append, reschedule. `seq` is assigned in
   * `EventLog.append` and nowhere else — `EventInput` cannot even name the field.
   */
  #step(input: Parameters<Normalizer["step"]>[0]): { input: EventInput; seq: number }[] {
    const { out, envelopes } = this.#stepOut(input);
    // `appendAll` returns exactly one envelope per input, in order (§8.2), so the pairing is
    // positional and total. The seq is COPIED off the envelope the log just stamped —
    // `EventLog.append` is its sole writer, and `seq-single-writer` wants that copy SPELLED, so
    // a missing envelope is an internal invariant break rather than a fabricated number.
    return out.emit.map((e, i) => {
      const envelope = envelopes[i];
      if (envelope === undefined) {
        throw new OmniError(
          "internal",
          `EventLog.appendAll returned ${String(envelopes.length)} envelopes for ${String(out.emit.length)} inputs`,
        );
      }
      return { input: e, seq: envelope.seq };
    });
  }

  /**
   * `#step`, handing back the reducer's OWN output.
   *
   * The close-out ladder needs `action` / `settled` / `scheduleTickAt`, not the seqs, and it must
   * see them from the very first step — `close_requested` that settles synchronously has to fall
   * straight through to the kill path rather than wait for a callback that already fired.
   */
  #stepOut(input: Parameters<Normalizer["step"]>[0]): {
    out: TurnOutput;
    envelopes: readonly EventEnvelope[];
  } {
    const out: TurnOutput = this.#deps.normalizer.step(input);
    const envelopes = this.#deps.log.appendAll(out.emit);
    // HUNK 7. The quiet window is anchored on the LAST ENVELOPE APPENDED, never on the prompt
    // response — F25 makes that 7/7 on claude-acp (a `session_info_update` arrives ~20 ms AFTER
    // the response), and codex emits `threadStatus:idle` BEFORE its response. Feeding here, at
    // the one place envelopes are written, is what makes that anchoring automatic. Replayed
    // envelopes are NOT activity, and the pure fold is where that is decided.
    for (const envelope of envelopes) {
      this.#feedWatchdog({ kind: "envelope", at: this.#deps.clock.now(), envelope });
    }
    this.#rescheduleTick(out.scheduleTickAt);
    this.#afterStep(out);
    return { out, envelopes };
  }

  /** `#step` for the paths where a throw must not escape into a timer or the SDK's dispatcher. */
  #feed(input: Parameters<Normalizer["step"]>[0]): void {
    try {
      this.#step(input);
    } catch (e) {
      this.#logger.error("normalizer step threw", { input: input.type, error: String(e) });
    }
  }

  /**
   * `#feed` for SEAM 1's three CLOSE_OUT inputs (`close_requested`, `drained`, `stderr_line`).
   *
   * They are fed unconditionally, because the ladder's decisions belong to the reducer and a
   * Worker that decided when to offer them would be making them here. A reducer that does not
   * implement them — M0's slice throws `unknown turn input` for all three — is a "no ladder
   * yet", not an error: it is logged at DEBUG once per call site rather than as the `error`
   * `#feed` would report, and the caller falls through to M0's path unchanged.
   */
  #feedLadder(input: Parameters<Normalizer["step"]>[0]): TurnOutput | null {
    try {
      return this.#stepOut(input).out;
    } catch (e) {
      this.#logger.debug("normalizer does not implement the close-out ladder", {
        input: input.type,
        error: String(e),
      });
      return null;
    }
  }

  /**
   * §13.2's CLOSE_OUT ladder, driven to `settled` BEFORE any kill. The four triggers §13.2 names
   * — `DELETE`, hibernate, daemon shutdown, cancel timeout — all enter through here.
   *
   * The Worker supplies the ladder's INPUTS and performs its rungs (`#perform`); every deadline
   * and every decision is the reducer's. `budgetMs` is a backstop on a reducer that never
   * settles, never a rung deadline.
   *
   * With M0's slice this returns in the same tick, having appended nothing: `close_requested`
   * throws inside the reducer, `#feedLadder` answers null, and the caller runs M0's path — which
   * is what keeps this amendment behaviour-neutral until M1-WP-B lands the ladder.
   */
  async #runCloseOut(budgetMs: number): Promise<void> {
    if (this.#closeOutActive) return;
    // Nothing to drain and nobody to cancel: the ladder's every rung is about a live process.
    if (this.#proc === null || this.#agentGone) return;

    this.#closeOutActive = true;
    try {
      const out = this.#feedLadder({ type: "close_requested", at: this.#deps.clock.now() });
      if (out === null) return;
      // Settled synchronously, or the reducer asked for nothing at all: either way there is no
      // rung to wait for, and waiting would only add latency to a close.
      if (out.settled !== null || (out.action === null && out.scheduleTickAt === null)) return;

      let timer: TimerHandle | null = null;
      await new Promise<void>((resolve) => {
        this.#closeOutWaiter = resolve;
        timer = this.#deps.clock.setTimer(budgetMs, () => {
          this.#logger.warn("close-out ladder did not settle within its backstop", { budgetMs });
          resolve();
        });
      });
      (timer as TimerHandle | null)?.cancel();
    } finally {
      this.#closeOutWaiter = null;
      this.#closeOutActive = false;
    }
  }

  /**
   * SEAM 1 (M1-PLAN §1.2). The close-out ladder's DECISIONS live in the pure reducer; the Worker
   * performs the rung it is handed and adds no judgement of its own. That is what keeps the whole
   * ladder unit-testable with `fakeClock()` and no process.
   *
   * The M0 slice never requests a rung (`turn-lifecycle.ts` returns `action: null`), so nothing
   * below runs until M1-WP-B fills the forced ladder in.
   */
  #perform(action: CloseOutAction | null): void {
    if (action === null) return;
    switch (action) {
      case "close_stdin":
        // Rung 2. NEVER at turn end — only in the FORCED ladder (§13, ruling M1-R4).
        this.#proc?.closeStdin();
        return;
      case "drain":
        // Rung 3. Nothing to do: the drain is OBSERVED (`stdoutEnded` feeds `drained` back into
        // the reducer, which owns the grace deadline). A rung that acted here would be racing
        // the reducer's own clock.
        return;
      case "cancel":
        // Rung 4. The notification only; the reducer owns the grace that follows it.
        //
        // The `catch` is not decoration. `AcpLink.notify` returns a promise and a write to a
        // stdin the agent is in the middle of dying on REJECTS; unhandled, that rejection takes
        // the whole process down under vitest's default. It is also the right semantics, and
        // `cancel()`'s own rule already says so: a failed send is not a failed cancel — the next
        // rung's deadline is already running and will terminate the tree regardless.
        if (this.#link !== null && !this.#linkClosed && this.#sessionId !== null) {
          void this.#link.notify("session/cancel", { sessionId: this.#sessionId }).catch(() => {
            // Deliberately silent: rung 5 is the answer to a cancel that did not arrive.
          });
        }
        return;
      case "terminate":
        // Rung 5. `force`, because every cooperative rung above it has already been offered.
        void this.#closeWith("cancel_timeout", { force: true });
        return;
    }
  }

  #afterStep(out: TurnOutput): void {
    this.#perform(out.action);
    const settledTurn = this.#currentTurnId;
    if (out.settled === null) return;

    // The ladder reached its last rung: `#runCloseOut` stops waiting and its caller proceeds to
    // the kill path. Resolved BEFORE the turn bookkeeping below, so a settle that arrives inside
    // a close cannot be swallowed by the `#closing` guard.
    const waiter = this.#closeOutWaiter;
    if (waiter !== null) {
      this.#closeOutWaiter = null;
      waiter();
    }

    // The turn is over. `settled` is the Normalizer's word for it, whichever of the quiet
    // window, the hard cap, an agent error or a death produced it.
    this.#cancelTimer?.cancel();
    this.#cancelTimer = null;
    this.#currentTurnId = null;
    // Rule L6's "released when it settles" — before the state envelope, so a subscriber that
    // reads `ready` and immediately re-reads the lease never sees a pin over a finished turn.
    this.#unpinLease();
    // `#hibernating` joins `#closing` here for the same reason it exists in `prompt()`: a worker
    // already on its way to `hibernated` (§15.1's `running -> hibernated, agent_crashed` row)
    // must not announce `ready` on the way past.
    this.#feedWatchdog({ kind: "turn_end", at: this.#deps.clock.now() });
    if (this.#state === "running" && !this.#closing && !this.#hibernating) {
      this.#setState("ready", "turn_end", { turnId: settledTurn });
    }
  }

  #rescheduleTick(at: number | null): void {
    this.#tickTimer?.cancel();
    this.#tickTimer = null;
    if (at === null) return;
    const delay = Math.max(0, at - this.#deps.clock.now());
    this.#tickTimer = this.#deps.clock.setTimer(delay, () => {
      this.#tickTimer = null;
      // The CLOSE_OUT ladder advances on ticks, and it runs while `#closing` is already true
      // (§13.2's triggers are all teardown). Suppressing them here is what would hang it.
      if (this.#closing && !this.#closeOutActive) return;
      this.#feed({ type: "tick", at: this.#deps.clock.now() });
    });
  }

  // ── inbound from the agent ─────────────────────────────────────────────────

  #onSessionUpdate(n: { sessionId: string; update: Record<string, unknown> }): void {
    if (this.#sessionId !== null && n.sessionId !== this.#sessionId) {
      // One worker owns one session in M0 (D2). Forward anyway — dropping an update would be a
      // silent hole in the canonical log — but say so, because it means an assumption broke.
      this.#logger.warn("session/update for an unexpected sessionId", {
        expected: this.#sessionId,
        received: n.sessionId,
      });
    }
    // D6: every update that arrives inside the replay window is MARKED, and the reducer copies
    // the flag onto each `EventInput` it emits — so the window lives here, in the Worker, and the
    // reducer stays pure and carries no window state of its own (§15.3).
    const replay = this.#replayWindow > 0;
    if (replay) this.#replayEvents += 1;
    this.#feed({
      type: "agent_update",
      update: n.update,
      at: this.#deps.clock.now(),
      ...(replay ? { replay: true as const } : {}),
    });
  }

  async #onPermissionRequest(req: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    // HUNK 2 (M2-PLAN §1.2). The permission arm is now ONE arm of ONE lifecycle (D10), and the
    // strategy is INJECTED. Absent, `#baselineInteractions` below is M1's body moved nowhere —
    // the same two envelopes, in the same order, with the same `-32603` on D4 rule 4 — so a
    // worker with no strategy is byte-for-byte M1 and the whole M1 permission suite proves it
    // (M2-PLAN §1.3 seam A, WP-I acceptance 1).
    //
    // Ruling M1-R14 is unchanged and load-bearing: the strategy sees the V2-MAPPED request,
    // never the raw v1 one, because D4's rule set is written against v2's tagged `subject` and
    // mapping FIRST is what lets M2-B's rule engine match `kind` / `path` / `cmd` with no
    // per-agent branch. The envelope still carries the RAW request verbatim (§7.5).
    const mapped: MappedPermissionRequest = this.#deps.normalizer.mapPermissionRequest(req);
    const strategy = this.#deps.interactions;
    if (strategy === undefined) return await this.#baselinePermission(req, mapped);
    return await strategy.permission(mapped, this.#interactionContext());
  }

  /**
   * HUNK 3 (M2-PLAN §1.2). `elicitation/create`, D10's second arm.
   *
   * It is registered on the link UNCONDITIONALLY and gated by the CAPABILITY, not by the
   * registration: D10 says we declare `elicitation.form` only under `onUnresolved:"park"`, so an
   * agent that calls this without having been offered it is answering a question nobody asked —
   * and `{action:"decline"}` is the only honest reply. With no strategy injected the capability
   * is never declared and this is never reached.
   */
  async #onElicitation(params: unknown): Promise<unknown> {
    const strategy = this.#deps.interactions;
    if (strategy === undefined) {
      this.#logger.warn("elicitation/create arrived with no interaction strategy; declining");
      return { action: "decline" };
    }
    // `mapElicitation` is a FREE function on `@omni-acp/core` (§5.8.9) rather than a `Normalizer`
    // member, because it is PURE, TOTAL and idempotent over the params and holds no descriptor —
    // there is nothing per-runtime to branch on. M2-A-WP-I lands the real one and injects it as
    // part of the strategy; until then the fallback below is the honest "I could not parse this
    // schema" shape: `fields: []`, every property in `unmodelled`.
    return await strategy.elicitation(mapElicitationFallback(params), this.#interactionContext());
  }

  /**
   * HUNK 4 (M2-PLAN §1.2). `running ⇄ requires_action`, REFCOUNTED exactly like
   * `Lease.pinExpiry()`.
   *
   * Three things are deliberately TRUE for the whole park window and each of them is a bug if it
   * is not: the lease pin is HELD (a parked turn is still this holder's turn), the hibernate
   * timer stays PAUSED (an idle timer that fired on a worker waiting for a human would reclaim
   * the process out from under the answer), and the watchdog is DISARMED (a human is not a
   * stalled agent). The LAST un-park emits `interaction_resolved`; the first park emits
   * `interaction_parked`.
   */
  #park(id: InteractionId): () => void {
    const first = this.#parked.size === 0;
    this.#parked.add(id);
    if (first && this.#state === "running") {
      this.#feedWatchdog({ kind: "parked", at: this.#deps.clock.now() });
      this.#setState("requires_action", "interaction_parked", {
        turnId: this.#currentTurnId,
        interactions: [...this.#parked],
      });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#unpark(id);
    };
  }

  #unpark(id: InteractionId): void {
    if (!this.#parked.delete(id)) return;
    if (this.#parked.size > 0) return;
    if (this.#state !== "requires_action") return;
    // RE-BASED from the unpark instant, never from the park (ruling M2-R21): a twenty-minute
    // park followed by one update must not immediately cancel.
    this.#feedWatchdog({ kind: "unparked", at: this.#deps.clock.now() });
    this.#setState("running", "interaction_resolved", {
      turnId: this.#currentTurnId,
      interactions: [],
    });
  }

  /** The three verbs a strategy may use on this Worker, and no others (§5.8.8). */
  #interactionContext(): InteractionContext {
    return {
      turnId: this.#currentTurnId,
      emit: (inputs) => {
        this.#deps.log.appendAll(inputs);
      },
      park: (id) => this.#park(id),
      failTurn: (reason) => {
        // `onUnresolved:"fail"` and `parkTimeoutAction:"fail"`: cancel the TURN, do not close the
        // worker. `cancelInternal` is the daemon-side cancel that is deliberately not lease-gated.
        void this.#cancelInternalFor(reason).catch((e: unknown) => {
          this.#logger.error("failTurn could not cancel the turn", { error: String(e) });
        });
      },
    };
  }

  /**
   * HUNK 5 (M2-PLAN §1.2). `lease.assertHolder(who)` FIRST, exactly as `prompt` / `cancel` /
   * `wake` do — F22's payoff, again: identity is the lease's business and this handle enforces
   * state, not identity.
   */
  answerInteraction(
    id: InteractionId,
    a: InteractionAnswer,
    who: ClientRef & { tokenId: TokenId },
  ): InteractionAnswerResult {
    this.#deps.lease.assertHolder(who);
    const strategy = this.#deps.interactions;
    if (strategy === undefined) {
      // No strategy ⇒ nothing was ever parked, so there is nothing this id could name. The
      // 404 is the honest answer and it names the RESOURCE, which is exactly why
      // `interaction_not_found` exists beside `worker_not_found` (ruling M2-R2).
      throw new OmniError("interaction_not_found", `no interaction ${id} is awaiting an answer`);
    }
    return strategy.answer(id, a, who);
  }

  get interactions(): readonly InteractionSnapshot[] {
    return this.#deps.interactions?.pending ?? [];
  }

  /**
   * HUNK 6 (M2-PLAN §1.2). `session/set_config_option`, lease-gated, `worker_busy` while a turn
   * runs, auto-waking exactly as `prompt` does.
   *
   * The METHOD's own result replaces `#configOptions` WHOLESALE (F34: the returned list is a full
   * replacement whose membership can SHRINK four → two; F35: another agent's does not) — never
   * the event stream, because neither real agent emits `config_option_update` for a set.
   *
   * With no implementation injected this is `agent_error` carrying `-32601`, which is the shape a
   * client already knows how to read for "this agent cannot do that" (D29, the M1 Land precedent).
   */
  setConfig(_body: SetConfigBody, who: ClientRef): Promise<SetConfigResponse> {
    this.#deps.lease.assertHolder(who);
    if (this.#state === "closed") {
      throw new OmniError("worker_closed", `worker ${this.#deps.workerId} is closed`);
    }
    if (this.#state === "running" || this.#state === "requires_action") {
      throw new OmniError("worker_busy", `worker ${this.#deps.workerId} is ${this.#state}`);
    }
    throw new OmniError("internal", "unimplemented: M2-A-WP-C (session/set_config_option)");
  }

  /**
   * DAEMON-initiated cancel, deliberately NOT lease-gated: the lease governs CLIENTS, and the
   * idle watchdog is not one. Without this the daemon's own timer `423`s itself the moment a real
   * `createLease` replaces `alwaysGrantedLease` — the kind of thing discovered in production
   * (§5.8.8).
   */
  async cancelInternal(reason: "watchdog_silent" | "watchdog_tool"): Promise<void> {
    await this.#cancelInternalFor(reason);
  }

  /**
   * `cancel()`'s body with the lease check removed and nothing else changed: the notification
   * goes first, the process stays alive, and the SAME `cancelGraceMs` escalation into M1's
   * existing `cancel_timeout` close is armed. The watchdog adds no close reason (§5.8.3).
   */
  async #cancelInternalFor(reason: string): Promise<void> {
    if (this.#state === "closed") return;
    if (this.#state !== "running" || this.#link === null || this.#sessionId === null) return;
    this.#logger.warn("cancelling the turn on the daemon's own initiative", { reason });
    this.#feedWatchdog({ kind: "cancel_sent", at: this.#deps.clock.now() });
    await this.cancel(this.#deps.lease.holder ?? this.#deps.owner);
  }

  // ── seams B and C, as no-ops when nothing is injected ──────────────────────

  /**
   * §19.8's settle, as a no-op when nothing is injected. Idempotent by the strategy's own
   * contract, so every teardown path may call it blindly.
   */
  #settleInteractions(reason: "shutdown" | "cancel" | "close" | "hibernate" | "timeout"): void {
    const strategy = this.#deps.interactions;
    if (strategy === undefined) return;
    try {
      strategy.settleAll(reason);
    } catch (e) {
      this.#logger.error("settling parked interactions failed", { reason, error: String(e) });
    }
    this.#parked.clear();
  }

  /** HUNK 7's one call site shape. Absent watchdog ⇒ disarmed, which is M1. */
  #feedWatchdog(signal: WatchdogSignal): void {
    const watchdog = this.#deps.watchdog;
    if (watchdog === undefined) return;
    try {
      const verdict = watchdog.observe(signal);
      this.#watchdogArmedAt = verdict.deadlineAt;
    } catch (e) {
      // A watchdog that throws must never fail a turn: its whole job is to be a backstop.
      this.#logger.error("watchdog step threw", { signal: signal.kind, error: String(e) });
    }
  }

  /** HUNK 8's settle half. NEVER throws: a git failure is `text: null` and not a failed turn. */
  async #endPatch(handle: PatchHandle | null): Promise<Record<string, unknown> | null> {
    const provider = this.#deps.diff;
    if (provider === undefined || handle === null) return null;
    try {
      return { [PATCH_META]: await provider.end(handle) };
    } catch (e) {
      this.#logger.warn("the diff provider failed to produce a patch", { error: String(e) });
      return null;
    }
  }

  #abandonPatch(handle: PatchHandle | null): void {
    if (handle === null) return;
    try {
      this.#deps.diff?.abandon(handle);
    } catch (e) {
      this.#logger.debug("abandoning a patch handle failed", { error: String(e) });
    }
  }

  /**
   * M1's permission path, UNCHANGED, reached only when no strategy is injected.
   *
   * It is `baselineInteractions`'s body in situ (M2-PLAN §1.3 seam A): WP-I lifts it into
   * `worker/interaction/baseline.ts` and wraps it in the strategy interface, and the golden that
   * proves the two are byte-identical is that acceptance bullet. Nothing below this line changed
   * in the M2 Land step.
   */
  async #baselinePermission(
    req: RequestPermissionRequest,
    mapped: MappedPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const decided = this.#deps.responder.decide(mapped);
    const turnId = this.#currentTurnId;

    // §12.6: D4 rule 1 ("only ever select an optionId the agent actually offered") is enforced
    // HERE, at the one place that emits the answer, and not only inside the responder that
    // happens to be wired today. `DaemonDeps.responder` is a public injection point and it is
    // the seam M2's policy engine lands on; corpus 09 is the recording of what a violation
    // costs, and its lesson is that it CANNOT be caught downstream — the agent failed every
    // tool call and still ended the turn `end_turn`, so `stopReason` reports nothing. A rule
    // that only one implementation upholds is a property of that implementation.
    //
    // The violation is folded into rule 4's existing answer — `response: null`, the record
    // stamped `decision: "error"` with `optionId: null`, and -32603 on the wire — because that
    // is the shape a caller and an auditor already know how to read. Never the invented id
    // (rule 1), and never `outcome: "cancelled"` (rule 5): cancelling would kill the whole turn
    // over one action our own responder got wrong.
    const offeredIds = new Set(mapped.options.map((o) => o.optionId));
    const selected = decided.record.optionId;
    const forged = decided.response !== null && (selected === null || !offeredIds.has(selected));
    const decision: PermissionDecision = forged
      ? { response: null, record: { ...decided.record, decision: "error", optionId: null } }
      : decided;
    if (forged) {
      this.#logger.error("the permission responder selected an option the agent never offered", {
        rule: decided.record.rule,
        optionId: selected,
        offered: [...offeredIds],
      });
    }

    const answered = decision.response !== null;
    const optionId = decision.record.optionId;

    // Two envelopes, always, in this order (§7.4). `omni.policy_decision` is the one
    // `reduceTurn` folds — it carries `title`, so an `InteractionRecord` is built from a single
    // envelope kind (review R9) — and `acp.interaction` keeps the request verbatim for audit.
    //
    // The versions differ because §5.1 defines `payloadVersion` as the ACP version of the payload
    // AS WRITTEN. `omni.policy_decision` is entirely daemon-authored, so it is 2. `acp.interaction`
    // embeds the agent's verbatim v1 `RequestPermissionRequest` in `payload.request` (the type says
    // so itself), so it is 1 — and when M2 normalizes `session/request_permission` to D4's
    // `{title, subject, options}` shape, THAT is the moment this flips to 2. Stamping 2 today
    // would change `payload.request`'s shape with no change in the one field a client has to
    // detect it by, which is the silent wire break §7.5 says this flag exists to prevent.
    this.#deps.log.appendAll([
      {
        kind: "acp.interaction",
        payloadVersion: 1,
        turnId,
        payload: {
          requestId: decision.record.requestId,
          method: "session/request_permission",
          request: req as unknown as Record<string, unknown>,
          status: answered ? "answered" : "failed",
          answer: { optionId, by: "baseline" },
        },
      },
      { kind: "omni.policy_decision", payloadVersion: 2, turnId, payload: decision.record },
    ]);

    if (decision.response === null) {
      // D4 rule 4: nothing acceptable was offered, so we answer with a JSON-RPC error rather
      // than inventing an option id (rule 1) or cancelling the whole turn (rule 5). The forged
      // case above lands here too, with its own message, because the ANSWER is the same one.
      throw AcpRequestError.internalError(
        { offered: decision.record.offered },
        forged
          ? "the selected permission option was not offered"
          : "no acceptable permission option was offered",
      );
    }
    return decision.response;
  }

  #onLinkClosed(err: Error | null): void {
    this.#linkClosed = true;
    if (err !== null) {
      this.#logger.debug("acp link closed", { error: err.message });
    }
  }

  // ── the crash classifier (§6.7) ────────────────────────────────────────────

  #watchProcess(proc: AgentProcess): void {
    // The identity guard is what makes a SECOND generation safe (§15.3): a hibernate or a failed
    // wake drops `#proc` before the old process finishes dying, and its late `exited` must not be
    // classified as a crash of the process that replaced it.
    void proc.exited.then((exit) => {
      if (this.#proc !== proc) return;
      this.#agentGone = true;
      this.#onExit(exit);
    });
    void proc.stdoutEnded.then(() => {
      if (this.#proc !== proc) return;
      this.#agentGone = true;
      // SEAM 1's `drained`: stdout EOF is what rung 3 is waiting for, and §13.2 short-circuits
      // it to `terminate` because nothing more can arrive. Fed BEFORE M0's exit-grace timer, so
      // a ladder that is running gets the observation first; the reducer owns whether it means
      // anything in the state it is actually in.
      this.#feedLadder({ type: "drained", at: this.#deps.clock.now() });
      this.#onStdoutEnded();
    });
  }

  #onExit(exit: ProcessExit): void {
    this.#exitGraceTimer?.cancel();
    this.#exitGraceTimer = null;
    if (this.#closing) return; // we asked for this; the close path owns it
    // `force`, because the leader is ALREADY gone: there is nobody left to cooperate with, and
    // rung 0 without `force` REPORTS a surviving tree (`treeGone:false`) instead of reclaiming
    // it — which is how §6.7's zombie leaked its grandchild past close and past `daemon.stop()`.
    // This costs nothing on a clean exit: rung 0 with `force` still short-circuits to
    // `already_exited` whenever `isTreeGone()` is true, so only a leader whose group is provably
    // still populated escalates to SIGKILL. On Windows `confirmsTreeGone` is false, so this is
    // one `taskkill /T /F` against the dead leader's pid — the same PID-reuse exposure
    // `#onStdoutEnded`'s force already carries and §6.4 already documents.
    this.#classifyAndClose(exit, { force: true });
  }

  /**
   * The transport died. That is NOT authoritative — a grandchild can hold the inherited stdout
   * open long after the leader is gone, and the leader can exit milliseconds later — so this
   * only starts the clock for `exit`. If `exit` does not arrive, the force rung runs and the
   * classification comes from the `KillOutcome`.
   */
  #onStdoutEnded(): void {
    if (this.#closing || this.#exitGraceTimer !== null) return;
    this.#exitGraceTimer = this.#deps.clock.setTimer(this.#deps.limits.exitGraceMs, () => {
      this.#exitGraceTimer = null;
      if (this.#closing) return;
      this.#logger.warn("stdout ended but the agent did not exit; forcing", {
        exitGraceMs: this.#deps.limits.exitGraceMs,
      });
      this.#classifyAndClose(null, { force: true });
    });
  }

  #classifyAndClose(exit: ProcessExit | null, o?: { force?: boolean }): void {
    const proc = this.#proc;
    // `finalize()` flushes a trailing unterminated line: on a crash that last line IS the reason.
    proc?.stderr.finalize();
    const stderrTail = proc?.stderr.snapshot() ?? "";

    // §6.7's table: `code === 0 && requested` is the only clean exit. Everything else — a
    // non-zero code, a signal, or an exit nobody asked for — is a crash.
    const clean = exit !== null && exit.code === 0 && exit.requested;
    const reason: WorkerCloseReason = clean ? "agent_exited" : "agent_crashed";
    // Sticky, and set HERE because `#crashed` is private to this class and this file is frozen
    // after the Land step: once true it never goes back to false, across hibernate, wake and
    // restart (D2, §15.1 invariant 2).
    if (!clean) this.#crashed = true;
    const message =
      exit === null
        ? "the agent transport ended and the process did not exit within exitGraceMs"
        : `the agent process exited (code=${String(exit.code)}, signal=${String(exit.signal)})`;

    const error = new OmniError("agent_error", message, {
      detail: { code: exit?.code ?? null, signal: exit?.signal ?? null },
    });

    // §15.1's `running -> hibernated` row, and DESIGN §3.2's 进程崩溃：agent 支持 resume →
    // 转 hibernated 并标记 crashed. A resumable agent that dies mid-turn keeps its session
    // pointer and sleeps; only a NON-resumable one closes. This is the same convergence boot
    // adoption already performs on an abandoned row (`boot-recovery.ts` `adoptRow`), and without
    // it a crash loses a session that a daemon RESTART would have preserved — the next prompt is
    // a 410 rather than a wake.
    if (!clean && this.#mayHibernateAfterCrash()) {
      void this.#hibernateAfterCrash(error, stderrTail).catch((e: unknown) => {
        this.#logger.error("hibernate after agent death failed", { error: String(e) });
      });
      return;
    }

    void this.#closeWith(reason, {
      error,
      stderrTail,
      exit,
      ...(o?.force === true ? { force: true } : {}),
    }).catch((e: unknown) => {
      this.#logger.error("close after agent death failed", { error: String(e) });
    });
  }

  /**
   * The exact predicate `boot-recovery.ts`'s `isResumable` applies to an abandoned ROW, asked of
   * a LIVE worker: a session pointer to resume with, a strategy that knows how to reopen it, and
   * a spelling the agent advertised at handshake. A `starting` worker is excluded — a handshake
   * that died has no session yet, and its failure edges (`spawn_failed`, `handshake_error`) are
   * closes by §15.1.
   */
  #mayHibernateAfterCrash(): boolean {
    if (this.#closing || this.#hibernating) return false;
    if (this.#state !== "ready" && this.#state !== "running") return false;
    if (this.#sessionId === null || this.#deps.session === undefined) return false;
    return (this.#capabilities?.resume.method ?? null) !== null;
  }

  /**
   * `running`/`ready` -> `hibernated`, reason `agent_crashed`, `crashed: true` (§15.1).
   *
   * The ORDER is §15.2's, minus the cooperative rungs there is nobody left to cooperate with:
   *
   *  1. the `omni.error` FIRST (§7.3: cause before consequence). It goes through
   *     `#appendCloseError`, so a mid-turn death settles the turn through the Normalizer's
   *     `process_gone` rather than fabricating an idle the agent never reported (§7.3).
   *  2. the process tree, reclaimed with `force` — the leader is already gone, so rung 0 without
   *     it would REPORT a surviving tree instead of reclaiming it (§6.7's zombie).
   *  3. the lease, released: a holder cannot control a worker with no process (D5, §15.2 step 3).
   *  4. the state envelope, carrying `crashed: true` and this generation.
   *
   * NO `session/close`: the pointer is the entire value being preserved, exactly as in
   * `#doHibernate`.
   */
  async #hibernateAfterCrash(error: OmniError, stderrTail: string): Promise<void> {
    // Synchronous, before the first await: `prompt()` reads `#hibernating` as "busy", so a
    // prompt landing mid-reclaim cannot be handed a link that is already gone (§15.2).
    this.#hibernating = true;
    this.#tickTimer?.cancel();
    this.#tickTimer = null;
    this.#cancelTimer?.cancel();
    this.#cancelTimer = null;
    this.#exitGraceTimer?.cancel();
    this.#exitGraceTimer = null;
    try {
      this.#appendCloseError(error, stderrTail, "agent_crashed");
      this.#currentTurnId = null;
      this.#unpinLease();
      await this.#reclaimProcess({ force: true });
      this.#deps.lease.releaseForHibernate();
      this.#hibernatedAt = this.#deps.clock.iso();
      this.#setState("hibernated", "agent_crashed", {
        turnId: null,
        generation: this.#generation,
        crashed: true,
      });
    } finally {
      this.#hibernating = false;
    }
  }

  // ── close ──────────────────────────────────────────────────────────────────

  /** Races `p` against the injected clock, so the close path has no unbounded step. */
  async #withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
    let timer: TimerHandle | null = null;
    const expiry = new Promise<never>((_resolve, reject) => {
      timer = this.#deps.clock.setTimer(ms, () => {
        reject(new OmniError("agent_timeout", `timed out after ${String(ms)}ms`));
      });
    });
    expiry.catch(() => {});
    try {
      return await Promise.race([p, expiry]);
    } finally {
      (timer as TimerHandle | null)?.cancel();
    }
  }

  /** Idempotent by construction: the FIRST caller's reason wins and everyone shares its run. */
  #closeWith(reason: WorkerCloseReason, extras: CloseExtras): Promise<CloseResult> {
    const existing = this.#closePromise;
    if (existing !== null) return existing;
    this.#closing = true;
    this.#closePromise = this.#doClose(reason, extras);
    return this.#closePromise;
  }

  async #doClose(reason: WorkerCloseReason, extras: CloseExtras): Promise<CloseResult> {
    this.#settleInteractions("close");
    const previous = this.#state;
    this.#closeReason = reason;
    // A close is an exit from `running` too, and the ladder below can await for seconds: a pin
    // held across it would keep a dead worker's lease un-expirable (rule L6).
    this.#unpinLease();
    this.#tickTimer?.cancel();
    this.#tickTimer = null;
    this.#cancelTimer?.cancel();
    this.#cancelTimer = null;
    this.#exitGraceTimer?.cancel();
    this.#exitGraceTimer = null;

    // The error envelope FIRST, so the log reads `omni.error` -> `omni.worker_state{closed}`
    // (§7.3) and a subscriber sees the cause before the consequence.
    if (extras.error !== undefined) {
      this.#appendCloseError(extras.error, extras.stderrTail ?? "", reason);
    }

    // Best effort, and skipped unless advertised: `session/close` does not exist in v1 unless
    // `sessionCapabilities.close` says so, and an unadvertised call would just earn a -32601.
    //
    // It stays FALSE unless the call resolved, which is the whole point of the field: the daemon
    // guarantees it stops referencing the session, never that the agent deleted it (§15.6).
    let sessionClosed = false;
    if (
      this.#capabilities?.supportsSessionClose === true &&
      this.#link !== null &&
      !this.#linkClosed &&
      this.#sessionId !== null &&
      !DEATH_REASONS.has(reason)
    ) {
      try {
        // Bounded, because every rung below it is: an agent that accepts `session/close` and
        // then never answers must not be able to hold `DELETE /v1/workers` open forever.
        await this.#withDeadline(
          this.#link.request("session/close", { sessionId: this.#sessionId }),
          this.#deps.limits.gracefulMs,
        );
        sessionClosed = true;
      } catch (e) {
        this.#logger.debug("session/close failed; continuing to the kill", { error: String(e) });
      }
    }

    // §13.2's CLOSE_OUT ladder — `DELETE` and daemon shutdown are its other two triggers — runs
    // AFTER `session/close` and BEFORE the kill. After, because rung 2 sends stdin EOF and an
    // agent whose stdin is closed can no longer answer a request; before, because the entire
    // point of the ladder is that the last output lands while the process is still alive.
    //
    // Skipped on a FORCED close: `force` means every cooperative rung has already been offered
    // (§6.5) — a crash, a failed handshake, a cancel escalation that already walked the ladder.
    if (extras.force !== true) {
      await this.#runCloseOut(this.#deps.limits.closeOutMs ?? DEFAULT_CLOSE_OUT_MS);
    }
    this.#unsubscribeStderr();

    let outcome: KillOutcome | null = null;
    if (this.#proc !== null) {
      try {
        outcome = await this.#proc.terminate(
          extras.force === true ? { force: true } : { gracefulMs: this.#deps.limits.gracefulMs },
        );
      } catch (e) {
        this.#logger.error("terminate() threw", { error: String(e) });
      }
    }

    this.#link?.close();

    const exit = extras.exit ?? outcome?.exit ?? null;
    // "No process was ever spawned" is not the same claim as "we killed a tree and proved it
    // gone", but it IS true that nothing is left running — and `treeGone` must never be
    // optimistic about a tree that exists (§6.6, D10).
    const leaderExited = this.#proc === null ? true : (outcome?.leaderExited ?? false);
    const treeGone = this.#proc === null ? true : (outcome?.treeGone ?? false);

    // A closed worker has no live turn. The turn itself is already terminal in the log — any
    // `worker_state{closed}` ends it (§7.3) — so this only keeps the snapshot honest.
    this.#currentTurnId = null;

    this.#setState("closed", reason, {
      turnId: null,
      exit,
      leaderExited,
      treeGone,
      ...(extras.error === undefined ? {} : { error: extras.error.toBody() }),
    });

    const result: CloseResult = {
      workerId: this.#deps.workerId,
      state: "closed",
      reason,
      leaderExited,
      treeGone,
      // §15.6: whether `session/close` was actually SENT AND ACKNOWLEDGED — not whether the
      // agent deleted anything, which we cannot know. False for every close of a `hibernated`
      // worker, because we do not spawn a process in order to politely close a session.
      sessionClosed,
    };
    this.#logger.info("worker closed", { reason, previous, leaderExited, treeGone });
    this.#resolveClosed(result);
    return result;
  }

  /**
   * The `omni.error` that precedes a close.
   *
   * When a turn is live and the agent is gone, this goes through the Normalizer as
   * `process_gone`, because that is the input whose defining property is that it emits
   * `omni.error` and NEVER a fabricated `idle` (§7.3). If the Normalizer emitted no error of its
   * own — there was no turn to end — the Worker appends one itself, so that "a close always has
   * a stated cause in the log" holds on every edge.
   */
  #appendCloseError(error: OmniError, stderrTail: string, reason: WorkerCloseReason): void {
    const body: OmniErrorBody = error.toBody();
    let emittedError = false;

    if (this.#currentTurnId !== null && DEATH_REASONS.has(reason)) {
      try {
        const emitted = this.#step({
          type: "process_gone",
          error: body,
          stderrTail,
          at: this.#deps.clock.now(),
        });
        emittedError = emitted.some((e) => e.input.kind === "omni.error");
      } catch (e) {
        this.#logger.error("normalizer step threw on process_gone", { error: String(e) });
      }
    }

    if (emittedError) return;
    this.#deps.log.append({
      kind: "omni.error",
      payloadVersion: 2,
      turnId: this.#currentTurnId,
      payload: stderrTail === "" ? body : { ...body, stderrTail },
    });
  }

  // ── state ──────────────────────────────────────────────────────────────────

  #setState(
    next: M1State,
    reason: WorkerStatePayload["reason"],
    o: {
      turnId?: TurnId | null;
      exit?: ProcessExit | null;
      leaderExited?: boolean;
      treeGone?: boolean;
      error?: OmniErrorBody;
      // ── M1 (§15.1): present on the rows that table marks, and on no others ──
      resume?: ResumeReport;
      orphan?: OrphanRecord;
      crashed?: boolean;
      generation?: number;
      // ── M2 (§5.8.3): present on the rows §19/§21 name, and on no others ──
      watchdog?: { budget: "silent" | "tool"; idleMs: number; openToolCalls: number };
      interactions?: readonly InteractionId[];
    },
  ): void {
    const previous = this.#emittedState;
    this.#state = next;
    this.#emittedState = next;
    this.#updatedAt = this.#deps.clock.iso();

    const payload: WorkerStatePayload = {
      state: next,
      previous,
      reason,
      ...(o.exit === undefined || o.exit === null
        ? {}
        : { exit: { code: o.exit.code, signal: o.exit.signal } }),
      ...(o.leaderExited === undefined ? {} : { leaderExited: o.leaderExited }),
      ...(o.treeGone === undefined ? {} : { treeGone: o.treeGone }),
      ...(o.error === undefined ? {} : { error: o.error }),
      ...(o.resume === undefined ? {} : { resume: o.resume }),
      ...(o.watchdog === undefined ? {} : { watchdog: o.watchdog }),
      ...(o.interactions === undefined ? {} : { interactions: o.interactions }),
      ...(o.orphan === undefined ? {} : { orphan: o.orphan }),
      ...(o.crashed === undefined ? {} : { crashed: o.crashed }),
      ...(o.generation === undefined ? {} : { generation: o.generation }),
    };

    this.#deps.log.append({
      kind: "omni.worker_state",
      payloadVersion: 2,
      turnId: o.turnId ?? null,
      payload,
    });

    for (const cb of this.#listeners) {
      try {
        cb(next, previous);
      } catch (e) {
        this.#logger.error("onStateChange listener threw", { error: String(e) });
      }
    }
  }

  // ── construction ───────────────────────────────────────────────────────────

  /**
   * spawn -> link -> watch, shared by `start()` and `wake()`.
   *
   * It exists so the wake path cannot drift from the create path: one spawn site (F10), one set
   * of link handlers, and the crash watcher armed BEFORE the handshake in both — an agent that
   * dies during `initialize` never rejects the in-flight request on a transport that only the
   * process signals can tell us about.
   */
  async #openProcess(signal?: AbortSignal): Promise<AcpLink> {
    const spec = (this.#deps.toSpawnSpec ?? ((d, o) => defaultSpawnSpec(d, o, this.#deps.label)))(
      this.#deps.descriptor,
      { cwd: this.#deps.cwd },
    );
    const proc = await this.#deps.supervisor.spawn(spec, signal);
    this.#proc = proc;
    const link = openAcpLink(
      proc.stream,
      {
        onSessionUpdate: (n) => {
          this.#onSessionUpdate(n);
        },
        onPermissionRequest: (req) => this.#onPermissionRequest(req),
        // HUNK 3's other half. The registration is unconditional; the CAPABILITY is the gate
        // (D10), and `link.ts` parses the params with `verbatim` — a `z.object` there would
        // strip `_meta._askUserQuestionCustomAnswer` and the FLAT `sessionId`/`toolCallId`,
        // which are the two fields the whole feature turns on (F29, F30).
        onElicitation: (params) => this.#onElicitation(params),
        onClosed: (err) => {
          this.#onLinkClosed(err);
        },
      },
      { logger: this.#logger },
    );
    this.#link = link;
    this.#linkClosed = false;
    this.#agentGone = false;
    // SEAM 1's `stderr_line`: §13.4's fourth signal, the descriptor-gated `fatalStderr` match.
    // COMPLETE lines only (`StderrTail.onLine`), which is why the promotion can key on a pattern
    // at all. The reducer decides what a line means; this only delivers it.
    //
    // One throw is enough to know this reducer has no arm for it (M0's slice), and an agent that
    // writes to stderr in a loop must not produce one log line per write — so the subscription
    // is dropped the first time the input is refused.
    this.#stderrUnsub = proc.stderr.onLine((line) => {
      if (this.#feedLadder({ type: "stderr_line", line, at: this.#deps.clock.now() }) === null) {
        this.#unsubscribeStderr();
      }
    });
    this.#watchProcess(proc);
    return link;
  }

  /** Idempotent, and called on every path that gives a process back. */
  #unsubscribeStderr(): void {
    const unsub = this.#stderrUnsub;
    this.#stderrUnsub = null;
    unsub?.();
  }

  /**
   * Give the process back, without closing the worker: hibernate's rungs 1-2 (§15.2) and the
   * cleanup after a failed wake. `#proc` and `#link` are dropped FIRST, so `#watchProcess`'s
   * identity guard stops classifying an exit we asked for as a crash.
   */
  async #reclaimProcess(o: { force: boolean }): Promise<void> {
    const proc = this.#proc;
    const link = this.#link;
    this.#unsubscribeStderr();
    this.#proc = null;
    this.#link = null;
    this.#linkClosed = false;
    this.#agentGone = false;
    if (proc !== null) {
      // stdin EOF FIRST, then the graceful ladder (§15.2 rung 2): the agent gets its normal
      // shutdown, because we are hibernating it rather than crashing it. A wake that already
      // failed skips the courtesy — there is nothing left to say to a half-initialized process.
      if (!o.force) proc.closeStdin();
      try {
        await proc.terminate(
          o.force ? { force: true } : { gracefulMs: this.#deps.limits.gracefulMs },
        );
      } catch (e) {
        this.#logger.error("terminate() threw while reclaiming the process", {
          error: String(e),
        });
      }
    }
    link?.close();
  }

  async start(signal?: AbortSignal): Promise<void> {
    // Seq 1 is ALWAYS `omni.worker_state{starting}` (§8.2 rule 2), so `?since=0` replays a
    // worker's whole life from birth — including a worker that never made it past the handshake.
    this.#setState("starting", "created", {});

    let link: AcpLink;
    try {
      link = await this.#openProcess(signal);
    } catch (e) {
      // Nothing was created, so there is no tree to reclaim — but the log and the caller are
      // owed the same two envelopes and the same error code as any other failure edge.
      const error = OmniError.from(e, "agent_error");
      await this.#closeWith("spawn_failed", { error });
      throw error;
    }

    try {
      // SEAM 2 (M1-PLAN §1.2): with a `SessionStrategy` injected, the Worker calls `open()` on
      // create and `reopen()` on wake and never names `initialize` or `session/new` itself.
      // ABSENT, it runs M0's inline handshake unchanged — a required dependency whose only
      // implementation is M1-WP-C's would have taken every M0 test with it (Land note S3).
      const strategy = this.#deps.session;
      const { capabilities, sessionId } =
        strategy === undefined
          ? await runHandshake(link, {
              cwd: this.#deps.cwd,
              timeoutMs: this.#deps.limits.handshakeTimeoutMs,
              clock: this.#deps.clock,
              // D10, threaded rather than hard-coded: ONE producer for both paths, which is what
              // F42 is about (see `CreateWorkerDeps.clientCapabilities`). Absent ⇒ `{}` = M1.
              ...(this.#deps.clientCapabilities === undefined
                ? {}
                : { clientCapabilities: this.#deps.clientCapabilities }),
              ...(signal === undefined ? {} : { signal }),
            })
          : await strategy.open(this.#asLinkLike(link), {
              cwd: this.#deps.cwd,
              descriptor: this.#runtime(),
              mcpServers: this.#deps.mcpServers ?? [],
              ...(this.#deps.clientCapabilities === undefined
                ? {}
                : { clientCapabilities: this.#deps.clientCapabilities }),
              budgetMs: this.#deps.limits.handshakeTimeoutMs,
              ...(signal === undefined ? {} : { signal }),
            });
      this.#capabilities = capabilities;
      this.#sessionId = sessionId;
      // One process has now handshaken. `generation` is "processes this worker has had", so it
      // is incremented HERE and not at spawn: a spawn that never handshakes produced no
      // generation of this worker, it produced a failed create (§5.1 `WorkerSnapshot`).
      this.#generation += 1;
    } catch (e) {
      const error = OmniError.from(e, "agent_error");
      const reason: WorkerCloseReason =
        error.code === "agent_timeout" ? "handshake_timeout" : "handshake_error";
      // Reclaim the tree BEFORE responding — `POST /v1/workers` must never leave a process
      // behind on the 502/504 paths (§2.1 H5).
      await this.#closeWith(reason, { error, force: true });
      throw error;
    }

    // Envelopes appended from here carry the sessionId; the pre-handshake prefix stays frozen at
    // null rather than being back-filled (§8.2 rule 3, review R16).
    this.#deps.log.setSessionId(this.#sessionId);
    this.#setState("ready", "handshake_ok", {});
  }
}

/**
 * spawn -> initialize{protocolVersion:1, clientCapabilities:{}} -> session/new{mcpServers:[]}.
 *
 * Resolves ONLY when state === "ready". On ANY failure edge it reclaims the process tree,
 * appends `omni.error` + `omni.worker_state{closed, ...}`, and REJECTS with an `OmniError` whose
 * code is already correct (`agent_error` / `agent_timeout`) — so the HTTP layer maps it with the
 * one table and adds no judgement of its own.
 *
 * The worker also owns the two things the pure Normalizer cannot: the tick timer that drives the
 * quiet window, and the crash classifier — which lives here rather than in `AcpLink` because it
 * needs the worker's state to know whether a mid-turn death is a crash or a requested close
 * (CONTRACTS.md §6.7).
 */
export async function createWorker(
  deps: CreateWorkerDeps,
  signal?: AbortSignal,
): Promise<WorkerHandle> {
  const worker = new Worker(deps);
  await worker.start(signal);
  return worker;
}

/**
 * §14.3's THREE answers, read off the log rather than re-derived here.
 *
 * `EventLog.persistent` is a boolean and has only two of them: it cannot say "the write-through
 * FAILED" — a log still perfectly correct in RAM whose history a restart will not recover.
 * M1-WP-A's `EventLogCore` adds the third as `persistence`, and this reads it STRUCTURALLY so
 * that every plain `EventLog` (the daemon's doubles, `arrayLog`, an embedder's own) keeps
 * answering exactly what it answered in M0. The fallback is M0's expression, unchanged.
 */
function persistenceOf(log: EventLog): "memory" | "durable" | "degraded" {
  const reported = (log as Partial<EventLogCore>).persistence;
  if (reported === "memory" || reported === "durable" || reported === "degraded") return reported;
  return log.persistent ? "durable" : "memory";
}
