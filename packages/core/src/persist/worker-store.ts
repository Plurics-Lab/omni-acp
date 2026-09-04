import { OmniError, type WorkerStore } from "@omni-acp/protocol";

/**
 * The durable half of the Worker Registry — D2's `workerId → (agentId, sessionId, cwd, label,
 * owner, state, capabilities, closeResult, …)` (§14.8, L17).
 *
 * It is what makes `GET` / `DELETE` / `?since=` work against a worker THIS PROCESS NEVER
 * CREATED, and it persists `closeResult` so `DELETE` is idempotent across a restart
 * byte-for-byte rather than recomputing a `treeGone` we never proved (§15.6).
 *
 * Visibility (D13) is the REGISTRY's job and never the store's.
 *
 * Owned by M1-WP-A.
 */
export function createSqliteWorkerStore(_db: unknown): WorkerStore {
  throw new OmniError("internal", "unimplemented: M1-WP-A");
}
