import {
  OmniError,
  SSE_CONTROL,
  assertTurnId,
  reduceTurn,
  type CloseResult,
  type ContentBlock,
  type DaemonId,
  type EventEnvelope,
  type OmniError as OmniErrorType,
  type PromptAccepted,
  type Seq,
  type SessionId,
  type StopReason,
  type ToolCallView,
  type TurnId,
  type TurnResult,
  type TurnStatus,
  type WorkerCloseReason,
  type WorkerId,
  type WorkerRef,
  type WorkerSnapshot,
  type WorkerState,
} from "@omni-acp/protocol";
import { isMalformedFrame, parseSseStream } from "./sse-parse.js";
import type { Transport } from "./transport.js";

export type PromptInput = string | ContentBlock | readonly ContentBlock[];

export interface PromptOptions {
  /** DESIGN §9.1: one turn at a time per worker. Default true (SDK-side serialization, D30). */
  readonly queue?: boolean;
  readonly signal?: AbortSignal;
}

export type StreamEvent =
  | { readonly type: "text"; readonly delta: string }
  | { readonly type: "thought"; readonly delta: string }
  | { readonly type: "tool_call"; readonly toolCall: ToolCallView }
  | { readonly type: "state"; readonly state: "running" | "idle"; readonly stopReason?: StopReason }
  | { readonly type: "raw"; readonly envelope: EventEnvelope }
  | { readonly type: "done"; readonly result: TurnResult };

export interface WorkerEventMap {
  state: (s: WorkerState, e: EventEnvelope) => void;
  event: (e: EventEnvelope) => void;
  error: (e: OmniErrorType) => void;
  closed: (s: WorkerSnapshot) => void;
}

export interface Worker {
  readonly id: WorkerId;
  readonly ref: WorkerRef;
  readonly daemonId: DaemonId;
  readonly sessionId: SessionId | null;
  readonly agentId: string;
  /**
   * The LAST STATE THIS HANDLE OBSERVED, not a live query.
   *
   * It advances from the envelopes this handle has read, so a handle with no listener and no
   * stream open holds the state it was created with. `on("state", …)` opens the tail and keeps
   * it current (DESIGN §9.1's own example does exactly that); `server.attach(id)` or
   * `server.workers()` fetch a fresh one. Making the getter itself fetch would turn a property
   * read into a network call, which is the surprise this note exists to avoid.
   */
  readonly state: WorkerState;
  /** As `state`: the last snapshot this handle observed. */
  readonly snapshot: WorkerSnapshot;
  /**
   * POST /prompt -> subscribe with `since = accepted.seq - 1` -> collect until this turnId's
   * `state_update{idle}` OR any `worker_state{closed}` -> `reduceTurn()` locally.
   *
   * The same pure reducer the daemon uses for GET /turns/{id}, so there is no extra round trip
   * and no possible disagreement (DESIGN §5.5, D7). `accepted.seq - 1` is what removes the
   * subscribe/prompt race without a pre-existing subscription.
   */
  prompt(input: PromptInput, opts?: PromptOptions): Promise<TurnResult>;
  stream(input: PromptInput, opts?: PromptOptions): AsyncIterable<StreamEvent>;
  /** Raw envelope tail; auto-reconnects with the last seen seq. */
  events(opts?: { since?: Seq; signal?: AbortSignal }): AsyncIterable<EventEnvelope>;
  turn(turnId: string): Promise<TurnStatus>;
  cancel(): Promise<void>;
  close(): Promise<CloseResult>;
  on<K extends keyof WorkerEventMap>(event: K, cb: WorkerEventMap[K]): () => void;
  readonly closed: Promise<WorkerSnapshot>;
}

/**
 * `server.close()` has to stop a handle's background stream, and `Worker` has no method for it
 * — deliberately, because a user-facing `dispose()` next to `close()` invites closing the wrong
 * one (one stops a local stream, the other kills a remote process tree). A WeakMap keeps the
 * capability inside the package without widening the published surface.
 */
const disposers = new WeakMap<Worker, () => void>();

/** Stops a handle's local streams. Never touches the remote worker. */
export function disposeWorker(w: Worker): void {
  disposers.get(w)?.();
}

