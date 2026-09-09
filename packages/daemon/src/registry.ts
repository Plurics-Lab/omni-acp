import {
  CreateWorkerRequest,
  InteractionAnswerBody,
  LeaseRequestBody,
  OmniError,
  PromptRequestBody,
  SetConfigBody,
  assertInteractionId,
  type Clock,
  type ClientRef,
  type CloseResult,
  type DaemonId,
  type EventLog,
  type HibernateTimer,
  type IdGen,
  type InteractionAnswerResult,
  type InteractionListResponse,
  type Lease,
  type LeaseSnapshot,
  type Logger,
  type OrphanRecord,
  type PermissionResponder,
  type PersistenceHandle,
  type PromptAccepted,
  type ResolvedDaemonConfig,
  type Seq,
  type SessionStrategy,
  type SetConfigResponse,
  type Subscription,
  type Supervisor,
  type TokenId,
  type TurnId,
  type TurnStatus,
  type WorkerCloseReason,
  type WorkerHandle,
  type WorkerId,
  type WorkerRow,
  type WorkerSnapshot,
  type WorkerState,
} from "@omni-acp/protocol";
import {
  alwaysGrantedLease,
  createHibernateTimer,
  createMemoryEventLog,
  createNormalizer,
  createPersistedEventLog,
  createRehydratedWorker,
  createWorker,
} from "@omni-acp/core";
import { recoverFromPreviousBoot, type BootRecoveryResult } from "./boot-recovery.js";
import type { AuthContext, Catalog, WorkerRegistry } from "./types.js";

export interface WorkerRegistryOptions {
  readonly daemonId: DaemonId;
  readonly config: ResolvedDaemonConfig;
  readonly catalog: Catalog;
  readonly supervisor: Supervisor;
  readonly responder: PermissionResponder;
  readonly clock: Clock;
  readonly ids: IdGen;
  readonly logger: Logger;
  /** Every appended envelope, for `daemon.on("worker.event" | "worker.state")`. */
  readonly onEnvelope?: (workerId: string, envelope: unknown) => void;
  /**
   * SEAM 3 (M1-PLAN §1.2, review R14). D5 enforcement is a change to the FACTORY this registry
   * passes in, and to nothing else: `Worker.prompt()` / `cancel()` / `wake()` already call
   * `lease.assertHolder(who)` as their first statement, and `delete()` below does too.
   *
   * Absent ⇒ `alwaysGrantedLease`, which is M0's behaviour exactly: one in-process controller by
   * construction. `create-daemon.ts` defaults it to M1-WP-D's `createLease`.
   *
   * The third parameter is the worker's own event log, and it is why this declaration is WIDER
   * than `DaemonDeps.leaseFactory` (which is frozen at two). §16.1 rule L9 says every lease
   * transition appends `omni.lease` TO THE WORKER'S LOG, and `LeaseOptions.onEvent` is the sink
   * that does it — so a factory that is never handed the log can only build a lease whose audit
   * trail goes nowhere. The log is in scope at both call sites below, and a two-parameter
   * function stays assignable to this type, so an injected `DaemonDeps.leaseFactory` written
   * against the frozen shape keeps working and simply ignores the argument.
   */
  readonly leaseFactory?: (
    owner: ClientRef | null,
    workerId: WorkerId,
    log: EventLog,
    initialEpoch?: number,
  ) => Lease;
  /**
   * The durable half (§14). Absent or `null` ⇒ memory only, which is `createDaemon()`'s default
   * (ruling M1-R17) and M0's behaviour exactly: no store to read, so `list()` is the live map,
   * `get()` cannot rehydrate, and `adopt()` has nothing to adopt.
   */
  readonly persistence?: PersistenceHandle | null;
  /**
   * SEAM 2 (M1-PLAN §1.2): the strategy `Worker` calls instead of naming `initialize` /
   * `session/new` itself. Absent ⇒ `worker.ts`'s inline M0 handshake, so the M0 suite runs
   * untouched.
   */
  readonly session?: SessionStrategy;
  /**
   * Boot adoption's FULL result, handed back when `adopt()` runs.
   *
   * `WorkerRegistry.adopt()` is frozen at `{hibernated, closed, orphans}` while
   * `GET /v1/info.orphansAtStart` needs `{found, reaped, skipped}` — the same pass, two audiences.
   * A callback is how `createDaemon` reads the second half without a second adoption run, and
   * without widening a frozen contract type.
   */
  readonly onBootAdoption?: (r: BootRecoveryResult) => void;
}

interface Entry {
  readonly id: WorkerId;
  readonly handle: WorkerHandle;
  readonly ownerTokenId: TokenId;
  /** The fan-out subscription that feeds `daemon.on(...)`; closed with the worker. */
  subscription: Subscription | null;
  /** The FIRST close, shared by every later caller — this is what makes DELETE idempotent. */
  closing: Promise<CloseResult> | null;
  /** Whether this worker still occupies a `maxWorkers` slot. */
  live: boolean;
  /** The agent id this worker was created for, for the persisted row (`WorkerRow.agentId`). */
  readonly agentId: string;
  /** Unsubscribes the row-persisting state listener; run once, when the entry is dropped. */
  offStateChange: (() => void) | null;
  /**
   * This worker's idle budget in ms, or `null` when hibernation is off for it.
   *
   * `CreateWorkerRequest.idleTimeoutMs` overrides `hibernate.idleMs` per worker, and `0` in
   * either place means "never hibernate this worker" — which has to survive as `null` rather
   * than as a zero-millisecond timer that fires immediately (`WorkerRow.hibernateIdleMs`).
   */
  readonly hibernateIdleMs: number | null;
  /** §15.2's `ready -> hibernated` driver. Armed by `watchEntry`, cancelled with the worker. */
  idleTimer: HibernateTimer | null;
}

/** The states that occupy a `maxWorkers` slot: a worker with a process, or on its way to one. */
const OCCUPIES_A_SLOT: readonly WorkerState[] = ["starting", "ready", "running", "requires_action"];

/**
 * One worker's idle budget: the request's override, else the daemon-wide setting.
 *
 * `0` in either place is "hibernation is off", and it must come back as `null` — a
 * zero-millisecond timer fires immediately, which would hibernate every worker the instant it
 * became ready (`HibernateConfig.idleMs`, `CreateWorkerRequest.idleTimeoutMs`).
 */
function idleBudgetOf(requested: number | undefined, daemonWide: number): number | null {
  const ms = requested ?? daemonWide;
  return ms > 0 ? ms : null;
}

/** How long `closeAll` waits for the whole fleet before returning anyway (best effort). */
const DEFAULT_CLOSE_ALL_MS = 30_000;

/**
 * A zod failure, as an `OmniError` an in-process caller can catch (D15's library path has no
 * HTTP mapper in front of it). The wire path formats the same failure in `http/errors.ts`; both
 * produce `bad_request`, which is the part §9 fixes.
 */
