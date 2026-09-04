import { describe, expect, it } from "vitest";
import {
  OmniError,
  type ClientId,
  type ClientRef,
  type Lease,
  type LeaseEventPayload,
  type LeaseSnapshot,
  type TokenId,
} from "@omni-acp/protocol";
import type { FakeClock } from "./fake-clock.js";

/**
 * D5's behaviour as ONE suite, run against the `Lease` OBJECT and against the HTTP SURFACE, so
 * the two cannot drift (CONTRACTS.md §16.4).
 *
 * That pairing is the point: a lease that is correct in core and permissive over HTTP is a lease
 * that does not exist, and a suite that only ever sees one of the two would never notice.
 *
 * ── HOW THE PAIRING IS ACHIEVED ─────────────────────────────────────────────
 *
 * There is exactly one table of scenarios, written against a `LeaseSurface` — five async verbs
 * that both a `Lease` object and `POST /v1/workers/{wid}/lease/*` can implement. The object
 * surface is built here; the HTTP one is supplied by the daemon's own suite, which wires it to
 * `daemon.fetch` (zero ports). Every scenario therefore runs twice over the SAME `Lease`
 * instance, and a rule that holds in core but not on the wire fails here rather than in
 * production.
 *
 * The suite additionally holds the `Lease` itself, because three things have no HTTP verb by
 * design and must still be proven: `pinExpiry()` (taken by the turn, not by a client),
 * `releaseForHibernate()` (H18's business, and `WorkerHandle.hibernate` takes no `ClientRef`)
 * and `onChange` (rule L9's audit fan-out). Where a scenario uses one it says so.
 *
 * Owned by M1-WP-D.
 */

// ── the surface the scenarios drive ──────────────────────────────────────────

/**
 * The five verbs of §16 that BOTH surfaces have. Async throughout, because the HTTP one cannot
 * be anything else — and because a synchronous object surface would let a scenario pass by
 * catching a throw that the wire turns into a rejection.
 *
 * Every rejection must be an `OmniError` carrying the real `code` (and, for `lease_held`, the
 * `lease` body of rule L10) — that is itself part of what the pairing asserts.
 */
export interface LeaseSurface {
  /** UNGATED (rule L2): `GET /v1/workers/{wid}` → `.lease`. Never a 423, for anybody. */
  snapshot(): Promise<LeaseSnapshot>;
  /** A GATED verb — `assertHolder`, i.e. `POST …/prompt`. The whole of rule L2's other half. */
  act(who: ClientRef): Promise<void>;
  acquire(who: ClientRef, opts?: { ttlMs?: number }): Promise<LeaseSnapshot>;
  release(who: ClientRef): Promise<LeaseSnapshot>;
  steal(who: ClientRef, opts: { reason: string | null; admin: boolean }): Promise<LeaseSnapshot>;
  /**
   * `DELETE /v1/workers/{wid}` — the lease **OR** `role:"admin"` (rule L3). Present only on the
   * HTTP surface: the admin half lives in `registry.delete()`, because the lease cannot know who
   * is asking with what authority.
   */
  destroy?(who: ClientRef, opts: { admin: boolean }): Promise<void>;
}

/**
 * The four callers of §16.4's matrix. The HTTP binding supplies its own, because only the caller
 * knows which bearer token each `tokenId` is spelled with in its token table.
 */
export interface LeaseIdentities {
  /** "A" — the client that takes the lease first. */
  readonly holder: ClientRef;
  /** "B" — the SAME token, a different `Omni-Client-Id`. Two SDK clients of one token (L4). */
  readonly peer: ClientRef;
  /** "C" — a different token entirely. */
  readonly stranger: ClientRef;
  /** An `admin`-role token (D13). `admin: true` is passed to `steal` / `destroy` for it. */
  readonly admin: ClientRef;
}

/** How the daemon suite hands the same rules a second surface to fail on. */
export interface LeaseHttpBinding {
  readonly identities: LeaseIdentities;
  /** Wraps THE VERY LEASE `make()` returned, so both runs observe one object. */
  surface(lease: Lease): LeaseSurface;
}

