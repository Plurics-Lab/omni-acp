import {
  RunConfig,
  WebhookConfig,
  type CreateRunRequest,
  type DeliveryId,
  type RunRegistry,
  type TokenId,
  type WebhookDispatcher,
  type WebhookEvent,
  type WebhookPayload,
  type WebhookTarget,
} from "@omni-acp/protocol";
import { fakeClock, nullLogger, seqIds, type FakeClock } from "@omni-acp/testkit";
import { createRunRegistry } from "../../../src/run/registry.js";
import { DAEMON_ID } from "../../persist/support/harness.js";
import { rawStore, type RawStore } from "../../persist/support/raw-db.js";
import { fakeWorkers, type FakeWorkerRegistry } from "./fake-workers.js";

/**
 * The run registry over REAL v2 stores and a scripted worker registry.
 *
 * The stores are the shipped SQLite ones, on a temp file, because half of §24's obligations are
 * about what survives a restart — and a registry tested against an in-memory double would prove
 * nothing about the pair of tables the obligations are actually written on.
 *
 * The DISPATCHER is a recorder rather than the real one: these tests are about what the registry
 * enqueues and when, and the real dispatcher has its own suite for what happens after. The one
 * property both need — that the enqueue and the state change are ONE transaction — is asserted
 * here with a planted throw, which needs a dispatcher that can be made to fail on demand.
 *
 * Owned by M2-B-WP-R.
 */

export interface RecordedDispatch {
  readonly payload: Omit<WebhookPayload, "deliveryId">;
  readonly target: WebhookTarget;
  readonly tokenId: TokenId;
}

export interface RecordingDispatcher extends WebhookDispatcher {
  readonly sent: readonly RecordedDispatch[];
  /** Make the next `dispatch` throw — the planted failure §24.4 rule 1 is tested with. */
  failNext(e: unknown): void;
}

export function recordingDispatcher(): RecordingDispatcher {
  const sent: RecordedDispatch[] = [];
  let next = 0;
  let failure: unknown = null;
  return {
    sent,
    failNext(e: unknown): void {
      failure = e;
    },
    start(): void {},
    dispatch(payload, target, tokenId): DeliveryId {
      if (failure !== null) {
        const e = failure;
        failure = null;
        throw e;
      }
      sent.push({ payload, target, tokenId });
      return `dl_${String(++next).padStart(26, "0")}` as DeliveryId;
    },
    redeliver: () => Promise.reject(new Error("not part of a registry test")),
    drain: () => Promise.resolve(),
    stop: () => Promise.resolve(),
  };
}

export interface Rig {
  readonly runs: RunRegistry;
  readonly workers: FakeWorkerRegistry;
  readonly dispatcher: RecordingDispatcher;
  readonly store: RawStore;
  readonly clock: FakeClock;
  /** Every event the dispatcher was handed, in order. */
  events(): readonly WebhookEvent[];
  dispose(): Promise<void>;
}

export const runRequest = (o: Partial<CreateRunRequest> = {}): CreateRunRequest =>
  ({
    agent: "fixture",
    cwd: "/tmp/fixture",
    prompt: [{ type: "text", text: "Reply with exactly the word PONG." }],
    ...o,
  }) as CreateRunRequest;

export async function rig(
  o: {
    webhooks?: Parameters<typeof WebhookConfig.parse>[0];
    run?: Parameters<typeof RunConfig.parse>[0];
    tokenSecrets?: Record<string, string>;
    resolve?: (host: string) => Promise<readonly string[]>;
    persistence?: "memory" | "durable" | "degraded";
    dispatcher?: RecordingDispatcher | null;
    /**
     * A dispatcher that WRITES to the store, for the boot path.
     *
     * §24.4 rule 4 is about a delivery ROW existing after `recover()`, and a recorder cannot say
     * whether one does. This one enqueues for real and asserts nothing else.
     */
    realEnqueue?: boolean;
    bootId?: string;
    store?: RawStore;
  } = {},
): Promise<Rig> {
  const store = o.store ?? (await rawStore());
  const clock = fakeClock();
  const ids = seqIds();
  const workers = fakeWorkers({ clock, ids, daemonId: DAEMON_ID });
  const recorder = o.dispatcher ?? recordingDispatcher();
  const enqueueing: RecordingDispatcher = {
    ...recorder,
    dispatch(payload, target, tokenId) {
      const deliveryId = recorder.dispatch(payload, target, tokenId);
      store.deliveries.enqueue({
        deliveryId,
        runId: payload.runId ?? ("r_missing" as never),
        tokenId,
        event: payload.event,
        url: target.url,
        payload: { ...payload, deliveryId },
        nowMs: clock.now(),
      });
      return deliveryId;
    },
  };
  const dispatcher = o.dispatcher === null ? null : o.realEnqueue === true ? enqueueing : recorder;

  const runs = createRunRegistry({
    daemonId: DAEMON_ID,
    bootId: o.bootId ?? "boot_a",
    workers,
    store: store.runs,
    deliveries: store.deliveries,
    dispatcher,
    config: RunConfig.parse(o.run ?? {}),
    clock,
    ids,
    logger: nullLogger(),
    webhooks: WebhookConfig.parse({
      enabled: true,
      mode: "any",
      denyCidrs: [],
      ...(o.webhooks ?? {}),
    }),
    resolve: o.resolve ?? (async () => await Promise.resolve(["93.184.216.34"])),
    tokenSecrets: o.tokenSecrets ?? {
      alice: "a-token-signing-secret-at-least-32b",
      bob: "b-token-signing-secret-at-least-32b",
    },
    persistence: o.persistence ?? "durable",
    transaction: (fn) => store.transaction(fn),
  });

  return {
    runs,
    workers,
    dispatcher: dispatcher ?? recorder,
    store,
    clock,
    events: () => recorder.sent.map((s) => s.payload.event),
    async dispose(): Promise<void> {
      if (o.store === undefined) await store.dispose();
    },
  };
}

/** Waits for a predicate on real time — a run converges on its own tick, not on a clock. */
export async function until(p: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!p()) {
    if (Date.now() > deadline) throw new Error("until() timed out");
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
}