function badRequest(e: unknown, what: string): OmniError {
  const issues = (e as { issues?: { path?: PropertyKey[]; message?: string }[] } | null)?.issues;
  const first = Array.isArray(issues) ? issues[0] : undefined;
  if (first === undefined) return OmniError.from(e, "bad_request");
  const where = (first.path ?? []).join(".");
  return new OmniError(
    "bad_request",
    `${what}${where === "" ? "" : ` (${where})`}: ${first.message ?? "invalid"}`,
    { cause: e },
  );
}

/**
 * Create / get / list / delete, plus the two counters that make this daemon safe to expose:
 * per-token and global `maxWorkers`, decremented on EVERY close including a crash-close.
 *
 * `get()` throws `worker_not_found` both when the worker is absent and when it is invisible to
 * this token (D13) — a `403` would leak that the id exists.
 *
 * `snapshot` / `prompt` / `cancel` / `turn` / `logFor` are the result-returning façade (review
 * R11): each is `get(id, auth)` plus one call on the handle, and they exist so that an HTTP
 * route is one daemon call rather than a get-then-act orchestration in the adapter — the one
 * place D15 constraint 1 otherwise leaks. In-process callers keep using `get()`.
 */
export function createWorkerRegistry(o: WorkerRegistryOptions): WorkerRegistry {
  const entries = new Map<WorkerId, Entry>();
  const perToken = new Map<TokenId, number>();
  let liveTotal = 0;

  const notFound = (id: WorkerId): never => {
    // The SAME error whether the worker is absent or merely invisible: a 403 here would confirm
    // that the id exists, which is exactly what D13 forbids.
    throw new OmniError("worker_not_found", `worker ${id} not found`);
  };

  /**
   * Check-and-reserve, in ONE synchronous block. Nothing may `await` between the comparison and
   * the increment, or fifty concurrent creates all read the same "one slot left" and spawn fifty
   * agents (H14).
   */
  const reserve = (auth: AuthContext): void => {
    if (liveTotal >= o.config.maxWorkers) {
      throw new OmniError(
        "worker_limit",
        `daemon worker limit reached (${o.config.maxWorkers} live workers)`,
      );
    }
    const mine = perToken.get(auth.tokenId) ?? 0;
    if (mine >= auth.maxWorkers) {
      throw new OmniError(
        "worker_limit",
        `token worker limit reached (${auth.maxWorkers} live workers)`,
      );
    }
    liveTotal += 1;
    perToken.set(auth.tokenId, mine + 1);
  };

  const release = (tokenId: TokenId, entry: Entry | null): void => {
    if (entry !== null) {
      if (!entry.live) return;
      entry.live = false;
    }
    liveTotal = Math.max(0, liveTotal - 1);
    const mine = perToken.get(tokenId) ?? 0;
    if (mine <= 1) perToken.delete(tokenId);
    else perToken.set(tokenId, mine - 1);
  };

  /**
   * Retake a slot a hibernation gave back, WITHOUT re-running the limit check.
   *
   * The check belongs to `wake()`, which must be able to answer `429` before a 7-second `npx`
   * cold start rather than after it. By the time the state actually flips to `starting` the
   * decision is made, and re-checking here would be a second verdict on the same question — the
   * one that fires half-way through a wake and leaves the counters disagreeing with the states.
   */
  const reacquire = (entry: Entry): void => {
    if (entry.live) return;
    entry.live = true;
    liveTotal += 1;
    perToken.set(entry.ownerTokenId, (perToken.get(entry.ownerTokenId) ?? 0) + 1);
  };

  /**
   * Check-and-reserve for a WAKE, in one synchronous block for `reserve()`'s reason: nothing may
   * `await` between the comparison and the increment, or N concurrent wakes all read the same
   * "one slot left" (H14). `Worker.wake()` is single-flight, so this runs once per genuine wake.
   *
   * The per-token quota is charged to the worker's OWNER, not to the caller — a worker belongs
   * to the token that created it, and an admin waking somebody else's worker must not spend
   * their own quota on it or hand the owner an uncounted slot. The owner's `maxWorkers` is not
   * knowable from another token's `AuthContext`, so their quota is only CHECKED when they are
   * the one asking; an admin's wake is bounded by the daemon-wide limit, which is the honest
   * reading of "admin sees and does all" (D13).
   */
  const reserveForWake = (entry: Entry, auth: AuthContext): void => {
    if (entry.live) return;
    if (liveTotal >= o.config.maxWorkers) {
      throw new OmniError(
        "worker_limit",
        `daemon worker limit reached (${o.config.maxWorkers} live workers)`,
      );
    }
    const mine = perToken.get(entry.ownerTokenId) ?? 0;
    if (auth.tokenId === entry.ownerTokenId && mine >= auth.maxWorkers) {
      throw new OmniError(
        "worker_limit",
        `token worker limit reached (${auth.maxWorkers} live workers)`,
      );
    }
    entry.live = true;
    liveTotal += 1;
    perToken.set(entry.ownerTokenId, mine + 1);
  };

  // ── the durable half (§14.8) ──────────────────────────────────────────────

  const store = o.persistence;

  /** This daemon's idle budget for one worker; see `idleBudgetOf`. */
  const idleBudget = (requested: number | undefined): number | null =>
    idleBudgetOf(requested, o.config.hibernate.idleMs);

  /**
   * `WorkerRow` for a live handle. The snapshot is the client-facing half; the rest is what a
   * snapshot does not carry because it is not client-facing (§5.1 `WorkerRow`).
   */
  const rowOf = (entry: Entry, previous?: WorkerRow | null): WorkerRow => {
    const snapshot = entry.handle.snapshot();
    const closeResult = previous?.closeResult ?? null;
    return {
      snapshot,
      agentId: entry.agentId,
      bootId: store?.bootId ?? "",
      closeResult,
      lastActiveMs: o.clock.now(),
      closedAtMs: snapshot.state === "closed" ? (previous?.closedAtMs ?? o.clock.now()) : null,
      // `0` disables hibernation daemon-wide, and it must survive as `null` rather than as a
      // zero-millisecond idle timer that fires immediately on the next boot. The ENTRY's budget
      // wins over the persisted one: `CreateWorkerRequest.idleTimeoutMs` is a per-worker
      // override, and a row written before it was read would pin the daemon-wide value forever.
      hibernateIdleMs: entry.hibernateIdleMs ?? previous?.hibernateIdleMs ?? null,
    };
  };

  /**
   * Write the row through, if there is anywhere to write it.
   *
   * NEVER throws: a durable write that fails must not fail the operation that triggered it.
   * §14.3's rule is that the log stays correct in RAM and the failure is REPORTED
   * (`WorkerSnapshot.persistence: "degraded"`, `GET /v1/info.persistence.writeFailures`) rather
   * than turning a working daemon into a broken one.
   */
  const persistRow = (entry: Entry): void => {
    if (store === null || store === undefined) return;
    try {
      const previous = store.workers.get(entry.id);
      store.workers.upsert(rowOf(entry, previous));
    } catch (e) {
      o.logger.warn("persisting a worker row failed", { workerId: entry.id, error: String(e) });
    }
  };

  /**
   * The final row, carrying the `CloseResult` §15.6 level 3 replays byte-for-byte.
   *
   * Recomputing it after a restart would report `treeGone: true` for a tree we never proved gone,
   * which is exactly the optimism §6.6 forbids — so the ONE authoritative result, the one the
   * worker actually produced, is what goes to disk.
   */
  const persistClose = (entry: Entry): void => {
    if (store === null || store === undefined) return;
    void entry.handle.closed.then(
      (closeResult) => {
        try {
          const previous = store.workers.get(entry.id);
          store.workers.upsert({ ...rowOf(entry, previous), closeResult });
        } catch (e) {
          o.logger.warn("persisting a close result failed", {
            workerId: entry.id,
            error: String(e),
          });
        }
      },
      () => {
        // `closed` is documented never to reject; if one ever does, the row from the state
        // listener still stands and DELETE falls back to the pessimistic body.
      },
    );
  };

  /**
   * The event log for one worker: memory, or write-through behind the same ring (ruling M1-R1).
   *
   * `startSeq` seeds `head` on a REHYDRATED worker so `seq` never restarts at 1 after a restart
   * (§14.4, ruling M1-R2) — the bug that quietly forks one worker's history into two.
   */
  const logFor = (workerId: WorkerId, startSeq?: Seq): EventLog => {
    const base = {
      workerId,
      daemonId: o.daemonId,
      clock: o.clock,
      maxEvents: o.config.eventLog.maxEventsPerWorker,
      subscriberQueueSize: o.config.eventLog.subscriberQueueSize,
    };
    if (store === null || store === undefined) return createMemoryEventLog(base);
    return createPersistedEventLog({
      ...base,
      queueSize: o.config.eventLog.subscriberQueueSize,
      store: store.events,
      config: o.config.eventLog,
      logger: o.logger.child({ workerId }),
      ...(startSeq === undefined ? {} : { startSeq }),
    });
  };

  /**
   * §14.8: a handle for a worker THIS PROCESS never created, built lazily and memoised.
   *
   * Lazily, because reconstructing every row at startup would make a daemon with 10 000 retained
   * workers take minutes to bind a port, and 99 % of them are closed and will never be asked for.
   * Memoised, because a second construction would give one worker two handles, two logs and two
   * `close()` promises — and the second `close()` is where "DELETE after a restart returns a
   * different body" lives.
   */
  const rehydrate = (row: WorkerRow): Entry | null => {
    if (store === null || store === undefined) return null;
    const workerId = row.snapshot.workerId;
    const existing = entries.get(workerId);
    if (existing !== undefined) return existing;

    const log = logFor(workerId, store.events.headOf(workerId));
    const owner: ClientRef = { tokenId: row.snapshot.ownerTokenId, clientId: null };
    let handle: WorkerHandle;
    try {
      // From the CURRENT config, never from the row (M1-WP-C's `RehydrateDeps` header): a
      // `cwdRoots`, timeout or quirk-table change between boots must take effect on the worker
      // this boot wakes. `catalog.get` THROWS for an agent the operator has since removed, which
      // the catch below turns into "no handle" rather than a 500 — the same answer the row gets
      // when its log belongs to somebody else.
      const descriptor = o.catalog.get(row.agentId);
      const runtime = o.catalog.descriptor(row.agentId);
      const runtimeId = o.catalog.list().find((e) => e.id === row.agentId)?.runtimeId;
      handle = createRehydratedWorker(row, log, {
        descriptor,
        supervisor: o.supervisor,
        // `session` is required by `RehydrateDeps`; without an injected strategy the rehydrated
        // worker uses the same inline handshake `worker.ts` falls back to, and M1-WP-C's
        // `createRehydratedWorker` is the one that knows how to say that.
        session: o.session as SessionStrategy,
        // Unheld, per ruling M1-R8 — but resuming the row's EPOCH, so rule L7's counter stays
        // monotonic across the restart. See `leaseFor`.
        lease: leaseFor(null, workerId, log, row.snapshot.lease.epoch),
        clock: o.clock,
        ids: o.ids,
        logger: o.logger.child({ workerId, agent: row.agentId, rehydrated: true }),
        // The same four `create()` builds, for the same reasons: a woken worker maps its updates
        // through the resolved descriptor, answers permissions through the daemon's one wired
        // responder, and takes its budgets from this boot's config.
        normalizer: createNormalizer({
          quietMs: o.config.turn.quietMs,
          hardMs: o.config.turn.hardMs,
          drainGraceMs: o.config.turn.drainGraceMs,
          cancelGraceMs: o.config.turn.cancelGraceMs,
          descriptor: runtime,
          ids: { synth: (prefix: string) => `${prefix}_${o.ids.request()}` },
          // The row's `capabilities` are the PERSISTED ones until this worker wakes and
          // handshakes again, at which point the handle carries the fresh catalogue. Reading
          // through the entry each time is what makes both true without a second thunk.
          modes: () => entries.get(workerId)?.handle.snapshot().capabilities?.modes ?? null,
          cwd: row.snapshot.cwd,
        }),
        responder: o.responder,
        limits: {
          handshakeTimeoutMs: o.config.handshakeTimeoutMs,
          cancelGraceMs: o.config.turn.cancelGraceMs,
          exitGraceMs: o.config.supervisor.exitGraceMs,
          gracefulMs: o.config.supervisor.gracefulMs,
          wakeTimeoutMs: o.config.hibernate.wakeTimeoutMs,
          maxWakeFailures: o.config.hibernate.maxWakeFailures,
        },
        runtime,
        ...(runtimeId === undefined ? {} : { runtimeId }),
        toSpawnSpec: (d, spawnOpts) => o.catalog.toSpawnSpec(d, spawnOpts),
        owner,
      });
    } catch (e) {
      // A row we cannot reconstruct is not a 500 on `GET /v1/workers`: the row is still visible
      // through `list()` (which reads the store directly and needs no handle), and the honest
      // answer to "give me a handle for it" is that we could not build one.
      o.logger.warn("rehydrating a persisted worker failed", { workerId, error: String(e) });
      log.close();
      return null;
    }

    const entry: Entry = {
      id: workerId,
      handle,
      ownerTokenId: row.snapshot.ownerTokenId,
      subscription: subscribeFanOut(workerId, log),
      // A `closed` row pre-resolves its close with the PERSISTED `CloseResult` inside `Worker`
      // (§15.6), so re-using `entry.closing` keeps DELETE byte-for-byte idempotent across a
      // restart without a second implementation.
      closing: null,
      // A rehydrated worker holds a slot only if its state says it has a process. A `hibernated`
      // or `closed` row does not, which is what makes hibernated workers bounded separately (H14).
      live: false,
      agentId: row.agentId,
      offStateChange: null,
      // The budget the row was created with, so a per-worker `idleTimeoutMs` survives a restart.
      // A row from a boot that never recorded one falls back to this boot's daemon-wide value.
      hibernateIdleMs: row.hibernateIdleMs ?? idleBudget(undefined),
      idleTimer: null,
    };
    if (OCCUPIES_A_SLOT.includes(row.snapshot.state)) reacquire(entry);
    entries.set(workerId, entry);
    watchEntry(entry);

    /**
     * The same close bookkeeping `create()` attaches, because a rehydrated worker has no
     * `create()` frame to have attached it in.
     *
     * Without this, closing a worker adopted from a previous boot would leak its `maxWorkers`
     * slot for the life of the daemon, and its fan-out subscription with it. On the PROMISE
     * rather than on the state transition, so the `omni.worker_state{closed}` envelope reaches
     * every subscriber first (§8.4).
     */
    const onClosed = (): void => {
      release(entry.ownerTokenId, entry);
      entry.subscription?.close();
      // The lease owns a TTL expiry timer (`lease.ttlMs`, 15 min by default). Nothing else
      // cancels it once the worker is gone, and a live `setTimeout` keeps an embedded daemon's
      // process alive for the rest of the TTL after `stop()` has returned.
      entry.handle.lease.close();
      persistClose(entry);
    };
    void handle.closed.then(onClosed, onClosed);

    return entry;
  };

  const subscribeFanOut = (workerId: WorkerId, log: EventLog): Subscription | null =>
    o.onEnvelope === undefined
      ? null
      : log.subscribe(0, (envelope) => {
          try {
            o.onEnvelope?.(workerId, envelope);
          } catch (e) {
            o.logger.warn("daemon event listener threw", { workerId, error: String(e) });
          }
        });

  /**
   * Keep the counters and the durable row in step with the worker's own state machine.
   *
   * The registry does not DECIDE any of these transitions — `Worker` does — it only observes
   * them, which is what keeps hibernation's ordering argument (§15.2) inside the one class that
   * can make it.
   */
  /**
   * §15.2's idle timer, armed HERE because this is the only place that knows both the worker's
   * budget and its state transitions.
   *
   * `createHibernateTimer` is M1-WP-C's and is pure over an injected clock; the registry supplies
   * the three things it cannot know — whether this worker's agent advertises a resume spelling
   * (read at FIRE TIME, because the handshake may not have happened when the timer was built),
   * what `hibernate.whenNotResumable` says, and what "hibernate" actually does.
   *
   * The transition itself is `Worker.hibernate()`'s, so every ordering rule in §15.2 stays inside
   * the one class that can make it. A refusal here is not an error: a turn that started between
   * the timer firing and the call landing answers `worker_busy`, and the next `turn_end` re-arms.
   */
  const armIdleTimer = (entry: Entry): void => {
    const idleMs = entry.hibernateIdleMs;
    if (idleMs === null || idleMs <= 0) return;
    const logger = o.logger.child({ workerId: entry.id, component: "hibernate-timer" });
    entry.idleTimer = createHibernateTimer({
      clock: o.clock,
      idleMs,
      logger,
      // Ruling M1-R15's gate. `resume.method === null` is an agent that told us it cannot resume;
      // hibernating it would turn a healthy worker into a guaranteed 422 on a timer.
      resumable: () => entry.handle.snapshot().capabilities?.resume.method !== null,
      whenNotResumable: o.config.hibernate.whenNotResumable,
      onNotResumable: () => {
        void entry.handle.close("idle_timeout").catch((e: unknown) => {
          logger.warn("closing an idle non-resumable worker failed", { error: String(e) });
        });
      },
      onFire: () => {
        // `maxHibernated` is the registry's bound, not the worker's, so it is checked here for
        // the same reason `hibernate(id, auth)` checks it: the transition reclaims a process tree
        // and there is no undo.
        if (countHibernated() >= o.config.hibernate.maxHibernated) {
          logger.info("idle timer fired but the hibernated-worker limit is reached", {
            maxHibernated: o.config.hibernate.maxHibernated,
          });
          return;
        }
        void entry.handle.hibernate("idle_timeout").catch((e: unknown) => {
          // Every refusal edge is legitimate: `worker_busy` (a turn started first),
          // `not_resumable` (the agent advertises no spelling), `worker_closed` (it went away).
          // None of them is worth failing anything over — the next turn boundary re-arms.
          logger.debug("idle hibernation was refused", { error: String(e) });
        });
      },
    });
    entry.idleTimer.touch();
  };

  const watchEntry = (entry: Entry): void => {
    armIdleTimer(entry);
    entry.offStateChange = entry.handle.onStateChange((state) => {
      // The idle countdown NEVER runs across a live turn (§15.2): `pause()` while the worker is
      // busy or asleep, `touch()` on every return to `ready`, `cancel()` once it is gone.
      if (state === "ready") entry.idleTimer?.touch();
      else if (state === "closed") entry.idleTimer?.cancel();
      else entry.idleTimer?.pause();

      if (state === "hibernated") {
        // A hibernated worker owns NO process, so it must not hold a `maxWorkers` slot (H14).
        // It is bounded by `hibernate.maxHibernated` instead, enforced in `wake`/`hibernate`.
        //
        // `closed` is deliberately NOT handled here: the slot comes back on the `handle.closed`
        // PROMISE, which resolves after the `omni.worker_state{closed}` envelope has been
        // appended and fanned out. Releasing on the state transition would be a few
        // microseconds earlier and would tempt a future edit to close the subscription here
        // too — which is exactly how §8.4's closing envelope gets dropped.
        release(entry.ownerTokenId, entry);
      } else if (OCCUPIES_A_SLOT.includes(state)) {
        reacquire(entry);
      }
      persistRow(entry);
    });
  };

  /** Live hibernated workers, plus persisted hibernated rows this process has not rehydrated. */
  const countHibernated = (): number => {
    let count = 0;
    const seen = new Set<WorkerId>();
    for (const entry of entries.values()) {
      seen.add(entry.id);
      if (entry.handle.snapshot().state === "hibernated") count += 1;
    }
    if (store === null || store === undefined) return count;
    try {
      for (const row of store.workers.list()) {
        if (seen.has(row.snapshot.workerId)) continue;
        if (row.snapshot.state === "hibernated") count += 1;
      }
    } catch (e) {
      o.logger.warn("counting hibernated rows failed", { error: String(e) });
    }
    return count;
  };

  /**
   * `get()`, plus §14.8's lazy rehydration.
   *
   * The visibility check runs against the SNAPSHOT in both paths, so a persisted worker is
   * exactly as invisible to a foreign token as a live one — and answers the same
   * `worker_not_found`, never a `403` that would confirm the id exists (D13).
   */
  const get = (id: WorkerId, auth: AuthContext): WorkerHandle => {
    const entry = lookup(id, auth);
    if (entry === null) return notFound(id);
    return entry.handle;
  };

  const lookup = (id: WorkerId, auth: AuthContext): Entry | null => {
    const live = entries.get(id);
    if (live !== undefined) return auth.canSee(live.handle.snapshot()) ? live : null;

    if (store === null || store === undefined) return null;
    let row: WorkerRow | null;
    try {
      row = store.workers.get(id);
    } catch (e) {
      o.logger.warn("reading a persisted worker row failed", { workerId: id, error: String(e) });
      return null;
    }
    if (row === null) return null;
    // The ACL is checked BEFORE anything is constructed: a foreign token must not be able to make
    // this daemon build a handle (and open an event log) for a worker it cannot see.
    if (!auth.canSee(row.snapshot)) return null;
    return rehydrate(row);
  };

  /**
   * H14's second sentence: "A wake also re-runs the full ACL check against the current config —
   * a restart must not resurrect a worker the present ACL forbids (§15.7)."
   *
   * `create()` is not the only door a process comes through. A hibernated worker (or one adopted
   * by boot recovery) is resurrected by `wake` — and by `prompt`, which auto-wakes inside
   * `Worker.prompt` — with the descriptor taken from the CURRENT config but the agent id and cwd
   * taken from the ROW. `lookup()` only answers D13's visibility question ("is this the token's
   * own worker"), which a narrowed allowlist does not change: the operator who removes
   * `claude-acp` from token `t`'s `agents`, or drops `/srv/a` from its `cwdRoots`, and reloads,
   * would otherwise still see `t` spawn that exact agent in that exact directory.
   *
   * `assertCwd` re-`realpath`s, so a cwd that has since been deleted or symlinked out of the
   * roots fails closed too — §15.7's intended answer, and the reason this is not a cached check.
   *
   * It runs BEFORE `reserveForWake`, so a 403 costs neither a slot nor an `npx` cold start.
   */
  const assertMayResume = async (entry: Entry, auth: AuthContext): Promise<void> => {
    auth.assertAgent(entry.agentId);
    await auth.assertCwd(entry.handle.snapshot().cwd);
  };

  const closeEntry = (entry: Entry, reason: WorkerCloseReason): Promise<CloseResult> => {
    entry.closing ??= entry.handle.close(reason);
    return entry.closing;
  };

  /**
   * §15.6 level 3: `DELETE` on a worker that closed in a PREVIOUS boot.
   *
   * The row says `closed`, so there is nothing to close and no process to reclaim — and the
   * persisted `CloseResult` is returned VERBATIM rather than recomputed, because recomputing it
   * would report `treeGone: true` for a tree we never proved gone (§6.6). Returning `null` means
   * "not this case"; the caller falls through to the ordinary path.
   *
   * No handle is constructed at all, which is the point: constructing one to ask it for a body we
   * already have on disk is where the "DELETE after a restart returns a different body" bug
   * comes from.
   */
  const deleteAcrossRestart = (id: WorkerId, auth: AuthContext): CloseResult | null => {
    if (store === null || store === undefined) return null;
    if (entries.has(id)) return null;
    let row: WorkerRow | null;
    try {
      row = store.workers.get(id);
    } catch {
      return null;
    }
    if (row === null || row.snapshot.state !== "closed") return null;
    if (!auth.canSee(row.snapshot)) return notFound(id);
    if (row.closeResult !== null) return row.closeResult;

    // A boot that crashed mid-close left the row `closed` with no result. The fallback is
    // deliberately PESSIMISTIC on both ownership fields: we did not see the tree go, so we do
    // not claim it did.
    return {
      workerId: id,
      state: "closed",
      reason: row.snapshot.closeReason ?? "daemon_shutdown",
      leaderExited: false,
      treeGone: false,
      sessionClosed: false,
    };
  };

  /** Seam 3's one call site. The default IS M0: `alwaysGrantedLease` grants every `assertHolder`. */
  /**
   * `owner === null` means the worker is created lease-FREE, which is two things at once:
   * `CreateWorkerRequest.lease: "observe"`, and — the one that matters here — a worker
   * REHYDRATED from a previous boot.
   *
   * Ruling M1-R8: the lease is not persisted across a restart, because a lease over a process
   * that no longer exists is meaningless. Seeding a rehydrated worker's lease with the row's
   * owner instead would make it `{tokenId, clientId: null}` — the token's DEFAULT client — and
   * every SDK client mints a ULID per `connect()` (§16.1 rule L4), so no client could ever match
   * it: a restarted worker would answer `423` to its own owner forever. Starting unheld lets
   * rule L5's implicit acquire do exactly what it is for.
   *
   * The EPOCH is the half that DOES survive, and it is a fourth argument rather than a revived
   * holder: rule L7 makes the epoch monotonic per worker, and boot adoption has already written
   * `snapshot.lease.epoch + 1` both into the row and into the in-band
   * `omni.lease{op:"expired", how:"daemon_restart"}` envelope a reconnecting client reads at its
   * next `?since=` seq. Restarting the count at 0 would re-issue numbers this worker's own log
   * has already spent — a replay reading 1 → 2 → 1, and an `isStaleEpoch` (exact equality) that
   * accepts a fence minted before the crash.
   */
  const leaseFor = (
    owner: ClientRef | null,
    workerId: WorkerId,
    log: EventLog,
    initialEpoch?: number,
  ): Lease =>
    o.leaseFactory?.(owner, workerId, log, initialEpoch) ??
    alwaysGrantedLease(owner ?? { tokenId: "", clientId: null }, workerId);

  return {
    /** Live workers — the number `maxWorkers` is compared against. A closed worker holds no slot. */
    get size(): number {
      return liveTotal;
    },

    async create(request, auth, signal): Promise<WorkerHandle> {
      let req: CreateWorkerRequest;
      try {
        req = CreateWorkerRequest.parse(request);
      } catch (e) {
        throw badRequest(e, "invalid worker request");
      }

      // ACL before catalog: a token that may not use an agent learns nothing about whether that
      // agent exists on this machine. Both precede the limit check, so a forbidden request is
      // never reported as a quota problem.
      auth.assertAgent(req.agent);
      const descriptor = o.catalog.get(req.agent);
      const cwd = await auth.assertCwd(req.cwd);

      reserve(auth);
      const workerId = o.ids.worker();
      const logger = o.logger.child({ workerId, agent: req.agent });

      const log = logFor(workerId);

      // Subscribed BEFORE the handshake, from seq 0, so `daemon.on(...)` sees a worker's whole
      // life — including the `starting` envelope and a handshake that fails.
      const subscription = subscribeFanOut(workerId, log);

      const spec = o.catalog.toSpawnSpec(descriptor, { cwd });
      // The RESOLVED quirk table (§17.2) and the descriptor identity that goes on every envelope.
      // `runtimeId` is taken from the catalog ENTRY rather than recomputed, so the value in the
      // log is the same string `GET /v1/agents` publishes — two computations of one identity is
      // how a log and a catalog come to disagree about which quirk table ran.
      const runtime = o.catalog.descriptor(req.agent);
      const runtimeId = o.catalog.list().find((e) => e.id === req.agent)?.runtimeId;

      /**
       * The handshake's `modes` catalogue, read LAZILY (M1-WP-B's `NormalizerOptions.modes`).
       *
       * §12.3 row 11 synthesizes the `mode` config option from it, and without it the map emits
       * `options: []` — honest, but empty. The catalogue only exists after `session/new`, which
       * is after the Normalizer is constructed, so the thunk closes over the handle this
       * `createWorker` is about to return. Every `mapUpdate` that could read a non-empty answer
       * runs after that assignment; the replay between a `session/load` request and its response
       * is the one window where it is still null, and `options: []` is the right answer there.
       */
      let built: WorkerHandle | null = null;
      const modesOf = (): Readonly<Record<string, unknown>> | null =>
        built?.snapshot().capabilities?.modes ?? null;

      try {
        const handle = await createWorker(
          {
            workerId,
            daemonId: o.daemonId,
            // The COMPLETE environment, composed by the catalog — the one producer of a
            // `SpawnSpec` (§5.4). It rides on the descriptor because `CreateWorkerDeps` has no
            // `spawnSpec` field; see the note in `docs/M0-PLAN.md` WP-5's hand-off.
            descriptor: { ...descriptor, env: { ...spec.env } },
            cwd,
            label: req.label ?? null,
            owner: auth.asClientRef(),
            supervisor: o.supervisor,
            log,
            normalizer: createNormalizer({
              quietMs: o.config.turn.quietMs,
              hardMs: o.config.turn.hardMs,
              drainGraceMs: o.config.turn.drainGraceMs,
              cancelGraceMs: o.config.turn.cancelGraceMs,
              descriptor: runtime,
              // Deterministic per worker: the map stays PURE by taking its ids from outside
              // (§5.7), and `IdGen.request()` is the daemon's one id source.
              ids: { synth: (prefix: string) => `${prefix}_${o.ids.request()}` },
              modes: modesOf,
              // §12.5: a reconstructed vendor patch names paths `git apply` accepts, which it
              // cannot do without the directory the agent's relative paths are relative to.
              cwd,
            }),
            responder: o.responder,
            lease: leaseFor(auth.asClientRef(), workerId, log),
            toSpawnSpec: (d, spawnOpts) => o.catalog.toSpawnSpec(d, spawnOpts),
            ...(o.session === undefined ? {} : { session: o.session }),
            runtime,
            ...(runtimeId === undefined ? {} : { runtimeId }),
            clock: o.clock,
            ids: o.ids,
            logger,
            limits: {
              handshakeTimeoutMs: req.timeoutMs ?? o.config.handshakeTimeoutMs,
              cancelGraceMs: o.config.turn.cancelGraceMs,
              exitGraceMs: o.config.supervisor.exitGraceMs,
              gracefulMs: spec.gracefulMs ?? o.config.supervisor.gracefulMs,
              // The wake half of §15.5, from the daemon-wide `hibernate` block. They live on the
              // worker because the counter and the budget are its private state (review R13).
              wakeTimeoutMs: o.config.hibernate.wakeTimeoutMs,
              maxWakeFailures: o.config.hibernate.maxWakeFailures,
            },
          },
          signal,
        );
        built = handle;

        const entry: Entry = {
          id: workerId,
          handle,
          ownerTokenId: auth.tokenId,
          subscription,
          closing: null,
          live: true,
          agentId: req.agent,
          offStateChange: null,
          // `CreateWorkerRequest.idleTimeoutMs` overrides the daemon-wide budget for THIS worker,
          // and `0` in either place means "never hibernate this one" (H5, §15.2).
          hibernateIdleMs: idleBudget(req.idleTimeoutMs),
          idleTimer: null,
        };
        entries.set(workerId, entry);
        watchEntry(entry);
        // The row exists from the first moment the worker does, so a daemon killed one
        // millisecond later still leaves something for the next boot's adoption to find (§15.7).
        persistRow(entry);

        // The slot comes back on EVERY close — client_request, daemon_shutdown or a crash the
        // registry never asked for (H14). `closed` never rejects; the catch is belt and braces.
        const onClosed = (): void => {
          release(auth.tokenId, entry);
          entry.subscription?.close();
          // The lease's TTL timer (`lease.ttlMs`, 15 min by default) has no other owner once
          // the worker is gone; left armed it keeps an embedded daemon's process alive after
          // `stop()` returned. Same line on the rehydrate path.
          handle.lease.close();
          // The LAST write, and the one §15.6 level 3 reads back: the persisted `CloseResult` is
          // what a `DELETE` after a restart replays byte-for-byte instead of recomputing.
          persistClose(entry);
        };
        void handle.closed.then(onClosed, onClosed);

        return handle;
      } catch (e) {
        // The worker reclaimed its own process tree before rejecting (§5.3); the registry's job
        // is to give the slot back and to stop feeding a log nobody can reach any more.
        release(auth.tokenId, null);
        subscription?.close();
        log.close();
        // `agent_error` rather than `internal` for an unclassified failure: everything reachable
        // here is the agent's process or its handshake (§9). An abort still maps to
        // `agent_timeout` through `OmniError.from`.
        throw OmniError.from(e, "agent_error");
      }
    },

    get,

    /**
     * §14.8: straight from the store — a synchronous indexed query, no handle construction —
     * with IN-MEMORY entries overriding the row, because a live snapshot is fresher than a
     * debounced one.
     *
     * Constructing a handle per row would make listing a daemon with 10 000 retained workers
     * spawn 10 000 event logs, and `list()` is the one call a dashboard polls.
     */
    list(auth): readonly WorkerSnapshot[] {
      const out: WorkerSnapshot[] = [];
      const live = new Set<WorkerId>();
      for (const entry of entries.values()) {
        live.add(entry.id);
        const snapshot = entry.handle.snapshot();
        if (auth.canSee(snapshot)) out.push(snapshot);
      }
      if (store !== null && store !== undefined) {
        try {
          for (const row of store.workers.list()) {
            if (live.has(row.snapshot.workerId)) continue;
            if (auth.canSee(row.snapshot)) out.push(row.snapshot);
          }
        } catch (e) {
          // A store read that fails must not empty a listing that already has the live half:
          // reporting fewer workers than exist is worse than reporting the ones we are sure of.
          o.logger.warn("listing persisted workers failed", { error: String(e) });
        }
      }
      return out;
    },

    async delete(id, auth): Promise<CloseResult> {
      const persisted = deleteAcrossRestart(id, auth);
      if (persisted !== null) return persisted;

      const entry = lookup(id, auth);
      if (entry === null) return notFound(id);
      // D5: a DELETE is a controlling operation, so a non-holder is `423` with the holder named
      // (M1-PLAN WP-D acceptance 2). `WorkerHandle.close()` takes no `ClientRef`, so this is the
      // enforcement point, and it is Land-written for the same reason the rest of seam 3 is:
      // under the default `alwaysGrantedLease` it always grants, which is M0 unchanged.
      //
      // §16.1 rule L3 is "the lease **or** `role:"admin"`", and the admin half has to be HERE:
      // the lease does not know who is asking with what authority, which is why `lease(...)`
      // below passes `admin` into `steal` rather than letting the lease infer it. Without this
      // line an admin who does not hold the lease would start getting `423` on DELETE the moment
      // WP-E flips `leaseFactory` to WP-D's enforcing lease — a behaviour change arriving through
      // a Land-written line, invisible under the default `alwaysGrantedLease`.
      if (auth.role !== "admin") entry.handle.lease.assertHolder(auth.asClientRef());
      // Idempotent by construction: the second DELETE awaits the FIRST close and returns its
      // body, rather than asking a closed worker to close again (H12).
      return await closeEntry(entry, "client_request");
    },

    async closeAll(reason, opts): Promise<void> {
      const budget = opts?.timeoutMs ?? DEFAULT_CLOSE_ALL_MS;
      /**
       * A HIBERNATED worker is skipped, and that is §15.2's whole point rather than an
       * optimisation: it owns no process, so there is nothing here to reclaim, and closing it
       * would discard the session pointer hibernation exists to preserve. Before this, a graceful
       * `stop()` closed every sleeping worker on the way out and the next boot adopted a fleet of
       * `closed` rows — which makes "a hibernated worker survives a restart" (§14.8, §15.6) false
       * for the only shutdown path anybody uses. `closed` is skipped for the plainer reason.
       */
      const reclaimable = [...entries.values()].filter((entry) => {
        const state = entry.handle.snapshot().state;
        return state !== "hibernated" && state !== "closed";
      });
      const all = reclaimable.map((entry) =>
        closeEntry(entry, reason).catch((e: unknown) => {
          o.logger.warn("worker close failed during shutdown", {
            workerId: entry.id,
            error: String(e),
          });
          return null;
        }),
      );
      if (all.length > 0) {
        // Bounded: a shutdown that hangs on one wedged agent is a daemon that never exits. The
        // Supervisor's own `shutdown()` is the backstop that force-kills whatever is left.
        await new Promise<void>((resolve) => {
          const timer = o.clock.setTimer(budget, resolve);
          void Promise.all(all).then(() => {
            timer.cancel();
            resolve();
          });
        });
      }

      // THEN the logs, which is what closes every remaining SSE subscription.
      //
      // CONTRACTS.md §5.4 words `stop()` as "SSE subs -> workers -> socket"; the order here is
      // deliberately the other way round for one reason: §8.4 requires a subscriber to receive
      // the `omni.worker_state{closed}` envelope and then `omni.stream_end`. Closing the
      // subscriptions first would drop exactly that frame and turn every clean shutdown into
      // what §8.4 defines as a network drop, sending every client back to reconnect against a
      // daemon that is going away. Closing the workers first gets both: the stream ends the way
      // the contract says it must, and this sweep guarantees the END STATE that ordering was
      // written for — `subscriberCount === 0` on every log, with nothing left to leak.
      for (const entry of entries.values()) {
        entry.subscription?.close();
        entry.handle.log.close();
        // A live `setTimer` keeps the event loop referenced, so a daemon that stopped would not
        // exit until every idle budget elapsed. `cancel()` is terminal by design.
        entry.idleTimer?.cancel();
        entry.idleTimer = null;
        // Shutdown means every timer this registry owns dies HERE, not on whatever microtask the
        // worker's `closed` promise settles on — a hibernated entry never reaches `onClosed` at all,
        // and its lease's TTL timer would otherwise outlive `stop()`.
        entry.handle.lease.close();
      }
    },

    // ── result-returning façade (review R11) ──────────────────────────────────

    snapshot(id, auth): WorkerSnapshot {
      return get(id, auth).snapshot();
    },

    async prompt(id, auth, body): Promise<PromptAccepted> {
      let parsed: PromptRequestBody;
      try {
        // SHAPE only, since H28: the text-only `.refine` was DELETED, not widened, so this schema
        // now decides that `content` is a non-empty array of at most 64 objects that each carry a
        // `type` string — and nothing about which types are allowed. The SEMANTIC gate is
        // `Worker.prompt`'s `deps.validateContent` (§26.2), which this creation path MUST inject
        // bound to the token's `cwdRoots` and the worker's `promptCapabilities`: zod holds
        // neither, and a schema that silently stopped enforcing containment looks exactly like a
        // schema that got more capable (review R2). M2-B-WP-S owns the injection and its guard.
        parsed = PromptRequestBody.parse(body);
      } catch (e) {
        throw badRequest(e, "invalid prompt");
      }
      const entry = lookup(id, auth);
      if (entry === null) return notFound(id);
      // `Worker.prompt` auto-wakes a hibernated worker internally, so the ACL that `wake()`
      // re-runs has to be re-run here too — otherwise the check is one HTTP route wide (H14).
      if (entry.handle.snapshot().state === "hibernated") await assertMayResume(entry, auth);
      return await entry.handle.prompt(parsed.content, auth.asClientRef());
    },

    async cancel(id, auth): Promise<void> {
      await get(id, auth).cancel(auth.asClientRef());
    },

    turn(id, auth, turnId: TurnId): TurnStatus {
      return get(id, auth).turn(turnId);
    },

    logFor(id, auth): EventLog {
      return get(id, auth).log;
    },

    // ── M1 façade rows (H17-H19, §5.4) ────────────────────────────────────────
    //
    // Same shape as the M0 rows above and for the same reason (review R11): an HTTP route is
    // "parse -> call ONE daemon method -> serialize", so `POST …/lease/steal` must not become a
    // get-then-act orchestration in the adapter.
    //
    // Owned by M1-WP-E (daemon wiring), which lands the persisted worker store, lazy
    // rehydration and the hibernated counter behind them — so the two throwing bodies below are
    // tagged M1-WP-E, the owner of this file, and not the feature's work package (review R18).
    // M1-WP-D swaps in the enforcing `Lease` FACTORY without touching this file — seam 3.

    // ── M2 façade rows (H22-H24, §5.8.8) ──────────────────────────────────────
    //
    // Land-written and then TRANSFERRED to M2-WP-J, which owns all daemon wiring (M2-PLAN §1.1).
    // Same shape and same reason as M1's rows above (review R11): an HTTP route is "parse -> call
    // ONE daemon method -> serialize", so `POST …/interactions/{reqId}` must not become a
    // get-then-act orchestration in the adapter.
    //
    // Each is `get(id, auth)` — which is where VISIBILITY is checked, before anything else, so a
    // worker this token cannot see is a 404 and not a 423 — followed by ONE call on the handle.
    // The handle's own body is where the state and lease checks live (hunks 5 and 6), so an
    // un-configured daemon answers `interaction_not_found` and `-32601` here rather than a 500.

    /** H22: `200 InteractionAnswerResult`. Lease-gated INSIDE the handle, exactly as `prompt` is. */
    answer(id, auth, reqId, body): InteractionAnswerResult {
      // VISIBILITY FIRST (§19.6: visibility → state → existence → lease → shape → …). A worker
      // this token cannot see must answer `404` whatever is in the body; parsing first made a
      // malformed body from a stranger a `400`, which inverts the table's first two rows.
      //
      // The re-parse below is not dead code even though `body` arrives typed: an in-process
      // embedder calls this façade directly and its object has been through no route.
      const handle = get(id, auth);
      let parsed: InteractionAnswerBody;
      try {
        parsed = InteractionAnswerBody.parse(body);
      } catch (e) {
        throw badRequest(e, "invalid interaction answer");
      }
      return handle.answerInteraction(assertInteractionId(reqId), parsed, {
        ...auth.asClientRef(),
        tokenId: auth.tokenId,
      });
    },

    /** H23: `200 InteractionListResponse`. UNGATED (rule L2) — reading is an observer's right. */
    interactions(id, auth): InteractionListResponse {
      return { interactions: get(id, auth).interactions };
    },

    /** H24: `200 SetConfigResponse`. */
    async setConfig(id, auth, body): Promise<SetConfigResponse> {
      let parsed: SetConfigBody;
      try {
        parsed = SetConfigBody.parse(body);
      } catch (e) {
        throw badRequest(e, "invalid config request");
      }
      const entry = lookup(id, auth);
      if (entry === null) return notFound(id);
      // `Worker.setConfig` auto-wakes a hibernated worker internally, so the ACL that `wake()`
      // re-runs has to be re-run here too — otherwise the check is one HTTP route wide (H14).
      // The same line `prompt` carries, for the same reason.
      if (entry.handle.snapshot().state === "hibernated") await assertMayResume(entry, auth);
      return await entry.handle.setConfig(parsed, auth.asClientRef());
    },

    /** A hibernated worker owns no process, so it is bounded separately from `maxWorkers` (H14). */
    get hibernatedSize(): number {
      return countHibernated();
    },

    /**
     * Seam 3's façade row, Land-written: parse, then ONE call on the injected lease. Under the
     * default `alwaysGrantedLease` every mutating verb answers `bad_request` naming M1-WP-D,
     * which is D29's honest "not implemented yet" rather than a 500.
     */
    lease(id, auth, op, body): LeaseSnapshot {
      let parsed: LeaseRequestBody;
      try {
        parsed = LeaseRequestBody.parse(body);
      } catch (e) {
        throw badRequest(e, "invalid lease request");
      }
      const handle = get(id, auth);
      const who = auth.asClientRef();
      switch (op) {
        case "acquire":
          return handle.lease.acquire(
            who,
            parsed.ttlMs === undefined ? {} : { ttlMs: parsed.ttlMs },
          );
        case "release":
          return handle.lease.release(who);
        case "steal":
          // D13: an admin never waits; a same-token peer waits `stealAfterIdleMs`. The lease owns
          // that rule — the registry only says who is asking and with which authority.
          return handle.lease.steal(who, {
            reason: parsed.reason ?? null,
            admin: auth.role === "admin",
          });
      }
    },

    /**
     * H18. The lease gate is `Worker.hibernate()`'s caller's job here rather than the worker's:
     * `hibernate(reason)` takes no `ClientRef` (it is also the idle timer's entry point), so this
     * is the one place that knows WHO asked. §16.1 rule L2 lists hibernate among the gated verbs.
     *
     * `maxHibernated` is checked BEFORE the transition, because the transition reclaims a process
     * tree and there is no undo.
     */
    async hibernate(id, auth): Promise<WorkerSnapshot> {
      const handle = get(id, auth);
      // NO admin bypass, unlike `delete()` below. Rule L3 grants one for `DELETE` and for
      // nothing else, and H18 says only "Lease-gated" — D13 gives an admin the power to STEAL
      // the lease, which is audited, rather than to reach past a holder mid-session in silence.
      handle.lease.assertHolder(auth.asClientRef());
      if (
        handle.snapshot().state !== "hibernated" &&
        countHibernated() >= o.config.hibernate.maxHibernated
      ) {
        throw new OmniError(
          "worker_limit",
          `hibernated worker limit reached (${o.config.hibernate.maxHibernated})`,
        );
      }
      return await handle.hibernate("client_request");
    },

    /**
     * H19. A wake takes a `maxWorkers` slot back, so the capacity question is answered BEFORE the
     * ~7 s cold start rather than after it — a `429` that arrives after the spawn has already
     * happened is a limit that does not limit anything (H14).
     */
    async wake(id, auth): Promise<WorkerSnapshot> {
      const entry = lookup(id, auth);
      if (entry === null) return notFound(id);
      await assertMayResume(entry, auth);
      const before = entry.handle.snapshot();
      if (before.state === "hibernated") {
        reserveForWake(entry, auth);
        try {
          return await entry.handle.wake(auth.asClientRef());
        } catch (e) {
          // Only give the slot back if the worker did not actually come up: a wake that failed
          // and left the worker `hibernated` must not keep a slot, and one that reached `ready`
          // legitimately holds the one we just took.
          if (entry.handle.snapshot().state === "hibernated") release(entry.ownerTokenId, entry);
          throw e;
        }
      }
      return await entry.handle.wake(auth.asClientRef());
    },

    /**
     * Boot adoption (§15.7), run once by `createDaemon()` and idempotent thereafter.
     *
     * The narrow `{hibernated, closed, orphans}` shape is what `WorkerRegistry` declares;
     * `onBootAdoption` carries the `{found, reaped, skipped}` half `GET /v1/info` needs, from the
     * SAME pass — running adoption twice to answer two questions would append two sets of
     * envelopes to every abandoned worker's log.
     */
    async adopt(): Promise<{
      hibernated: number;
      closed: number;
      orphans: readonly OrphanRecord[];
    }> {
      if (store === null || store === undefined) {
        // Nothing was persisted, so nothing survived the last boot to adopt. Reporting zeroes is
        // the truth for `eventLog.driver: "memory"`, which is still the default (M1-R17).
        const empty: BootRecoveryResult = {
          found: 0,
          reaped: 0,
          skipped: 0,
          hibernated: 0,
          closed: 0,
          orphans: [],
        };
        o.onBootAdoption?.(empty);
        return { hibernated: 0, closed: 0, orphans: [] };
      }

      const result = await recoverFromPreviousBoot({
        persistence: store,
        supervisor: o.supervisor,
        config: o.config,
        clock: o.clock,
        logger: o.logger,
        // Adoption writes to the worker's OWN log, continuing the same seq space (§14.4). Going
        // through `logFor` with the store's head is what makes those envelopes land at the next
        // seq a reconnecting client expects, rather than restarting the worker's history at 1.
        logFor: (workerId) => logFor(workerId, store.events.headOf(workerId)),
      });
      o.onBootAdoption?.(result);
      return { hibernated: result.hibernated, closed: result.closed, orphans: result.orphans };
    },
  };
}
