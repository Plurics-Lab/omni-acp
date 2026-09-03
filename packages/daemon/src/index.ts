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
