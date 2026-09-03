import {
  OmniError,
  turnStatus,
  type AgentProcess,
  type CloseResult,
  type EventEnvelope,
  type EventInput,
  type EventListener,
  type EventLog,
  type Normalizer,
  type PromptAccepted,
  type SessionId,
  type Seq,
  type SpawnSpec,
  type Subscription,
  type TurnId,
  type TurnStatus,
  type WorkerCloseReason,
  type WorkerHandle,
  type WorkerId,
  type WorkerSnapshot,
  type WorkerState,
} from "@omni-acp/protocol";
import type { CreateWorkerDeps, MemoryEventLogOptions } from "@omni-acp/core";

/**
 * The WP-3 / WP-4 factories the daemon calls, as doubles.
 *
 * WP-5 owns `packages/daemon/**` and consumes `createMemoryEventLog` / `createNormalizer` /
 * `createWorker` as INTERFACES (M0-PLAN §2): in this tree they are scaffold stubs that throw
 * `unimplemented`. `vi.mock("@omni-acp/core", …)` over this module is what lets the daemon's own
 * suites drive the real registry, the real HTTP adapter and the real SSE writer against
 * `fakeSupervisor()` — the seam CONTRACTS.md §10.1 names — without waiting on WP-3/WP-4 and
 * without a production-code injection point that CONTRACTS.md §5.4 does not have.
 *
 * The doubles are deliberately REAL where the daemon can observe them: the log below passes
 * testkit's exported `runEventLogConformance()` verbatim, and the worker actually spawns through
 * the injected `Supervisor` and actually reclaims the tree on every failure edge, so
 * `fakeSupervisor.allTreesReclaimed()` is a real assertion rather than a tautology.
 */

// ── event log ────────────────────────────────────────────────────────────────

interface Sub {
  cursor: Seq;
  closed: boolean;
  pumping: boolean;
  readonly listener: EventListener;
  readonly queueSize: number;
  readonly onOverflow: ((lastDelivered: Seq) => void) | undefined;
}

export function testEventLog(o: MemoryEventLogOptions): EventLog {
  const ring: EventEnvelope[] = [];
  const subs = new Set<Sub>();
  let head: Seq = 0;
  let sessionId: SessionId | null = null;
  let logClosed = false;

  const tail = (): Seq => ring[0]?.seq ?? 1;

  const readFrom = (since: Seq, limit?: number): EventEnvelope[] => {
    const out: EventEnvelope[] = [];
    for (const e of ring) {
      if (e.seq <= since) continue;
      out.push(e);
      if (limit !== undefined && out.length >= limit) break;
    }
    return out;
  };

  /**
   * Delivers everything past `sub.cursor`, and keeps going if the listener appended more while
   * it ran. The re-entrancy guard is what keeps the sequence gap-free when a listener writes
   * back into the log (the conformance suite plants exactly that).
   */
  const pump = (sub: Sub): void => {
    if (sub.pumping || sub.closed) return;
    sub.pumping = true;
    try {
      for (;;) {
        if (sub.closed) return;
        if (sub.onOverflow !== undefined && head - sub.cursor > sub.queueSize) {
          const last = sub.cursor;
          closeSub(sub);
          sub.onOverflow(last);
          return;
        }
        const next = readFrom(sub.cursor);
        if (next.length === 0) return;
        for (const e of next) {
          if (sub.closed) return;
          sub.cursor = e.seq;
          sub.listener(e);
        }
      }
    } finally {
      sub.pumping = false;
    }
  };

  const closeSub = (sub: Sub): void => {
    if (sub.closed) return;
    sub.closed = true;
    subs.delete(sub);
  };

  const appendOne = (input: EventInput): EventEnvelope => {
    head += 1;
    const envelope = Object.freeze({
      ...input,
      turnId: input.turnId ?? null,
      seq: head,
      ts: o.clock.iso(),
      daemonId: o.daemonId,
      workerId: o.workerId,
      sessionId,
    }) as EventEnvelope;
    ring.push(envelope);
    while (ring.length > o.maxEvents) ring.shift();
    return envelope;
  };

  const fanOut = (): void => {
    for (const sub of [...subs]) pump(sub);
  };

  return {
    workerId: o.workerId,
    get head(): Seq {
      return head;
    },
    get tail(): Seq {
      return tail();
    },
    get subscriberCount(): number {
      return subs.size;
    },
    append(input): EventEnvelope {
      const envelope = appendOne(input);
      fanOut();
      return envelope;
    },
    appendAll(inputs): EventEnvelope[] {
      const out = inputs.map(appendOne);
      fanOut();
      return out;
    },
    read: readFrom,
    subscribe(since, listener, opts): Subscription {
      // Cursor skew is not an error in either direction: below `tail` we start at what is left
      // (the caller is told by `tail`), above `head` we start at `head` and go live (§8.4).
      const clamped = Math.min(Math.max(since, tail() - 1), head);
      const sub: Sub = {
        cursor: clamped,
        closed: false,
        pumping: false,
        listener,
        queueSize: opts?.queueSize ?? o.subscriberQueueSize,
        onOverflow: opts?.onOverflow,
      };
      subs.add(sub);
      pump(sub);
      return {
        close: () => {
          closeSub(sub);
        },
        get closed(): boolean {
          return sub.closed;
        },
      };
    },
    close(): void {
      if (logClosed) return;
      logClosed = true;
      for (const sub of [...subs]) closeSub(sub);
    },
    setSessionId(id): void {
      sessionId = id;
    },
  };
}

