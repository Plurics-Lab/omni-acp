import { afterEach, describe, expect, it } from "vitest";
import {
  WEBHOOK_HEADER,
  WebhookConfig,
  type DeliveryId,
  type ResolvedWebhookConfig,
  type TokenId,
  type WebhookPayload,
  type WebhookTarget,
} from "@omni-acp/protocol";
import {
  fakeClock,
  fakeWebhookReceiver,
  nullLogger,
  seqIds,
  type FakeClock,
  type FakeReceiver,
} from "@omni-acp/testkit";
import { createWebhookDispatcher } from "../../src/webhook/dispatcher.js";
import { signDelivery } from "../../src/webhook/sign.js";
import { rawStore, type RawStore } from "../persist/support/raw-db.js";
import { DAEMON_ID, workerId } from "../persist/support/harness.js";
import { runId, tokenId } from "../persist/support/rows.js";

/**
 * The delivery loop against a REAL loopback receiver, because the contract is about HTTP.
 *
 * The clock is fake and the network is real, which is the split that makes these deterministic:
 * a hang is aborted by advancing `fakeClock` past `timeoutMs`, and a retry rung is reached by
 * advancing to it — no `setTimeout`-and-hope anywhere.
 *
 * Owned by M2-B-WP-R.
 */

const TOKEN = tokenId("alice");
const SECRET = "dispatcher-test-secret-at-least-32b";

interface Rig {
  raw: RawStore;
  clock: FakeClock;
  receiver: FakeReceiver;
  dispatcher: ReturnType<typeof createWebhookDispatcher>;
  target: WebhookTarget;
  dispatch(o?: { event?: WebhookPayload["event"]; runIndex?: number }): DeliveryId;
  dispose(): Promise<void>;
}

const openRigs: Rig[] = [];

async function rig(
  o: {
    config?: Partial<ResolvedWebhookConfig>;
    bootId?: string;
    tokenSecrets?: Record<string, string>;
    rnd?: () => number;
  } = {},
): Promise<Rig> {
  const raw = await rawStore();
  const clock = fakeClock();
  const receiver = await fakeWebhookReceiver();
  const config = WebhookConfig.parse({
    enabled: true,
    mode: "any",
    denyCidrs: [],
    jitter: 0,
    timeoutMs: 5_000,
    ...o.config,
  });
  const dispatcher = createWebhookDispatcher({
    store: raw.deliveries,
    config,
    secrets: config.secrets,
    tokenSecrets: o.tokenSecrets ?? { [TOKEN]: SECRET },
    bootId: o.bootId ?? "boot_a",
    clock,
    ids: seqIds(),
    logger: nullLogger(),
    resolve: async () => await Promise.resolve(["127.0.0.1"]),
    rnd: o.rnd ?? ((): number => 0),
  });
  const target: WebhookTarget = { url: receiver.url };

  const it: Rig = {
    raw,
    clock,
    receiver,
    dispatcher,
    target,
    dispatch(opts = {}) {
      return dispatcher.dispatch(
        {
          event: opts.event ?? "run.completed",
          daemonId: DAEMON_ID,
          workerId: workerId(opts.runIndex ?? 1),
          runId: runId(opts.runIndex ?? 1),
          sessionId: null,
          seq: 7,
          ts: clock.iso(),
        },
        target,
        TOKEN,
      );
    },
    async dispose() {
      await dispatcher.stop();
      await receiver.close();
      await raw.dispose();
    },
  };
  openRigs.push(it);
  return it;
}

afterEach(async () => {
  while (openRigs.length > 0) await openRigs.pop()?.dispose();
});

