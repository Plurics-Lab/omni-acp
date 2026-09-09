import { OmniError, reduceTurn } from "@omni-acp/protocol";
import type {
  AuthContext,
  Clock,
  CreateRunRequest,
  CreateWorkerRequest,
  DaemonId,
  DeliveryStore,
  EventEnvelope,
  EventLog,
  IdGen,
  Logger,
  OmniErrorBody,
  ResolvedRunConfig,
  ResolvedWebhookConfig,
  Resolver,
  RunId,
  RunRegistry,
  RunRow,
  RunSnapshot,
  RunState,
  RunStore,
  Seq,
  TimerHandle,
  TokenId,
  TurnId,
  TurnResult,
  WebhookDispatcher,
  WebhookEvent,
  WebhookTarget,
  WorkerHandle,
  WorkerId,
  WorkerRegistry,
} from "@omni-acp/protocol";
import type { RunRowV2, RunStoreV2 } from "../persist/run-store.js";
import { assertWebhookUrl } from "../webhook/guard.js";
import { recoverRuns } from "./recovery.js";

export interface RunRegistryDeps {
  readonly daemonId: DaemonId;
  readonly bootId: string;
  readonly workers: WorkerRegistry;
  readonly store: RunStoreV2;
  readonly deliveries: DeliveryStore;
  readonly dispatcher: WebhookDispatcher | null;
  readonly config: ResolvedRunConfig;
  readonly clock: Clock;
  readonly ids: IdGen;
  readonly logger: Logger;

  // ── the five the Land stub could not name, each with the reason it is here ──

  /** The SSRF gate's config and resolver. §24.6 runs the gate at CREATE, which is here. */
  readonly webhooks: ResolvedWebhookConfig;
  readonly resolve: Resolver;
  /**
   * Each token's own `webhookSecret`, by token id — the same map the dispatcher signs with.
   *
   * The registry reads it for exactly one purpose: to REFUSE at create. A webhook run whose
   * signature could never be computed must fail where the operator can see it, not six retries
   * later in a dispatcher's log.
   */
  readonly tokenSecrets: Readonly<Record<string, string>>;
  /**
   * `RunSnapshot.persistence` (ruling M2-R14). `"memory"` ⇒ this run does NOT survive a restart,
   * and we say so rather than letting `GET /v1/runs/{rid}` 404 mysteriously later.
   */
  readonly persistence: "memory" | "durable" | "degraded";
  /**
   * ONE transaction across the run store and the delivery store (§24.4 rule 1). Absent ⇒ the
   * driver has none; the two writes then happen in order, which is the strongest guarantee the
   * memory driver can give and is said out loud rather than assumed.
   */
  readonly transaction?: <T>(fn: () => T) => T;
}

/**
 * The webhook events a target subscribes to when it names none.
 *
 * The RUN lifecycle, and not the two `worker.*` events, because a parked run would otherwise fire
 * `run.requires_action` and `worker.requires_action` for one thing that happened — and a receiver
 * that has to deduplicate two names for one event is a receiver we have made a mistake for. The
 * worker-scoped pair is opt-in, by naming it.
 */
const DEFAULT_EVENTS: readonly WebhookEvent[] = [
  "run.completed",
  "run.failed",
  "run.requires_action",
];

const TERMINAL: ReadonlySet<RunState> = new Set<RunState>([
  "succeeded",
  "failed",
  "cancelled",
  "abandoned",
]);

/**
 * §7.3's rule, on the core side of the fence: a turn is terminal on `state_update{idle}` for that
 * turnId, OR on ANY `omni.worker_state{state:"closed"}`.
 *
 * The second arm is the one that matters — a dead agent never produces a fabricated `idle`, so
 * without it a run would wait forever for an event that is never coming. It is spelled here
 * rather than imported because the identical predicate in `@omni-acp/client` is on the wrong side
 * of the dependency DAG (§3.1); that the two agree is asserted rather than asserted-in-a-comment,
 * by `run-webhook.itest.ts` comparing a run's `TurnResult` with the SDK's own fold of the same
 * envelopes (D7).
 */
function isTurnTerminal(turnId: TurnId, e: EventEnvelope): boolean {
  if (e.kind === "omni.worker_state") return e.payload.state === "closed";
  if (e.kind !== "acp.session_update" || e.turnId !== turnId) return false;
  const payload = e.payload as Record<string, unknown>;
  return payload["sessionUpdate"] === "state_update" && payload["state"] === "idle";
}

