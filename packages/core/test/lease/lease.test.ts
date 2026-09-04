import { describe, expect, it } from "vitest";
import {
  LeaseConfig,
  OmniError,
  type ClientRef,
  type Lease,
  type LeaseEventPayload,
  type ResolvedLeaseConfig,
  type TokenId,
  type WorkerId,
} from "@omni-acp/protocol";
import { fakeClock, type FakeClock } from "@omni-acp/testkit";
import { createLease } from "@omni-acp/core";

/**
 * `createLease`'s behaviour where the shared conformance suite cannot reach: the config knobs
 * (`requireClientId`, `stealAfterIdleMs`, `renewOnUse`, `ttlMs: 0`), the seeded creator, the
 * `onEvent` sink and `close()`.
 *
 * Everything §16.4 enumerates is in `conformance.test.ts` and is run twice — once here against
 * the object, once in `packages/daemon/test/http/lease.test.ts` against the wire.
 */

const WID = "w_00000000000000000000000001" as WorkerId;
const A: ClientRef = { tokenId: "tok_a" as TokenId, clientId: "cli_a" };
const A2: ClientRef = { tokenId: "tok_a" as TokenId, clientId: "cli_b" };
const ANON: ClientRef = { tokenId: "tok_a" as TokenId, clientId: null };
const C: ClientRef = { tokenId: "tok_c" as TokenId, clientId: "cli_c" };

interface Fixture {
  readonly lease: Lease;
  readonly clock: FakeClock;
  readonly events: LeaseEventPayload[];
  readonly config: ResolvedLeaseConfig;
}

function fixture(o?: {
  config?: Partial<Record<string, unknown>>;
  initialHolder?: ClientRef | null;
}): Fixture {
  const clock = fakeClock();
  const config = LeaseConfig.parse(o?.config ?? {});
  const events: LeaseEventPayload[] = [];
  const lease = createLease({
    workerId: WID,
    clock,
    config,
    // `onEvent` is the sink `registry.create()` points at the worker's own log (rule L9). Here
    // it is an array, which is the same assertion with less machinery.
    onEvent: (e) => events.push(e),
    ...(o?.initialHolder === undefined ? {} : { initialHolder: o.initialHolder }),
  });
  return { lease, clock, events, config };
}

/** The thrown `OmniError`, or a failure that says which call was supposed to throw. */
function thrown(what: string, fn: () => unknown): OmniError {
  try {
    fn();
  } catch (e) {
    expect(e, `${what} must throw an OmniError`).toBeInstanceOf(OmniError);
    return e as OmniError;
  }
  throw new Error(`${what}: expected a throw, but the call returned`);
}

describe('createLease — the creator\'s lease (H5 `lease: "take"`)', () => {
  it("is held from birth, at epoch 1, with a deadline, and WITHOUT an envelope", () => {
    const { lease, events, clock } = fixture({ initialHolder: A });
    const snapshot = lease.snapshot();
    expect(snapshot.holder).toEqual({ tokenId: A.tokenId, clientId: A.clientId });
    // Epoch 1, not 0: "how many times control has been taken". 0 is `alwaysGrantedLease`'s
    // "never contested", and the two must not be confusable by a fencing client.
    expect(snapshot.epoch).toBe(1);
    expect(snapshot.acquiredAt).toBe(new Date(clock.now()).toISOString());
    expect(snapshot.expiresAt).not.toBeNull();
    // §8.2 rule 2 fixes seq 1 of every worker's log as `worker_state{starting}`, and this
    // factory runs BEFORE the worker exists. Seeding is a value, not a transition.
    expect(events).toEqual([]);
  });

  it('is UNHELD when the registry passes null (`lease: "observe"`), at epoch 0', () => {
    const { lease, events } = fixture({ initialHolder: null });
    expect(lease.snapshot().holder).toBeNull();
    expect(lease.snapshot().epoch).toBe(0);
    expect(events).toEqual([]);
  });

  it("expires the creator's lease on its own timer, with no other caller in sight", () => {
    const { lease, clock, events } = fixture({
      initialHolder: A,
      config: { ttlMs: 30_000 },
    });
    expect(clock.pendingTimers).toBe(1);
    clock.advance(30_000);
    // The TIMER fired — nothing touched the lease. An idle worker whose holder vanished is
    // exactly what a TTL is for, and a lazy-only sweep would never notice.
    expect(events.map((e) => e.op)).toEqual(["expired"]);
    expect(lease.snapshot().holder).toBeNull();
    expect(lease.snapshot().epoch).toBe(2);
  });
});