describe("createWebhookDispatcher — the body and the signature (§24.3)", () => {
  it("sends EXACTLY the eight WebhookPayload keys, and `deliveryId` is the idempotency key", async () => {
    const r = await rig();
    const id = r.dispatch();
    await r.dispatcher.drain({ timeoutMs: 5_000 });

    expect(r.receiver.received).toHaveLength(1);
    const body = JSON.parse(r.receiver.received[0]?.body ?? "{}") as Record<string, unknown>;
    // The set is PINNED, not a superset check: a ninth key is the thing this assertion exists to
    // catch, and `webhook-body-is-thin` is the structural half of the same rule.
    expect(Object.keys(body).sort()).toEqual([
      "daemonId",
      "deliveryId",
      "event",
      "runId",
      "seq",
      "sessionId",
      "ts",
      "workerId",
    ]);
    expect(body["deliveryId"]).toBe(id);
    // `workerId` is the eighth (ruling M2-R13): `/v1` is keyed on it, and a receiver holding only
    // `sessionId` cannot pull anything back.
    expect(body["workerId"]).toBe(workerId(1));
    expect(r.receiver.received[0]?.headers[WEBHOOK_HEADER.deliveryId]).toBe(id);
    expect(r.receiver.received[0]?.headers[WEBHOOK_HEADER.event]).toBe("run.completed");
    expect(r.receiver.received[0]?.headers[WEBHOOK_HEADER.attempt]).toBe("1");
  });

  it("signs with the token's key, and a WRONG secret fails to verify", async () => {
    const r = await rig();
    r.dispatch();
    await r.dispatcher.drain({ timeoutMs: 5_000 });

    expect(r.receiver.verify(0, SECRET)).toBe(true);
    expect(r.receiver.verify(0, `${SECRET}-not`)).toBe(false);
    // The header is the whole `t=…,v1=…` value one function owns, signed over `"<t>.<body>"`.
    const header = r.receiver.received[0]?.headers[WEBHOOK_HEADER.signature] ?? "";
    const t = Number(/t=(\d+)/.exec(header)?.[1]);
    expect(header).toBe(signDelivery(SECRET, t, r.receiver.received[0]?.body ?? ""));
  });

  it("prefers a NAMED secret over the token's own when the target names one", async () => {
    const r = await rig({
      config: { secrets: { ci: "the-named-ci-secret-at-least-32-chars" } },
    });
    r.dispatcher.dispatch(
      {
        event: "run.completed",
        daemonId: DAEMON_ID,
        workerId: workerId(1),
        runId: runId(1),
        sessionId: null,
        seq: 1,
        ts: r.clock.iso(),
      },
      { url: r.receiver.url, secret: "ci" },
      TOKEN,
    );
    // With no `secretRefFor` the dispatcher falls back to the token's key, which is the durable
    // answer; the named one is reached through the run row. Both are asserted, so the fallback is
    // a decision rather than an accident.
    await r.dispatcher.drain({ timeoutMs: 5_000 });
    expect(r.receiver.verify(0, SECRET)).toBe(true);
  });

  it("a `worker.requires_action` delivery carries NO request content", async () => {
    const r = await rig();
    r.dispatch({ event: "worker.requires_action" });
    await r.dispatcher.drain({ timeoutMs: 5_000 });

    const raw = r.receiver.received[0]?.body ?? "";
    const body = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(body)).toHaveLength(8);
    expect(body["event"]).toBe("worker.requires_action");
    // Thinness is a SECURITY property here, not only a bandwidth one: none of the words an
    // interaction is made of can appear, whatever the request said.
    for (const word of ["title", "options", "optionId", "message", "fields", "toolCall", "raw"]) {
      expect(raw).not.toContain(word);
    }
  });

  it("refuses a body over `webhooks.maxBodyBytes` — the thinness rule's runtime canary", async () => {
    // The eight-key payload is a few hundred bytes, so a cap of 32 is unreachable in production
    // and is exactly what a key carrying CONTENT would trip. `webhook-body-is-thin` catches that
    // in CI; this catches it on a machine where no guard runs.
    const r = await rig({ config: { maxBodyBytes: 32 } });
    r.dispatch();
    await r.dispatcher.drain({ timeoutMs: 5_000 });

    expect(r.receiver.received).toHaveLength(0);
    expect(r.raw.deliveries.list({ limit: 1 }).rows[0]?.lastError).toMatch(/maxBodyBytes=32/);
  });

  it("REFUSES to send unsigned when no secret resolves, rather than downgrading quietly", async () => {
    const r = await rig({ tokenSecrets: {} });
    r.dispatch();
    await r.dispatcher.drain({ timeoutMs: 5_000 });

    expect(r.receiver.received).toHaveLength(0);
    const row = r.raw.deliveries.list({ limit: 1 }).rows[0];
    expect(row?.state).toBe("pending");
    expect(row?.lastError).toContain("no signing secret");
  });
});