/**
 * DESIGN §9.3's Run API: create + prompt + settle + close, as ONE addressable object.
 *
 * `…/events?since=` proxies the RUN'S WORKER's log rather than adding a second stream writer —
 * which is why `omni.run` is an envelope kind on that log and why `daemon/src/http/sse.ts` stays
 * byte-identical (Land exit criterion 6). `sse-resume.itest.ts`'s frame comparison is reused
 * against a run's stream, so M1's exact `?since=` semantics are proven and not re-implemented.
 *
 * `idempotencyKey` is scoped to the TOKEN and returns the ORIGINAL run on a repeat, across a
 * restart — a retry after a timeout must not start a second agent process.
 *
 * Under the memory driver a run is ALLOWED and reports `persistence:"memory"` (ruling M2-R14):
 * refusing would break `OmniACP.local()`, and saying nothing would let `GET /v1/runs/{rid}` 404
 * mysteriously after a restart.
 *
 * **`create()` returns as soon as the worker exists and the prompt is on its way.** Settling the
 * turn, folding the `TurnResult`, closing the worker and firing the webhook all happen after it
 * has returned. That is what makes §24.5's "a slow or dead receiver never blocks a turn"
 * structural rather than a promise: there is no code path on which a receiver's socket and an
 * agent's turn are in the same await chain.
 *
 * Owned by M2-B-WP-R.
 */
