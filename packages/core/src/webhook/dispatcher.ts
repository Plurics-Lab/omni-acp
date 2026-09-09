import { OmniError, WEBHOOK_HEADER } from "@omni-acp/protocol";
import type {
  Clock,
  DeliveryId,
  DeliveryRecord,
  DeliveryStore,
  IdGen,
  Logger,
  ResolvedWebhookConfig,
  Resolver,
  RunId,
  TimerHandle,
  TokenId,
  WebhookDispatcher,
  WebhookPayload,
  WebhookTarget,
} from "@omni-acp/protocol";
import type { DeliveryRow, DeliveryStoreV2 } from "../persist/delivery-store.js";
import { assertWebhookUrl } from "./guard.js";
import { planNextAttempt } from "./ladder.js";
import { signDelivery } from "./sign.js";

/**
 * How often the loop looks for a delivery whose rung has come due.
 *
 * It is not `webhooks.backoffMs[1]` and it is not configurable, because it is not a retry
 * interval: `dispatch()` and `redeliver()` both pump IMMEDIATELY, so the only thing this timer
 * ever catches is a rung that fell due while nothing was happening. A second is small next to a
 * 30-second first retry and invisible next to a two-hour last one.
 */
const POLL_MS = 1_000;

export interface WebhookDispatcherDeps {
  readonly store: DeliveryStore;
  readonly config: ResolvedWebhookConfig;
  /** `webhooks.secrets`: NAME → secret value. A client names one; the value never crosses a wire. */
  readonly secrets: Readonly<Record<string, string>>;
  /**
   * Each token's own `webhookSecret` (§5.8.7), by token id.
   *
   * A SECOND map rather than a reserved key range in the first, because the two have different
   * trust stories — one is an operator-declared keyring a client may name, the other is a
   * per-token key a client can never reach — and a shared namespace is how a client-supplied name
   * eventually collides with a token id.
   */
  readonly tokenSecrets: Readonly<Record<string, string>>;
  /**
   * Which key signs THIS row, resolved from the two columns the delivery row keeps.
   *
   * A delivery outlives the boot that created it, and `webhook_deliveries` (§24.2) has no column
   * for a secret NAME — so a dispatcher that remembered the name in memory would sign with a
   * different key after a restart, and every receiver verifying across that restart would reject
   * a delivery that is perfectly authentic. Resolving it from `(tokenId, runId)` makes the answer
   * a function of durable state: the run row holds the target, and the run row is on disk.
   *
   * Absent, or returning null ⇒ this token's own key from `tokenSecrets`.
   */
  readonly secretRefFor?: (r: { tokenId: TokenId; runId: RunId }) => string | null;
  readonly bootId: string;
  readonly clock: Clock;
  readonly ids: IdGen;
  readonly logger: Logger;
  /**
   * The SSRF gate's resolver, used by `redeliver` and by nothing else.
   *
   * §24.6 validates a url at CREATE so the 403 reaches the operator, and §11.9 accepts the
   * residual TOCTOU on the delivery path. `redeliver` is not that path: an operator replays a
   * dead letter hours or days later, by which time a name that was safe may resolve into the
   * metadata range — so the one place where re-checking is both cheap and materially different
   * from the create-time answer does re-check.
   */
  readonly resolve: Resolver;
  /** Injected so the delivery tests need no network. */
  readonly fetch?: typeof globalThis.fetch;
  /** Injected so the ladder's jitter is deterministic in a test (§24.3). */
  readonly rnd?: () => number;
  /** Called after every settled attempt, so the run registry can count deliveries. */
  readonly onSettled?: (r: {
    deliveryId: DeliveryId;
    runId: RunId;
    state: DeliveryRecord["state"];
  }) => void;
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
 *    reply is unbounded input we have no use for. It is CANCELLED, which is the opposite of
 *    reading it and is what returns the socket to the pool.
 *
 * Restart safety lives in the STORE's `claim` / `requeueStale`: a `delivering` row owned by a
 * foreign boot is re-queued with `attempt` UNCHANGED (it never got its attempt), and two
 * dispatchers racing one row see exactly one `claim` succeed.
 *
 * Owned by M2-B-WP-R.
 */
export function createWebhookDispatcher(o: WebhookDispatcherDeps): WebhookDispatcher {
  const store = o.store as DeliveryStoreV2;
  const doFetch = o.fetch ?? globalThis.fetch;
  const rnd = o.rnd ?? Math.random;

  const inFlight = new Set<Promise<void>>();
  let poll: TimerHandle | null = null;
  let started = false;
  let stopped = false;
  let pumping = false;

  const arm = (): void => {
    if (!started || stopped) return;
    poll?.cancel();
    poll = o.clock.setTimer(POLL_MS, () => {
      void pump().finally(arm);
    });
  };

  /**
   * Claim what is due and send it, up to `maxConcurrent` at a time.
   *
   * Single-flight (`pumping`), because two concurrent pumps would both read the same `due()` page
   * and race on `claim` — which the store survives, but only by making one of the two do the
   * whole query for nothing. The loop stops as soon as a page yields no CLAIM rather than no ROW:
   * a page whose rows were all taken by somebody else is the signal that there is no work here.
   */
  const pump = async (): Promise<void> => {
    if (pumping || stopped) return;
    pumping = true;
    try {
      for (;;) {
        const capacity = o.config.maxConcurrent - inFlight.size;
        if (capacity <= 0) return;
        const rows = store.due(o.clock.now(), capacity);
        if (rows.length === 0) return;

        let claimed = 0;
        for (const row of rows) {
          if (inFlight.size >= o.config.maxConcurrent) break;
          if (!store.claim(row.deliveryId, o.bootId, o.clock.now())) continue;
          claimed += 1;
          // `.catch` here, not on the caller: a task that rejects would be an unhandled rejection
          // AND would leave its row `delivering` forever. Neither is allowed to be silent.
          const task = attempt(row).catch((e: unknown) => {
            o.logger.error("webhook attempt threw outside its own error handling", {
              deliveryId: row.deliveryId,
              error: e instanceof Error ? e.message : String(e),
            });
          });
          inFlight.add(task);
          void task.finally(() => inFlight.delete(task));
        }
        if (claimed === 0) return;
      }
    } finally {
      pumping = false;
    }
  };

  /** ONE attempt. It never throws: a delivery that fails is a settled row, not an exception. */
  const attempt = async (row: DeliveryRow): Promise<void> => {
    const startedAt = o.clock.now();
    const body = JSON.stringify(row.payload);
    const secret = secretFor(row);

    if (secret === null) {
      // Refusing to send is the safe half of this branch: an UNSIGNED delivery looks exactly like
      // a signed one to a receiver that forgot to check, so we would be teaching it to stop.
      settle(row, startedAt, null, "no signing secret is configured for this token");
      return;
    }

    // `webhooks.maxBodyBytes` as a RUNTIME canary for the thinness rule. The eight-key payload is
    // a few hundred bytes and cannot approach the 64 KiB default, so this firing means a key that
    // carries content has appeared on the body — which is `webhook-body-is-thin`'s subject caught
    // at the last possible moment, on a machine where the guard does not run.
    if (Buffer.byteLength(body, "utf8") > o.config.maxBodyBytes) {
      settle(
        row,
        startedAt,
        null,
        `delivery body is ${String(Buffer.byteLength(body, "utf8"))} bytes, over ` +
          `webhooks.maxBodyBytes=${String(o.config.maxBodyBytes)}`,
      );
      return;
    }

    const controller = new AbortController();
    const timeout = o.clock.setTimer(o.config.timeoutMs, () => {
      controller.abort(
        new Error(`webhook delivery exceeded timeoutMs=${String(o.config.timeoutMs)}`),
      );
    });

    try {
      const res = await doFetch(row.url, {
        method: "POST",
        // `manual` is the security decision, not a preference: following a redirect turns an
        // allowlisted origin into whatever the receiver names next, which is the entire SSRF gate
        // undone by a `302` (§24.4).
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          [WEBHOOK_HEADER.signature]: signDelivery(secret, Math.floor(o.clock.now() / 1000), body),
          [WEBHOOK_HEADER.deliveryId]: row.deliveryId,
          [WEBHOOK_HEADER.event]: row.event,
          [WEBHOOK_HEADER.attempt]: String(row.attempt + 1),
        },
        body,
      });
      // NOT read — cancelled. `no-unbounded-outbound` is about the bytes never entering this
      // process; cancelling is how the socket goes back to the pool without them.
      void res.body?.cancel().catch(() => {});
      settle(row, startedAt, res.status, statusError(res.status));
    } catch (e) {
      settle(row, startedAt, null, e instanceof Error ? e.message : String(e));
    } finally {
      timeout.cancel();
    }
  };

