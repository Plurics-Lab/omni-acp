import {
  ERROR_STATUS,
  HEADER,
  SSE_CONTROL,
  turnStatus,
  type AgentCatalogEntry,
  type ClientRefWire,
  type Daemon,
  type DaemonId,
  type DaemonInfo,
  type EventBody,
  type EventEnvelope,
  type LeaseEventPayload,
  type LeaseOp,
  type LeaseSnapshot,
  type OmniErrorBody,
  type OmniErrorCode,
  type PermissionOption,
  type ResumeReport,
  type SessionId,
  type Seq,
  type StopReason,
  type TurnId,
  type WhoAmIResponse,
  type WorkerCloseReason,
  type WorkerId,
  type WorkerSnapshot,
  type WorkerState,
  type WorkerStateReason,
} from "@omni-acp/protocol";
import { seqIds, stubDaemon } from "@omni-acp/testkit";

/**
 * A `/v1` wire surface over an in-memory event log — the client's Tier-1 fixture.
 *
 * It exists because WP-6's unit tests must exercise the SDK against the SHAPES of
 * `CONTRACTS.md` §2.1 without WP-2…WP-5 (in this branch those are stubs that throw), and
 * without a socket. It deliberately implements the wire and nothing else: no supervisor, no
 * normalizer, no policy — the daemon's own behaviour is proven by `tests/integration`, and a
 * second implementation of it here would be a second opinion nobody asked for.
 *
 * What it does model exactly, because the client's correctness depends on it:
 *
 *  - `seq` assigned synchronously, 1-based and gap-free, seq 1 = `worker_state{starting}` (§8.2);
 *  - `PromptAccepted.seq` = the seq of that turn's `state_update{running}` (§5.3);
 *  - `?since=N` is EXCLUSIVE, replay-then-live in one synchronous step (§8.4);
 *  - the three out-of-band control frames, with no `id:` and no seq (§8.4, D24);
 *  - `omni.stream_end` after a closed worker's last envelope, and an ABRUPT close for a network
 *    drop — the distinction the client's resume logic is built on.
 */

// ── scripts ──────────────────────────────────────────────────────────────────

export type ScriptItem =
  | { kind: "text"; text: string }
  | { kind: "thought"; text: string }
  | { kind: "tool_call"; payload: Record<string, unknown> }
  | { kind: "usage"; used: number; size: number }
  | { kind: "permission"; requestId: string; title: string; optionId: string }
  | { kind: "error"; body: OmniErrorBody }
  | { kind: "close"; reason: WorkerCloseReason }
  | { kind: "idle"; stopReason: StopReason | null };

const PERMISSION_OPTIONS: readonly PermissionOption[] = [
  { kind: "allow_once", name: "Allow this change", optionId: "allow" },
  { kind: "reject_once", name: "Skip this change", optionId: "reject" },
] as unknown as readonly PermissionOption[];

/**
 * A scale model of the SDK example agent's turn: two tool calls, a permission that the baseline
 * responder denies, and the reject-branch sentence. Same shape as the acceptance fixture, minus
 * five seconds of simulated latency.
 */
export function exampleTurn(): ScriptItem[] {
  return [
    { kind: "text", text: "I'll help you with that." },
    {
      kind: "tool_call",
      payload: {
        sessionUpdate: "tool_call",
        toolCallId: "call_1",
        title: "Reading project files",
        kind: "read",
        status: "pending",
        locations: [{ path: "/project/README.md" }],
        rawInput: { path: "/project/README.md" },
      },
    },
    {
      kind: "tool_call",
      payload: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call_1",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "# My Project" } }],
      },
    },
    { kind: "thought", text: "considering the config change" },
    {
      kind: "tool_call",
      payload: {
        sessionUpdate: "tool_call",
        toolCallId: "call_2",
        title: "Modifying critical configuration file",
        kind: "edit",
        status: "pending",
        locations: [{ path: "/project/config.json" }],
      },
    },
    {
      kind: "permission",
      requestId: "req_1",
      title: "Modifying critical configuration file",
      optionId: "reject",
    },
    { kind: "text", text: " I'll skip the configuration update." },
    { kind: "usage", used: 1_234, size: 200_000 },
    { kind: "idle", stopReason: "end_turn" as StopReason },
  ];
}

