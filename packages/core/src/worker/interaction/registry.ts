import { OmniError } from "@omni-acp/protocol";
import type {
  Clock,
  ClientRef,
  EventEnvelope,
  EventInput,
  InteractionActor,
  InteractionAnswer,
  InteractionAnswerResult,
  InteractionId,
  InteractionRequest,
  InteractionSnapshot,
  ParkTimeoutAction,
  TokenId,
  WorkerId,
  WorkerState,
} from "@omni-acp/protocol";
import type { AcpRequestError } from "@omni-acp/protocol";
import { answerFrom, settlementEvents, type SettlementRecord } from "./envelopes.js";

/**
 * How many SETTLED rows the registry keeps after the fact.
 *
 * §19.6 needs a settled row to answer `409 interaction_settled` with "the settled snapshot, naming
 * who won" — a double-submit that answered `404` would send an SDK looking for a worker problem it
 * does not have (ruling M2-R2). The history is bounded because a long-lived worker settles an
 * unbounded number of interactions and none of them is persisted (ruling M2-R10); past the bound
 * the oldest terminal row is reaped and a very late double-submit degrades to the honest `404`.
 */
const TERMINAL_HISTORY = 64;

/**
 * The pending set, and the JSON-RPC promises it is holding open.
 *
 * Every entry here is an agent BLOCKED on our answer (F1), which is why `settleAll` must put a
 * real answer on the wire for each and return only once every held promise has resolved — a log
 * that ends on a `pending` interaction is a log that lies, and an agent waiting on us may never
 * read a `session/cancel` we send first (§19.8).
 *
 * `interaction.maxParked` is enforced here: over the bound the NEWEST is denied with
 * `rule:"limit:max_parked"` and never dropped, because an unanswered agent request hangs a turn
 * forever and a silent drop is the one outcome worse than a denial. The registry reports the
 * bound through `atCapacity` and refuses a `hold` past it; the DENIAL itself is the strategy's,
 * because only the strategy may name an option id (ruling M2-R16).
 *
 * Owned by M2-A-WP-I.
 */
export interface PendingInteractions {
  /** Registers a request and returns the promise the link handler will await. */
  hold(req: InteractionRequest, o: HoldOptions): Promise<unknown>;
  answer(
    id: InteractionId,
    a: InteractionAnswer,
    who: ClientRef & { tokenId: TokenId },
  ): InteractionAnswerResult;
  /**
   * Settles ONE held request from outside — the park deadline's path (§19.5). Returns false when
   * the id is unknown or already terminal, which is exactly the race a timer that fired one tick
   * after a human answered would otherwise turn into a double settlement.
   */
  settleOne(
    id: InteractionId,
    decide: (held: HeldInteraction) => Settlement,
    by: InteractionActor,
  ): boolean;
  get(id: InteractionId): InteractionSnapshot | null;
  readonly pending: readonly InteractionSnapshot[];
  /** True when one more park would exceed `interaction.maxParked` (§19.5). */
  readonly atCapacity: boolean;
  /** Returns only once every held JSON-RPC promise has RESOLVED — review R1: resolving a deferred
   *  the link is holding writes the response bytes a microtask later, so a synchronous settle
   *  followed by `session/cancel` would still put the cancel on stdin first (§19.8). */
  settleAll(reason: "shutdown" | "cancel" | "close" | "hibernate" | "timeout"): Promise<void>;
}

/** How one settlement reaches the agent. `reject` is only ever an `AcpRequestError` (§19.8). */
export type WireAnswer =
  | { readonly kind: "resolve"; readonly value: unknown }
  | { readonly kind: "reject"; readonly error: AcpRequestError };

/** What a settlement decided: the bytes the agent gets, and the audit trail it leaves. */
export interface Settlement {
  readonly wire: WireAnswer;
  readonly record: SettlementRecord;
}

/** One held request, as the settling side sees it. */
export interface HeldInteraction {
  readonly id: InteractionId;
  readonly request: InteractionRequest;
  readonly parkedAtMs: number;
  readonly expiresAtMs: number | null;
  readonly onTimeout: ParkTimeoutAction;
  /** ms this request has spent parked, as of `nowMs`. `answer.parkedMs`'s only source. */
  parkedMs(nowMs: number): number;
}

/** Per-hold wiring the strategy supplies, because only it holds the context and the deadline. */
export interface HoldOptions {
  /** Absolute epoch-ms the park expires, or null for `parkTimeoutMs: 0` — parked forever. */
  readonly expiresAtMs: number | null;
  readonly onTimeout: ParkTimeoutAction;
  /** `InteractionContext.emit` for the context this request arrived on. */
  readonly emit: (inputs: readonly EventInput[]) => void;
  /**
   * Disposes everything this park owns: the `ctx.park()` un-park and the park deadline. Called
   * EXACTLY once, after the settlement envelopes are appended, so §19.10's five-envelope order
   * holds — the terminal `acp.interaction` and `omni.policy_decision` precede the
   * `omni.worker_state{interaction_resolved}` the un-park emits.
   */
  readonly release: () => void;
}