describe("createLease — `lease.requireClientId` (rule L4)", () => {
  it("defaults false, so a header-less client is a real controller", () => {
    const { lease, config } = fixture();
    expect(config.requireClientId).toBe(false);
    expect(lease.assertHolder(ANON).holder).toEqual({ tokenId: ANON.tokenId, clientId: null });
    // ...and shared: the second header-less client of that token IS the first one (L4).
    expect(() => lease.assertHolder({ tokenId: ANON.tokenId, clientId: null })).not.toThrow();
  });

  it("true makes every gated verb a 400 for a header-less caller — never a 423", () => {
    const { lease } = fixture({ config: { requireClientId: true } });
    for (const [what, call] of [
      ["assertHolder", () => lease.assertHolder(ANON)],
      ["acquire", () => lease.acquire(ANON)],
      ["release", () => lease.release(ANON)],
      ["steal", () => lease.steal(ANON, { reason: null, admin: false })],
    ] as const) {
      const error = thrown(what, call);
      // 400, because the REQUEST is malformed — the client did not say who it is. A 423 would
      // tell it to go and take a lease it can never be identified as holding.
      expect({ what, code: error.code, status: error.status }).toEqual({
        what,
        code: "bad_request",
        status: 400,
      });
    }
    // A named client of the same token is unaffected.
    expect(lease.assertHolder(A).holder).toEqual({ tokenId: A.tokenId, clientId: A.clientId });
  });
});

describe("createLease — `stealAfterIdleMs` (rule L8)", () => {
  it("makes a same-token peer WAIT, and the wait is measured from the holder's last USE", () => {
    const { lease, clock } = fixture({ config: { stealAfterIdleMs: 60_000, ttlMs: 0 } });
    lease.acquire(A);

    clock.advance(59_999);
    const early = thrown("early steal", () => lease.steal(A2, { reason: "mine", admin: false }));
    expect(early.code).toBe("lease_held");
    expect(early.lease?.holder).toEqual({ tokenId: A.tokenId, clientId: A.clientId });

    // The holder uses it — which RESETS the idle clock. A peer must not inherit the wait a
    // previous idle period accumulated.
    clock.advance(30_000);
    lease.assertHolder(A);
    clock.advance(59_999);
    expect(() => lease.steal(A2, { reason: "mine", admin: false })).toThrow(OmniError);

    clock.advance(1);
    expect(lease.steal(A2, { reason: "mine", admin: false }).holder).toEqual({
      tokenId: A2.tokenId,
      clientId: A2.clientId,
    });
  });

  it("never makes an ADMIN wait (D13)", () => {
    const { lease } = fixture({ config: { stealAfterIdleMs: 3_600_000 } });
    lease.acquire(A);
    expect(lease.steal(C, { reason: "operator", admin: true }).holder).toEqual({
      tokenId: C.tokenId,
      clientId: C.clientId,
    });
  });
});

describe("createLease — TTL knobs", () => {
  it("`ttlMs: 0` means never: no deadline, no timer, no expiry", () => {
    const { lease, clock, events } = fixture({ config: { ttlMs: 0 } });
    lease.acquire(A);
    expect(lease.snapshot().expiresAt).toBeNull();
    expect(clock.pendingTimers).toBe(0);
    clock.advance(365 * 24 * 3_600_000);
    expect(lease.snapshot().holder).not.toBeNull();
    expect(events.filter((e) => e.op === "expired")).toEqual([]);
  });

  it("`renewOnUse: true` (the default) pushes the deadline on every gated call", () => {
    const { lease, clock } = fixture({ config: { ttlMs: 10_000 } });
    lease.acquire(A);
    for (let i = 0; i < 10; i++) {
      clock.advance(9_000);
      lease.assertHolder(A);
    }
    // 90 seconds of a 10-second lease, held throughout, because it was in constant use.
    expect(lease.snapshot().holder).not.toBeNull();
  });

  it("`renewOnUse: false` expires an actively used lease, which is what the knob is for", () => {
    const { lease, clock, events } = fixture({ config: { ttlMs: 10_000, renewOnUse: false } });
    lease.acquire(A);
    clock.advance(9_000);
    lease.assertHolder(A);
    clock.advance(1_000);
    expect(events.map((e) => e.op)).toEqual(["acquired", "expired"]);
    expect(lease.snapshot().holder).toBeNull();
  });

  it("`renewOnUse: false` also leaves a PIN's original deadline standing", () => {
    const { lease, clock, events } = fixture({ config: { ttlMs: 10_000, renewOnUse: false } });
    lease.acquire(A);
    const unpin = lease.pinExpiry();
    clock.advance(60_000);
    // Rule L6 still holds mid-turn: nothing expires while pinned...
    expect(lease.snapshot().holder).not.toBeNull();
    expect(lease.snapshot().expiresAt).toBeNull();
    // ...and the moment the turn settles, the deadline the operator asked for applies.
    unpin();
    expect(events.map((e) => e.op)).toEqual(["acquired", "expired"]);
  });

  it("`acquire({ttlMs})` overrides the config for THIS holder, and the next holder starts clean", () => {
    const { lease, clock } = fixture({ config: { ttlMs: 10_000 } });
    lease.acquire(A, { ttlMs: 120_000 });
    clock.advance(60_000);
    expect(lease.snapshot().holder).not.toBeNull();

    lease.release(A);
    lease.acquire(A2);
    clock.advance(10_001);
    expect(lease.snapshot().holder, "the override did not leak to the next holder").toBeNull();
  });

  it("a pin taken on an unheld lease still reports honestly", () => {
    const { lease } = fixture();
    const unpin = lease.pinExpiry();
    expect(lease.snapshot()).toMatchObject({ holder: null, pinned: true, expiresAt: null });
    unpin();
    expect(lease.snapshot().pinned).toBe(false);
  });

  it("an un-pin is idempotent: calling it twice does not release somebody else's pin", () => {
    const { lease, clock } = fixture({ config: { ttlMs: 10_000 } });
    lease.acquire(A);
    const unpinA = lease.pinExpiry();
    const unpinB = lease.pinExpiry();
    unpinA();
    unpinA();
    unpinA();
    expect(lease.snapshot().pinned, "three calls to one handle released one pin").toBe(true);
    unpinB();
    expect(lease.snapshot().pinned).toBe(false);
    clock.advance(10_001);
    expect(lease.snapshot().holder).toBeNull();
  });

  it("releaseForHibernate drops the pins with the lease — the turn is over by construction", () => {
    const { lease } = fixture({ config: { ttlMs: 10_000 } });
    lease.acquire(A);
    lease.pinExpiry();
    lease.releaseForHibernate();
    expect(lease.snapshot().pinned).toBe(false);
    expect(lease.snapshot().holder).toBeNull();
  });
});

