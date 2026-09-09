import { OmniError } from "@omni-acp/protocol";
import type { DatabaseSync } from "node:sqlite";
import type { DeliveryStore } from "@omni-acp/protocol";

/**
 * The `webhook_deliveries` table (schema v2).
 *
 * `claim` is the load-bearing method and it is an ATOMIC compare-and-set: `pending → delivering`
 * stamping this boot's id, returning false when somebody else got there first. Two dispatchers
 * racing one row must see exactly one success, and doing it any other way turns a duplicate
 * delivery into a routine event rather than an accident.
 *
 * `requeueStale` is its restart counterpart: a `delivering` row owned by a FOREIGN boot goes back
 * to `pending` with `attempt` UNCHANGED, because that attempt never happened — charging it would
 * silently shorten the ladder every time the daemon restarted.
 *
 * Owned by M2-B-WP-R.
 */
export function createDeliveryStore(_db: DatabaseSync): DeliveryStore {
  throw new OmniError("internal", "unimplemented: M2-B-WP-R");
}
