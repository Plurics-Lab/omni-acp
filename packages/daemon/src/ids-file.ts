import { OmniError, type DaemonId, type IdGen } from "@omni-acp/protocol";

/**
 * Reads `<dataDir>/daemon-id`, or mints a `d_`-prefixed ULID and persists it. The daemonId is
 * stable across `createDaemon()` calls because it is half of a `WorkerRef` (D11) — a value that
 * changes on restart would silently re-address every worker.
 */
export function loadOrCreateDaemonId(dataDir: string, ids: IdGen): Promise<DaemonId> {
  throw new OmniError("internal", "unimplemented: WP-5 (daemon.loadOrCreateDaemonId)");
}
