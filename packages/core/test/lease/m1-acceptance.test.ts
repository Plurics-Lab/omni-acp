import { describe, it } from "vitest";

/** M1-WP-D's acceptance bullets, one `it.todo` each (M1-PLAN §2, WP-D). */
describe("M1-WP-D — lease, fencing epoch, 423, observer mode", () => {
  it.todo(
    "runLeaseConformance is green against the Lease OBJECT and against the HTTP SURFACE, so the two cannot drift",
  );
  it.todo(
    "a non-holder's prompt / cancel / hibernate / wake / DELETE is 423 with body.lease.holder and body.lease.epoch",
  );
  it.todo(
    "an observer's SSE stream receives EVERY envelope of the holder's turn, omni.lease included; attach and GET are never 423",
  );
  it.todo(
    "steal transfers, bumps the epoch, appends an audited envelope carrying `reason`, and the previous holder's next call is 423",
  );
  it.todo("a STALE Omni-Lease-Epoch is 423 even from the right client id");
  it.todo(
    "a lease never expires mid-turn: fakeClock, ttlMs shorter than the turn, pinExpiry refcounted, and a pinned lease reports expiresAt: null",
  );
  it.todo(
    "hibernate releases the lease; an expired lease is acquirable by anyone; every transition emits exactly ONE omni.lease",
  );
  it.todo(
    "lease.requireClientId:true makes a header-less gated request 400; the default false keeps curl-shapes.itest.ts passing",
  );
  it.todo("M0's two-workers-do-not-interfere.itest.ts still passes UNTOUCHED");
});
