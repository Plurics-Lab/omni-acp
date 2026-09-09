import { OmniError } from "@omni-acp/protocol";
import type { DatabaseSync } from "node:sqlite";
import type { RunStore } from "@omni-acp/protocol";

/**
 * The `runs` table (schema v2), behind the same prepared-statement discipline `worker-store.ts`
 * uses.
 *
 * `bootId` is a column rather than a detail, because §24.4's recovery is a QUERY: "every live run
 * that is not mine". `idempotency_key` is indexed per token, so a retry after a client timeout
 * finds the original run instead of starting a second agent process.
 *
 * Owned by M2-B-WP-R.
 */
export function createRunStore(_db: DatabaseSync): RunStore {
  throw new OmniError("internal", "unimplemented: M2-B-WP-R");
}
