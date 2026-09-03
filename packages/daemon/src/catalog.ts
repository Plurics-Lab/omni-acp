import { OmniError, type ResolvedDaemonConfig } from "@omni-acp/protocol";
import type { Catalog } from "./types.js";

/**
 * The ONLY producer of `SpawnSpec` (CONTRACTS.md §5.4). Composing the child environment in one
 * place is what lets `SpawnSpec.env` be documented as complete — the Supervisor adds nothing and
 * removes nothing, so what you read in the catalog is what the agent gets.
 */
export function createCatalog(config: ResolvedDaemonConfig): Catalog {
  throw new OmniError("internal", "unimplemented: WP-5 (daemon.createCatalog)");
}
