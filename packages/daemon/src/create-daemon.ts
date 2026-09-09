import { chmod, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import {
  DaemonConfig,
  OmniError,
  createIdGen,
  isDaemonId,
  type ClientId,
  type DaemonId,
  type DeliveryStore,
  type DiffProvider,
  type RunRegistry,
  type DaemonInfo,
  type EventEnvelope,
  type IdGen,
  type ResolvedDaemonConfig,
  type TokenId,
  type WhoAmIResponse,
  type WorkerId,
} from "@omni-acp/protocol";
import {
  DEFAULT_V1_PROFILE,
  createBaselineResponder,
  createGitDiffProvider,
  createInteractionStrategy,
  createLease,
  createSessionStrategy,
  createSupervisor,
  createWatchdog,
  runUtility,
} from "@omni-acp/core";
import type { AddressInfo } from "node:net";
import type { Hono } from "hono";
import { createTokenStore } from "./auth.js";
import { createCatalog } from "./catalog.js";
import { systemClock } from "./clock.js";
import { armRetention, openDaemonPersistence } from "./event-store.js";
import { createHttpApp } from "./http/app.js";
import { loadOrCreateDaemonId, resolvePath } from "./ids-file.js";
import { createLogger } from "./logger.js";
import { createProbeCache } from "./probe-cache.js";
import { createProbeService } from "./probe-service.js";
import { resolvePolicyForRequest } from "./policy/resolve.js";
import { createRunSubsystem } from "./runs.js";
import { createWorkerRegistry } from "./registry.js";
import type { BootRecoveryResult } from "./boot-recovery.js";
import type { AuthContext, Daemon, DaemonDeps, DaemonEvent } from "./types.js";

/**
 * The slice of `node:http.Server` this file uses. `@hono/node-server`'s `serve()` is typed as a
 * union of three server classes; naming the two methods keeps the cast honest and the teardown
 * path independent of which one it handed back.
 */
interface BoundServer {
  close(cb?: (e?: Error) => void): void;
  closeAllConnections?: () => void;
  /** All three are `EventEmitter`s; a failed bind arrives here, not as a throw from `serve()`. */
  on(event: "error", listener: (e: Error) => void): void;
  off(event: "error", listener: (e: Error) => void): void;
}

/**
 * The library IS the product; HTTP is an adapter over it (D15).
 *
 * Two constraints this function has to keep, and both are proven at runtime rather than asserted
 * in prose:
 *  1. `listen: null` => no socket is bound, `daemon.url === null`, and the FULL worker lifecycle
 *     still works in-process. `library-only.itest.ts` drives create/prompt/events/turn/delete
 *     that way and never touches `fetch`.
 *  2. `daemon.fetch(Request)` is available whether or not `start()` bound a port, so the entire
 *     route suite runs with zero ports.
 *
 * `deps` exists so a test can inject `fakeSupervisor()` and nothing else — that is the only seam
 * a daemon or HTTP test needs in order to avoid real agent processes (CONTRACTS.md §10.1).
 */
export async function createDaemon(config: DaemonConfig, deps?: DaemonDeps): Promise<Daemon> {
  const resolved = parseConfig(config);

  const clock = deps?.clock ?? systemClock();
  const ids = deps?.ids ?? createIdGen();
  const logger = deps?.logger ?? createLogger(resolved.logLevel);

  // Owner-only, the same posture `persist/open.ts`, `probe-cache.ts`, `ids-file.ts` and
  // `persist/lock.ts` take: the data dir holds the event database, the daemon id and the probe
  // cache, none of which another local account has any business reading. `mkdir`'s mode is
  // umask-masked and is a no-op on a PRE-EXISTING directory, so the `chmod` is the half that
  // actually bites; it is tolerated when it fails, because it is advisory on win32 and because a
  // daemon must not refuse to start over a directory somebody else owns.
  await mkdir(resolved.dataDir, { recursive: true, mode: 0o700 });
  await chmod(resolved.dataDir, 0o700).catch(() => {});
  const daemonId = await resolveDaemonId(resolved, ids);

  /**
   * The boot sequence §14 and §15.7 prescribe, in order: OPEN persistence (which takes the
   * data-dir lock and migrates, §14.10 / §14.7), then boot adoption, then the retention timer.
   *
   * An injected handle wins, so a test drives the whole wiring without a database file and an
   * embedder can supply its own store. `null` is the memory driver, still the default (ruling
   * M1-R17) — `omni-acp start` is what writes `"sqlite"` into the config it builds.
   */
  const persistence =
    deps?.persistence ?? (await openDaemonPersistence({ config: resolved, clock, logger }));

  /**
   * This BOOT's id, distinct from the persistent `daemonId` (§15.7). It is what lets boot
   * adoption recognise a worker row a PREVIOUS boot owned; the store carries the authoritative
   * one, and a per-process value is the honest answer for a daemon whose rows never leave memory.
   */
  const bootId = persistence?.bootId ?? `boot_${ids.request()}`;

  const tokens = createTokenStore(resolved);
  const supervisor =
    deps?.supervisor ??
    createSupervisor({ config: resolved.supervisor, clock, logger: logger.child({ mod: "sup" }) });

  /**
   * The probe layer, wired into the catalog by a late-bound hook.
   *
   * The cycle is real — the probe service asks the catalog for a `SpawnSpec` and a descriptor,
   * and the catalog's `probe()` façade row hands H16 back to the probe service — so `catalog`
   * is built first with a hook that reads `probes` out of the closure. There is no window in
   * which the hook can fire early: nothing calls `catalog.probe` during construction.
   */
  const probeCache = createProbeCache({ dataDir: resolved.dataDir, logger });
  let probes: ReturnType<typeof createProbeService> | null = null;
  const catalog = createCatalog(resolved, {
    hooks: {
      cached: (agentId) => probes?.cached(agentId) ?? null,
      run: (id, body, auth) => {
        if (probes === null) {
          return Promise.reject(new OmniError("internal", "the probe service is not ready"));
        }
        return probes.probe(id, body, auth);
      },
    },
  });
  probes = createProbeService({
    config: resolved,
    catalog,
    supervisor,
    cache: probeCache,
    clock,
    logger,
  });
  // M0 wires the fixed auto-DENY responder and nothing else: the first remote-execution surface
  // ships fail-closed (D4/L7, CONTRACTS.md §7.4).
  const responder = deps?.responder ?? createBaselineResponder("deny", clock);

  const listeners: { [K in DaemonEvent["type"]]: Set<(e: DaemonEvent) => void> } = {
    "worker.state": new Set(),
    "worker.event": new Set(),
  };

  const emit = (workerId: WorkerId, envelope: EventEnvelope): void => {
    // One envelope, one channel: `omni.worker_state` is the lifecycle stream and everything else
    // is the content stream, so a listener never has to filter out what it did not ask for.
    const type: DaemonEvent["type"] =
      envelope.kind === "omni.worker_state" ? "worker.state" : "worker.event";
    for (const handler of listeners[type]) {
      try {
        handler({ type, workerId, envelope } as DaemonEvent);
      } catch (e) {
        logger.warn("daemon event handler threw", { type, error: String(e) });
      }
    }
  };

  /**
   * ── M2's six defaults, flipped HERE and nowhere else (M2-WP-J acceptance 7) ──────────────────
   *
   * Each is `deps?.x ?? <the real one>`, so an injected double still wins and the seam stays the
   * seam. With every one of them absent from `CreateWorkerDeps` — which is what `createWorker`
   * sees in a unit test — `worker.ts` is M1 exactly: no strategy, no watchdog, no provider, M0's
   * text-only content whitelist and `TurnResult.patch: null`. That is ruling M2-R1, and the M1
   * suite passing unedited against this file is its proof.
   *
   * The GIT provider is the one that is conditional on config rather than on `deps`, because
   * `diff.provider` defaults to `"none"`: a daemon that ran `git` on every turn without being
   * asked would be a daemon that touches the operator's repository because it could.
   */
  const interactions = deps?.interactions ?? ((d) => createInteractionStrategy(d));
  const watchdog = deps?.watchdog ?? ((d) => createWatchdog(d));
  const diff: DiffProvider | undefined =
    deps?.diff ??
    (resolved.diff.provider === "git"
      ? createGitDiffProvider({
          // The ONE spawn seam (§6.1): git is reached through the same `RunUtility`
          // `fingerprint.ts` uses for `ps`, which is what `no-direct-spawn` asserts and what lets
          // the provider's own tests run with no git installed.
          run: runUtility,
          cfg: resolved.diff,
          clock,
          ids,
          logger: logger.child({ mod: "diff" }),
        })
      : undefined);
  /**
   * D4's engine, per REQUEST: the ceiling is per token and the selection is per worker, and the
   * `403 policy_exceeds_ceiling` it raises belongs at CREATE — before a process exists (§20.5).
   *
   * An injected `deps.policy` is handed `(selection, ceiling)` exactly as §5.8.8 declares it; the
   * default path goes through `resolvePolicyForRequest`, which is the one place the preset ACL,
   * the `extends` resolution and the ceiling clamp live.
   */
  const policyFor: NonNullable<Parameters<typeof createWorkerRegistry>[0]["policyFor"]> = (
    sel,
    auth,
    onUnresolved,
  ) =>
    deps?.policy === undefined
      ? resolvePolicyForRequest(resolved, auth, sel, { onUnresolved })
      : deps.policy(sel ?? null, auth.policyCeiling);

  /** Boot adoption's full result, captured from the ONE pass `workers.adopt()` runs below. */
  let adoption: BootRecoveryResult = {
    found: 0,
    reaped: 0,
    skipped: 0,
    hibernated: 0,
    closed: 0,
    orphans: [],
  };

  const workers = createWorkerRegistry({
    daemonId,
    config: resolved,
    catalog,
    supervisor,
    responder,
    clock,
    ids,
    logger: logger.child({ mod: "registry" }),
    /**
     * Seam 3, closed: M1-WP-D's enforcing lease is the daemon's default (D5).
     *
     * `onEvent` is rule L9's sink — every acquire / release / steal / expiry appends one
     * `omni.lease` envelope to the worker's OWN log, so an observer's SSE stream carries the
     * control history alongside the turn it belongs to (WP-D acceptance 3). The registry hands
     * the log in as the third argument precisely so this line can point at it; see the comment
     * on `WorkerRegistryOptions.leaseFactory`.
     *
     * An injected factory still wins, which is what lets a test drive `alwaysGrantedLease` or a
     * spy without the daemon composing one behind its back.
     */
    leaseFactory: (owner, workerId, log, initialEpoch) => {
      // An INJECTED factory still wins — that is what lets a test drive `alwaysGrantedLease` or a
      // spy without the daemon composing one behind its back. It cannot be consulted for an
      // UNHELD lease, though: `DaemonDeps.leaseFactory` is frozen at `(owner: ClientRef, …)` and
      // has no way to say "nobody holds this yet", which is exactly what a rehydrated worker
      // needs (ruling M1-R8). So the null case composes the daemon's own.
      const injected = deps?.leaseFactory;
      if (injected !== undefined && owner !== null) return injected(owner, workerId);
      return createLease({
        workerId,
        clock,
        config: resolved.lease,
        initialHolder: owner,
        // Rule L7's monotonic counter across a restart: the registry hands the row's persisted
        // epoch back for a REHYDRATED worker (and `undefined` for every other one), so the
        // number boot adoption already published in the worker's own
        // `omni.lease{how:"daemon_restart"}` envelope is the number the live lease reports.
        initialEpoch,
        onEvent: (payload) => {
          try {
            log.append({ kind: "omni.lease", payloadVersion: 2, turnId: null, payload });
          } catch (e) {
            // A lease transition that cannot be audited is still a lease transition: control
            // has already moved, and throwing here would turn a full log or a closed one into
            // a failed `acquire`. The write failure is the log's own to report (§14.3).
            logger.warn("appending an omni.lease envelope failed", {
              workerId,
              op: payload.op,
              error: String(e),
            });
          }
        },
      });
    },
    /**
     * SEAM 2, closed: M1-WP-C's `SessionStrategy` is the daemon's default.
     *
     * Absent, `worker.ts` falls back to M0's inline `runHandshake` — and that fallback is what
     * the Land step left standing so the M0 suite could run before WP-C existed. It is NOT a
     * viable production default any more: `Worker.hibernate()` REFUSES outright when no strategy
     * is wired ("no SessionStrategy is wired, so nothing could reopen the session") and
     * `Worker.wake()` closes the worker with `not_resumable`, so a daemon composed without one
     * has an idle timer that can never fire and a `POST …/wake` that can only fail. The M1
     * integration suite found exactly that (M1-PLAN §2, WP-F 6).
     *
     * The strategy is per DAEMON while the quirk table is per AGENT, which is why it is
     * constructed with the generic v1 profile: every call carries its own
     * `SessionOpenOptions.descriptor` / `SessionReopenOptions.descriptor` — the worker's resolved
     * builtin ⊕ config ⊕ probe table — and `session-open.ts` prefers it (§17.2). The constructor
     * argument is only the fallback for a caller that has none.
     *
     * An injected `deps.session` still wins, so a test can drive a scripted strategy.
     */
    session:
      deps?.session ??
      createSessionStrategy({
        descriptor: DEFAULT_V1_PROFILE,
        clock,
        logger: logger.child({ mod: "session" }),
      }),
    persistence,
    // M2's four per-worker seams. The registry composes one strategy and one watchdog per worker
    // from the REQUEST's own disposition and budgets, and hands every worker the same provider.
    interactions,
    watchdog,
    ...(diff === undefined ? {} : { diff }),
    policyFor,
    onBootAdoption: (r) => {
      adoption = r;
    },
    onEnvelope: (workerId, envelope) => {
      emit(workerId as WorkerId, envelope as EventEnvelope);
    },
  });

  // Boot adoption runs ONCE, here, before `start()` can bind a port (§15.7, H21): every row a
  // previous boot abandoned converges on `hibernated` or `closed`, with the orphan recorded
  // whether or not it could be reaped. It is a no-op on a second run and for the memory driver.
  await workers.adopt();

  /**
   * ── §24.4's boot order, and every arrow in it is load-bearing ────────────────────────────────
   *
   *     persistence → worker adopt → run recover → delivery requeue → dispatcher.start → listen
   *
   * Recovering runs BEFORE workers were adopted would abandon runs whose workers were about to be
   * rehydrated; starting the dispatcher BEFORE the requeue would let it claim rows a previous
   * boot still owns. `createRunSubsystem` builds the pieces and starts nothing — this file is the
   * only one that knows where `workers.adopt()` sits relative to them.
   *
   * A run under the memory driver is ALLOWED (ruling M2-R14): it says so in
   * `RunSnapshot.persistence` rather than pretending to survive a restart, which is why the
   * subsystem is wired unconditionally and only the DISPATCHER is gated on `webhooks.enabled`.
   */
  const runSubsystem = createRunSubsystem({
    config: resolved,
    // The V2 handle, or none. `openPersistence` returns the run and delivery stores alongside the
    // event store from M2 on, but `DaemonDeps.persistence` is a `PersistenceHandle` — the M1
    // shape — and a test double built to that contract carries neither. Handing one to the run
    // subsystem would make it read `undefined.transaction` at construction, so the guard asks the
    // object rather than the type, and a handle without the stores gets the in-memory ones (a run
    // under the memory driver is ALLOWED and says so in `RunSnapshot.persistence`, M2-R14).
    persistence: hasRunStores(persistence) ? persistence : null,
    workers,
    clock,
    ids,
    logger,
    daemonId,
  });
  const recovered = runSubsystem.recover();
  if (recovered.abandoned > 0 || recovered.requeued > 0) {
    logger.info("recovered runs and deliveries from a previous boot", recovered);
  }
  const dispatcher = deps?.webhooks ?? runSubsystem.dispatcher;
  dispatcher?.start();

  // The retention sweep, armed last so it cannot race adoption for the same rows (§14.5).
  const retention = armRetention({ persistence, config: resolved, clock, logger });

  /**
   * `probe.onStart` (§17.4). The DEFAULT is `"cached"`, which LOADS `<dataDir>/probes/*.json`
   * and spawns nothing: an operator with eight agents configured must not pay eight `npx` cold
   * starts to bind a port. `"always"` is the explicit lever for the operator who wants exactly
   * that, and a broken agent there is a log line rather than a daemon that will not start.
   */
  await probes.warmup().catch((e: unknown) => {
    logger.warn("probe warmup failed", { error: String(e) });
  });

  /**
   * §14.9's honesty contract, extended: an operator reads these BEFORE anything goes wrong.
   *
   * A GETTER rather than a frozen literal, because `writeFailures`, `sizeBytes` and `lastSweep`
   * all change while the daemon runs — a snapshot taken at construction would report a healthy
   * store forever, which is the opposite of what `writeFailures` exists to say.
   */
  const persistenceInfo = (): DaemonInfo["persistence"] => {
    const diagnostics = persistence?.events.diagnostics;
    return {
      // What is in FORCE, not what was configured: an operator must never have to guess whether
      // this daemon's logs survive a restart (§14.9).
      driver: diagnostics?.driver ?? "memory",
      file: diagnostics?.file ?? null,
      schemaVersion: diagnostics?.schemaVersion ?? 0,
      sizeBytes: diagnostics?.sizeBytes ?? 0,
      writeFailures: diagnostics?.writeFailures ?? 0,
      retentionDays: resolved.eventLog.retentionDays,
      lastSweep: retention.lastSweep,
    };
  };

  const info: DaemonInfo = Object.freeze({
    daemonId,
    version: packageVersion(),
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    // M0 negotiates v1 only; the internal representation being v2 (D1) is not a claim about
    // what this daemon can speak to an agent.
    protocolVersions: [1] as const,
    startedAt: clock.iso(),
    // §6.6: the honesty field, taken from the platform the Supervisor actually chose — never
    // from `process.platform` re-derived here.
    ownership: supervisor.platform.ownership,

    // ── M1 (§14.9, §15.7, H21) ──────────────────────────────────────────────
    //
    // The version of the canonical payload this daemon WRITES (ruling M1-R10).
    canonicalPayloadVersion: 2 as const,
    /**
     * The whole point of these three is that an operator can read them BEFORE anything goes
     * wrong: whether this daemon's logs survive a restart, whether they still do, and what a
     * previous boot left behind — including `skipped: n` on Windows, where nothing can be reaped.
     *
     * `persistence` is a live view (the getter above); `orphansAtStart` is deliberately frozen at
     * what the ONE adoption pass found, because "at start" is exactly what it claims to be.
     */
    get persistence(): DaemonInfo["persistence"] {
      return persistenceInfo();
    },
    /** This daemon INSTANCE's id — not `daemonId`, which is stable across boots (§15.7). */
    bootId,
    orphansAtStart: Object.freeze({
      found: adoption.found,
      reaped: adoption.reaped,
      // On win32 `PlatformOps.fingerprint` is null by design, so nothing is ever reaped and this
      // is `found` — `{found: 3, reaped: 0, skipped: 3}` rather than a quiet lie (§15.7, M1-R9).
      skipped: adoption.skipped,
    }),
  });

  // Bound lazily so that `createHttpApp(daemon)` can close over the finished object. The import
  // is STATIC (D27): `daemon.fetch` must work without `start()`, which is the property the whole
  // route suite is built on.
  let app: Hono | null = null;
  let server: BoundServer | null = null;
  let url: string | null = null;
  let starting: Promise<void> | null = null;
  let stopping: Promise<void> | null = null;

  const closeServer = async (): Promise<void> => {
    const current = server;
    if (current === null) return;
    server = null;
    await new Promise<void>((resolve) => {
      current.close(() => {
        resolve();
      });
      // An SSE stream is a live connection by design; without this the socket never closes and
      // `stop()` hangs on exactly the feature §8.4 exists for.
      current.closeAllConnections?.();
    });
  };

  const daemon: Daemon = {
    id: daemonId,
    config: resolved,
    info,
    get url(): string | null {
      return url;
    },
    workers,
    catalog,
    supervisor,
    // M2-B (D9). Always PRESENT — a `Daemon` that grew and lost a member between milestones is
    // the shape §5.8.6 spends a comment forbidding for `policyCeiling` — and every verb answers
    // `bad_request` naming its work package until `deps.runs` / `deps.webhooks` are wired. That
    // is D29's honest "not implemented yet", and it is the M1 Land precedent S8 exactly.
    // M2-B (D9), wired. `deps.runs` still wins — that is the seam a test injects a recorder into
    // — and `unimplementedRuns()` remains as the honest answer for a `Daemon` assembled without
    // the subsystem at all (D29's "not implemented yet", the M1 Land precedent S8).
    runs: deps?.runs ?? runSubsystem.runs,
    deliveries: runSubsystem.deliveries,

    authContextFor(tokenId: TokenId, clientId?: ClientId | null): AuthContext {
      return tokens.contextFor(tokenId, clientId ?? null);
    },

    authenticate(headers: Headers): AuthContext {
      return tokens.verify(headers);
    },

    whoami(auth): WhoAmIResponse {
      return {
        tokenId: auth.tokenId,
        role: auth.role,
        daemonId,
        agents: auth.agents,
        cwdRoots: auth.cwdRoots,
        maxWorkers: auth.maxWorkers,
        // M2-B (§5.8.6). The field never appeared or disappeared — only its TYPE widened, which
        // is the one compile break in M2 (§11.9). The three beside it are read from the token's
        // own config row rather than from `AuthContext`, because they are REPORTING fields: the
        // context carries what it can ENFORCE (`policyCeiling`, `assertPolicy`, `assertMcp`), and
        // widening it with two lists nothing checks would invite a second enforcement site.
        policyCeiling: auth.policyCeiling,
        policyPresets: tokenRow(resolved, auth.tokenId)?.policyPresets ?? [],
        mcpPresets: tokenRow(resolved, auth.tokenId)?.mcpPresets ?? [],
        // A token may create webhook runs when it has a signing secret AND the operator has
        // enabled the outbound surface. FAIL CLOSED: the default is `false` on both counts.
        webhooks:
          resolved.webhooks.enabled &&
          (tokenRow(resolved, auth.tokenId)?.webhookSecret !== undefined ||
            tokenRow(resolved, auth.tokenId)?.webhookSecretFile !== undefined),
      };
    },

    fetch: async (req: Request): Promise<Response> => {
      app ??= createHttpApp(daemon);
      return await app.fetch(req);
    },

    on(type, handler): () => void {
      listeners[type].add(handler);
      return () => {
        listeners[type].delete(handler);
      };
    },

    start(): Promise<void> {
      // Idempotent AND concurrency-safe: two callers share one bind rather than racing for the
      // port, and a failed bind is not remembered as "started".
      starting ??= bind().catch((e: unknown) => {
        starting = null;
        throw e;
      });
      return starting;
    },

    stop(opts): Promise<void> {
      // Idempotent, and concurrent callers share ONE teardown: a CLI that gets SIGINT twice must
      // not start a second shutdown while the first is killing trees (L12).
      stopping ??= (async () => {
        const graceful = opts?.graceful ?? true;
        const timeoutMs = opts?.timeoutMs;
        /**
         * §24.4's mirror of the boot order, and the FIRST step is §19.8's:
         *
         *     interactions.settleAll → dispatcher.drain(bounded) → workers → socket
         *
         * `settleAll` first because an agent BLOCKED on our answer may never read the shutdown —
         * a log that ends on a `pending` interaction is a log that lies, and a JSON-RPC promise
         * nobody resolved is a process that will not exit. It runs through `closeAll` below (each
         * `Worker.close` settles its own strategy), so the explicit step here is the DISPATCHER's:
         * a bounded drain, never an unbounded one, because a slow receiver must not hold a
         * shutdown open.
         */
        await dispatcher?.drain({ timeoutMs: DISPATCHER_DRAIN_MS }).catch((e: unknown) => {
          logger.warn("draining webhook deliveries failed", { error: String(e) });
        });
        await dispatcher?.stop().catch((e: unknown) => {
          logger.warn("stopping the webhook dispatcher failed", { error: String(e) });
        });
        await workers.closeAll(
          "daemon_shutdown",
          timeoutMs === undefined ? undefined : { timeoutMs },
        );
        // The backstop: anything the workers did not own (or did not manage to reap) is killed
        // here, so `supervisor.live` is empty when this resolves.
        await supervisor
          .shutdown({ gracefulMs: graceful ? resolved.supervisor.gracefulMs : 0 })
          .catch((e: unknown) => {
            logger.warn("supervisor shutdown failed", { error: String(e) });
            return [];
          });
        await closeServer();
        /**
         * The store closes LAST, after `closeAll` (M1-PLAN WP-E acceptance 5).
         *
         * `closeAll` is what appends every worker's `omni.worker_state{closed}`, and closing the
         * store first would drop exactly the envelopes that tell the next boot each worker shut
         * down cleanly — which is the difference between a clean stop and a fleet of orphans on
         * the next start. There is no separate `flush()` to call: `EventStore.put` is
         * SYNCHRONOUS (§5.1 — `DatabaseSync` is, and an async `put` would reintroduce the
         * interleave a non-monotonic `seq` is), so a returned `append` is already durable and
         * `close()` is the barrier.
         *
         * An injected handle is NOT closed here: it belongs to whoever injected it, and closing
         * somebody else's store is how a test that reuses one file across two daemons breaks.
         */
        retention.stop();
        if (deps?.persistence === undefined) {
          try {
            persistence?.close();
          } catch (e) {
            logger.warn("closing persistence failed", { error: String(e) });
          }
        }
        url = null;
        starting = null;
        logger.info("daemon stopped", { daemonId });
      })();
      return stopping;
    },
  };

  async function bind(): Promise<void> {
    const listen = resolved.listen;
    if (listen === null) return; // in-process only: no socket, url stays null (D15)

    const { serve } = await import("@hono/node-server");
    app ??= createHttpApp(daemon);
    const bound = await new Promise<AddressInfo>((resolve, reject) => {
      /**
       * A bind that fails — `EADDRINUSE` on a configured port, `EADDRNOTAVAIL` on a host this
       * machine does not own — is reported ASYNCHRONOUSLY as an `error` event on the server, not
       * as a throw from `serve()`. With no listener Node re-raises it as an uncaught exception
       * and the daemon dies with a stack trace, so `start()` never rejects and the CLI's
       * "failed to start" path is unreachable. This is what makes the failure a rejection.
       */
      const onBindError = (e: Error): void => {
        server = null;
        reject(e);
      };
      try {
        const created = serve(
          {
            fetch: (request: Request) => daemon.fetch(request),
            hostname: listen.host,
            port: listen.port,
            // D17: `POST /v1/workers` legitimately holds a request open for a cold `npx` start,
            // and an SSE stream holds one open indefinitely. Node's 5-minute default cuts both.
            serverOptions: { requestTimeout: 0, headersTimeout: 0 },
          },
          (address) => {
            created.off("error", onBindError);
            // Past the bind, an `error` event is a runtime fault on a socket that is already
            // serving. Logging it keeps the daemon alive; leaving it unhandled would not.
            created.on("error", (e: Error) => {
              logger.error("http server error", { error: String(e), daemonId });
            });
            resolve(address);
          },
        ) as unknown as BoundServer;
        server = created;
        created.on("error", onBindError);
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
    // IPv6 literals need brackets in a URL; `::1` and `127.0.0.1` must both round-trip.
    const host = bound.family === "IPv6" ? `[${bound.address}]` : bound.address;
    url = `http://${host}:${bound.port}`;
    logger.info("daemon listening", { url, daemonId });
  }

  return daemon;
}

/**
 * Does this handle carry M2's v2 stores, or is it an M1-shaped double?
 *
 * A property test rather than a `instanceof` or a version field, because that is exactly what the
 * caller needs to know: `createRunSubsystem` reads `handle.runs`, `handle.deliveries` and
 * `handle.transaction`, and those three are the question.
 */
function hasRunStores(handle: unknown): boolean {
  if (typeof handle !== "object" || handle === null) return false;
  const h = handle as Record<string, unknown>;
  return (
    typeof h["runs"] === "object" &&
    h["runs"] !== null &&
    typeof h["deliveries"] === "object" &&
    h["deliveries"] !== null &&
    typeof h["transaction"] === "function"
  );
}

/**
 * How long `stop()` waits for in-flight deliveries before it stops caring (§24.4).
 *
 * BOUNDED, and deliberately short: a delivery that does not make it is `pending` on disk and the
 * next boot's requeue picks it up with the SAME `deliveryId`, so the cost of giving up is a
 * retry — while the cost of an unbounded drain is a daemon a slow receiver can keep alive.
 */
const DISPATCHER_DRAIN_MS = 2_000;

/** zod is the source of truth for the shape; these are the two things it cannot express. */
function parseConfig(config: DaemonConfig): ResolvedDaemonConfig {
  let parsed: ResolvedDaemonConfig;
  try {
    parsed = DaemonConfig.parse(config);
  } catch (e) {
    const issues = (e as { issues?: { path?: PropertyKey[]; message?: string }[] } | null)?.issues;
    const first = Array.isArray(issues) ? issues[0] : undefined;
    if (first === undefined) throw OmniError.from(e, "bad_request");
    const where = (first.path ?? []).join(".");
    throw new OmniError(
      "bad_request",
      `invalid daemon config${where === "" ? "" : ` (${where})`}: ${first.message ?? "invalid"}`,
      { cause: e },
    );
  }

  // M0 refused every driver but `"memory"` here; M1 is the milestone that removes that line
  // (§8.1). `"memory"` remains the DEFAULT (ruling M1-R17) — `createDaemon()` keeps a zero-file,
  // zero-experimental-module footprint so `OmniACP.local()` in a user's script does not leave a
  // database behind, and `omni-acp start` is what writes `"sqlite"` into the config it builds.

  // Every path the daemon stores is absolute and `~`-expanded, so `daemon.config` reads the same
  // as what is on disk.
  return { ...parsed, dataDir: resolvePath(parsed.dataDir) };
}

async function resolveDaemonId(config: ResolvedDaemonConfig, ids: IdGen): Promise<DaemonId> {
  const configured = config.daemonId;
  if (configured === undefined) {
    return await loadOrCreateDaemonId(config.dataDir, ids);
  }
  if (!isDaemonId(configured)) {
    // Envelopes carry `daemonId` and the client validates it against `ID_PATTERN.daemon`
    // (`eventEnvelopeSchema`), so a free-form id would produce a daemon whose every event fails
    // to parse at the other end. Better to refuse at startup than to ship unreadable events.
    throw new OmniError(
      "bad_request",
      'daemonId must be a "d_"-prefixed 26-character Crockford ULID',
    );
  }
  return configured;
}

/**
 * The published version, read from this package's own manifest rather than hard-coded, so
 * `GET /v1/info` cannot drift from what npm installed. A missing manifest is not worth failing a
 * daemon start over.
 */
function packageVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const manifest = require("../package.json") as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * The token's own config row, for `whoami`'s three REPORTING fields (§5.8.6).
 *
 * `AuthContext` deliberately does not carry them: it carries what it can ENFORCE, and a list
 * nothing checks sitting beside `assertMcp` is an invitation to a second enforcement site.
 */
function tokenRow(
  config: ResolvedDaemonConfig,
  tokenId: TokenId,
): ResolvedDaemonConfig["tokens"][number] | undefined {
  return config.tokens.find((t) => t.id === tokenId);
}

/**
 * `Daemon.runs` with no `RunRegistry` injected (M2-B-WP-R).
 *
 * Every verb is `bad_request` naming the work package, which is D29's honest "not implemented
 * yet" and the M1 Land precedent S8 — a 500 would say the daemon broke, and a silent empty list
 * would say there are no runs, which is a different and worse lie.
 *
 * `list` throws for exactly that reason (review follow-up 9): its ONE caller is `GET /v1/runs`,
 * which `registerRunRoutes` registers unconditionally, so an empty array would answer `200
 * {"runs":[]}` and leave a client unable to tell "this daemon has no run support" from "you have
 * no runs". `recover` is the deliberate exception — it is a STARTUP path, it must be total, and
 * "nothing was abandoned" is true of a daemon that never had a run.
 */
function unimplementedRuns(): RunRegistry {
  const no = (): never => {
    throw new OmniError("bad_request", "runs are not enabled on this daemon (M2-B-WP-R)");
  };
  return {
    create: () => Promise.reject(new OmniError("bad_request", "runs are not enabled (M2-B-WP-R)")),
    get: no,
    list: no,
    cancel: () => Promise.reject(new OmniError("bad_request", "runs are not enabled (M2-B-WP-R)")),
    logFor: no,
    recover: () => ({ abandoned: 0 }),
  };
}

/** `Daemon.deliveries` with no dispatcher wired. Same rule as `unimplementedRuns`. */
function unimplementedDeliveries(): DeliveryStore {
  const no = (): never => {
    throw new OmniError("bad_request", "webhooks are not enabled on this daemon (M2-B-WP-R)");
  };
  return {
    enqueue: no,
    due: () => [],
    claim: () => false,
    settle: no,
    requeueStale: () => 0,
    list: () => ({ rows: [], cursor: null }),
    redeliver: no,
  };
}