// ── the object surface, and the default identities it uses ───────────────────

const tok = (s: string): TokenId => s as TokenId;
const cli = (s: string): ClientId => s as ClientId;

const OBJECT_IDENTITIES: LeaseIdentities = {
  holder: { tokenId: tok("tok_a"), clientId: cli("cli_a") },
  peer: { tokenId: tok("tok_a"), clientId: cli("cli_b") },
  stranger: { tokenId: tok("tok_c"), clientId: cli("cli_c") },
  admin: { tokenId: tok("tok_admin"), clientId: cli("cli_admin") },
};

/**
 * `Promise.resolve().then(...)` rather than an `async` wrapper around a bare call: the object's
 * verbs throw SYNCHRONOUSLY, and a scenario that awaited such a call would never see the
 * rejection the HTTP surface produces. Wrapping here is what makes the two shapes identical.
 */
function objectSurface(lease: Lease): LeaseSurface {
  return {
    snapshot: () => Promise.resolve().then(() => lease.snapshot()),
    act: (who) =>
      Promise.resolve().then(() => {
        lease.assertHolder(who);
      }),
    acquire: (who, opts) => Promise.resolve().then(() => lease.acquire(who, opts)),
    release: (who) => Promise.resolve().then(() => lease.release(who)),
    steal: (who, opts) => Promise.resolve().then(() => lease.steal(who, opts)),
  };
}

// ── assertion helpers ────────────────────────────────────────────────────────

/** A sentinel no promise can resolve to, so "resolved with undefined" is not read as a throw. */
const NOTHING_THROWN = Symbol("nothing thrown");

/** The rejection, as an `OmniError`. A resolved promise is a failure with a readable message. */
async function rejection(what: string, p: Promise<unknown>): Promise<OmniError> {
  let caught: unknown = NOTHING_THROWN;
  try {
    await p;
  } catch (e) {
    caught = e;
  }
  if (caught === NOTHING_THROWN) {
    throw new Error(`${what}: expected a rejection, but the call succeeded`);
  }
  expect(caught, `${what} must reject with an OmniError`).toBeInstanceOf(OmniError);
  return caught as OmniError;
}

/**
 * "Denied, however this surface is entitled to spell it."
 *
 * A client of ANOTHER token cannot take a worker (D13) — but over HTTP it cannot even learn that
 * the worker exists, so the registry answers `404 worker_not_found` before the lease is ever
 * consulted, while the bare `Lease` object (which has no visibility rules of its own) answers
 * `423`. Both are correct, and the difference IS D13's invisibility — so the shared table
 * asserts the property the two surfaces genuinely have in common: the call fails and the holder
 * does not move. The exact `423` is pinned by the object's own suite, where it is the only
 * possible answer.
 */
async function expectDenied(what: string, p: Promise<unknown>): Promise<void> {
  const error = await rejection(what, p);
  expect(
    ["lease_held", "worker_not_found"].includes(error.code),
    `${what}: expected lease_held or worker_not_found, got ${error.code}`,
  ).toBe(true);
}

/** A `423` that names the holder and the epoch — rule L10, asserted in one place. */
async function expectLeaseHeld(
  what: string,
  p: Promise<unknown>,
  holder: ClientRef | null,
  epoch: number,
): Promise<void> {
  const error = await rejection(what, p);
  expect({ what, code: error.code, status: error.status }).toEqual({
    what,
    code: "lease_held",
    status: 423,
  });
  expect(error.lease, `${what}: the 423 body must carry the lease (rule L10)`).toBeDefined();
  expect(error.lease?.holder ?? null).toEqual(
    holder === null ? null : { tokenId: holder.tokenId, clientId: holder.clientId },
  );
  expect(error.lease?.epoch).toBe(epoch);
}

const wire = (who: ClientRef): { tokenId: TokenId; clientId: ClientId | null } => ({
  tokenId: who.tokenId,
  clientId: who.clientId,
});

