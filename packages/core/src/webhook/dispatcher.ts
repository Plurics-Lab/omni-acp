import { OmniError } from "@omni-acp/protocol";
import type {
  Clock,
  DeliveryStore,
  IdGen,
  Logger,
  ResolvedWebhookConfig,
  Resolver,
  WebhookDispatcher,
} from "@omni-acp/protocol";

export interface WebhookDispatcherDeps {
  readonly store: DeliveryStore;
  readonly config: ResolvedWebhookConfig;
  readonly secrets: Readonly<Record<string, string>>;
  readonly bootId: string;
  readonly clock: Clock;
  readonly ids: IdGen;
  readonly logger: Logger;
  readonly resolve: Resolver;
  /** Injected so the delivery tests need no network. */
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * D9's delivery loop. The invariant that shapes every method: **it NEVER blocks a turn.**
 * `dispatch` enqueues and returns; a run whose receiver hangs for the full `timeoutMs` reports
 * its `TurnResult` at the same moment as one with no webhook at all.
 *
 * The delivery rules that are not obvious:
 *  - a `410` is `failed` IMMEDIATELY — the receiver said the resource is gone, and six retries
 *    against a gone endpoint is just noise;
 *  - a `3xx` is a FAILURE and is NOT followed: following a redirect is how an allowlisted origin
 *    becomes an unallowlisted one;
 *  - the response body is NEVER READ (`no-unbounded-outbound`), because a hostile receiver's
 *    reply is unbounded input we have no use for.
 *
 * Restart safety lives in the STORE's `claim` / `requeueStale`: a `delivering` row owned by a
 * foreign boot is re-queued with `attempt` UNCHANGED (it never got its attempt), and two
 * dispatchers racing one row see exactly one `claim` succeed.
 *
 * Owned by M2-B-WP-R.
 */
export function createWebhookDispatcher(_o: WebhookDispatcherDeps): WebhookDispatcher {
  throw new OmniError("internal", "unimplemented: M2-B-WP-R");
}

/** Boot: `delivering` rows from a FOREIGN bootId → `pending`, `attempt` unchanged (§24.4). */
export function recoverDeliveries(_store: DeliveryStore, _bootId: string, _nowMs: number): number {
  throw new OmniError("internal", "unimplemented: M2-B-WP-R");
}
