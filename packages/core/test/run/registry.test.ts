import { describe, it } from "vitest";

/**
 * M2-B-WP-R's acceptance script (docs/M2-PLAN.md §2), one `it.todo` per bullet.
 *
 * Owned by M2-B-WP-R.
 */

describe("M2-B-WP-R — Run API, webhook delivery, persistence v2", () => {
  it.todo(
    "SCHEMA_VERSION 2 is CREATE-only: a v1 file opened by an M2 daemon migrates forward keeping every M1 event, §14.11's conformance suite runs VERBATIM, and a v2 file opened by an M1 daemon still fails loudly naming the version",
  );
  it.todo(
    "planNextAttempt is PURE and reproduces D9's ladder exactly — 0s / 30s / 2m / 10m / 30m / 2h, then failed — under fakeClock() with no network; jitter stays within [0, base*jitter] and rnd is injected",
  );
  it.todo(
    "the delivery body has EXACTLY the eight WebhookPayload keys (webhook-body-is-thin), deliveryId is the idempotency key, and the worker.requires_action payload carries NO request content; signDelivery matches a fixed vector and fakeWebhookReceiver verifies it; a wrong secret fails",
  );
  it.todo(
    "receiver 500 x6 -> failed; 410 -> failed immediately; a hang -> aborted at timeoutMs; a 3xx is a failure and is NOT followed; the response body is NEVER read (no-unbounded-outbound)",
  );
  it.todo(
    "restart safety, four tests: a delivering row with a foreign lease_boot is re-queued with attempt UNCHANGED; two dispatchers racing one row see EXACTLY ONE claim succeed; a live runs row from a foreign boot becomes abandoned with a terminal run.failed delivery enqueued; and a planted throw between the state change and the enqueue leaves NEITHER",
  );
  it.todo("idempotencyKey returns the ORIGINAL run on a repeat, across a restart");
  it.todo(
    "GET /v1/webhooks/deliveries is admin-or-owner only, cursor-paginated, survives a restart, and retentionDays sweeps runs and their deliveries TOGETHER on M1's existing timer; redeliver keeps the deliveryId and resets attempt",
  );
  it.todo(
    "a slow or dead receiver NEVER blocks a turn: a run whose webhook hangs for timeoutMs reports its TurnResult at the same time as one with no webhook",
  );
  it.todo(
    'webhooks.mode:"allowlist" with an empty allow makes a webhook run 403 AT CREATE, not at delivery; a hostname resolving into denyCidrs is 403 — the URL is validated where the operator can see it',
  );
  it.todo(
    'POST /v1/runs = create + prompt + settle + close (or keepWorker), and .../events?since= returns the worker\'s envelopes with M1\'s exact ?since= semantics, proven by REUSING sse-resume.itest.ts\'s frame comparison; a run whose worker parks reports state:"requires_action" and fires run.requires_action; under the memory driver a run is allowed and reports persistence:"memory" (M2-R14)',
  );
});