// ── worker ───────────────────────────────────────────────────────────────────

export interface FakeWorker {
  readonly handle: WorkerHandle;
  readonly process: AgentProcess;
  readonly deps: CreateWorkerDeps;
  /** An agent message chunk on the live turn. */
  chunk(text: string): void;
  /** Ends the live turn with `state_update{idle, stopReason}` (the normalizer's job in WP-4). */
  finishTurn(stopReason?: string): void;
  /** A mid-turn death: `omni.error` + `worker_state{closed, agent_crashed}`, never a fake idle. */
  crash(): Promise<void>;
}

export interface CoreScript {
  /** What the next `createWorker()` does once it has spawned. */
  handshake: "ok" | "jsonrpc_error" | "timeout";
  /** Set by the fake so a test can reach the worker it just created. */
  readonly workers: FakeWorker[];
  reset(): void;
}

export const coreScript: CoreScript = {
  handshake: "ok",
  workers: [],
  reset(): void {
    coreScript.handshake = "ok";
    coreScript.workers.length = 0;
  },
};

const CAPABILITIES = {
  protocolVersion: 1 as const,
  raw: { loadSession: false } as Readonly<Record<string, unknown>>,
  loadSession: false,
  promptCapabilities: null,
  supportsSessionClose: false,
};

export async function testCreateWorker(
  deps: CreateWorkerDeps,
  signal?: AbortSignal,
): Promise<WorkerHandle> {
  const { log, ids, clock } = deps;

  const spec: SpawnSpec = {
    command: deps.descriptor.command,
    args: deps.descriptor.args,
    cwd: deps.cwd,
    // The env the Catalog composed, unchanged — asserted by the catalog suite through
    // `fakeSupervisor.spawnCalls`.
    env: deps.descriptor.env,
    label: deps.descriptor.id,
  };

  let state: WorkerState = "starting";
  const createdAt = clock.iso();
  log.append({
    kind: "omni.worker_state",
    payloadVersion: 2,
    turnId: null,
    payload: { state: "starting", previous: null, reason: "created" },
  });

  const proc = await deps.supervisor.spawn(spec, signal);

  const failNow = async (
    code: "agent_error" | "agent_timeout",
    reason: WorkerCloseReason,
    message: string,
  ): Promise<never> => {
    // Every failure edge reclaims the tree BEFORE rejecting (§5.3 / H5), which is what
    // `fakeSupervisor.allTreesReclaimed()` checks after a 502 and a 504.
    const outcome = await proc.terminate({ force: true });
    const error = { code, message } as const;
    log.append({ kind: "omni.error", payloadVersion: 2, turnId: null, payload: error });
    log.append({
      kind: "omni.worker_state",
      payloadVersion: 2,
      turnId: null,
      payload: {
        state: "closed",
        previous: "starting",
        reason,
        leaderExited: outcome.leaderExited,
        treeGone: outcome.treeGone,
        error,
      },
    });
    throw new OmniError(code, message, {
      ...(code === "agent_error" ? { acp: { code: -32603, message: "handshake failed" } } : {}),
    });
  };

  if (coreScript.handshake === "jsonrpc_error") {
    await failNow("agent_error", "handshake_error", "agent rejected initialize");
  }
  if (coreScript.handshake === "timeout") {
    await failNow("agent_timeout", "handshake_timeout", "handshake exceeded the budget");
  }

  const sessionId = `sess_${deps.workerId}` as SessionId;
  log.setSessionId(sessionId);
  state = "ready";
  log.append({
    kind: "omni.worker_state",
    payloadVersion: 2,
    turnId: null,
    payload: { state: "ready", previous: "starting", reason: "handshake_ok" },
  });

  let currentTurnId: TurnId | null = null;
  let closeResult: Promise<CloseResult> | null = null;
  let closeReason: WorkerCloseReason | null = null;
  let settleClosed!: (r: CloseResult) => void;
  const closed = new Promise<CloseResult>((resolve) => {
    settleClosed = resolve;
  });
  const stateListeners = new Set<(s: WorkerState, prev: WorkerState | null) => void>();

  const setState = (next: WorkerState): void => {
    const prev = state;
    state = next;
    for (const cb of stateListeners) cb(next, prev);
  };

  const snapshot = (): WorkerSnapshot => ({
    workerId: deps.workerId,
    daemonId: deps.daemonId,
    ref: `${deps.daemonId}:${deps.workerId}`,
    sessionId: state === "starting" ? null : sessionId,
    agentId: deps.descriptor.id,
    state,
    cwd: deps.cwd,
    label: deps.label,
    ownerTokenId: deps.owner.tokenId,
    createdAt,
    updatedAt: clock.iso(),
    headSeq: log.head,
    currentTurnId,
    capabilities: CAPABILITIES,
    process: state === "closed" ? null : proc.info,
    closeReason,
  });

  const endTurn = (payload: Record<string, unknown>): void => {
    if (currentTurnId === null) return;
    log.append({
      kind: "acp.session_update",
      payloadVersion: 2,
      turnId: currentTurnId,
      payload: { sessionUpdate: "state_update", state: "idle", ...payload } as never,
    });
    currentTurnId = null;
    setState("ready");
  };

  const handle: WorkerHandle = {
    id: deps.workerId,
    log,
    lease: deps.lease,
    snapshot,

    prompt(content, who): Promise<PromptAccepted> {
      if (state === "closed") {
        return Promise.reject(new OmniError("worker_closed", `worker ${deps.workerId} is closed`));
      }
      if (currentTurnId !== null) {
        return Promise.reject(new OmniError("worker_busy", "a turn is already running"));
      }
      deps.lease.assertHolder(who);
      const turnId = ids.turn();
      currentTurnId = turnId;
      const running = log.append({
        kind: "acp.session_update",
        payloadVersion: 2,
        turnId,
        payload: { sessionUpdate: "state_update", state: "running" } as never,
      });
      setState("running");
      void content;
      return Promise.resolve({ turnId, seq: running.seq });
    },

    cancel(): Promise<void> {
      endTurn({ stopReason: "cancelled" });
      return Promise.resolve();
    },

    close(reason): Promise<CloseResult> {
      closeResult ??= (async () => {
        const outcome = await proc.terminate({ force: false });
        closeReason = reason;
        setState("closed");
        log.append({
          kind: "omni.worker_state",
          payloadVersion: 2,
          turnId: null,
          payload: {
            state: "closed",
            previous: "ready",
            reason,
            leaderExited: outcome.leaderExited,
            treeGone: outcome.treeGone,
          },
        });
        const result: CloseResult = {
          workerId: deps.workerId,
          state: "closed",
          reason,
          leaderExited: outcome.leaderExited,
          treeGone: outcome.treeGone,
        };
        settleClosed(result);
        return result;
      })();
      return closeResult;
    },

    turn(turnId): TurnStatus {
      return turnStatus(turnId, log.read(0));
    },

    onStateChange(cb): () => void {
      stateListeners.add(cb);
      return () => stateListeners.delete(cb);
    },

    closed,
  };

  coreScript.workers.push({
    handle,
    process: proc,
    deps,
    chunk(text: string): void {
      log.append({
        kind: "acp.session_update",
        payloadVersion: 1,
        turnId: currentTurnId,
        payload: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        } as never,
      });
    },
    finishTurn(stopReason = "end_turn"): void {
      endTurn({ stopReason });
    },
    async crash(): Promise<void> {
      const error = { code: "agent_error", message: "agent exited mid-turn" } as const;
      log.append({
        kind: "omni.error",
        payloadVersion: 2,
        turnId: currentTurnId,
        payload: { ...error, stderrTail: "boom" },
      });
      // §7.3: a dead agent NEVER produces a fabricated `idle`.
      currentTurnId = null;
      closeReason = "agent_crashed";
      setState("closed");
      const outcome = await proc.terminate({ force: true });
      log.append({
        kind: "omni.worker_state",
        payloadVersion: 2,
        turnId: null,
        payload: {
          state: "closed",
          previous: "running",
          reason: "agent_crashed",
          leaderExited: outcome.leaderExited,
          treeGone: outcome.treeGone,
          error,
        },
      });
      const result: CloseResult = {
        workerId: deps.workerId,
        state: "closed",
        reason: "agent_crashed",
        leaderExited: outcome.leaderExited,
        treeGone: outcome.treeGone,
      };
      closeResult ??= Promise.resolve(result);
      settleClosed(result);
    },
  });

  return handle;
}