describe("createLease — the audit fan-out (rule L9)", () => {
  it("delivers to `onEvent` and to every `onChange`, in that order, once each", () => {
    const { lease, events } = fixture();
    const first: string[] = [];
    const second: string[] = [];
    const off = lease.onChange((e) => first.push(e.op));
    lease.onChange((e) => second.push(e.op));

    lease.acquire(A);
    off();
    lease.release(A);

    // `onEvent` is the log; it sees everything.
    expect(events.map((e) => e.op)).toEqual(["acquired", "released"]);
    expect(first).toEqual(["acquired"]);
    expect(second).toEqual(["acquired", "released"]);
  });

  it("contains a sink that throws — a broken audit callback must not fail a prompt", () => {
    const { lease, events } = fixture();
    lease.onChange(() => {
      throw new Error("the observer is having a bad day");
    });
    const after: string[] = [];
    lease.onChange((e) => after.push(e.op));

    expect(() => lease.assertHolder(A)).not.toThrow();
    // The sink after the broken one still ran, and the log still got its line.
    expect(after).toEqual(["acquired"]);
    expect(events).toHaveLength(1);
  });

  it("close() stops the timer and the fan-out, and is idempotent", () => {
    const { lease, clock, events } = fixture({ config: { ttlMs: 10_000 } });
    const seen: string[] = [];
    lease.onChange((e) => seen.push(e.op));
    lease.acquire(A);
    expect(clock.pendingTimers).toBe(1);

    lease.close();
    lease.close();
    expect(clock.pendingTimers).toBe(0);

    clock.advance(60_000);
    // A closed lease belongs to a closed worker: nothing more is written to a log nobody reads.
    expect(events.map((e) => e.op)).toEqual(["acquired"]);
    expect(seen).toEqual(["acquired"]);
  });
});

describe("createLease — the 423 body (rule L10)", () => {
  it("names the holder and the epoch on every refusal, for a stranger too", () => {
    const { lease } = fixture();
    lease.acquire(A);
    const epoch = lease.snapshot().epoch;
    for (const [what, call] of [
      ["assertHolder", () => lease.assertHolder(C)],
      ["acquire", () => lease.acquire(C)],
      ["release", () => lease.release(C)],
      ["steal", () => lease.steal(C, { reason: null, admin: false })],
      ["stale fence", () => lease.assertHolder({ ...A, epoch: epoch - 1 })],
    ] as const) {
      const error = thrown(what, call);
      expect({ what, code: error.code, status: error.status }).toEqual({
        what,
        code: "lease_held",
        status: 423,
      });
      expect(error.lease).toEqual(lease.snapshot());
      expect(error.toBody().lease?.holder).toEqual({ tokenId: A.tokenId, clientId: A.clientId });
      expect(error.toBody().lease?.epoch).toBe(epoch);
    }
  });

  it("does not carry a `resume` field — 423 and 422 bodies stay disjoint (§9)", () => {
    const { lease } = fixture();
    lease.acquire(A);
    const body = thrown("peer act", () => lease.assertHolder(A2)).toBody();
    expect(Object.keys(body).sort()).toEqual(["code", "lease", "message"]);
  });
});

describe("createLease — the holder is an identity, never a cached fence", () => {
  it("strips `epoch` from whatever a caller acquired with", () => {
    const { lease } = fixture();
    lease.acquire({ ...A, epoch: 41 });
    expect(lease.snapshot().holder).toEqual({ tokenId: A.tokenId, clientId: A.clientId });
    expect(Object.keys(lease.snapshot().holder ?? {}).sort()).toEqual(["clientId", "tokenId"]);
    // ...and the stored value is not a live reference into the caller's object.
    expect(lease.holder).not.toBe(A);
  });
});