/** A turn that dies mid-flight: no `idle` is ever produced (CONTRACTS.md §7.3). */
export function crashingTurn(): ScriptItem[] {
  return [
    { kind: "text", text: "about to crash" },
    { kind: "error", body: { code: "agent_error", message: "agent exited with code 1" } },
    { kind: "close", reason: "agent_crashed" },
  ];
}

// ── options ──────────────────────────────────────────────────────────────────

export interface WireOptions {
  readonly token?: string;
  readonly url?: string;
  readonly agents?: readonly AgentCatalogEntry[];
  /**
   * `"sync"` writes the WHOLE turn into the log inside the POST handler, before the client can
   * possibly subscribe. That is the strongest available proof that `since = accepted.seq - 1`
   * is what makes `prompt()` race-free — with `since = accepted.seq` the buffer loses its first
   * envelope, and with a post-hoc subscription it loses the lot.
   */
  readonly emit?: "sync" | "async";
  /** Delay between envelopes in `"async"` mode. */
  readonly stepMs?: number;
  /**
   * Simulates a flaky network: the response body is closed ABRUPTLY (no `omni.stream_end`)
   * after `dropAfter` envelopes, for the first `maxDrops` connections.
   */
  readonly chaos?: { readonly dropAfter: number; readonly maxDrops: number };
  /** The oldest retained seq, as if the ring had evicted. `since < tail - 1` ⇒ `stream_truncated`. */
  readonly tail?: Seq;
}

export interface Connection {
  readonly since: number;
  readonly workerId: string;
}

export interface WireDaemon {
  /** A `stubDaemon()` whose `fetch` is this wire surface, so tests use `daemon.fetch`. */
  readonly daemon: Daemon;
  readonly url: string;
  readonly token: string;
  readonly daemonId: DaemonId;
  /** Every HTTP call, in order — how "connect() issues exactly one request" is asserted. */
  readonly requests: readonly { method: string; path: string }[];
  /** Every SSE connection, with the cursor it carried. */
  readonly connections: readonly Connection[];
  /** Live SSE subscribers, per worker. Must return to 0 when a client goes away. */
  subscriberCount(workerId: string): number;
  /** Creates a ready worker in-process, the way `POST /v1/workers` would. */
  createWorker(opts?: { agentId?: string; cwd?: string; script?: ScriptItem[] }): WorkerSnapshot;
  envelopes(workerId: string): readonly EventEnvelope[];
  /** Closes a worker out of band, the way a crash would. */
  closeWorker(workerId: string, reason: WorkerCloseReason): void;
  setScript(workerId: string, script: ScriptItem[]): void;
  /** Resolves once every scripted envelope of the last accepted turn has been appended. */
  turnWritten(): Promise<void>;
  /** Every `Omni-Lease-Epoch` header the client sent, in order — `null` for a request without one. */
  readonly epochs: readonly (number | null)[];
  /** Forces a worker into `hibernated` out of band, the way an idle timer would (§15.2). */
  hibernateWorker(workerId: string): void;
}

// ── implementation ───────────────────────────────────────────────────────────

interface WorkerRecord {
  snapshot: WorkerSnapshot;
  envelopes: EventEnvelope[];
  subscribers: Set<(e: EventEnvelope) => void>;
  script: ScriptItem[];
  currentTurn: TurnId | null;
  closed: boolean;
}