/** `who`, plus the fencing epoch it claims — the value `Omni-Lease-Epoch` carries (seam 3). */
const fenced = (who: ClientRef, epoch: number): ClientRef => ({ ...who, epoch });

interface Run {
  readonly lease: Lease;
  readonly surface: LeaseSurface;
  readonly ids: LeaseIdentities;
  /** Every `omni.lease` payload this lease emitted, in order (rule L9's audit trail). */
  readonly events: LeaseEventPayload[];
}

/**
 * `make()` must return a FRESH, **UNHELD** lease each time — §16.4's matrix starts from "nobody
 * controls this worker", which is also the state rule L5 is about. A lease seeded with a creator
 * is the `lease:"take"` case and is tested by its own suite, not by this one.
 */
export function runLeaseConformance(
  name: string,
  make: () => Lease,
  clock: FakeClock,
  http?: LeaseHttpBinding,
): void {
  const start = (ids: LeaseIdentities, wrap: (lease: Lease) => LeaseSurface) => (): Run => {
    const lease = make();
    const events: LeaseEventPayload[] = [];
    lease.onChange((e) => events.push(e));
    expect(lease.snapshot().holder, "make() must return an UNHELD lease").toBeNull();
    return { lease, surface: wrap(lease), ids, events };
  };

  describe(`Lease conformance: ${name} — object`, () => {
    scenarios(start(OBJECT_IDENTITIES, objectSurface), clock);
  });

  if (http !== undefined) {
    describe(`Lease conformance: ${name} — HTTP`, () => {
      scenarios(
        start(http.identities, (lease) => http.surface(lease)),
        clock,
      );
    });
  }
}

// ── the one table both surfaces run ──────────────────────────────────────────

