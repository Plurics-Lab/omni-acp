import { OmniError } from "@omni-acp/protocol";
import type {
  Clock,
  DeliveryStore,
  IdGen,
  Logger,
  PersistenceHandle,
  ResolvedDaemonConfig,
  RunRegistry,
  WebhookDispatcher,
  WorkerRegistry,
} from "@omni-acp/protocol";

/**
 * The daemon's Run wiring: stores, dispatcher, registry, and the boot order they must follow.
 *
 * §24.4's boot order is not a preference —
 * `persistence → worker adopt → run recover → delivery requeue → dispatcher.start → listen` — and
 * every arrow is load-bearing: recovering runs before workers are adopted would abandon runs
 * whose workers were about to be rehydrated, and starting the dispatcher before requeueing would
 * let it claim rows a previous boot still owns.
 *
 * `stop()` runs the mirror: `interactions.settleAll → dispatcher.drain(bounded) → workers →
 * socket`. Settling first is §19.8 — an agent blocked on our answer may never read the shutdown.
 *
 * Owned by M2-B-WP-R.
 */
export function createRunSubsystem(_o: {
  config: ResolvedDaemonConfig;
  persistence: PersistenceHandle | null;
  workers: WorkerRegistry;
  clock: Clock;
  ids: IdGen;
  logger: Logger;
}): { runs: RunRegistry; deliveries: DeliveryStore; dispatcher: WebhookDispatcher | null } {
  throw new OmniError("internal", "unimplemented: M2-B-WP-R");
}