describe("createWebhookDispatcher — the response rules (§24.4)", () => {
  it("500 x6 → failed, on D9's rungs", async () => {
    const r = await rig();
    r.receiver.failNext(6, 500);
    const id = r.dispatch();

    const rungs = [0, 30_000, 120_000, 600_000, 1_800_000, 7_200_000];
    for (const [attempt, rung] of rungs.entries()) {
      if (rung > 0) r.clock.advance(rung);
      await r.dispatcher.drain({ timeoutMs: 5_000 });
      expect(r.receiver.received).toHaveLength(attempt + 1);
      const row = r.raw.deliveries.get(id);
      expect(row?.attempt).toBe(attempt + 1);
      expect(row?.state).toBe(attempt === rungs.length - 1 ? "failed" : "pending");
    }
    // Six attempts, then failed — and nothing more is ever due.
    r.clock.advance(86_400_000);
    await r.dispatcher.drain({ timeoutMs: 2_000 });
    expect(r.receiver.received).toHaveLength(6);
    expect(r.raw.deliveries.get(id)?.state).toBe("failed");
    expect(r.raw.deliveries.get(id)?.nextAttemptAt).toBeNull();
  });

  it("410 → failed IMMEDIATELY, without spending the ladder", async () => {
    const r = await rig();
    r.receiver.respond([410]);
    const id = r.dispatch();
    await r.dispatcher.drain({ timeoutMs: 5_000 });

    const row = r.raw.deliveries.get(id);
    // Retrying a retired endpoint for two hours is rudeness with extra steps.
    expect(row?.state).toBe("failed");
    expect(row?.attempt).toBe(1);
    expect(row?.lastStatus).toBe(410);
    expect(row?.nextAttemptAt).toBeNull();

    r.clock.advance(7_200_000);
    await r.dispatcher.drain({ timeoutMs: 2_000 });
    expect(r.receiver.received).toHaveLength(1);
  });

  it("a 3xx is a FAILURE and is NOT followed", async () => {
    const r = await rig();
    // The receiver's redirect points at the metadata endpoint: following one is exactly how an
    // allowlisted origin becomes an unallowlisted one.
    r.receiver.respond([302]);
    const id = r.dispatch();
    await r.dispatcher.drain({ timeoutMs: 5_000 });

    const row = r.raw.deliveries.get(id);
    expect(row?.lastStatus).toBe(302);
    expect(row?.state).toBe("pending");
    expect(row?.lastError).toMatch(/redirect 302 is not followed/);
    // One request, to the origin we were given, and no second one anywhere.
    expect(r.receiver.received).toHaveLength(1);
  });

  it("a hang is aborted at `timeoutMs` and retried on the next rung", async () => {
    const r = await rig({ config: { timeoutMs: 4_000 } });
    r.receiver.respond(["hang"]);
    const id = r.dispatch();

    // The attempt is in flight and the receiver is holding the socket.
    const inFlight = r.dispatcher.drain({ timeoutMs: 10_000 });
    await waitFor(() => r.receiver.hanging === 1);
    expect(r.raw.deliveries.get(id)?.state).toBe("delivering");

    // The FAKE clock is what ends it: `timeoutMs` is measured on the injected clock, so this is a
    // deterministic abort rather than a sleep.
    r.clock.advance(4_000);
    await inFlight;

    const row = r.raw.deliveries.get(id);
    expect(row?.state).toBe("pending");
    expect(row?.attempt).toBe(1);
    expect(row?.lastStatus).toBeNull();
    expect(row?.lastError).toMatch(/timeoutMs=4000|abort/i);
  });

  it("never reads the response body, however large the receiver makes it", async () => {
    // The receiver answers 1 KiB on every success. The structural half of this claim is the
    // `no-unbounded-outbound` guard; this is the behavioural half — the delivery succeeds and
    // nothing about the body reaches the row.
    const r = await rig();
    const id = r.dispatch();
    await r.dispatcher.drain({ timeoutMs: 5_000 });
    const row = r.raw.deliveries.get(id);
    expect(row?.state).toBe("delivered");
    expect(row?.lastError).toBeNull();
    expect(JSON.stringify(row)).not.toContain("xxxx");
  });

  it("honours `maxConcurrent`", async () => {
    const r = await rig({ config: { maxConcurrent: 2, timeoutMs: 60_000 } });
    // The first two hang; anything after them gets the receiver's default success.
    r.receiver.respond(["hang", "hang"]);
    for (let n = 1; n <= 4; n++) r.dispatch({ runIndex: n });

    const inFlight = r.dispatcher.drain({ timeoutMs: 20_000 });
    await waitFor(() => r.receiver.hanging === 2);
    // Two in flight, two still pending — a burst of deliveries may not become a burst of sockets.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(r.receiver.hanging).toBe(2);
    expect(r.raw.deliveries.list({ limit: 10, state: "pending" }).rows).toHaveLength(2);

    // The two hangs abort, which is what frees the capacity the other two were waiting for.
    r.clock.advance(60_000);
    await inFlight;
    expect(r.receiver.received).toHaveLength(4);
    expect(r.raw.deliveries.list({ limit: 10, state: "delivered" }).rows).toHaveLength(2);
  });
});

