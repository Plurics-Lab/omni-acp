import { OmniError } from "@omni-acp/protocol";
import type {
  Clock,
  DaemonId,
  DeliveryStore,
  IdGen,
  Logger,
  ResolvedRunConfig,
  RunRegistry,
  RunStore,
  WebhookDispatcher,
  WorkerRegistry,
} from "@omni-acp/protocol";

export interface RunRegistryDeps {
  readonly daemonId: DaemonId;
  readonly bootId: string;
  readonly workers: WorkerRegistry;
  readonly store: RunStore;
  readonly deliveries: DeliveryStore;
  readonly dispatcher: WebhookDispatcher | null;
  readonly config: ResolvedRunConfig;
  readonly clock: Clock;
  readonly ids: IdGen;
  readonly logger: Logger;
}

/**
 * DESIGN §9.3's Run API: create + prompt + settle + close, as ONE addressable object.
 *
 * `…/events?since=` proxies the RUN'S WORKER's log rather than adding a second stream writer —
 * which is why `omni.run` is an envelope kind on that log and why `daemon/src/http/sse.ts` stays
 * byte-identical (Land exit criterion 6). `sse-resume.itest.ts`'s frame comparison is reused
 * against a run's stream, so M1's exact `?since=` semantics are proven and not re-implemented.
 *
 * `idempotencyKey` is scoped to the TOKEN and returns the ORIGINAL run on a repeat, across a
 * restart — a retry after a timeout must not start a second agent process.
 *
 * Under the memory driver a run is ALLOWED and reports `persistence:"memory"` (ruling M2-R14):
 * refusing would break `OmniACP.local()`, and saying nothing would let `GET /v1/runs/{rid}` 404
 * mysteriously after a restart.
 *
 * Owned by M2-B-WP-R.
 */
export function createRunRegistry(_o: RunRegistryDeps): RunRegistry {
  throw new OmniError("internal", "unimplemented: M2-B-WP-R");
}