export function createRunRegistry(o: RunRegistryDeps): RunRegistry {
  const atomically = o.transaction ?? (<T>(fn: () => T): T => fn());
  /** Runs this boot is still driving. The `run.maxConcurrent` gate, and nothing else. */
  const live = new Set<RunId>();
  /** `run.maxDurationMs` timers, so a run that finishes early leaves none armed. */
  const deadlines = new Map<RunId, TimerHandle>();

  const visible = (row: RunRowV2, auth: AuthContext): boolean =>
    auth.role === "admin" || row.tokenId === auth.tokenId;

  const rowOf = (id: RunId, auth: AuthContext): RunRowV2 => {
    const row = o.store.get(id);
    // A run a token may not see is a run that does not exist, exactly as D13 rules for workers:
    // a 403 here would leak that the id is real. §H25: an unknown run is `404 worker_not_found`,
    // because ruling M2-R2 declines a `run_not_found` code — `/v1/runs/{rid}` addresses exactly
    // one resource, so its 404 is already unambiguous.
    if (row === null || !visible(row, auth)) {
      throw new OmniError("worker_not_found", `no run ${id}`);
    }
    return row;
  };

  const subscribed = (target: WebhookTarget | null, event: WebhookEvent): boolean =>
    target !== null && o.dispatcher !== null && (target.events ?? DEFAULT_EVENTS).includes(event);

  /**
   * The ONE place a run changes state: append the `omni.run` envelope, then persist the row and
   * enqueue its deliveries in a single transaction.
   *
   * Order matters twice. The envelope goes FIRST so the thin payload's `seq` names an envelope
   * that exists — a delivery pointing at a seq a receiver cannot fetch is a delivery that teaches
   * the receiver to stop trusting the field. The put and the enqueue go together because §24.4
   * rule 1 says so: a run that reached a terminal state with no delivery row is a webhook that
   * will never be sent and never be retried.
   */
  const transition = (
    row: RunRowV2,
    next: RunState,
    reason: string,
    extra: {
      error?: OmniErrorBody | null;
      result?: TurnResult | null;
      workerId?: WorkerId | null;
      turnId?: TurnId | null;
      log?: EventLog | null;
      events?: readonly WebhookEvent[];
    } = {},
  ): RunRowV2 => {
    const previous = row.snapshot.state;
    const log = extra.log ?? null;
    // The envelope FIRST, so the row can record where it landed and a delivery can point at
    // something a receiver is able to fetch. A log-less transition keeps the previous anchor:
    // the run's last real position is a better answer than a fabricated one, and
    // `seq-single-writer` (§8.2) allows no other kind.
    const appended =
      log === null
        ? null
        : log.append({
            kind: "omni.run",
            payloadVersion: 2,
            payload: {
              runId: row.snapshot.runId,
              state: next,
              previous,
              reason,
              ...(extra.error === undefined || extra.error === null ? {} : { error: extra.error }),
            },
          });

    const updated: RunRowV2 = {
      ...row,
      ...(appended === null ? {} : { seq: appended.seq }),
      updatedAtMs: o.clock.now(),
      snapshot: {
        ...row.snapshot,
        state: next,
        updatedAt: o.clock.iso(),
        ...(extra.workerId === undefined ? {} : { workerId: extra.workerId }),
        ...(extra.turnId === undefined ? {} : { turnId: extra.turnId }),
        ...(extra.error === undefined ? {} : { error: extra.error }),
        ...(extra.result === undefined ? {} : { result: extra.result }),
      },
    };

    const settled = commit(updated, extra.events ?? []);

    if (TERMINAL.has(next)) {
      live.delete(settled.snapshot.runId);
      deadlines.get(settled.snapshot.runId)?.cancel();
      deadlines.delete(settled.snapshot.runId);
    }
    return settled;
  };

  /**
   * Persist the row and enqueue its deliveries, atomically, bumping the delivery count by exactly
   * the number of deliveries this commit creates.
   *
   * The count lives on the row rather than being derived from the delivery table, because
   * `RunSnapshot.webhook.deliveries` is read on the hot `GET /v1/runs/{rid}` path and a count(*)
   * over a growing dead-letter table is the wrong shape of query for it.
   */
  const commit = (row: RunRowV2, events: readonly WebhookEvent[]): RunRowV2 => {
    const target = row.webhook;
    const wanted = target === null ? [] : events.filter((e) => subscribed(target, e));
    const counted: RunRowV2 =
      wanted.length === 0 || target === null
        ? row
        : {
            ...row,
            snapshot: {
              ...row.snapshot,
              webhook: {
                url: target.url,
                deliveries: (row.snapshot.webhook?.deliveries ?? 0) + wanted.length,
              },
            },
          };

    return atomically(() => {
      o.store.put(counted);
      if (target !== null) for (const event of wanted) fire(counted, target, event);
      return counted;
    });
  };

  const fire = (row: RunRowV2, target: WebhookTarget, event: WebhookEvent): void => {
    const workerId = row.snapshot.workerId;
    // The thin payload is ADDRESSABLE by construction (ruling M2-R13): `workerId` says WHERE to
    // pull from and `seq` says FROM WHEN. A run with neither — one whose worker failed to start,
    // so nothing was ever appended for it — has nothing a receiver could fetch, and that failure
    // is already the caller's synchronous error rather than a delivery.
    if (workerId === null || row.seq === undefined || o.dispatcher === null) return;
    o.dispatcher.dispatch(
      {
        event,
        daemonId: o.daemonId,
        workerId,
        runId: row.snapshot.runId,
        sessionId: null,
        // An explicit READ of a seq `EventLog.append()` assigned, copied off the row that
        // recorded it — never a shorthand and never a computed value (`seq-single-writer`, §8.2).
        seq: row.seq,
        ts: o.clock.iso(),
      },
      target,
      row.tokenId,
    );
  };

  /**
   * A webhook target, validated where the operator can act on it (§24.6).
   *
   * Every refusal here is a `403` or `400` on `POST /v1/runs`, which is the whole point: a
   * misconfigured run must not become a background delivery that fails six times and goes quiet.
   */
  const checkWebhook = async (
    target: WebhookTarget | undefined,
    tokenId: TokenId,
  ): Promise<void> => {
    if (target === undefined) return;
    if (!o.webhooks.enabled || o.dispatcher === null) {
      throw new OmniError("forbidden", "webhooks are not enabled on this daemon");
    }
    await assertWebhookUrl(target.url, o.webhooks, o.resolve);

    if (target.secret !== undefined && o.webhooks.secrets[target.secret] === undefined) {
      throw new OmniError(
        "bad_request",
        `webhook secret "${target.secret}" is not named in webhooks.secrets`,
      );
    }
    // FAIL CLOSED on the signature. An unsigned delivery looks exactly like a signed one to a
    // receiver that forgot to check, so a run that could never be signed is refused rather than
    // quietly downgraded.
    const named = target.secret === undefined ? undefined : o.webhooks.secrets[target.secret];
    if (named === undefined && o.tokenSecrets[tokenId] === undefined) {
      throw new OmniError(
        "bad_request",
        "this token has no webhookSecret and the request named none, so the delivery could " +
          "not be signed",
      );
    }
  };

  /** The `CreateWorkerRequest` a run implies. Every field a run may set, and not one more. */
  const workerRequestOf = (req: CreateRunRequest): CreateWorkerRequest =>
    ({
      agent: req.agent,
      cwd: req.cwd,
      ...(req.label === undefined ? {} : { label: req.label }),
      ...(req.mcp === undefined ? {} : { mcp: req.mcp }),
      ...(req.policy === undefined ? {} : { policy: req.policy }),
      ...(req.env === undefined ? {} : { env: req.env }),
      ...(req.onUnresolved === undefined ? {} : { onUnresolved: req.onUnresolved }),
      ...(req.parkTimeoutMs === undefined ? {} : { parkTimeoutMs: req.parkTimeoutMs }),
      ...(req.parkTimeoutAction === undefined ? {} : { parkTimeoutAction: req.parkTimeoutAction }),
      ...(req.watchdog === undefined ? {} : { watchdog: req.watchdog }),
      ...(req.patch === undefined ? {} : { patch: req.patch }),
      ...(req.timeoutMs === undefined ? {} : { timeoutMs: req.timeoutMs }),
    }) as unknown as CreateWorkerRequest;

  // `OmniError.from` is total and never throws, so a run's `error` field is always the same shape
  // an HTTP caller would have seen for the same failure (§9's one mapper, reused).
  const errorBody = (e: unknown): OmniErrorBody => OmniError.from(e).toBody();

  /**
   * Every envelope of this turn, from `accepted.seq - 1` (M1's race-free lower bound) to the
   * turn's terminal envelope.
   *
   * `subscribe` replays and attaches in ONE synchronous critical section, so nothing can slip
   * between the replay and the live tail — the same guarantee `worker.events()` is built on,
   * reused here rather than re-derived.
   */
  const collect = (log: EventLog, seq: Seq, turnId: TurnId): Promise<EventEnvelope[]> =>
    new Promise<EventEnvelope[]>((resolve) => {
      const buffer: EventEnvelope[] = [];
      let done = false;
      const sub = log.subscribe(Math.max(0, seq - 1) as Seq, (e) => {
        if (done) return;
        buffer.push(e);
        if (!isTurnTerminal(turnId, e)) return;
        done = true;
        // Deferred, because `subscribe` replays synchronously: on the replay path `sub` is not
        // yet assigned when this listener first runs, and closing a subscription from inside its
        // own critical section is not something the log promises to survive.
        queueMicrotask(() => {
          sub.close();
          resolve(buffer);
        });
      });
    });

  /**
   * The background half: prompt, settle, fold, close, fire.
   *
   * It NEVER throws into a caller — there is no caller. Every failure becomes a `failed` run with
   * an `OmniErrorBody`, because the only thing worse than a run that failed is a run that stays
   * `running` forever because the code meant to converge it threw.
   */
  const drive = async (
    runId: RunId,
    handle: WorkerHandle,
    req: CreateRunRequest,
    auth: AuthContext,
  ): Promise<void> => {
    const who = auth.asClientRef();
    const log = handle.log;

    // `requires_action` is reported from the WORKER's own state change rather than inferred from
    // the stream: the worker is the authority on whether it is parked, and re-deriving it here
    // would give a run and its worker two answers to one question.
    const unwatch = handle.onStateChange((state) => {
      const row = o.store.get(runId);
      if (row === null || TERMINAL.has(row.snapshot.state)) return;
      if (state === "requires_action" && row.snapshot.state !== "requires_action") {
        transition(row, "requires_action", "interaction_parked", {
          log,
          // Both names, and each only if the target asked for it. The worker-scoped one carries
          // no request content: thinness is a security property here, not only bandwidth (§24.3).
          events: ["run.requires_action", "worker.requires_action"],
        });
      } else if (state === "running" && row.snapshot.state === "requires_action") {
        transition(row, "running", "interaction_resolved", { log });
      }
    });

    try {
      const accepted = await handle.prompt(req.prompt, who);
      const started = o.store.get(runId);
      if (started === null) return;
      transition(started, "running", "prompt accepted", { log, turnId: accepted.turnId });

      const envelopes = await collect(log, accepted.seq, accepted.turnId);
      const result = reduceTurn(accepted.turnId, envelopes);

      const row = o.store.get(runId);
      if (row === null) return;
      // A run cancelled while its turn was settling stays cancelled: the terminal state belongs
      // to whoever got there first, and re-terminalizing would fire a second terminal webhook.
      if (TERMINAL.has(row.snapshot.state)) return;

      const failed = result.verdict === "failed";
      transition(row, failed ? "failed" : "succeeded", `turn ${result.verdict}`, {
        log,
        result,
        error: result.error,
        events: [failed ? "run.failed" : "run.completed"],
      });
    } catch (e) {
      o.logger.warn("run failed", { runId, error: e instanceof Error ? e.message : String(e) });
      try {
        const row = o.store.get(runId);
        if (row !== null && !TERMINAL.has(row.snapshot.state)) {
          transition(row, "failed", "the run's turn could not be completed", {
            log,
            error: errorBody(e),
            events: ["run.failed"],
          });
        }
      } catch (inner) {
        // The compensating transition failed too — which means the STORE is the problem, not the
        // turn. Recording that and moving on is the only honest option: throwing here would
        // reject the un-awaited `drive` promise, and the run is left in a live state for the next
        // boot's `recover()` to abandon, which is exactly what that pass is for (§24.4 rule 4).
        o.logger.error("a run could not be marked failed", {
          runId,
          error: inner instanceof Error ? inner.message : String(inner),
        });
      }
    } finally {
      unwatch();
      await closeIfAsked(runId, handle, req);
    }
  };

  const closeIfAsked = async (
    runId: RunId,
    handle: WorkerHandle,
    req: CreateRunRequest,
  ): Promise<void> => {
    if (req.keepWorker === true) return;
    try {
      // Fired BEFORE the close, so the delivery's `seq` still names a log an operator can read.
      const row = o.store.get(runId);
      if (row !== null) commit(row, ["worker.closed"]);
      await handle.close("client_request");
    } catch (e) {
      o.logger.warn("closing a run's worker failed", {
        runId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  };

  /** `run.maxDurationMs`: a hard ceiling on one run, independent of the watchdog. */
  const armDeadline = (runId: RunId, handle: WorkerHandle, auth: AuthContext): void => {
    if (o.config.maxDurationMs <= 0) return;
    deadlines.set(
      runId,
      o.clock.setTimer(o.config.maxDurationMs, () => {
        deadlines.delete(runId);
        const row = o.store.get(runId);
        if (row === null || TERMINAL.has(row.snapshot.state)) return;
        transition(row, "failed", "run.maxDurationMs elapsed", {
          log: handle.log,
          error: {
            code: "agent_timeout",
            message: `the run exceeded run.maxDurationMs=${String(o.config.maxDurationMs)}`,
          },
          events: ["run.failed"],
        });
        void handle.cancel(auth.asClientRef()).catch(() => {});
      }),
    );
  };

  return {
    async create(req: CreateRunRequest, auth: AuthContext): Promise<RunSnapshot> {
      await checkWebhook(req.webhook, auth.tokenId);

      // Idempotency BEFORE anything is spent: a retry after a client timeout must not start a
      // second agent process, and it must return the ORIGINAL run rather than a copy of it.
      if (req.idempotencyKey !== undefined) {
        const existing = o.store.byIdempotencyKey(auth.tokenId, req.idempotencyKey);
        if (existing !== null) return existing.snapshot;
      }

      if (live.size >= o.config.maxConcurrent) {
        throw new OmniError(
          "worker_limit",
          `run.maxConcurrent=${String(o.config.maxConcurrent)} runs are already in flight`,
        );
      }

      const runId = o.ids.run();
      const createdAt = o.clock.iso();
      const seeded: RunRowV2 = {
        snapshot: {
          runId,
          daemonId: o.daemonId,
          state: "queued",
          agentId: req.agent,
          cwd: req.cwd,
          workerId: null,
          turnId: null,
          createdAt,
          updatedAt: createdAt,
          result: null,
          error: null,
          persistence: o.persistence,
          webhook: req.webhook === undefined ? null : { url: req.webhook.url, deliveries: 0 },
        },
        tokenId: auth.tokenId,
        bootId: o.bootId,
        idempotencyKey: req.idempotencyKey ?? null,
        webhook: req.webhook ?? null,
        createdAtMs: o.clock.now(),
        updatedAtMs: o.clock.now(),
      };
      // Written BEFORE the worker exists, which is what makes the unique index on
      // `(token_id, idempotency_key)` do its job: a second concurrent request with the same key
      // collides here rather than after both have spawned an agent.
      o.store.put(seeded);
      live.add(runId);

      let handle: WorkerHandle;
      try {
        handle = await o.workers.create(workerRequestOf(req), auth);
      } catch (e) {
        // The run is `failed` and the caller still gets the real error. There is no worker and
        // therefore no log, which is why this is the one transition with no `omni.run` envelope
        // and no delivery: the thin payload has no address to carry.
        transition(seeded, "failed", "the run's worker could not be created", {
          error: errorBody(e),
        });
        throw e;
      }

      const started = transition(seeded, "starting", "worker created", {
        workerId: handle.id,
        log: handle.log,
      });
      armDeadline(runId, handle, auth);

      // NOT awaited. The turn, the fold, the close and the delivery all happen after this
      // function has returned — the structural half of "a slow receiver never blocks a turn".
      // `.catch` because an un-awaited rejection is a crash in some hosts and a silence in
      // others, and neither is a way to learn that a run stopped converging.
      void drive(runId, handle, req, auth).catch((e: unknown) => {
        o.logger.error("a run's driver threw outside its own error handling", {
          runId,
          error: e instanceof Error ? e.message : String(e),
        });
      });

      return started.snapshot;
    },

    get(id: RunId, auth: AuthContext): RunSnapshot {
      return rowOf(id, auth).snapshot;
    },

    list(auth: AuthContext, opts?: { limit?: number; cursor?: string }): readonly RunSnapshot[] {
      const page = o.store.list({
        // D13, unchanged for runs: admin sees all, everybody else sees their own token's.
        ...(auth.role === "admin" ? {} : { tokenId: auth.tokenId }),
        limit: opts?.limit ?? 50,
        ...(opts?.cursor === undefined ? {} : { cursor: opts.cursor }),
      });
      return page.rows.map((r) => r.snapshot);
    },

    async cancel(id: RunId, auth: AuthContext): Promise<RunSnapshot> {
      const row = rowOf(id, auth);
      if (TERMINAL.has(row.snapshot.state)) return row.snapshot;

      const workerId = row.snapshot.workerId;
      // Idempotent, and a no-op when the worker is not running — exactly as H9 is.
      if (workerId !== null) await o.workers.cancel(workerId, auth);

      const current = o.store.get(id) ?? row;
      if (TERMINAL.has(current.snapshot.state)) return current.snapshot;
      return transition(current, "cancelled", "cancelled by a client", {
        log: workerId === null ? null : safeLog(workerId, auth),
        events: ["run.failed"],
      }).snapshot;
    },

    logFor(id: RunId, auth: AuthContext): EventLog {
      const row = rowOf(id, auth);
      const workerId = row.snapshot.workerId;
      // A run with no worker has no stream to proxy, and an empty log would claim the run
      // produced nothing — a different and wronger statement than "there is nothing here yet".
      if (workerId === null) throw new OmniError("worker_not_found", `run ${id} has no worker yet`);
      return o.workers.logFor(workerId, auth);
    },

    recover(): { abandoned: number } {
      const result = recoverRuns(o.store, o.bootId, o.clock.now(), {
        ...(o.transaction === undefined ? {} : { transaction: o.transaction }),
        enqueue: (abandoned) => {
          if (!subscribed(abandoned.webhook, "run.failed")) return;
          const target = abandoned.webhook;
          if (target !== null) fire(abandoned, target, "run.failed");
        },
      });
      if (result.abandoned > 0) {
        o.logger.info("abandoned runs from a previous boot", { runs: result.abandoned });
      }
      return result;
    },
  };

  /** A log for a worker that may already be gone — a cancel must not 404 on its own bookkeeping. */
  function safeLog(workerId: WorkerId, auth: AuthContext): EventLog | null {
    try {
      return o.workers.logFor(workerId, auth);
    } catch {
      return null;
    }
  }
}