/**
 * Exhaustive by construction: a mapped type over `WorkerCloseReason` makes a missing arm a
 * compile error, so this narrowing cannot silently rot when a reason is added to the protocol.
 * `WorkerStatePayload.reason` widens to include lifecycle reasons (`created`, `prompt`, …) that
 * are not close reasons, and `WorkerSnapshot.closeReason` accepts only the latter.
 */
const IS_CLOSE_REASON: { readonly [R in WorkerCloseReason]: true } = {
  client_request: true,
  daemon_shutdown: true,
  spawn_failed: true,
  handshake_error: true,
  handshake_timeout: true,
  agent_exited: true,
  agent_crashed: true,
  protocol_error: true,
  // M1's three (§5.1 `WorkerCloseReason`). The map is exhaustive BY CONSTRUCTION, which is why
  // adding a reason to the protocol shows up here as a compile error rather than as a snapshot
  // whose `closeReason` silently became null.
  idle_timeout: true,
  wake_failed: true,
  orphaned: true,
  cancel_timeout: true,
  not_resumable: true,
};

function asCloseReason(reason: string): WorkerCloseReason | null {
  return Object.prototype.hasOwnProperty.call(IS_CLOSE_REASON, reason)
    ? (reason as WorkerCloseReason)
    : null;
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

/**
 * A bare string becomes ONE `type:"text"` block, which is all M0 accepts (CONTRACTS.md §2.3,
 * review R12). The blocks themselves are forwarded verbatim — never re-modelled — so that an
 * M1 client sending a richer block does not have to wait for this function to learn about it.
 */
export function toContentBlocks(input: PromptInput): ContentBlock[] {
  if (typeof input === "string") {
    return [{ type: "text", text: input } as ContentBlock];
  }
  const blocks = Array.isArray(input)
    ? [...(input as readonly ContentBlock[])]
    : [input as ContentBlock];
  if (blocks.length === 0) {
    throw new OmniError("bad_request", "prompt() needs at least one content block");
  }
  return blocks;
}

/**
 * CONTRACTS.md §7.3, implemented on the client exactly as the daemon implements it:
 *
 *   a turn is terminal on `state_update{idle}` for that turnId, OR on ANY
 *   `omni.worker_state{state:"closed"}`.
 *
 * The second arm is the one that matters: a dead agent never produces a fabricated `idle`, so
 * without it `prompt()` would wait forever for an event that is never coming.
 */
export function isTurnTerminal(turnId: TurnId, e: EventEnvelope): boolean {
  if (e.kind === "omni.worker_state") return e.payload.state === "closed";
  if (e.kind !== "acp.session_update" || e.turnId !== turnId) return false;
  const payload = asRecord(e.payload);
  return payload["sessionUpdate"] === "state_update" && payload["state"] === "idle";
}

const RECONNECT_BACKOFF_MS = [0, 25, 50, 100, 200, 400, 800] as const;
/** A stream that reopens and immediately ends, over and over, is a broken daemon, not a tail. */
const MAX_EMPTY_RECONNECTS = 20;

function backoff(attempt: number): number {
  return RECONNECT_BACKOFF_MS[Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)] ?? 800;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** A terminal answer: reconnecting cannot change it, so the reader stops rather than spins. */
function isFatal(e: unknown): boolean {
  return (
    // A frame we cannot parse is the daemon speaking a shape we do not know, not a dropped
    // connection: replaying it from the same cursor would produce the same failure forever.
    isMalformedFrame(e) ||
    OmniError.is(e, "worker_not_found") ||
    OmniError.is(e, "worker_closed") ||
    OmniError.is(e, "unauthorized") ||
    OmniError.is(e, "forbidden") ||
    OmniError.is(e, "bad_request")
  );
}

export function createWorkerHandle(transport: Transport, snapshot: WorkerSnapshot): Worker {
  const id = snapshot.workerId;
  let current: WorkerSnapshot = snapshot;

  // The emitter's high-water mark. `prompt()` opens its own stream while a background tail may
  // already be running; both feed `ingest`, and both deliver in ascending seq, so one comparison
  // gives each listener every envelope exactly once.
  let emittedThrough: Seq = 0;

  const listeners: { [K in keyof WorkerEventMap]: Set<WorkerEventMap[K]> } = {
    state: new Set(),
    event: new Set(),
    error: new Set(),
    closed: new Set(),
  };

  const local = new AbortController();
  let tailStarted = false;

  let resolveClosed!: (s: WorkerSnapshot) => void;
  const closedPromise = new Promise<WorkerSnapshot>((resolve) => {
    resolveClosed = resolve;
  });
  // The handle may be created and dropped without anyone awaiting `closed`; an unhandled
  // rejection is impossible because this promise only ever resolves.
  let closedSettled = false;

  const emitError = (e: unknown): void => {
    const err = OmniError.from(e);
    for (const cb of listeners.error) cb(err);
  };

  /** Listener callbacks are user code: one that throws must not kill the reader. */
  const safely = (fn: () => void): void => {
    try {
      fn();
    } catch (e) {
      emitError(e);
    }
  };

  const markClosed = (s: WorkerSnapshot): void => {
    if (closedSettled) return;
    closedSettled = true;
    resolveClosed(s);
    for (const cb of listeners.closed) safely(() => cb(s));
  };

  const ingest = (e: EventEnvelope): void => {
    if (e.seq <= emittedThrough) return;
    emittedThrough = e.seq;

    const sessionId = e.sessionId ?? current.sessionId;
    if (e.kind === "omni.worker_state") {
      const p = e.payload;
      const closeReason = p.state === "closed" ? asCloseReason(p.reason) : current.closeReason;
      current = {
        ...current,
        sessionId,
        state: p.state,
        headSeq: e.seq,
        updatedAt: e.ts,
        closeReason,
        process: p.state === "closed" ? null : current.process,
      };
      for (const cb of listeners.state) safely(() => cb(p.state, e));
      for (const cb of listeners.event) safely(() => cb(e));
      if (p.state === "closed") markClosed(current);
      return;
    }

    current = { ...current, sessionId, headSeq: e.seq, updatedAt: e.ts };
    for (const cb of listeners.event) safely(() => cb(e));
  };

  /**
   * The resumable envelope tail.
   *
   * One connection is never the unit of work: the stream is re-opened with `?since=<last seq
   * seen>` after every drop, and an envelope at or below the cursor is discarded, so the union
   * over N connections is gap-free AND duplicate-free by construction. That is the whole of
   * §8.4's reconnect contract, and it is why the chaos test can drop the connection five times
   * mid-turn and still see the reference replay.
   */
  async function* envelopes(since: Seq, signal?: AbortSignal): AsyncGenerator<EventEnvelope> {
    const stop = signal === undefined ? local.signal : AbortSignal.any([local.signal, signal]);
    // Called, never read as a property: `AbortSignal.aborted` is declared `readonly`, so
    // TypeScript narrows it once and keeps believing that narrowing for the rest of the loop.
    const stopped = (): boolean => stop.aborted;
    let cursor = Math.max(0, since);
    let attempt = 0;
    let empty = 0;

    while (!stopped()) {
      let res: Response;
      try {
        res = await transport.open(`/v1/workers/${id}/events?since=${String(cursor)}`, {
          signal: stop,
        });
      } catch (e) {
        if (stopped()) return;
        if (isFatal(e)) throw e;
        if (++attempt > MAX_EMPTY_RECONNECTS) throw OmniError.from(e);
        await delay(backoff(attempt), stop);
        continue;
      }
      attempt = 0;

      let progressed = false;
      let ended = false;
      try {
        for await (const message of parseSseStream(res, stop)) {
          if (message.type === "control") {
            // `omni.stream_end` is the daemon saying "this worker is closed" — the closed
            // envelope itself already came through above it, so there is nothing to resume.
            // `_truncated` and `_overflow` are both handled by the cursor: reopen from where we
            // actually got to and take the truthful partial history (D6, D24).
            if (message.event === SSE_CONTROL.end) ended = true;
            if (message.event === SSE_CONTROL.end || message.event === SSE_CONTROL.overflow) break;
            continue;
          }
          const envelope = message.envelope;
          if (envelope.seq <= cursor) continue; // a resume overlap, not new history
          cursor = envelope.seq;
          progressed = true;
          ingest(envelope);
          yield envelope;
        }
      } catch (e) {
        if (stopped()) return;
        if (isFatal(e)) throw e;
        // A mid-stream transport failure is exactly what `?since=` exists for.
        emitError(e);
      }

      if (ended || stopped()) return;
      empty = progressed ? 0 : empty + 1;
      if (empty > MAX_EMPTY_RECONNECTS) {
        throw new OmniError(
          "internal",
          `event stream for ${id} ended ${String(empty)} times without delivering an envelope`,
          { detail: { since: cursor } },
        );
      }
      await delay(backoff(empty), stop);
    }
  }

  /** Started once, lazily: a handle nobody listens to must not hold an SSE stream open. */
  const ensureTail = (): void => {
    if (tailStarted || local.signal.aborted || closedSettled) return;
    tailStarted = true;
    void (async () => {
      try {
        // `since = 0` is a full retained replay, which §8.4 makes the correct default: it is
        // bounded, and it removes the create-then-subscribe race entirely.
        for await (const e of envelopes(0)) {
          if (e.kind === "omni.worker_state" && e.payload.state === "closed") break;
        }
      } catch (e) {
        if (!local.signal.aborted) emitError(e);
      }
    })();
  };

  // ── one turn at a time (D30) ───────────────────────────────────────────────
  //
  // `queue: true` (the default) chains turns through a promise mutex so two back-to-back
  // prompts both succeed, in order. `queue: false` skips the chain so the daemon's `409` is what
  // the caller sees — which is the point of the option.
  let chain: Promise<void> = Promise.resolve();

  const acquire = async (queue: boolean): Promise<() => void> => {
    if (!queue) return () => {};
    const previous = chain;
    let release!: () => void;
    chain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    return release;
  };

  const startTurn = async (
    input: PromptInput,
    opts: PromptOptions | undefined,
  ): Promise<PromptAccepted> => {
    const content = toContentBlocks(input);
    return transport.request<PromptAccepted>(
      "POST",
      `/v1/workers/${id}/prompt`,
      { content },
      { ...(opts?.signal === undefined ? {} : { signal: opts.signal }) },
    );
  };

  const collect = async (
    accepted: PromptAccepted,
    signal: AbortSignal | undefined,
    onEnvelope?: (e: EventEnvelope) => void,
  ): Promise<TurnResult> => {
    const buffer: EventEnvelope[] = [];
    // `accepted.seq` is this turn's `state_update{running}`; subscribing one below it is what
    // guarantees the whole turn is in the buffer even though the subscription opens after the
    // POST returned (CONTRACTS.md §5.3 `PromptAccepted.seq`).
    for await (const e of envelopes(accepted.seq - 1, signal)) {
      buffer.push(e);
      onEnvelope?.(e);
      if (isTurnTerminal(accepted.turnId, e)) break;
    }
    return reduceTurn(accepted.turnId, buffer);
  };

  const worker: Worker = {
    id,
    get ref(): WorkerRef {
      return current.ref;
    },
    get daemonId(): DaemonId {
      return current.daemonId;
    },
    get sessionId(): SessionId | null {
      return current.sessionId;
    },
    get agentId(): string {
      return current.agentId;
    },
    get state(): WorkerState {
      return current.state;
    },
    get snapshot(): WorkerSnapshot {
      return current;
    },
    get closed(): Promise<WorkerSnapshot> {
      ensureTail();
      return closedPromise;
    },

    async prompt(input: PromptInput, opts?: PromptOptions): Promise<TurnResult> {
      const release = await acquire(opts?.queue !== false);
      try {
        const accepted = await startTurn(input, opts);
        return await collect(accepted, opts?.signal);
      } finally {
        release();
      }
    },

    stream(input: PromptInput, opts?: PromptOptions): AsyncIterable<StreamEvent> {
      // An async generator body does not run until the first `next()`, so the turn is not
      // started — and the queue slot is not taken — until somebody actually iterates.
      return streamTurn(input, opts);
    },

    events(opts?: { since?: Seq; signal?: AbortSignal }): AsyncIterable<EventEnvelope> {
      return tail(opts);
    },

    async turn(turnId: string): Promise<TurnStatus> {
      return transport.request<TurnStatus>(
        "GET",
        `/v1/workers/${id}/turns/${assertTurnId(turnId)}`,
      );
    },

    async cancel(): Promise<void> {
      await transport.request("POST", `/v1/workers/${id}/cancel`, {});
    },

    async close(): Promise<CloseResult> {
      const result = await transport.request<CloseResult>("DELETE", `/v1/workers/${id}`);
      current = {
        ...current,
        state: "closed",
        closeReason: result.reason,
        process: null,
      };
      markClosed(current);
      local.abort();
      return result;
    },

    on<K extends keyof WorkerEventMap>(event: K, cb: WorkerEventMap[K]): () => void {
      listeners[event].add(cb);
      // `error` alone does not open a stream: it is the sink for the others' failures, and a
      // handle that only wants to hear about problems should not create one.
      if (event !== "error") ensureTail();
      return () => {
        listeners[event].delete(cb);
      };
    },
  };

  async function* streamTurn(
    input: PromptInput,
    opts?: PromptOptions,
  ): AsyncGenerator<StreamEvent> {
    const release = await acquire(opts?.queue !== false);
    try {
      const accepted = await startTurn(input, opts);
      const buffer: EventEnvelope[] = [];

      for await (const e of envelopes(accepted.seq - 1, opts?.signal)) {
        buffer.push(e);
        yield { type: "raw", envelope: e };
        yield* derive(accepted.turnId, e, buffer);
        if (isTurnTerminal(accepted.turnId, e)) break;
      }

      // The SAME pure reducer over the SAME envelopes prompt() would have folded, so
      // `done.result` is deep-equal to `prompt()`'s by construction (DESIGN §5.5).
      yield { type: "done", result: reduceTurn(accepted.turnId, buffer) };
    } finally {
      release();
    }
  }

  async function* tail(opts?: {
    since?: Seq;
    signal?: AbortSignal;
  }): AsyncGenerator<EventEnvelope> {
    for await (const e of envelopes(opts?.since ?? 0, opts?.signal)) {
      yield e;
      // Past a close there is no more history to wait for, and reconnecting would only 404.
      if (e.kind === "omni.worker_state" && e.payload.state === "closed") return;
    }
  }

  disposers.set(worker, () => {
    local.abort();
  });
  return worker;
}

/**
 * The typed view of one envelope, derived rather than re-implemented.
 *
 * `tool_call` re-folds the buffer with `reduceTurn` instead of maintaining a second upsert
 * state machine: `ToolCallUpdate` merge semantics (absent means unchanged, `content` replaces)
 * live in exactly one place in this repository, and a second copy here would be a second
 * opinion about what a tool call currently is. Turns are tens of envelopes, so the re-fold is
 * cheap and it cannot disagree with `done.result`.
 */
function* derive(
  turnId: TurnId,
  e: EventEnvelope,
  buffer: readonly EventEnvelope[],
): Generator<StreamEvent> {
  if (e.kind !== "acp.session_update" || e.turnId !== turnId) return;
  const payload = asRecord(e.payload);
  const kind = payload["sessionUpdate"];

  if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
    const content = asRecord(payload["content"]);
    if (content["type"] !== "text" || typeof content["text"] !== "string") return;
    const delta = content["text"];
    yield kind === "agent_message_chunk" ? { type: "text", delta } : { type: "thought", delta };
    return;
  }

  if (kind === "tool_call" || kind === "tool_call_update") {
    const toolCallId = payload["toolCallId"];
    if (typeof toolCallId !== "string") return;
    const view = reduceTurn(turnId, buffer).toolCalls.find((c) => c.toolCallId === toolCallId);
    if (view !== undefined) yield { type: "tool_call", toolCall: view };
    return;
  }

  if (kind === "state_update") {
    const state = payload["state"];
    if (state !== "running" && state !== "idle") return;
    const stopReason = payload["stopReason"];
    yield {
      type: "state",
      state,
      ...(typeof stopReason === "string" ? { stopReason: stopReason as StopReason } : {}),
    };
  }
}
