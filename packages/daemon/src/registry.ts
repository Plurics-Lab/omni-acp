import {
  OmniError,
  type Clock,
  type DaemonId,
  type IdGen,
  type Logger,
  type PermissionResponder,
  type ResolvedDaemonConfig,
  type Supervisor,
} from "@omni-acp/protocol";
import type { Catalog, WorkerRegistry } from "./types.js";

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
  throw new OmniError("internal", "unimplemented: WP-5 (daemon.createWorkerRegistry)");
}