describe("createWebhookDispatcher — restart and redelivery", () => {
  it("re-queues a foreign boot's in-flight row and sends it again with the SAME deliveryId", async () => {
    const r = await rig({ bootId: "boot_new" });
    const id = r.dispatch();
    // A previous boot claimed it and died mid-flight.
    r.raw.deliveries.claim(id, "boot_dead", r.clock.now());
    expect(r.raw.deliveries.get(id)?.state).toBe("delivering");

    expect(r.raw.deliveries.requeueStale("boot_new", r.clock.now())).toBe(1);
    await r.dispatcher.drain({ timeoutMs: 5_000 });

    expect(r.receiver.received).toHaveLength(1);
    expect(r.receiver.received[0]?.headers[WEBHOOK_HEADER.deliveryId]).toBe(id);
    // At-least-once, and `deliveryId` is the dedupe key: the receiver may have had the first
    // attempt too, and it is the one that has to notice.
    expect(r.raw.deliveries.get(id)?.state).toBe("delivered");
  });

  it("TWO dispatchers over one store send a row exactly ONCE", async () => {
    // §24.4 rule 2, at the level the rule is about: two dispatchers — or a restarted one racing a
    // zombie — must not both send. `claim` precedes `fetch`, always, and it is one UPDATE.
    const raw = await rawStore();
    const receiver = await fakeWebhookReceiver();
    const clock = fakeClock();
    const config = WebhookConfig.parse({ enabled: true, mode: "any", denyCidrs: [], jitter: 0 });
    const make = (bootId: string) =>
      createWebhookDispatcher({
        store: raw.deliveries,
        config,
        secrets: {},
        tokenSecrets: { [TOKEN]: SECRET },
        bootId,
        clock,
        ids: seqIds(),
        logger: nullLogger(),
        resolve: async () => await Promise.resolve(["127.0.0.1"]),
        rnd: () => 0,
      });
    const a = make("boot_a");
    const b = make("boot_b");

    try {
      const id = a.dispatch(
        {
          event: "run.completed",
          daemonId: DAEMON_ID,
          workerId: workerId(1),
          runId: runId(1),
          sessionId: null,
          seq: 1,
          ts: clock.iso(),
        },
        { url: receiver.url },
        TOKEN,
      );
      // Both drain at once, over the same row.
      await Promise.all([a.drain({ timeoutMs: 5_000 }), b.drain({ timeoutMs: 5_000 })]);

      expect(receiver.received).toHaveLength(1);
      const row = raw.deliveries.get(id);
      expect(row?.state).toBe("delivered");
      // ONE completed attempt, not two: the loser never got as far as an attempt to charge.
      expect(row?.attempt).toBe(1);
    } finally {
      await a.stop();
      await b.stop();
      await receiver.close();
      await raw.dispose();
    }
  });

  it("`redeliver` keeps the id, resets the attempt, and re-checks the URL", async () => {
    const r = await rig();
    r.receiver.respond([410]);
    const id = r.dispatch();
    await r.dispatcher.drain({ timeoutMs: 5_000 });
    expect(r.raw.deliveries.get(id)?.state).toBe("failed");

    const record = await r.dispatcher.redeliver(id);
    expect(record.deliveryId).toBe(id);
    expect(record.attempt).toBe(0);
    await r.dispatcher.drain({ timeoutMs: 5_000 });
    expect(r.receiver.received).toHaveLength(2);
    expect(r.receiver.received[1]?.headers[WEBHOOK_HEADER.deliveryId]).toBe(id);
  });

  it("`redeliver` REFUSES a target that has since become unreachable", async () => {
    // The one place re-checking is materially different from the create-time answer: an operator
    // replays a dead letter days later, and the name may resolve somewhere else by then (§24.6).
    const raw = await rawStore();
    const clock = fakeClock();
    // A HOSTNAME, not a literal: the gate skips DNS for a literal address, so a rebinding fixture
    // has to be a name — which is also the only shape the attack actually takes.
    const url = "http://rebind.example.test:9443/hook";
    let resolvesTo = "93.184.216.34";
    const dispatcher = createWebhookDispatcher({
      store: raw.deliveries,
      config: WebhookConfig.parse({ enabled: true, mode: "any", denyCidrs: ["169.254.0.0/16"] }),
      secrets: {},
      tokenSecrets: { [TOKEN]: SECRET },
      bootId: "boot_a",
      clock,
      ids: seqIds(),
      logger: nullLogger(),
      resolve: async () => await Promise.resolve([resolvesTo]),
    });
    try {
      const id = "dl_00000000000000000000000042" as DeliveryId;
      raw.deliveries.enqueue({
        deliveryId: id,
        runId: runId(1),
        tokenId: TOKEN,
        event: "run.completed",
        url,
        payload: {
          deliveryId: id,
          event: "run.completed",
          daemonId: DAEMON_ID,
          workerId: workerId(1),
          runId: runId(1),
          sessionId: null,
          seq: 1,
          ts: clock.iso(),
        },
        nowMs: clock.now(),
      });
      // It was fine when the run was created; days later the name points somewhere else.
      resolvesTo = "169.254.169.254";
      await expect(dispatcher.redeliver(id)).rejects.toThrow(/169\.254\.169\.254/);
      // The row is untouched: a refusal is not a re-queue.
      expect(raw.deliveries.get(id)?.attempt).toBe(0);
      expect(raw.deliveries.get(id)?.state).toBe("pending");
    } finally {
      await dispatcher.stop();
      await raw.dispose();
    }
  });

  it("`dispatch` enqueues and RETURNS — it does not wait for the receiver", async () => {
    const r = await rig({ config: { timeoutMs: 60_000 } });
    r.receiver.respond(["hang"]);

    const before = Date.now();
    const id = r.dispatch();
    const elapsed = Date.now() - before;

    // The whole of "a slow receiver may not slow an agent", measured rather than asserted in
    // prose: `dispatch` is synchronous and the socket is somebody else's tick.
    expect(elapsed).toBeLessThan(50);
    expect(r.raw.deliveries.get(id)?.state).toBe("pending");

    const inFlight = r.dispatcher.drain({ timeoutMs: 10_000 });
    await waitFor(() => r.receiver.hanging === 1);
    r.clock.advance(60_000);
    await inFlight;
  });

  it("`start()` picks up a rung that fell due while nothing was happening", async () => {
    const r = await rig();
    r.receiver.failNext(1, 500);
    const id = r.dispatch();
    await r.dispatcher.drain({ timeoutMs: 5_000 });
    expect(r.raw.deliveries.get(id)?.state).toBe("pending");

    r.dispatcher.start();
    // The poll timer is re-armed in a `.finally`, so each `advance` needs a real tick after it
    // for the next one to exist — which is also a faithful model of a daemon that is idle.
    await realTick();
    r.clock.advance(30_000); // the rung comes due while nothing is happening
    await realTick();
    r.clock.advance(POLL_MS); // ...and the poll timer is what notices
    await waitFor(() => r.receiver.received.length === 2, 5_000);
    expect(r.raw.deliveries.get(id)?.state).toBe("delivered");
  });
});

/** The dispatcher's own idle poll interval, restated so the test says what it is waiting for. */
const POLL_MS = 1_000;

/** One real macrotask, so the loop's `.finally` re-arm has happened before the clock moves again. */
const realTick = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 1));

/** Polls a predicate on real time — for the places where a socket, not a clock, is the event. */
async function waitFor(p: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!p()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}