  /** `null` ⇒ this status is a success. Everything else names why it is not. */
  const statusError = (status: number): string | null => {
    if (status >= 200 && status < 300) return null;
    if (status >= 300 && status < 400) return `redirect ${String(status)} is not followed`;
    return `receiver answered ${String(status)}`;
  };

  const settle = (
    row: DeliveryRow,
    startedAt: number,
    status: number | null,
    error: string | null,
  ): void => {
    const nowMs = o.clock.now();
    const responseMs = nowMs - startedAt;

    if (error === null) {
      store.settle({
        deliveryId: row.deliveryId,
        ok: true,
        status,
        error: null,
        responseMs,
        nextAttemptMs: null,
        state: "delivered",
        nowMs,
      });
      o.onSettled?.({ deliveryId: row.deliveryId, runId: row.runId, state: "delivered" });
      return;
    }

    // `410 Gone` is terminal on the first hearing: retrying a retired endpoint for two hours is
    // rudeness with extra steps, and the receiver has told us the resource will not come back.
    const gone = status === 410;
    const plan = gone
      ? ({ state: "failed", nextAttemptMs: null } as const)
      : planNextAttempt(row.attempt + 1, nowMs, o.config.jitter, rnd, o.config.backoffMs);

    store.settle({
      deliveryId: row.deliveryId,
      ok: false,
      status,
      error: error.slice(0, 500),
      responseMs,
      nextAttemptMs: plan.nextAttemptMs,
      state: plan.state,
      nowMs,
    });
    o.onSettled?.({ deliveryId: row.deliveryId, runId: row.runId, state: plan.state });

    if (plan.state === "failed") {
      o.logger.warn("webhook delivery failed for good", {
        deliveryId: row.deliveryId,
        runId: row.runId,
        event: row.event,
        attempt: row.attempt + 1,
        status,
        error,
      });
    }
  };

