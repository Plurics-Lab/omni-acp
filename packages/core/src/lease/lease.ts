import {
  OmniError,
  type ClientRef,
  type ClientRefWire,
  type Lease,
  type LeaseEventPayload,
  type LeaseHow,
  type LeaseOp,
  type LeaseOptions,
  type LeaseSnapshot,
  type TimerHandle,
} from "@omni-acp/protocol";
import { isStaleEpoch, mayAct, maySteal, sameClient, toWire } from "./policy.js";

/**
 * D5's real lease (§16): acquire / release / steal with a fencing EPOCH, a TTL that cannot fire
 * mid-turn, implicit acquire of an unheld lease, release on hibernate, `omni.lease` audit
 * envelopes, and a `423 lease_held` body that names the holder.
 *
 * SEAM 3 (M1-PLAN §1.2): `Worker.prompt()` and `Worker.cancel()` ALREADY call
 * `lease.assertHolder(who)` as their first statement (F22), so enforcement is a change to the
 * FACTORY the registry passes in and touches zero core worker files. That is M0's DI paying off,
 * and it is said out loud so nobody helpfully adds an interface.
 *
 * Owned by M1-WP-D.
 *
 * ── THE FOUR DECISIONS THIS FILE MAKES, AND WHY ─────────────────────────────
 *
 * **1. The epoch moves when control is TAKEN AWAY, or GRANTED by a verb whose answer carries
 * the new value.** §16.1 rule L7 says "+1 on every acquire / steal / expiry". `steal` and
 * `expiry` bump — those are the two ways a holder LOSES the lease, and fencing the loser is the
 * entire purpose of the counter. `acquire` bumps too. Three things do not, and each has a
 * reason:
 *
 *  - `release()`: rule L7 does not list it, and the next acquire bumps anyway.
 *  - a re-`acquire()` by the client that already holds it: that is a TTL renewal, not an
 *    acquisition, and bumping would fence out the very client that just called.
 *  - **an IMPLICIT acquire (rule L5)**, and this one is a considered reading of L7 rather than
 *    its literal words. The implicit path is reached from a GATED VERB — `prompt` answers `202
 *    PromptAccepted{turnId, seq}`, `cancel` answers `202 {}` — and neither body has anywhere to
 *    put a lease. So a client that sends `Omni-Lease-Epoch` and implicitly acquires would be
 *    holding a number the daemon had just changed, with no way to have learnt the new one: its
 *    NEXT prompt would be a `423`, then a re-read, then a fresh implicit acquire, then a `423`
 *    again — a ping-pong that turns rule L5's "a worker nobody controls should not 423 the first
 *    client that reaches for it" into "…and it 423s the second". Not bumping costs nothing
 *    L7 was protecting: every transfer between two DIFFERENT parties still passes through a
 *    `steal` or an expiry, both of which bump, so a client that lost the lease is still fenced.
 *    A fence nobody can read is a trap, not a fence. (Reported to the merge step as a deviation.)
 *
 * **2. The fence is checked where a caller CLAIMS to be the controller.** `assertHolder` and
 * `release` check it; `steal` does not (see `maySteal`), and `acquire` does not, because a
 * client that was fenced out must be able to take an unheld lease back without first paying a
 * round trip to learn a number the daemon is about to change anyway.
 *
 * **3. Expiry is evaluated LAZILY as well as on a timer.** A `Clock` may be stepped (`fakeClock`
 * has `set()`) or a timer may be starved; a lease whose deadline has passed must not report a
 * holder just because no callback ran. Every public entry point sweeps first, so `expiresAt` is
 * never a time in the past and the expiry event fires exactly once whichever path notices.
 *
 * **4. Construction emits NOTHING.** The creator holding the lease (D5, `lease:"take"`) is the
 * lease's initial VALUE, not a transition: §8.2 rule 2 fixes seq 1 of every worker's log as
 * `omni.worker_state{starting}`, and this factory is called from `registry.create()` BEFORE the
 * worker — and therefore before that envelope — exists. The creator learns it holds the lease
 * from `WorkerSnapshot.lease` on the 201 body, which it reads before anything else. `how:
 * "create"` stays in the enum for the caller that wants to announce a hand-over at birth, the
 * same way `requires_action` stays in `WORKER_STATES` unemitted until M2.
 *
 * ── NOTE (M1-WP-D → M1-WP-E), so rule L9 is not lost in the wiring ──────────
 *
 * "Every transition appends `omni.lease` to the **worker's own event log**" is `onEvent`'s job,
 * and `onEvent` is the CALLER's to supply. `create-daemon.ts` builds the factory that
 * `WorkerRegistryOptions.leaseFactory` calls, and that factory's signature is
 * `(owner, workerId) => Lease` — it is handed no `EventLog`, although `registry.create()` has
 * one in scope at the call site. Until that changes, the daemon's factory must reach the log
 * lazily (`daemon.workers.logFor(workerId, …)`), which works for every transition because they
 * all happen after `create()` has resolved. `packages/daemon/test/http/lease.test.ts` wires it
 * the direct way and asserts what an observer then sees.
 */