/** Everything the registry needs that is not bookkeeping. Supplied by the strategy (§1.3 seam A). */
export interface PendingInteractionsOptions {
  readonly maxParked: number;
  readonly clock: Clock;
  readonly workerId: WorkerId;
  /**
   * Turns a client's answer into a settlement. Throws `OmniError("bad_request")` for a body this
   * request cannot accept — §19.6's semantics rows, which the ROUTE reports and which must
   * therefore be decidable without touching the wire.
   */
  readonly decideAnswer: (
    held: HeldInteraction,
    a: InteractionAnswer,
    who: ClientRef & { tokenId: TokenId },
  ) => Settlement;
  /** The settlement `settleAll` imposes: `-32603` for a permission, decline for an elicitation. */
  readonly decideSettleAll: (
    held: HeldInteraction,
    reason: "shutdown" | "cancel" | "close" | "hibernate" | "timeout",
  ) => Settlement;
  /** `InteractionAnswerResult.state`; absent ⇒ derived from whether anything is still parked. */
  readonly workerState?: () => WorkerState;
  /**
   * The newest envelope in the worker's log, or null when no log is wired.
   *
   * `InteractionAnswerResult.seq` is COPIED off it and never computed: `EventLog.append()` is the
   * only assigner of a `seq` in this repository (§8.2), and the `seq-single-writer` guard fails
   * the build on anything that invents one. That is why this is an envelope rather than a number
   * — a `seq` that a second writer produced makes two subscribers disagree about history, and no
   * cursor recovers from that.
   */
  readonly cursor: () => EventEnvelope | null;
}

interface Entry {
  readonly held: HeldInteraction;
  readonly options: HoldOptions;
  /** Ordinal, so the terminal history is reaped oldest-first without reading a clock twice. */
  readonly ordinal: number;
  /** Resolves the promise the ACP link handler is awaiting. */
  readonly finish: (w: WireAnswer) => void;
  /** Awaited by `settleAll`: resolves only once the held promise's continuations have run. */
  readonly done: Promise<void>;
  settled: {
    readonly record: SettlementRecord;
    readonly at: string;
    readonly by: InteractionActor;
  } | null;
}