function errorResponse(code: OmniErrorCode, message: string): Response {
  const body: OmniErrorBody = { code, message };
  return new Response(JSON.stringify(body), {
    status: ERROR_STATUS[code],
    headers: { "content-type": "application/json" },
  });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function createWireDaemon(options: WireOptions = {}): WireDaemon {
  const ids = seqIds();
  const daemonId = ids.daemon();
  const token = options.token ?? "wire-token-0123456789";
  const url = options.url ?? "http://wire.invalid";
  const emit = options.emit ?? "sync";
  const stepMs = options.stepMs ?? 1;
  const tail: Seq = options.tail ?? 1;
  const agents: readonly AgentCatalogEntry[] = options.agents ?? [
    {
      id: "example",
      command: process.execPath,
      args: ["agent.js"],
      source: "config",
      probed: null,
    },
  ];

  const workers = new Map<string, WorkerRecord>();
  const requests: { method: string; path: string }[] = [];
  const connections: Connection[] = [];
  let drops = 0;
  let clock = Date.UTC(2026, 0, 1);
  let turnWritten: Promise<void> = Promise.resolve();

  const nextTs = (): string => new Date(++clock).toISOString();

  /** D6's replay window, as the fixture's own flag: every append inside it is marked (M1-R5). */
  let replaying = false;

  /** The ONE place a seq is assigned — synchronous, gap-free, per worker (§8.2). */
  const append = (
    rec: WorkerRecord,
    body: EventBody,
    o: { turnId?: TurnId | null; payloadVersion?: 1 | 2 } = {},
  ): EventEnvelope => {
    const envelope = Object.freeze({
      ...body,
      seq: rec.envelopes.length + 1,
      ts: nextTs(),
      daemonId,
      workerId: rec.snapshot.workerId,
      sessionId: rec.snapshot.sessionId,
      turnId: o.turnId ?? null,
      payloadVersion: o.payloadVersion ?? 1,
      ...(replaying ? { replay: true as const } : {}),
    }) as EventEnvelope;
    rec.envelopes.push(envelope);
    rec.snapshot = { ...rec.snapshot, headSeq: envelope.seq, updatedAt: envelope.ts };
    for (const deliver of [...rec.subscribers]) deliver(envelope);
    return envelope;
  };

  const setState = (
    rec: WorkerRecord,
    state: WorkerState,
    reason: WorkerStateReason,
    turnId: TurnId | null = null,
    extra: { resume?: ResumeReport; generation?: number } = {},
  ): EventEnvelope => {
    const previous = rec.snapshot.state;
    rec.snapshot = { ...rec.snapshot, state };
    return append(
      rec,
      {
        kind: "omni.worker_state",
        payload: {
          state,
          previous,
          reason,
          ...(state === "closed"
            ? { leaderExited: true, treeGone: process.platform !== "win32" }
            : {}),
          ...extra,
        },
      },
      { turnId, payloadVersion: 2 },
    );
  };

  /**
   * D5's audit envelope (§16.1 rule L9), which is what makes observer mode observable: a client
   * that never called a lease verb still watches the lease move, because every transition is in
   * the worker's own log.
   */
  const leaseEvent = (
    rec: WorkerRecord,
    op: LeaseOp,
    lease: LeaseSnapshot,
    previous: ClientRefWire | null,
    by: ClientRefWire | null,
    how: LeaseEventPayload["how"],
    reason: string | null,
  ): EventEnvelope => {
    rec.snapshot = { ...rec.snapshot, lease };
    return append(
      rec,
      { kind: "omni.lease", payload: { op, lease, previous, by, how, reason } },
      { payloadVersion: 2 },
    );
  };

  const sessionUpdate = (
    rec: WorkerRecord,
    payload: Record<string, unknown>,
    turnId: TurnId | null,
    payloadVersion: 1 | 2 = 1,
  ): EventEnvelope =>
    append(
      rec,
      { kind: "acp.session_update", payload: payload as never },
      {
        turnId,
        payloadVersion,
      },
    );

  const createWorker = (o?: {
    agentId?: string;
    cwd?: string;
    script?: ScriptItem[];
  }): WorkerSnapshot => {
    const workerId = ids.worker();
    const sessionId: SessionId = `sess-${workerId.slice(2, 8)}`;
    const now = nextTs();
    const rec: WorkerRecord = {
      snapshot: {
        workerId,
        daemonId,
        ref: `${daemonId}:${workerId}`,
        sessionId: null,
        agentId: o?.agentId ?? "example",
        state: "starting",
        cwd: o?.cwd ?? "/tmp/wire",
        label: null,
        ownerTokenId: "wire",
        createdAt: now,
        updatedAt: now,
        headSeq: 0,
        currentTurnId: null,
        capabilities: {
          protocolVersion: 1,
          raw: { loadSession: true, sessionCapabilities: { resume: {} } },
          loadSession: true,
          promptCapabilities: null,
          supportsSessionClose: false,
          // M1: a worker that can hibernate is one whose agent advertises a resume spelling
          // (§15.2, ruling M1-R15). The wire fixture models a resumable agent so the SDK's
          // hibernate/wake surface has something to talk to.
          resume: { method: "session/resume", replayFrom: false, requiresSameCwd: false },
          supportsSessionList: false,
          configOptions: null,
          modes: null,
          extensions: [],
        },
        process: {
          pid: 4242 + workers.size,
          groupId: process.platform === "win32" ? null : 4242 + workers.size,
          startedAt: now,
          command: process.execPath,
          argsRedacted: ["agent.js"],
          fingerprint: null,
        },
        closeReason: null,
        // ── M1 (CONTRACTS.md §5.1 `WorkerSnapshot`) ─────────────────────────
        // Created lease-FREE. `createWorker()` here is the out-of-band constructor a test uses to
        // put a worker on the wire; nobody asked for it, so nobody holds it, and rule L5's
        // implicit acquire is what the first gated call then does. `POST /v1/workers` sets the
        // holder to its caller, which is `CreateWorkerRequest.lease: "take"`, the default.
        lease: {
          workerId,
          holder: null,
          epoch: 0,
          expiresAt: null,
          acquiredAt: null,
          pinned: false,
        },
        hibernatedAt: null,
        crashed: false,
        resume: null,
        wakeCount: 0,
        wakeFailures: 0,
        orphan: null,
        generation: 1,
        runtimeId: `${o?.agentId ?? "example"}@wire00000000`,
        persistence: "memory",
      },
      envelopes: [],
      subscribers: new Set(),
      script: o?.script ?? exampleTurn(),
      currentTurn: null,
      closed: false,
    };
    workers.set(workerId, rec);

    // Seq 1 is ALWAYS `worker_state{starting}` and its `sessionId` is null — the pre-handshake
    // prefix is frozen and never back-filled (§8.2 rule 3, review R16).
    setState(rec, "starting", "created");
    rec.snapshot = { ...rec.snapshot, sessionId };
    setState(rec, "ready", "handshake_ok");
    return rec.snapshot;
  };

  const writeItem = (rec: WorkerRecord, item: ScriptItem, turnId: TurnId): void => {
    switch (item.kind) {
      case "text":
        sessionUpdate(
          rec,
          {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: item.text },
          },
          turnId,
        );
        return;
      case "thought":
        sessionUpdate(
          rec,
          {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: item.text },
          },
          turnId,
        );
        return;
      case "replay":
        replaying = true;
        sessionUpdate(
          rec,
          {
            sessionUpdate: "agent_message_chunk",
            messageId: "m-replay",
            content: { type: "text", text: item.text },
          },
          turnId,
          2,
        );
        replaying = false;
        return;
      case "tool_call":
        sessionUpdate(rec, item.payload, turnId);
        return;
      case "usage":
        sessionUpdate(
          rec,
          { sessionUpdate: "usage_update", used: item.used, size: item.size },
          turnId,
        );
        return;
      case "permission":
        append(
          rec,
          {
            kind: "acp.interaction",
            payload: {
              requestId: item.requestId,
              method: "session/request_permission",
              request: { toolCall: { title: item.title }, options: PERMISSION_OPTIONS },
              status: "answered",
              answer: { optionId: item.optionId, by: "baseline" },
            },
          },
          { turnId, payloadVersion: 2 },
        );
        append(
          rec,
          {
            kind: "omni.policy_decision",
            payload: {
              requestId: item.requestId,
              title: item.title,
              decision: "deny",
              rule: "m0:auto-deny",
              optionId: item.optionId,
              offered: PERMISSION_OPTIONS,
              // §13.4: the join back to the tool call, recorded by the party that decided.
              toolCallId: null,
            },
          },
          { turnId, payloadVersion: 2 },
        );
        return;
      case "error":
        append(rec, { kind: "omni.error", payload: item.body }, { turnId, payloadVersion: 2 });
        return;
      case "close":
        rec.closed = true;
        rec.snapshot = { ...rec.snapshot, closeReason: item.reason, process: null };
        setState(rec, "closed", item.reason);
        return;
      case "idle":
        sessionUpdate(
          rec,
          {
            sessionUpdate: "state_update",
            state: "idle",
            ...(item.stopReason === null ? {} : { stopReason: item.stopReason }),
          },
          turnId,
          2,
        );
        rec.currentTurn = null;
        rec.snapshot = { ...rec.snapshot, currentTurnId: null };
        if (!rec.closed) setState(rec, "ready", "turn_end");
        return;
    }
  };

  const runTurn = (rec: WorkerRecord, turnId: TurnId): { turnId: TurnId; seq: Seq } => {
    // `state_update{running}` is appended BEFORE anything the agent produces, so its seq is a
    // sound subscription cursor (§7.1).
    const running = sessionUpdate(
      rec,
      { sessionUpdate: "state_update", state: "running" },
      turnId,
      2,
    );
    rec.currentTurn = turnId;
    rec.snapshot = { ...rec.snapshot, currentTurnId: turnId };
    // The worker's OWN lifecycle envelope, after the turn's: `reason: "prompt"` and
    // `reason: "turn_end"` exist in `WorkerStatePayload` for exactly this pair. Emitting it
    // after `state_update{running}` keeps `accepted.seq - 1` a sound cursor for both.
    setState(rec, "running", "prompt", turnId);

    const script = [...rec.script];
    if (emit === "sync") {
      for (const item of script) writeItem(rec, item, turnId);
    } else {
      turnWritten = (async () => {
        for (const item of script) {
          await new Promise<void>((resolve) => setTimeout(resolve, stepMs));
          writeItem(rec, item, turnId);
        }
      })();
    }
    return { turnId, seq: running.seq };
  };

  // ── SSE ────────────────────────────────────────────────────────────────────

  const sse = (rec: WorkerRecord, since: number): Response => {
    const encoder = new TextEncoder();
    let deliver: ((e: EventEnvelope) => void) | null = null;
    let delivered = 0;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const push = (text: string): void => {
          controller.enqueue(encoder.encode(text));
        };
        const frame = (e: EventEnvelope): void => {
          push(`id: ${String(e.seq)}\nevent: ${e.kind}\ndata: ${JSON.stringify(e)}\n\n`);
        };
        const control = (event: string, data: unknown): void => {
          // No `id:` — a control frame is not an envelope and consumes no seq (§8.4, D24).
          push(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };
        const finish = (): void => {
          if (deliver !== null) rec.subscribers.delete(deliver);
          deliver = null;
          controller.close();
        };

        push("retry: 2000\n\n");
        if (since < tail - 1) control(SSE_CONTROL.truncated, { tail });

        const emitOne = (e: EventEnvelope): boolean => {
          frame(e);
          delivered += 1;
          if (
            options.chaos !== undefined &&
            drops < options.chaos.maxDrops &&
            delivered >= options.chaos.dropAfter
          ) {
            // An ABRUPT close: no `omni.stream_end`, which is exactly how a dropped connection
            // differs from a finished one. The client must reconnect with `?since=<last seq>`.
            drops += 1;
            finish();
            return false;
          }
          if (e.kind === "omni.worker_state" && e.payload.state === "closed") {
            control(SSE_CONTROL.end, { reason: "worker_closed", lastSeq: e.seq });
            finish();
            return false;
          }
          return true;
        };

        // Replay then live, in ONE synchronous step: no event can slip between them (§8.4).
        for (const e of rec.envelopes) {
          if (e.seq <= Math.max(since, tail - 1)) continue;
          if (!emitOne(e)) return;
        }

        deliver = (e: EventEnvelope): void => {
          if (deliver === null) return;
          emitOne(e);
        };
        rec.subscribers.add(deliver);
      },
      cancel() {
        // The client went away. A subscription that outlives its reader is the classic SSE leak.
        if (deliver !== null) rec.subscribers.delete(deliver);
        deliver = null;
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  };

  // ── M1: the lease, hibernation and the probe ──────────────────────────────

  const epochs: (number | null)[] = [];
  const probed = new Set<string>();

  /** Who is asking. `null` is a client that sent no `Omni-Client-Id` — legal by default (L4). */
  const callerOf = (request: Request): ClientRefWire => ({
    tokenId: "wire",
    clientId: request.headers.get(HEADER.clientId),
  });

  const sameClient = (a: ClientRefWire | null, b: ClientRefWire | null): boolean =>
    a !== null && b !== null && a.tokenId === b.tokenId && a.clientId === b.clientId;

  const lease423 = (lease: LeaseSnapshot, message: string): Response => {
    // §16.1 rule L10: the body NAMES the holder and the epoch, which is what lets a caller learn
    // who took the worker without a second round trip against a worker it may not control.
    const body: OmniErrorBody = { code: "lease_held", message, lease };
    return new Response(JSON.stringify(body), {
      status: ERROR_STATUS["lease_held"],
      headers: { "content-type": "application/json" },
    });
  };

  /**
   * Rules L2, L5 and L7 for one gated request.
   *
   * L7 is the one worth modelling here and the one the SDK's fence is measured against: a
   * PRESENT-and-stale `Omni-Lease-Epoch` is a `423` **even from the right client id**. Order
   * matters — the epoch is checked first, so a holder that cached an old number is refused rather
   * than waved through on identity.
   */
  const fenceOf = (request: Request, rec: WorkerRecord): Response | null => {
    const header = request.headers.get(HEADER.leaseEpoch);
    epochs.push(header === null ? null : Number(header));
    const lease = rec.snapshot.lease;
    if (header !== null && Number(header) !== lease.epoch) {
      return lease423(lease, `stale lease epoch ${header} (current ${String(lease.epoch)})`);
    }
    if (lease.holder === null) {
      // L5: the first gated call on an unheld lease CLAIMS it, and the claim is audited like any
      // other transition — a lease that changed hands silently is the one thing D5 forbids.
      const by = callerOf(request);
      leaseEvent(
        rec,
        "acquired",
        { ...lease, holder: by, epoch: lease.epoch + 1, acquiredAt: nextTs() },
        null,
        by,
        "implicit",
        null,
      );
      return null;
    }
    if (sameClient(lease.holder, callerOf(request))) return null;
    return lease423(lease, `worker is held by ${lease.holder.clientId ?? lease.holder.tokenId}`);
  };

  const applyLease = (
    rec: WorkerRecord,
    op: LeaseOp | "acquire",
    by: ClientRefWire,
    body: { reason?: string },
  ): LeaseSnapshot => {
    const previous = rec.snapshot.lease.holder;
    const epoch = rec.snapshot.lease.epoch + 1;
    const next: LeaseSnapshot =
      op === "release"
        ? { ...rec.snapshot.lease, holder: null, epoch, acquiredAt: null }
        : { ...rec.snapshot.lease, holder: by, epoch, acquiredAt: nextTs() };
    leaseEvent(
      rec,
      op === "acquire" ? "acquired" : op === "release" ? "released" : "stolen",
      next,
      previous,
      by,
      op === "steal" ? "steal" : "explicit",
      body.reason ?? null,
    );
    return next;
  };

  /** §15.2's order: release the lease, THEN the state envelope. The process is already gone. */
  const hibernate = (rec: WorkerRecord): void => {
    if (rec.snapshot.state === "hibernated") return;
    const previous = rec.snapshot.lease.holder;
    leaseEvent(
      rec,
      "released",
      { ...rec.snapshot.lease, holder: null, acquiredAt: null },
      previous,
      previous,
      "hibernate",
      null,
    );
    rec.snapshot = { ...rec.snapshot, process: null, hibernatedAt: nextTs() };
    setState(rec, "hibernated", "hibernate");
  };

  /**
   * §15.3, including the replay window: the envelopes between the `wake` and the `resumed` state
   * carry `replay: true`, which is precisely what `stream()` filters by default (M1-R5).
   */
  const wake = (rec: WorkerRecord, by: ClientRefWire): WorkerSnapshot => {
    leaseEvent(rec, "acquired", { ...rec.snapshot.lease, holder: by }, null, by, "implicit", null);
    setState(rec, "starting", "wake");
    replaying = true;
    sessionUpdate(
      rec,
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "m-replay",
        content: { type: "text", text: "earlier" },
      },
      null,
      2,
    );
    replaying = false;
    const resume: ResumeReport = {
      outcome: "landed",
      hint: "ok",
      rule: "rule7:landed",
      method: "session/resume",
      requested: rec.snapshot.sessionId,
      landedOn: rec.snapshot.sessionId,
      historyLost: false,
      acp: null,
      replayedEvents: 1,
      replayDropped: 0,
      durationMs: 7,
      at: nextTs(),
    };
    const generation = rec.snapshot.generation + 1;
    rec.snapshot = {
      ...rec.snapshot,
      resume,
      generation,
      wakeCount: rec.snapshot.wakeCount + 1,
      hibernatedAt: null,
      process: {
        pid: 5252 + workers.size,
        groupId: process.platform === "win32" ? null : 5252 + workers.size,
        startedAt: nextTs(),
        command: process.execPath,
        argsRedacted: ["agent.js"],
        fingerprint: null,
      },
    };
    setState(rec, "ready", "resumed", null, { resume, generation });
    return rec.snapshot;
  };

  const probeSummary = (agentId: string) => ({
    agentId,
    at: nextTs(),
    durationMs: 12,
    fingerprint: `${agentId}@wire00000000`,
    agentInfo: { name: agentId, version: "0.0.0-wire" },
    protocolVersion: 1 as const,
    capabilities: { loadSession: true },
    methods: {},
    errors: [],
  });

  // ── routing ────────────────────────────────────────────────────────────────

  const whoami: WhoAmIResponse = {
    tokenId: "wire",
    role: "admin",
    daemonId,
    agents: "*",
    cwdRoots: ["/tmp"],
    maxWorkers: 16,
    policyCeiling: null,
  };

  const info: DaemonInfo = {
    daemonId,
    version: "0.0.0-wire",
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    protocolVersions: [1],
    startedAt: new Date(clock).toISOString(),
    ownership: {
      kind: process.platform === "win32" ? "windows-taskkill-tree" : "posix-process-group",
      confirmsTreeGone: process.platform !== "win32",
      survivesDaemonKill: true,
      caveat: process.platform === "win32" ? "tree kill is best effort on Windows" : null,
    },
  };

  const handle = async (request: Request): Promise<Response> => {
    const parsed = new URL(request.url);
    const path = parsed.pathname;
    requests.push({ method: request.method, path: `${path}${parsed.search}` });

    if (path === "/v1/health") return json(200, { ok: true });

    if (request.headers.get(HEADER.auth) !== `Bearer ${token}`) {
      return errorResponse("unauthorized", "missing or invalid bearer token");
    }

    if (path === "/v1/whoami") return json(200, whoami);
    if (path === "/v1/info") return json(200, info);
    if (path === "/v1/agents") return json(200, { agents });

    if (path === "/v1/workers" && request.method === "GET") {
      return json(200, { workers: [...workers.values()].map((r) => r.snapshot) });
    }
    if (path === "/v1/workers" && request.method === "POST") {
      const body = (await request.json()) as { agent?: string; cwd?: string };
      if (typeof body.agent !== "string" || typeof body.cwd !== "string") {
        return errorResponse("bad_request", "agent and cwd are required");
      }
      const created = createWorker({ agentId: body.agent, cwd: body.cwd });
      const rec = workers.get(created.workerId);
      // `CreateWorkerRequest.lease` defaults to `"take"`: the creator holds it (D5).
      if (rec !== undefined) applyLease(rec, "acquire", callerOf(request), {});
      return json(201, rec?.snapshot ?? created);
    }

    const probeMatch = /^\/v1\/agents\/([^/]+)\/probe$/.exec(path);
    if (probeMatch !== null && request.method === "POST") {
      const agentId = decodeURIComponent(probeMatch[1] ?? "");
      if (!agents.some((a) => a.id === agentId)) {
        return errorResponse("bad_request", `unknown agent "${agentId}"`);
      }
      const cached = probed.has(agentId);
      probed.add(agentId);
      return json(200, { probe: probeSummary(agentId), cached });
    }

    const worker = /^\/v1\/workers\/([^/]+)(\/.*)?$/.exec(path);
    if (worker === null) return errorResponse("bad_request", `no route for ${path}`);

    const rec = workers.get(worker[1] ?? "");
    if (rec === undefined) return errorResponse("worker_not_found", "no such worker");
    const rest = worker[2] ?? "";

    if (rest === "" && request.method === "GET") return json(200, rec.snapshot);

    if (rest === "" && request.method === "DELETE") {
      if (!rec.closed) {
        rec.closed = true;
        rec.snapshot = { ...rec.snapshot, closeReason: "client_request", process: null };
        setState(rec, "closed", "client_request");
      }
      return json(200, {
        workerId: rec.snapshot.workerId,
        state: "closed",
        reason: rec.snapshot.closeReason ?? "client_request",
        leaderExited: true,
        treeGone: process.platform !== "win32",
      });
    }

    if (rest === "/prompt" && request.method === "POST") {
      // Parse FIRST, then decide — the order every route has (D15 constraint 1: parse → call
      // one daemon method → serialize). Checking `currentTurn` before `await request.json()`
      // would put an await between the check and the act, and two concurrent prompts would
      // BOTH be accepted: the 409 this fixture exists to produce would never fire.
      const body = (await request.json()) as { content?: unknown };
      if (!Array.isArray(body.content) || body.content.length === 0) {
        return errorResponse("bad_request", "content must be a non-empty array");
      }
      for (const block of body.content as { type?: unknown }[]) {
        if (block.type !== "text") {
          return errorResponse("bad_request", 'M0 accepts only content blocks with type "text"');
        }
      }
      if (rec.closed) return errorResponse("worker_closed", "worker is closed");
      if (rec.currentTurn !== null) return errorResponse("worker_busy", "a turn is already live");
      return json(202, runTurn(rec, ids.turn()));
    }

    if (rest === "/cancel" && request.method === "POST") return json(202, {});

    // ── M1: H17-H19 ────────────────────────────────────────────────────────
    //
    // The fixture models the RULES the SDK has to cope with, not the daemon's implementation of
    // them: rule L7's stale fence, rule L9's audit envelope, §15.3's replay window and §15.5's
    // `422` carrying a `ResumeReport`. The daemon's own behaviour is proven by
    // `tests/integration`; a second implementation of it here would be a second opinion.

    if (rest === "/hibernate" && request.method === "POST") {
      const fenced = fenceOf(request, rec);
      if (fenced !== null) return fenced;
      hibernate(rec);
      return json(200, rec.snapshot);
    }

    if (rest === "/wake" && request.method === "POST") {
      const fenced = fenceOf(request, rec);
      if (fenced !== null) return fenced;
      if (rec.snapshot.state !== "hibernated") return json(200, rec.snapshot);
      return json(200, wake(rec, callerOf(request)));
    }

    const leaseOp = /^\/lease\/(acquire|release|steal)$/.exec(rest);
    if (leaseOp !== null && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { reason?: string };
      return json(200, applyLease(rec, leaseOp[1] as LeaseOp | "acquire", callerOf(request), body));
    }

    if (rest === "/events" && request.method === "GET") {
      const raw = parsed.searchParams.get("since");
      const since = raw === null ? 0 : Number(raw);
      if (!Number.isInteger(since) || since < 0) {
        return errorResponse("bad_request", `since must be a non-negative integer, got "${raw}"`);
      }
      connections.push({ since, workerId: rec.snapshot.workerId });
      return sse(rec, since);
    }

    const turn = /^\/turns\/([^/]+)$/.exec(rest);
    if (turn !== null && request.method === "GET") {
      return json(200, turnStatus((turn[1] ?? "") as TurnId, rec.envelopes));
    }

    return errorResponse("bad_request", `no route for ${request.method} ${path}`);
  };

  const daemon = stubDaemon({ fetch: (req: Request) => handle(req) });

  return {
    daemon,
    url,
    token,
    daemonId,
    requests,
    connections,
    subscriberCount: (workerId) => workers.get(workerId)?.subscribers.size ?? 0,
    createWorker,
    envelopes: (workerId) => workers.get(workerId)?.envelopes ?? [],
    closeWorker: (workerId, reason) => {
      const rec = workers.get(workerId);
      if (rec === undefined || rec.closed) return;
      rec.closed = true;
      rec.snapshot = { ...rec.snapshot, closeReason: reason, process: null };
      setState(rec, "closed", reason);
    },
    epochs,
    hibernateWorker: (workerId) => {
      const rec = workers.get(workerId);
      if (rec !== undefined && !rec.closed) hibernate(rec);
    },
    setScript: (workerId, script) => {
      const rec = workers.get(workerId);
      if (rec !== undefined) rec.script = script;
    },
    turnWritten: () => turnWritten,
  };
}

/**
 * `Daemon.fetch` is `(Request) => Promise<Response>`; `ConnectOptions.fetch` is
 * `typeof globalThis.fetch` (CONTRACTS.md §5.5). The two are runtime-identical for every call
 * this SDK makes — it only ever builds a `Request` and calls `fetch(request)` — but the narrower
 * one is not assignable to the wider under `strictFunctionTypes`. Adapting is honest where a
 * cast would merely be quiet.
 */
export function fetchOf(daemon: Daemon): typeof globalThis.fetch {
  return (input, init) =>
    daemon.fetch(input instanceof Request && init === undefined ? input : new Request(input, init));
}

/** The WorkerId of a snapshot, in the shape the routes want. */
export function idOf(snapshot: WorkerSnapshot): WorkerId {
  return snapshot.workerId;
}