function scenarios(start: () => Run, clock: FakeClock): void {
  it("L5: an UNHELD lease is implicitly acquired by the first gated call", async () => {
    const { surface, ids, events } = start();
    const before = await surface.snapshot();
    expect(before.holder).toBeNull();

    await surface.act(ids.holder);

    const after = await surface.snapshot();
    expect(after.holder).toEqual(wire(ids.holder));
    expect(after.acquiredAt).not.toBeNull();
    expect(events.map((e) => [e.op, e.how])).toEqual([["acquired", "implicit"]]);
    expect(events[0]?.previous).toBeNull();
    expect(events[0]?.by).toEqual(wire(ids.holder));

    // The epoch does NOT move, and that is deliberate. The verb that acquired implicitly answers
    // `202 PromptAccepted` — a body with nowhere to put a lease — so a bump here would hand the
    // acquirer a fence it cannot read, and its very next fenced call would be a 423. Rule L7's
    // counter exists to stop a client acting after it LOST the lease, and nothing was lost here:
    // every transfer between two different parties still goes through a `steal` or an expiry,
    // and both of those bump. Asserted rather than tolerated, because a future change that adds
    // the bump back must come here and read this.
    expect(after.epoch, "an implicit acquire must not move a fence its holder cannot read").toBe(
      before.epoch,
    );
    // ...and the holder can go on acting with the fence it already had.
    await surface.act(fenced(ids.holder, after.epoch));
    expect((await surface.snapshot()).epoch).toBe(before.epoch);
  });

  it("L2 + L10: a non-holder's gated call is 423 naming the holder; a second call is not", async () => {
    const { surface, ids, events } = start();
    await surface.act(ids.holder);
    const held = await surface.snapshot();

    await expectLeaseHeld("peer act", surface.act(ids.peer), ids.holder, held.epoch);
    // An ADMIN's gated call is 423 too: rule L3's bypass is for `DELETE` alone, and D13 gives an
    // admin the power to STEAL, not the power to prompt somebody else's live worker behind its
    // back. An admin that wants the worker says so, in the audit trail.
    await expectLeaseHeld("admin act", surface.act(ids.admin), ids.holder, held.epoch);
    await expectDenied("stranger act", surface.act(ids.stranger));

    // The refusal changed nothing: same holder, same epoch, and no envelope was written.
    expect(await surface.snapshot()).toEqual(held);
    expect(events).toHaveLength(1);

    // ...and the holder may keep acting, as many times as it likes, with no further transition.
    await surface.act(ids.holder);
    await surface.act(ids.holder);
    expect(events).toHaveLength(1);
    expect((await surface.snapshot()).epoch).toBe(held.epoch);
  });

  it("L2: reading is NEVER gated — every observer sees the snapshot the holder sees", async () => {
    const { surface, ids } = start();
    await surface.act(ids.holder);
    const asHolder = await surface.snapshot();
    // `snapshot()` on the HTTP surface is `GET /v1/workers/{wid}`, and the observer sends its
    // own credentials. Observer mode is the point of D5 (§16.2).
    expect(await surface.snapshot()).toEqual(asHolder);
    expect(asHolder.holder).toEqual(wire(ids.holder));
  });

  it("L8: steal transfers, bumps the epoch, audits the reason, and fences the old holder", async () => {
    const { surface, ids, events } = start();
    await surface.act(ids.holder);
    const before = await surface.snapshot();

    const after = await surface.steal(ids.peer, {
      reason: "taking over from my laptop",
      admin: false,
    });
    expect(after.holder).toEqual(wire(ids.peer));
    expect(after.epoch).toBe(before.epoch + 1);

    const stolen = events.at(-1);
    expect(stolen?.op).toBe("stolen");
    expect(stolen?.how).toBe("steal");
    expect(stolen?.previous).toEqual(wire(ids.holder));
    expect(stolen?.by).toEqual(wire(ids.peer));
    // D5: 带审计 — the reason is recorded VERBATIM, because it is the entire audit.
    expect(stolen?.reason).toBe("taking over from my laptop");
    expect(events).toHaveLength(2);

    // The previous holder's NEXT call is a 423, not a silent hijack of the new holder's turn.
    await expectLeaseHeld("stolen-from act", surface.act(ids.holder), ids.peer, after.epoch);
  });

  it("D13: an admin steals from another token; a stranger cannot", async () => {
    const { surface, ids } = start();
    await surface.act(ids.holder);
    const held = await surface.snapshot();

    await expectDenied(
      "stranger steal",
      surface.steal(ids.stranger, { reason: "mine now", admin: false }),
    );
    expect(await surface.snapshot(), "a refused steal moves nothing").toEqual(held);

    const after = await surface.steal(ids.admin, { reason: "operator preemption", admin: true });
    expect(after.holder).toEqual(wire(ids.admin));
    expect(after.epoch).toBe(held.epoch + 1);
  });

  it("L7: a STALE Omni-Lease-Epoch is 423 even from the RIGHT client id", async () => {
    const { surface, ids } = start();
    await surface.act(ids.holder);
    const mine = await surface.snapshot();

    // The right client, the right epoch: through.
    await surface.act(fenced(ids.holder, mine.epoch));

    // Somebody steals. The holder's cached epoch is now one behind.
    await surface.steal(ids.peer, { reason: null, admin: false });
    const now = await surface.snapshot();
    expect(now.epoch).toBe(mine.epoch + 1);

    // Same client id as the CURRENT holder would be, but a stale fence: still a 423. This is the
    // difference between a lease and an advisory hint.
    await expectLeaseHeld(
      "stale fence from the new holder",
      surface.act(fenced(ids.peer, mine.epoch)),
      ids.peer,
      now.epoch,
    );
    // And with the current epoch, the same client is through.
    await surface.act(fenced(ids.peer, now.epoch));
  });

  it("L7: an epoch from the FUTURE is 423 too — it describes a state that never existed", async () => {
    const { surface, ids } = start();
    await surface.act(ids.holder);
    const held = await surface.snapshot();
    await expectLeaseHeld(
      "future fence",
      surface.act(fenced(ids.holder, held.epoch + 7)),
      ids.holder,
      held.epoch,
    );
  });

  it("release hands the worker back: anyone may take it, and releasing twice is a no-op", async () => {
    const { surface, ids, events } = start();
    await surface.acquire(ids.holder);
    const held = await surface.snapshot();

    const released = await surface.release(ids.holder);
    expect(released.holder).toBeNull();
    expect(released.acquiredAt).toBeNull();
    expect(released.expiresAt).toBeNull();
    expect(events.map((e) => e.op)).toEqual(["acquired", "released"]);

    // Idempotent, and silent: `release` is the verb a client calls blind in a `finally`.
    expect((await surface.release(ids.holder)).holder).toBeNull();
    expect(events).toHaveLength(2);

    // ...and the peer takes it with no ceremony (rule L5 again, now explicitly).
    const taken = await surface.acquire(ids.peer);
    expect(taken.holder).toEqual(wire(ids.peer));
    expect(taken.epoch).toBeGreaterThan(held.epoch);
    expect(events.map((e) => [e.op, e.how])).toEqual([
      ["acquired", "explicit"],
      ["released", "explicit"],
      ["acquired", "explicit"],
    ]);
  });

  it("acquire never preempts — a held lease is 423, and a re-acquire by the holder is a renewal", async () => {
    const { surface, ids, events } = start();
    await surface.acquire(ids.holder, { ttlMs: 60_000 });
    const held = await surface.snapshot();

    await expectLeaseHeld("peer acquire", surface.acquire(ids.peer), ids.holder, held.epoch);

    clock.advance(30_000);
    const renewed = await surface.acquire(ids.holder, { ttlMs: 60_000 });
    // A renewal moves the deadline and NOTHING else: no epoch bump (it would fence out the
    // client that just called) and no envelope (nothing transitioned).
    expect(renewed.epoch).toBe(held.epoch);
    expect(renewed.holder).toEqual(wire(ids.holder));
    expect(Date.parse(renewed.expiresAt ?? "")).toBeGreaterThan(Date.parse(held.expiresAt ?? ""));
    expect(events).toHaveLength(1);
  });

  it("L6/L1: a TTL expires the lease, exactly once, and anyone may then take it", async () => {
    const { surface, ids, events } = start();
    await surface.acquire(ids.holder, { ttlMs: 60_000 });
    const held = await surface.snapshot();
    expect(held.expiresAt).not.toBeNull();

    clock.advance(59_999);
    expect((await surface.snapshot()).holder).toEqual(wire(ids.holder));

    clock.advance(2);
    const expired = await surface.snapshot();
    expect(expired.holder).toBeNull();
    expect(expired.epoch, "an expiry bumps the epoch (rule L7)").toBe(held.epoch + 1);
    expect(expired.expiresAt).toBeNull();

    const event = events.at(-1);
    expect(event?.op).toBe("expired");
    expect(event?.how).toBe("timeout");
    // `by` is null: nobody did it, the clock did.
    expect(event?.by).toBeNull();
    expect(event?.previous).toEqual(wire(ids.holder));
    // Exactly one, however many times the expiry is observed.
    await surface.snapshot();
    await surface.snapshot();
    expect(events.filter((e) => e.op === "expired")).toHaveLength(1);

    // "an expired lease is acquirable by anyone" (§16.4) — including a client of another token,
    // here the admin, because D13 makes any OTHER token unable to see the worker at all.
    const taken = await surface.acquire(ids.admin);
    expect(taken.holder).toEqual(wire(ids.admin));
  });

  it("L6: a PIN suspends expiry, reports expiresAt null, and refcounts", async () => {
    const { lease, surface, ids, events } = start();
    await surface.acquire(ids.holder, { ttlMs: 60_000 });

    // `pinExpiry()` has no HTTP verb by design: the TURN takes it, not a client (rule L6). The
    // SNAPSHOT it produces is still asserted through whichever surface is running, which is the
    // half that has to reach the wire.
    const unpinOuter = lease.pinExpiry();
    const unpinInner = lease.pinExpiry();

    const pinned = await surface.snapshot();
    expect(pinned.pinned).toBe(true);
    expect(pinned.expiresAt, "an expiry we will not honour is a lie (rule L6)").toBeNull();

    // Ten times the TTL, mid-turn. Nothing expires.
    clock.advance(600_000);
    expect((await surface.snapshot()).holder).toEqual(wire(ids.holder));
    expect(events.filter((e) => e.op === "expired")).toHaveLength(0);

    // The outer pin releasing first must not un-pin the inner one — this is why it is a refcount.
    unpinOuter();
    clock.advance(600_000);
    expect((await surface.snapshot()).pinned).toBe(true);
    expect((await surface.snapshot()).holder).toEqual(wire(ids.holder));

    unpinInner();
    const live = await surface.snapshot();
    expect(live.pinned).toBe(false);
    expect(live.holder).toEqual(wire(ids.holder));
    expect(live.expiresAt, "the deadline is back, and it is in the future").not.toBeNull();
    expect(Date.parse(live.expiresAt ?? "")).toBeGreaterThan(clock.now());
  });

  it("L1: hibernation releases the lease unconditionally, and emits one envelope", async () => {
    const { lease, surface, ids, events } = start();
    await surface.acquire(ids.holder);
    const held = await surface.snapshot();

    // §15.2 step 3. `WorkerHandle.hibernate()` takes no `ClientRef`, so this is the object's verb
    // and has no HTTP spelling of its own; H18's gate lives in `registry.hibernate()`.
    const after = lease.releaseForHibernate();
    expect(after.holder).toBeNull();
    expect(after.epoch, "a voluntary release is not an acquisition — no bump").toBe(held.epoch);

    const event = events.at(-1);
    expect(event?.op).toBe("released");
    expect(event?.how).toBe("hibernate");
    expect(event?.previous).toEqual(wire(ids.holder));
    expect(event?.by, "the clock did not do it and no client asked — hibernation did").toBeNull();

    // Idempotent: hibernating an already-unheld worker writes nothing.
    lease.releaseForHibernate();
    expect(events.filter((e) => e.op === "released")).toHaveLength(1);

    // And the woken worker is takeable by whoever gets there first.
    expect((await surface.acquire(ids.peer)).holder).toEqual(wire(ids.peer));
  });

  it("L9: every transition emits EXACTLY one omni.lease, and no non-transition emits any", async () => {
    const { surface, ids, events } = start();

    await surface.act(ids.holder); // implicit acquire            → 1
    await surface.act(ids.holder); // the holder acting again     → 0
    await surface.snapshot(); //      a read                      → 0
    await rejection("peer act", surface.act(ids.peer)); //          0
    await surface.steal(ids.peer, { reason: "r", admin: false }); // 1
    await surface.steal(ids.peer, { reason: "r", admin: false }); // 0 — already the holder
    await surface.release(ids.peer); //                             1
    await surface.release(ids.peer); //                             0 — already unheld
    await surface.acquire(ids.admin); //                            1

    expect(events.map((e) => e.op)).toEqual(["acquired", "stolen", "released", "acquired"]);
    // Every payload carries the lease AS OF the transition, which is what makes the log readable
    // without replaying it against a second source of truth. The epoch is monotonic, and moves
    // for the steal (control taken) and the explicit acquire (whose answer IS the snapshot) —
    // not for the implicit acquire, and not for the release.
    expect(events.map((e) => e.lease.epoch)).toEqual([0, 1, 1, 2]);
  });

  it("L3: DELETE requires the lease OR admin", async (ctx) => {
    const { surface, ids } = start();
    const destroy = surface.destroy;
    if (destroy === undefined) {
      // The object has no `delete`: `WorkerHandle.close()` takes no `ClientRef`, so rule L3 is
      // enforced in `registry.delete()` and is only observable through the HTTP surface.
      ctx.skip("no DELETE on this surface (the object has none by design)");
      return;
    }
    await surface.act(ids.holder);
    const held = await surface.snapshot();

    await expectLeaseHeld(
      "peer DELETE",
      destroy(ids.peer, { admin: false }),
      ids.holder,
      held.epoch,
    );
    // ...but an admin who does NOT hold the lease still succeeds (§16.1 rule L3, review item 4).
    await destroy(ids.admin, { admin: true });
  });
}