export function createLease(o: LeaseOptions): Lease {
  const { workerId, clock, config } = o;

  /** null = unheld. Stored in WIRE form: a holder is an identity, never a cached fence. */
  let holder: ClientRefWire | null = null;
  let epoch = 0;
  let acquiredAtMs: number | null = null;
  /** The TTL in force for the CURRENT holder — `acquire({ttlMs})` overrides the config's. */
  let ttlMs = config.ttlMs;
  /** Absolute deadline, or null for "no TTL configured" (`ttlMs: 0`) and for an unheld lease. */
  let expiresAtMs: number | null = null;
  /** The holder's last use: acquire, renewal, or a gated verb. Feeds `stealAfterIdleMs` (L8). */
  let lastUseMs = clock.now();
  /** Refcount, not a boolean: nested turns/pins must not un-pin each other (rule L6). */
  let pins = 0;
  let timer: TimerHandle | null = null;
  let closed = false;

  /**
   * `CreateWorkerRequest.lease` (H5): `"take"` — the default — makes the creator the holder, and
   * `"observe"` passes `null` so the worker is born lease-free (D5). Seeding is not an event; see
   * decision 4 in this file's header.
   *
   * The epoch starts at 1 rather than 0 when somebody holds it, so that "epoch" reads as "how
   * many times control has been taken" and a fence of 0 — the value `alwaysGrantedLease` reports
   * for a lease that can never be contested — is never accidentally valid here.
   */
  const seedHolder = o.initialHolder ?? null;
  if (seedHolder !== null) {
    holder = toWire(seedHolder);
    epoch = 1;
    acquiredAtMs = clock.now();
    lastUseMs = acquiredAtMs;
    expiresAtMs = ttlMs > 0 ? acquiredAtMs + ttlMs : null;
  }

  const subscribers = new Set<(e: LeaseEventPayload) => void>();

  const clearTimer = (): void => {
    timer?.cancel();
    timer = null;
  };

  /** (Re)arms the expiry timer. A pinned or unheld or TTL-less lease has no timer at all. */
  const armTimer = (): void => {
    clearTimer();
    if (closed || holder === null || pins > 0 || expiresAtMs === null) return;
    timer = clock.setTimer(Math.max(0, expiresAtMs - clock.now()), () => {
      timer = null;
      sweep();
    });
  };

  const iso = (epochMs: number): string => new Date(epochMs).toISOString();

  const snapshot = (): LeaseSnapshot => ({
    workerId,
    holder,
    epoch,
    // Rule L6: a pinned lease reports `expiresAt: null`, because an expiry we will not honour is
    // a lie an operator will plan around. Unheld and TTL-less report null for the same reason —
    // there is no moment at which this lease will be taken away.
    expiresAt: holder === null || pins > 0 || expiresAtMs === null ? null : iso(expiresAtMs),
    acquiredAt: acquiredAtMs === null ? null : iso(acquiredAtMs),
    pinned: pins > 0,
  });

  /**
   * Fans one transition out to `LeaseOptions.onEvent` (which is where the `omni.lease` envelope
   * is appended to the worker's own log — rule L9) and then to `onChange` subscribers.
   *
   * A sink that throws is contained, exactly as the event log contains a listener that throws
   * (§8.2): the alternative is a `prompt()` that fails because somebody's audit callback has a
   * bug, and a lease that is correct only while every observer is is not a lease.
   */
  const emit = (
    op: LeaseOp,
    how: LeaseHow,
    previous: ClientRefWire | null,
    by: ClientRefWire | null,
    reason: string | null,
  ): LeaseSnapshot => {
    const payload: LeaseEventPayload = { op, lease: snapshot(), previous, by, how, reason };
    for (const sink of [o.onEvent, ...subscribers]) {
      if (sink === undefined) continue;
      try {
        sink(payload);
      } catch {
        // Contained on purpose; see the doc comment above.
      }
    }
    return payload.lease;
  };

  /**
   * The one place a lease is taken.
   *
   * The epoch moves for every `how` EXCEPT `"implicit"`, which is decision 1 in this file's
   * header: the verb that acquires implicitly answers `202` with no room for a lease, so a bump
   * there is a fence its own beneficiary can never read.
   */
  const take = (
    who: ClientRef,
    how: LeaseHow,
    ttl: number,
    reason: string | null,
  ): LeaseSnapshot => {
    const previous = holder;
    holder = toWire(who);
    if (how !== "implicit") epoch += 1;
    ttlMs = ttl;
    acquiredAtMs = clock.now();
    lastUseMs = acquiredAtMs;
    expiresAtMs = ttl > 0 ? acquiredAtMs + ttl : null;
    armTimer();
    return emit(previous === null ? "acquired" : "stolen", how, previous, holder, reason);
  };

  /** The one place a lease is given up voluntarily. No epoch bump — rule L7 does not list one. */
  const giveUp = (
    how: LeaseHow,
    by: ClientRefWire | null,
    reason: string | null,
  ): LeaseSnapshot => {
    const previous = holder;
    if (previous === null) return snapshot(); // idempotent: nothing changed, so nothing is emitted
    holder = null;
    acquiredAtMs = null;
    expiresAtMs = null;
    ttlMs = config.ttlMs;
    clearTimer();
    return emit("released", how, previous, by, reason);
  };

  /**
   * Expiry, the third epoch bump. `by` is null because nobody did it — the clock did (§5.1's
   * `LeaseEventPayload.by`).
   */
  const expire = (): void => {
    const previous = holder;
    if (previous === null) return;
    holder = null;
    epoch += 1;
    acquiredAtMs = null;
    expiresAtMs = null;
    ttlMs = config.ttlMs;
    clearTimer();
    emit("expired", "timeout", previous, null, null);
  };

  /**
   * Has the deadline passed? Called at the top of every public entry point, so a stepped clock
   * or a starved timer cannot make this lease report a holder it no longer has. Idempotent: the
   * first caller to notice emits the one event.
   */
  const sweep = (): void => {
    if (closed || holder === null || pins > 0 || expiresAtMs === null) return;
    if (clock.now() >= expiresAtMs) expire();
  };

  // The seeded holder's deadline, armed now that the timer helpers above exist. Without this a
  // lease taken at birth would only ever expire when somebody next touched it (the lazy sweep),
  // and an idle worker whose holder vanished is exactly the case a TTL is for.
  armTimer();

  const held = (): OmniError =>
    new OmniError(
      "lease_held",
      holder === null
        ? `the lease on ${workerId} moved on; re-read it and retry`
        : `worker ${workerId} is held by ${holder.tokenId}/${holder.clientId ?? "<default>"}`,
      // Rule L10: the body NAMES the holder and the epoch. A client that has to re-GET the
      // worker to learn who holds it may be told about a third holder by the time it lands.
      { lease: snapshot() },
    );

  /**
   * Rule L4's other half: `lease.requireClientId: true` makes a header-less gated request a
   * `400`, because `clientId: null` is a SHARED identity and an operator who has turned the
   * knob on has said that sharing a controller between anonymous clients is not acceptable here.
   * It defaults false so raw `curl` and `curl-shapes.itest.ts` keep working.
   */
  const assertIdentified = (who: ClientRef): void => {
    if (config.requireClientId && who.clientId === null) {
      throw new OmniError(
        "bad_request",
        "this daemon requires an Omni-Client-Id header on lease-gated requests",
      );
    }
  };

  /** The fence a call carries: on the identity (seam 3's other half), or passed explicitly. */
  const fenceOf = (who: ClientRef, opts?: { epoch?: number }): number | undefined =>
    who.epoch ?? opts?.epoch;

  return {
    get holder(): ClientRef | null {
      sweep();
      return holder;
    },

    get epoch(): number {
      sweep();
      return epoch;
    },

    snapshot(): LeaseSnapshot {
      sweep();
      return snapshot();
    },

    assertHolder(who: ClientRef, opts?: { epoch?: number }): LeaseSnapshot {
      sweep();
      assertIdentified(who);
      const fence = fenceOf(who, opts);
      // `admin: false` — the lease genuinely does not know who is asking with what authority.
      // Rule L3's admin half lives in `registry.delete()`, which is the one call site that has
      // the `AuthContext`; see the Land-written comment there.
      if (!mayAct(snapshot(), who, { admin: false, epoch: fence })) throw held();
      if (holder === null) {
        // Rule L5: a worker nobody controls should not 423 the first client that reaches for it.
        return take(who, "implicit", config.ttlMs, null);
      }
      lastUseMs = clock.now();
      if (config.renewOnUse && expiresAtMs !== null) {
        expiresAtMs = lastUseMs + ttlMs;
        armTimer();
      }
      return snapshot();
    },

    acquire(who: ClientRef, opts?: { ttlMs?: number }): LeaseSnapshot {
      sweep();
      assertIdentified(who);
      const ttl = opts?.ttlMs ?? config.ttlMs;
      if (holder !== null && !sameClient(holder, who)) {
        // `acquire` never preempts — M1 moved that to its own audited verb (§5.7, rule L8).
        throw held();
      }
      if (holder === null) return take(who, "explicit", ttl, null);
      // A re-acquire by the holder is a RENEWAL: the TTL moves, the epoch does not, and no
      // envelope is written because nothing transitioned.
      ttlMs = ttl;
      lastUseMs = clock.now();
      expiresAtMs = ttl > 0 ? lastUseMs + ttl : null;
      armTimer();
      return snapshot();
    },

    release(who: ClientRef): LeaseSnapshot {
      sweep();
      assertIdentified(who);
      const fence = fenceOf(who);
      if (isStaleEpoch(snapshot(), fence)) throw held();
      // Releasing an unheld lease is a no-op, not an error: `release` is the one verb a client
      // is expected to call blind, in a `finally`, without first asking who holds what.
      if (holder === null) return snapshot();
      if (!sameClient(holder, who)) throw held();
      return giveUp("explicit", toWire(who), null);
    },

    steal(who: ClientRef, opts: { reason: string | null; admin: boolean }): LeaseSnapshot {
      sweep();
      assertIdentified(who);
      if (
        !maySteal(snapshot(), who, {
          admin: opts.admin,
          nowMs: clock.now(),
          lastUseMs,
          config,
        })
      ) {
        throw held();
      }
      // Already the holder: a steal from yourself is a renewal, and writing a `stolen` envelope
      // for it would put a preemption in the audit trail that never happened.
      if (holder !== null && sameClient(holder, who)) {
        lastUseMs = clock.now();
        if (expiresAtMs !== null) {
          expiresAtMs = lastUseMs + ttlMs;
          armTimer();
        }
        return snapshot();
      }
      // D5: 强制抢占（带审计）. `reason` is recorded VERBATIM — it is the whole audit.
      return take(who, "steal", config.ttlMs, opts.reason);
    },

    pinExpiry(): () => void {
      pins += 1;
      clearTimer();
      let released = false;
      return () => {
        // Idempotent per handle: two calls to one un-pin must not cancel somebody else's pin.
        if (released) return;
        released = true;
        pins = Math.max(0, pins - 1);
        if (pins > 0) return;
        if (holder !== null && ttlMs > 0) {
          // A live turn IS use, so the deadline is re-based when `renewOnUse` is on. With the
          // knob OFF the original deadline stands — and may already have passed, which is the
          // operator asking for exactly that: expire the moment the turn is no longer at risk.
          if (config.renewOnUse) expiresAtMs = clock.now() + ttlMs;
          armTimer();
        }
        sweep();
      };
    },

    releaseForHibernate(): LeaseSnapshot {
      sweep();
      // DESIGN §3.2 (进程回收、lease 释放、记录保留), §15.2 step 3. UNCONDITIONAL and holder-less:
      // `Worker.hibernate()` takes no `ClientRef`, and a holder cannot control a worker with no
      // process. Pins go with it — the turn that took them is over by construction (§15.2
      // refuses to hibernate a running worker).
      pins = 0;
      return giveUp("hibernate", null, null);
    },

    onChange(cb: (e: LeaseEventPayload) => void): () => void {
      subscribers.add(cb);
      return () => {
        subscribers.delete(cb);
      };
    },

    close(): void {
      if (closed) return;
      closed = true;
      clearTimer();
      subscribers.clear();
    },
  };
}
