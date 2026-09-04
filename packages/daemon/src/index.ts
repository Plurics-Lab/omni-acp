/**
 * @omni-acp/daemon — the library, plus an HTTP adapter over it.
 *
 * FROZEN by the scaffold (M0-PLAN.md §1.2): re-export only.
 */

export { createDaemon } from "./create-daemon.js";
export type {
  AuthContext,
  Catalog,
  Daemon,
  DaemonDeps,
  DaemonEvent,
  WorkerRegistry,
} from "./types.js";
export { createHttpApp } from "./http/app.js";

// ── M1 additions (CONTRACTS.md §5.7) ────────────────────────────────────────
export { createProbeService, type ProbeService } from "./probe-service.js";
export { createProbeCache, type ProbeCache } from "./probe-cache.js";
export { recoverFromPreviousBoot } from "./boot-recovery.js";
export { openDaemonPersistence } from "./event-store.js";
export { registerLeaseRoutes } from "./http/routes/lease.js";
export { registerAgentRoutes } from "./http/routes/agents.js";
