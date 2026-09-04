import {
  CreateWorkerRequest,
  LeaseRequestBody,
  OmniError,
  PromptRequestBody,
  type Clock,
  type ClientRef,
  type CloseResult,
  type DaemonId,
  type EventLog,
  type IdGen,
  type Lease,
  type LeaseSnapshot,
  type Logger,
  type OrphanRecord,
  type PermissionResponder,
  type PromptAccepted,
  type ResolvedDaemonConfig,
  type Subscription,
  type Supervisor,
  type TokenId,
  type TurnId,
  type TurnStatus,
  type WorkerCloseReason,
  type WorkerHandle,
  type WorkerId,
  type WorkerSnapshot,
} from "@omni-acp/protocol";
import {
  alwaysGrantedLease,
  createMemoryEventLog,
  createNormalizer,
  createWorker,
} from "@omni-acp/core";
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
   * construction, every mutating verb a `bad_request` naming M1-WP-D. M1-WP-D implements
   * `createLease` in its own files and M1-WP-E flips this default in `create-daemon.ts` — neither
   * of them edits the hunk the other owns.
   */
  readonly leaseFactory?: (owner: ClientRef, workerId: WorkerId) => Lease;
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

  const get = (id: WorkerId, auth: AuthContext): WorkerHandle => {
    const entry = entries.get(id);
    if (entry === undefined) return notFound(id);
    if (!auth.canSee(entry.handle.snapshot())) return notFound(id);
    return entry.handle;
  };

  const closeEntry = (entry: Entry, reason: WorkerCloseReason): Promise<CloseResult> => {
    entry.closing ??= entry.handle.close(reason);
    return entry.closing;
  };

  /** Seam 3's one call site. The default IS M0: `alwaysGrantedLease` grants every `assertHolder`. */
  const leaseFor = (owner: ClientRef, workerId: WorkerId): Lease =>
    o.leaseFactory?.(owner, workerId) ?? alwaysGrantedLease(owner, workerId);

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

      const log = createMemoryEventLog({
        workerId,
        daemonId: o.daemonId,
        clock: o.clock,
        maxEvents: o.config.eventLog.maxEventsPerWorker,
        subscriberQueueSize: o.config.eventLog.subscriberQueueSize,
      });

      // Subscribed BEFORE the handshake, from seq 0, so `daemon.on(...)` sees a worker's whole
      // life — including the `starting` envelope and a handshake that fails.
      const subscription =
        o.onEnvelope === undefined
          ? null
          : log.subscribe(0, (envelope) => {
              try {
                o.onEnvelope?.(workerId, envelope);
              } catch (e) {
                // A listener that throws must not corrupt the log's fan-out (§8.2).
                logger.warn("daemon event listener threw", { error: String(e) });
              }
            });

      const spec = o.catalog.toSpawnSpec(descriptor, { cwd });

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
            }),
            responder: o.responder,
            lease: leaseFor(auth.asClientRef(), workerId),
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

        const entry: Entry = {
          id: workerId,
          handle,
          ownerTokenId: auth.tokenId,
          subscription,
          closing: null,
          live: true,
        };
        entries.set(workerId, entry);

        // The slot comes back on EVERY close — client_request, daemon_shutdown or a crash the
        // registry never asked for (H14). `closed` never rejects; the catch is belt and braces.
        void handle.closed.then(
          () => {
            release(auth.tokenId, entry);
            entry.subscription?.close();
          },
          () => {
            release(auth.tokenId, entry);
            entry.subscription?.close();
          },
        );

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

    list(auth): readonly WorkerSnapshot[] {
      const out: WorkerSnapshot[] = [];
      for (const entry of entries.values()) {
        const snapshot = entry.handle.snapshot();
        if (auth.canSee(snapshot)) out.push(snapshot);
      }
      return out;
    },

    async delete(id, auth): Promise<CloseResult> {
      const entry = entries.get(id);
      if (entry === undefined) return notFound(id);
      if (!auth.canSee(entry.handle.snapshot())) return notFound(id);
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
      const all = [...entries.values()].map((entry) =>
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
      }
    },

    // ── result-returning façade (review R11) ──────────────────────────────────

    snapshot(id, auth): WorkerSnapshot {
      return get(id, auth).snapshot();
    },

    async prompt(id, auth, body): Promise<PromptAccepted> {
      let parsed: PromptRequestBody;
      try {
        // The M0 content pre-check IS this schema: only `type:"text"` blocks are accepted, so
        // there is no unchecked path surface to contain (§2.3, review R12). A type outside the
        // handshake `promptCapabilities` cannot occur while text is the only type allowed.
        parsed = PromptRequestBody.parse(body);
      } catch (e) {
        throw badRequest(e, "invalid prompt");
      }
      const handle = get(id, auth);
      return await handle.prompt(parsed.content, auth.asClientRef());
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

    /** A hibernated worker owns no process, so it is bounded separately from `maxWorkers` (H14). */
    get hibernatedSize(): number {
      return 0;
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

    hibernate(_id, _auth): Promise<WorkerSnapshot> {
      throw new OmniError("internal", "unimplemented: M1-WP-E");
    },

    wake(_id, _auth): Promise<WorkerSnapshot> {
      throw new OmniError("internal", "unimplemented: M1-WP-E");
    },

    adopt(): Promise<{ hibernated: number; closed: number; orphans: readonly OrphanRecord[] }> {
      throw new OmniError("internal", "unimplemented: M1-WP-E");
    },
  };
}
