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
  type OrphanRecord,
  type ResumeReport,
  type SessionStrategy,
  type WorkerId,
  type WorkerSnapshot,
  type WorkerState,
  type WorkerStatePayload,
} from "@omni-acp/protocol";
import { openAcpLink, type AcpLink } from "../acp/link.js";
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
   * Descriptor identity for `WorkerSnapshot.runtimeId` — "which quirk table governed this
   * worker". M1-WP-E computes it as `"<agentId>@<fingerprint12>"` from the resolved descriptor;
   * absent, the snapshot reports the agent id against the `unresolved` fingerprint sentinel
   * rather than a hex string that would look authoritative (see `runtime/known.ts`).
   */
  readonly runtimeId?: string;
}

/**
 * The states an M1 worker can actually occupy (`events.ts` M1_WORKER_STATES).
 *
 * `hibernated` is reachable from M1 on; `requires_action` stays wire-stable and unemitted until
 * M2's policy engine, so it is deliberately NOT in this union — a state the kernel cannot enter
 * must not typecheck as one it can.
 */
type M1State = "starting" | "ready" | "running" | "hibernated" | "closed";

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

class Worker implements WorkerHandle {
  readonly #deps: CreateWorkerDeps;
  readonly #logger: Logger;
  readonly #createdAt: string;
  readonly #listeners = new Set<(s: WorkerState, prev: WorkerState | null) => void>();

  /** The authoritative state. `prompt()` flips it during its synchronous admission check. */
  #state: M1State = "starting";
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
  #resolveClosed!: (r: CloseResult) => void;
  readonly closed: Promise<CloseResult>;

  constructor(deps: CreateWorkerDeps) {
    this.#deps = deps;
    this.#logger = deps.logger.child({ component: "worker", workerId: deps.workerId });
    this.#createdAt = deps.clock.iso();
    this.#updatedAt = this.#createdAt;
    this.closed = new Promise<CloseResult>((resolve) => {
      this.#resolveClosed = resolve;
    });
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
      // "degraded" — a durable write FAILED — is M1-WP-A's to report through the log it owns.
      persistence: this.#deps.log.persistent ? "durable" : "memory",
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

  // ── the wire ───────────────────────────────────────────────────────────────

  async prompt(content: readonly unknown[], who: ClientRef): Promise<PromptAccepted> {
    this.#deps.lease.assertHolder(who);

    // Check-and-set, with NOTHING async between the two halves: `prompt()` is `async` only
    // because the contract types it that way, and 50 concurrent callers must yield exactly one
    // acceptance. An `await` anywhere above `#state = "running"` reopens that race.
    if (this.#state === "closed") {
      throw new OmniError("worker_closed", `worker ${this.#deps.workerId} is closed`);
    }
    if (this.#state !== "ready") {
      throw new OmniError("worker_busy", `worker ${this.#deps.workerId} is ${this.#state}`);
    }
    assertPromptContent(content);

    const link = this.#link;
    const sessionId = this.#sessionId;
    if (link === null || sessionId === null) {
      throw new OmniError("internal", "worker reached ready with no session");
    }

    const turnId = this.#deps.ids.turn();
    this.#state = "running";
    this.#currentTurnId = turnId;

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
      throw OmniError.from(e);
    }
    if (running === undefined) {
      this.#state = "ready";
      this.#currentTurnId = null;
      throw new OmniError(
        "internal",
        "normalizer did not synthesize state_update{running} for prompt_sent",
      );
    }
    this.#setState("running", "prompt", { turnId });

    void this.#drivePrompt(link, sessionId, turnId, content);

    return { turnId, seq: running.seq };
  }