export function createPendingInteractions(o: PendingInteractionsOptions): PendingInteractions {
  const entries = new Map<InteractionId, Entry>();
  let ordinal = 0;
  let live = 0;

  const snapshotOf = (e: Entry): InteractionSnapshot => {
    const req = e.held.request;
    const settled = e.settled;
    return {
      requestId: e.held.id,
      workerId: o.workerId,
      kind: req.kind,
      method: req.method,
      status: settled?.record.status ?? "pending",
      title: req.title,
      message: req.message,
      turnId: req.turnId,
      toolCallId: req.toolCallId,
      createdAt: new Date(e.held.parkedAtMs).toISOString(),
      options: req.options,
      fields: req.fields,
      // NEVER a lie (§5.8.4): the deadline is cleared the moment the request settles, exactly as
      // `LeaseSnapshot.expiresAt` is under a pin. A settled row advertising a countdown nothing is
      // running is the same bug in a different table.
      expiresAt:
        settled !== null || e.held.expiresAtMs === null
          ? null
          : new Date(e.held.expiresAtMs).toISOString(),
      settledAt: settled?.at ?? null,
      settledBy: settled?.by ?? null,
      answer: settled === null ? null : answerFrom(settled.record),
    };
  };

  /** Bounded terminal history (see `TERMINAL_HISTORY`): oldest settled row first. */
  const reap = (): void => {
    let terminal = entries.size - live;
    if (terminal <= TERMINAL_HISTORY) return;
    const oldestFirst = [...entries.values()]
      .filter((e) => e.settled !== null)
      .sort((a, b) => a.ordinal - b.ordinal);
    for (const e of oldestFirst) {
      if (terminal <= TERMINAL_HISTORY) return;
      entries.delete(e.held.id);
      terminal -= 1;
    }
  };

  /**
   * The one place an entry moves from pending to terminal.
   *
   * Order is the contract: record the settlement (so every snapshot built from here on is
   * terminal), append the two envelopes, release the park — which is what emits
   * `omni.worker_state{interaction_resolved}`, §19.10's n+4 — and only THEN put the bytes on the
   * wire. A caller that resolved first would let the agent's next frame race the envelopes that
   * explain it, and §19.10's sequence is asserted frame by frame.
   */
  const settle = (e: Entry, s: Settlement, by: InteractionActor): void => {
    if (e.settled !== null) return;
    e.settled = { record: s.record, at: o.clock.iso(), by };
    live -= 1;
    e.options.emit(settlementEvents(e.held.request, s.record, e.held.request.turnId));
    e.options.release();
    e.finish(s.wire);
    reap();
  };

  return {
    hold(req: InteractionRequest, options: HoldOptions): Promise<unknown> {
      if (entries.has(req.id)) {
        throw new OmniError("internal", `interaction ${req.id} is already held`);
      }
      // The bound is checked HERE as well as at the strategy's own gate, because a silent
      // overflow is the failure mode §19.5 exists to prevent and a second check costs nothing.
      if (live >= o.maxParked) {
        throw new OmniError(
          "worker_limit",
          `worker ${o.workerId} already has ${String(o.maxParked)} parked interactions`,
        );
      }

      const parkedAtMs = o.clock.now();
      const held: HeldInteraction = {
        id: req.id,
        request: req,
        parkedAtMs,
        expiresAtMs: options.expiresAtMs,
        onTimeout: options.onTimeout,
        parkedMs: (nowMs) => Math.max(0, nowMs - parkedAtMs),
      };

      let finish!: (w: WireAnswer) => void;
      const promise = new Promise<unknown>((resolve, reject) => {
        finish = (w) => {
          if (w.kind === "resolve") resolve(w.value);
          else reject(w.error);
        };
      });
      // Review R1's guarantee, made mechanical: `settleAll` awaits THIS, not the held promise —
      // the held promise's rejection belongs to the ACP link handler, and awaiting it in the
      // teardown path would turn a `-32603` we deliberately sent into an unhandled rejection.
      const done = promise.then(
        () => undefined,
        () => undefined,
      );

      ordinal += 1;
      live += 1;
      entries.set(req.id, { held, options, ordinal, finish, done, settled: null });
      return promise;
    },

    answer(id, a, who): InteractionAnswerResult {
      const e = entries.get(id);
      if (e === undefined) {
        // Never held on this worker, or settled long enough ago to have left the history. Both
        // are `404` and neither is a worker problem, which is exactly why `interaction_not_found`
        // exists beside `worker_not_found` (ruling M2-R2).
        throw new OmniError("interaction_not_found", `no interaction ${id} is awaiting an answer`);
      }
      if (e.settled !== null) {
        // §19.6: `409`, carrying the settled snapshot so the loser of a double-submit learns WHO
        // won without a second round trip that may already be stale.
        throw new OmniError(
          "interaction_settled",
          `interaction ${id} is already ${e.settled.record.status}`,
          { interaction: snapshotOf(e) },
        );
      }

      // §19.6's SEMANTICS row, and it runs before anything reaches the wire: a body the stored
      // request cannot accept is a `400` naming what was wrong, and the agent stays parked.
      const settlement = o.decideAnswer(e.held, a, who);
      settle(e, settlement, "human");

      const at = o.cursor();
      if (at === null) {
        // No log wired ⇒ no envelope ⇒ no `seq` to report, and inventing one is exactly what
        // §8.2 forbids. It is a WIRING bug rather than a client one, so it says which wire is
        // missing: the daemon hands `DaemonDeps.interactions` the worker's own log
        // (`InteractionStrategyDeps.log`), and every path a client can reach goes through it.
        throw new OmniError(
          "internal",
          "InteractionAnswerResult.seq needs the worker's EventLog; pass `log` to " +
            "createInteractionStrategy (see InteractionStrategyDeps)",
        );
      }
      return {
        interaction: snapshotOf(e),
        state: o.workerState?.() ?? (live > 0 ? "requires_action" : "running"),
        seq: at.seq,
      };
    },

    settleOne(id, decide, by): boolean {
      const e = entries.get(id);
      if (e === undefined || e.settled !== null) return false;
      settle(e, decide(e.held), by);
      return true;
    },

    get(id): InteractionSnapshot | null {
      const e = entries.get(id);
      return e === undefined ? null : snapshotOf(e);
    },

    get pending(): readonly InteractionSnapshot[] {
      return [...entries.values()].filter((e) => e.settled === null).map(snapshotOf);
    },

    get atCapacity(): boolean {
      return live >= o.maxParked;
    },

    async settleAll(reason): Promise<void> {
      // Snapshotted first, because `settle` mutates the map's contents underneath the iteration.
      const open = [...entries.values()].filter((e) => e.settled === null);
      const waits = open.map((e) => e.done);
      const by: InteractionActor = reason === "timeout" ? "timeout" : "daemon";
      for (const e of open) settle(e, o.decideSettleAll(e.held, reason), by);
      // The whole point of §19.8: resolving a deferred the link handler is holding writes the
      // response bytes a MICROTASK later, so a synchronous settle followed by
      // `await link.notify("session/cancel")` still puts the cancel on stdin first — which is
      // exactly the hang this section exists to prevent. Idempotent: a second call finds nothing
      // open and awaits an empty list.
      await Promise.all(waits);
      // …and then ONE macrotask, because the promise we hold is not the last link in that chain.
      // The ACP link's request handler awaits OURS, the SDK serializes the result, and the write
      // happens in the continuations that follow — all of them queued BEHIND this function's own
      // resumption. Measured, not assumed: with `await Promise.all(waits)` alone, a permission
      // settled to `-32603` reached the agent AFTER a `session/cancel` sent on the next line, and
      // the named test in `lifecycle.test.ts` is the recording of it. Yielding to the macrotask
      // queue drains every pending microtask, response writes included. It costs one tick on the
      // four teardown paths that call this and nothing at all on a hot path.
      if (open.length > 0) await new Promise<void>((resolve) => setImmediate(resolve));
    },
  };
}
