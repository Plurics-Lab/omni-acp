import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import {
  DaemonConfig,
  OmniError,
  createIdGen,
  isDaemonId,
  type ClientId,
  type DaemonId,
  type DaemonInfo,
  type EventEnvelope,
  type IdGen,
  type ResolvedDaemonConfig,
  type TokenId,
  type WhoAmIResponse,
  type WorkerId,
} from "@omni-acp/protocol";
import { createBaselineResponder, createSupervisor } from "@omni-acp/core";
import type { AddressInfo } from "node:net";
import type { Hono } from "hono";
import { createTokenStore } from "./auth.js";
import { createCatalog } from "./catalog.js";
import { systemClock } from "./clock.js";
import { createHttpApp } from "./http/app.js";
import { loadOrCreateDaemonId, resolvePath } from "./ids-file.js";
import { createLogger } from "./logger.js";
import { createWorkerRegistry } from "./registry.js";
import type { AuthContext, Daemon, DaemonDeps, DaemonEvent } from "./types.js";

/**
 * The slice of `node:http.Server` this file uses. `@hono/node-server`'s `serve()` is typed as a
 * union of three server classes; naming the two methods keeps the cast honest and the teardown
 * path independent of which one it handed back.
 */
interface BoundServer {
  close(cb?: (e?: Error) => void): void;
  closeAllConnections?: () => void;
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

  await mkdir(resolved.dataDir, { recursive: true });
  const daemonId = await resolveDaemonId(resolved, ids);

  const tokens = createTokenStore(resolved);
  const catalog = createCatalog(resolved);
  const supervisor =
    deps?.supervisor ??
    createSupervisor({ config: resolved.supervisor, clock, logger: logger.child({ mod: "sup" }) });
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

  const workers = createWorkerRegistry({
    daemonId,
    config: resolved,
    catalog,
    supervisor,
    responder,
    clock,
    ids,
    logger: logger.child({ mod: "registry" }),
    onEnvelope: (workerId, envelope) => {
      emit(workerId as WorkerId, envelope as EventEnvelope);
    },
  });

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
        // Present and null, so the field never appears and disappears between milestones (M2).
        policyCeiling: null,
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
      try {
        server = serve(
          {
            fetch: (request: Request) => daemon.fetch(request),
            hostname: listen.host,
            port: listen.port,
            // D17: `POST /v1/workers` legitimately holds a request open for a cold `npx` start,
            // and an SSE stream holds one open indefinitely. Node's 5-minute default cuts both.
            serverOptions: { requestTimeout: 0, headersTimeout: 0 },
          },
          (address) => {
            resolve(address);
          },
        ) as unknown as BoundServer;
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

  if (parsed.eventLog.driver !== "memory") {
    // Parses, and is rejected here: the config SHAPE does not change in M1, only this line
    // does (CONTRACTS.md §8.1).
    throw new OmniError(
      "bad_request",
      `eventLog.driver "${parsed.eventLog.driver}" is M1; M0 supports "memory" only`,
    );
  }

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