  async #drivePrompt(
    link: AcpLink,
    sessionId: SessionId,
    turnId: TurnId,
    content: readonly unknown[],
  ): Promise<void> {
    try {
      const res = await link.request<unknown>("session/prompt", {
        sessionId,
        prompt: content,
      });
      if (this.#currentTurnId !== turnId || this.#closing) return;
      this.#feed({
        type: "prompt_result",
        stopReason: stopReasonOf(res),
        at: this.#deps.clock.now(),
      });
    } catch (e) {
      if (this.#currentTurnId !== turnId || this.#closing) return;

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
    try {
      await this.#link.notify("session/cancel", { sessionId: this.#sessionId });
    } catch (e) {
      this.#logger.warn("session/cancel could not be sent", { error: String(e) });
    }

    this.#cancelTimer?.cancel();
    this.#cancelTimer = this.#deps.clock.setTimer(this.#deps.limits.cancelGraceMs, () => {
      this.#cancelTimer = null;
      if (this.#state !== "running" || this.#currentTurnId !== turnId) return;
      // The agent ignored `session/cancel`. It has had its cooperative chance, so the ladder
      // starts at the force rung (§6.5) rather than offering another graceful window.
      void this.#closeWith("cancel_timeout", {
        force: true,
        error: new OmniError(
          "agent_timeout",
          `the agent did not answer session/cancel within ${String(this.#deps.limits.cancelGraceMs)}ms`,
        ),
      }).catch((e: unknown) => {
        this.#logger.error("cancel escalation failed", { error: String(e) });
      });
    });
  }

  get generation(): number {
    return this.#generation;
  }

  /**
   * ready → hibernated (§15.2). Reclaims the process tree, RELEASES the lease, keeps the record
   * and the session pointer, and NEVER sends `session/close` — the pointer is the entire value
   * being preserved. Owned by M1-WP-C (`worker/hibernate.ts`).
   */
  hibernate(_reason: "idle_timeout" | "client_request"): Promise<WorkerSnapshot> {
    throw new OmniError("internal", "unimplemented: M1-WP-C");
  }

  /**
   * hibernated → ready (§15.5). Idempotent and single-flight. Owned by M1-WP-C
   * (`worker/wake.ts`), which drives it through the injected `SessionStrategy.reopen`.
   */
  wake(_who: ClientRef, _opts?: { timeoutMs?: number }): Promise<WorkerSnapshot> {
    // The resume call happens INSIDE D6's replay window, which is why the wake path is the one
    // that opens it. `#withReplayWindow` is the seam; what runs inside it is M1-WP-C's.
    return this.#withReplayWindow(() => {
      throw new OmniError("internal", "unimplemented: M1-WP-C");
    });
  }

  /**
   * D6's replay window, opened for the duration of `fn` and closed in a `finally`.
   *
   * The `finally` is load-bearing and is an acceptance bullet of its own (M1-PLAN WP-C 3): a
   * REJECTED resume that left the window open would mark the NEXT turn's updates as replay, and
   * a consumer filtering `replay: true` would then silently drop a live turn.
   *
   * It is a REFCOUNT rather than a boolean so a nested or re-entered open cannot close a window
   * somebody else still holds. `SessionReopenOptions.controls.replayWindow()` is the same thing
   * handed to a `SessionStrategy`.
   */
  async #withReplayWindow<T>(fn: () => Promise<T>): Promise<T> {
    this.#replayWindow += 1;
    try {
      return await fn();
    } finally {
      this.#replayWindow -= 1;
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
    const out: TurnOutput = this.#deps.normalizer.step(input);
    const envelopes = this.#deps.log.appendAll(out.emit);
    this.#rescheduleTick(out.scheduleTickAt);
    this.#afterStep(out);
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

  /** `#step` for the paths where a throw must not escape into a timer or the SDK's dispatcher. */
  #feed(input: Parameters<Normalizer["step"]>[0]): void {
    try {
      this.#step(input);
    } catch (e) {
      this.#logger.error("normalizer step threw", { input: input.type, error: String(e) });
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
        if (this.#link !== null && !this.#linkClosed && this.#sessionId !== null) {
          this.#link.notify("session/cancel", { sessionId: this.#sessionId });
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

    // The turn is over. `settled` is the Normalizer's word for it, whichever of the quiet
    // window, the hard cap, an agent error or a death produced it.
    this.#cancelTimer?.cancel();
    this.#cancelTimer = null;
    this.#currentTurnId = null;
    if (this.#state === "running" && !this.#closing) {
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
      if (this.#closing) return;
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
    this.#feed({
      type: "agent_update",
      update: n.update,
      at: this.#deps.clock.now(),
      ...(this.#replayWindow > 0 ? { replay: true as const } : {}),
    });
  }

  async #onPermissionRequest(req: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    // Ruling M1-R14: the responder sees the V2-MAPPED request, never the raw v1 one. D4's rule
    // set is written against v2's tagged `subject`, and mapping FIRST is what lets M2's rule
    // engine match `kind` / `path` / `cmd` with no per-agent branch.
    //
    // The envelope below still carries the RAW request verbatim — `acp.interaction` is the audit
    // record, and an audit of a reshaped object audits our reshaping (§7.5).
    const mapped: MappedPermissionRequest = this.#deps.normalizer.mapPermissionRequest(req);
    const decision = this.#deps.responder.decide(mapped);
    const turnId = this.#currentTurnId;
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
      // than inventing an option id (rule 1) or cancelling the whole turn (rule 5).
      throw AcpRequestError.internalError(
        { offered: decision.record.offered },
        "no acceptable permission option was offered",
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
    void proc.exited.then((exit) => {
      this.#agentGone = true;
      this.#onExit(exit);
    });
    void proc.stdoutEnded.then(() => {
      this.#agentGone = true;
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
    const message =
      exit === null
        ? "the agent transport ended and the process did not exit within exitGraceMs"
        : `the agent process exited (code=${String(exit.code)}, signal=${String(exit.signal)})`;

    const error = new OmniError("agent_error", message, {
      detail: { code: exit?.code ?? null, signal: exit?.signal ?? null },
    });

    void this.#closeWith(reason, {
      error,
      stderrTail,
      exit,
      ...(o?.force === true ? { force: true } : {}),
    }).catch((e: unknown) => {
      this.#logger.error("close after agent death failed", { error: String(e) });
    });
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
    const previous = this.#state;
    this.#closeReason = reason;
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

  async start(signal?: AbortSignal): Promise<void> {
    // Seq 1 is ALWAYS `omni.worker_state{starting}` (§8.2 rule 2), so `?since=0` replays a
    // worker's whole life from birth — including a worker that never made it past the handshake.
    this.#setState("starting", "created", {});

    const spec = (this.#deps.toSpawnSpec ?? ((d, o) => defaultSpawnSpec(d, o, this.#deps.label)))(
      this.#deps.descriptor,
      { cwd: this.#deps.cwd },
    );

    let proc: AgentProcess;
    try {
      proc = await this.#deps.supervisor.spawn(spec, signal);
    } catch (e) {
      // Nothing was created, so there is no tree to reclaim — but the log and the caller are
      // owed the same two envelopes and the same error code as any other failure edge.
      const error = OmniError.from(e, "agent_error");
      await this.#closeWith("spawn_failed", { error });
      throw error;
    }

    this.#proc = proc;
    this.#link = openAcpLink(
      proc.stream,
      {
        onSessionUpdate: (n) => {
          this.#onSessionUpdate(n);
        },
        onPermissionRequest: (req) => this.#onPermissionRequest(req),
        onClosed: (err) => {
          this.#onLinkClosed(err);
        },
      },
      { logger: this.#logger },
    );

    // Watch BEFORE the handshake: an agent that dies during `initialize` never rejects the
    // in-flight request on a transport that only the process signals can tell us about, and the
    // handshake budget is the wrong instrument for a process that is already gone.
    this.#watchProcess(proc);

    try {
      const { capabilities, sessionId } = await runHandshake(this.#link, {
        cwd: this.#deps.cwd,
        timeoutMs: this.#deps.limits.handshakeTimeoutMs,
        clock: this.#deps.clock,
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
