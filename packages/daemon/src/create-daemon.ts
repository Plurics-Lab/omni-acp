import { OmniError, type DaemonConfig } from "@omni-acp/protocol";
import type { Daemon, DaemonDeps } from "./types.js";

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
export function createDaemon(config: DaemonConfig, deps?: DaemonDeps): Promise<Daemon> {
  throw new OmniError("internal", "unimplemented: WP-5 (daemon.createDaemon)");
}