  const secretFor = (row: DeliveryRow): string | null => {
    const ref = o.secretRefFor?.({ tokenId: row.tokenId, runId: row.runId }) ?? null;
    if (ref !== null && o.secrets[ref] !== undefined) return o.secrets[ref] ?? null;
    return o.tokenSecrets[row.tokenId] ?? null;
  };

  return {
    start(): void {
      if (stopped) throw new OmniError("internal", "webhook dispatcher was stopped");
      started = true;
      // A boot with rows already due must not wait a whole poll interval for them.
      void pump().finally(arm);
    },

    dispatch(p: Omit<WebhookPayload, "deliveryId">, target: WebhookTarget, tokenId: TokenId) {
      if (p.runId === null) {
        // Every webhook in M2 belongs to a run — `WebhookTarget` exists on `CreateRunRequest` and
        // nowhere else — and `webhook_deliveries.run_id` is `not null`. A caller that gets here
        // with no run has found a wiring bug, and saying so is better than writing an unaddressable
        // row.
        throw new OmniError("internal", "a webhook delivery must belong to a run");
      }
      const deliveryId = o.ids.delivery();
      const payload: WebhookPayload = { ...p, deliveryId };
      store.enqueue({
        deliveryId,
        runId: p.runId,
        tokenId,
        event: p.event,
        url: target.url,
        payload,
        nowMs: o.clock.now(),
      });
      // ENQUEUE AND RETURN. Everything after this line is somebody else's tick — that is the
      // whole of "a slow receiver may not slow an agent".
      //
      // A MICROTASK, not a direct call: `dispatch` is invoked from inside the run registry's
      // one transaction (§24.4 rule 1), and a pump that ran synchronously there would `claim`
      // and start sending a row whose own INSERT had not committed yet.
      queueMicrotask(() => {
        void pump();
      });
      return deliveryId;
    },

    async redeliver(id: DeliveryId): Promise<DeliveryRecord> {
      const existing = store.get(id);
      if (existing === null) throw new OmniError("worker_not_found", `no delivery ${id}`);
      // Re-validated, for the reason on `resolve` above: a dead letter is replayed long after it
      // was created, and the answer to "may this ADDRESS be called" may have changed since.
      await assertWebhookUrl(existing.url, o.config, o.resolve);
      const record = store.redeliver(id, o.clock.now());
      void pump();
      return record;
    },

    /**
     * Drains what is due right now and returns when the in-flight set is empty.
     *
     * The deadline is WALL TIME rather than `clock.now()`, and that is the one place in this file
     * where the injected clock is deliberately not the authority: under `fakeClock()` the clock
     * only moves when a test moves it, so a clock-based bound would make a stuck drain hang
     * forever instead of returning. Draining is a shutdown and test affordance; how long it may
     * take is a question about this process, not about the simulated one.
     */
    async drain(opts?: { timeoutMs?: number }): Promise<void> {
      const deadline = Date.now() + (opts?.timeoutMs ?? 30_000);
      for (;;) {
        await pump();
        // One more look after the pump: an attempt that just settled may have put its own next
        // rung due, and `inFlight` being empty is not the same as there being nothing to do.
        if (inFlight.size === 0 && store.due(o.clock.now(), 1).length === 0) return;
        if (Date.now() > deadline) return;
        await Promise.race([...inFlight, tick()]);
      }
    },

    async stop(): Promise<void> {
      stopped = true;
      started = false;
      poll?.cancel();
      poll = null;
      // Bounded, and NOT a cancel: an in-flight attempt that is about to settle should be allowed
      // to record its result, or the next boot re-queues a delivery the receiver already has.
      await Promise.all([...inFlight]).catch(() => {});
    },
  };
}

/** A real macrotask, so `drain()` cannot spin the event loop while an attempt is in flight. */
const tick = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 1));

/**
 * Boot: `delivering` rows from a FOREIGN bootId → `pending`, `attempt` unchanged (§24.4).
 *
 * It runs BEFORE `dispatcher.start()`, and the order is the correctness argument: a dispatcher
 * that started first could claim a row this call was about to re-queue, and the two writes would
 * race for a row whose whole purpose is to be owned by exactly one of them.
 */
export function recoverDeliveries(store: DeliveryStore, bootId: string, nowMs: number): number {
  return store.requeueStale(bootId, nowMs);
}