/** A normalizer that synthesizes nothing: the fake worker writes the lifecycle itself. */
export function testNormalizer(): Normalizer {
  return {
    sourceProtocolVersion: 1,
    slice: "m0-lifecycle",
    step: () => ({ emit: [], scheduleTickAt: null, state: "idle", turnId: null, settled: null }),
  };
}

/**
 * The module object `vi.mock("@omni-acp/core", …)` installs. Everything the daemon does not
 * touch stays REAL (`importOriginal`), so a mocked suite cannot quietly diverge from the package
 * it is standing in for.
 */
export async function fakeCoreModule(
  importOriginal: () => Promise<typeof import("@omni-acp/core")>,
): Promise<typeof import("@omni-acp/core")> {
  const actual = await importOriginal();
  return {
    ...actual,
    createMemoryEventLog: testEventLog,
    createNormalizer: testNormalizer,
    createWorker: testCreateWorker,
    alwaysGrantedLease: (holder) => ({
      holder,
      assertHolder: () => {},
      acquire: () => {
        throw new OmniError("bad_request", "lease.acquire is not implemented until M1");
      },
      release: () => {
        throw new OmniError("bad_request", "lease.release is not implemented until M1");
      },
    }),
    createBaselineResponder: () => ({
      decide: (req) => ({
        response: null,
        record: {
          requestId: String((req as { requestId?: unknown }).requestId ?? "req"),
          title: "",
          decision: "deny",
          rule: "m0:auto-deny",
          optionId: null,
          offered: [],
        },
      }),
    }),
  };
}

/** A `WorkerId` literal for tests that need one without creating a worker. */
export const someWorkerId = (n: number): WorkerId => `w_${String(n).padStart(26, "0")}` as WorkerId;
