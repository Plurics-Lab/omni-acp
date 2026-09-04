import {
  type ClientRef,
  type ClientRefWire,
  type LeaseSnapshot,
  type ResolvedLeaseConfig,
} from "@omni-acp/protocol";

/**
 * The PURE half of §16.1's rules L1–L7 — who may act, who may steal, and when a fencing epoch is
 * stale — separated from the stateful `Lease` so the table can be tested with no clock and no
 * worker.
 *
 * L3: `DELETE` requires the lease OR `role:"admin"`. L4: `clientId: null` means "the token's
 * default client". L5: the first gated call on an UNHELD lease acquires it implicitly — a worker
 * nobody controls should not 423 the first client that reaches for it. L7: a present-and-stale
 * `Omni-Lease-Epoch` is a 423 even from the right client id.
 *
 * Owned by M1-WP-D.
 */

/**
 * Identity, as §16.1 rule L4 defines it: `{tokenId, clientId}`, with `clientId: null` meaning
 * "the token's default client" — a value that is deliberately SHARED, because a daemon genuinely
 * cannot tell two header-less clients of one token apart. So `null === null` is a match, and
 * saying so here once is what keeps every call site from re-deciding it.
 *
 * The `epoch` a `ClientRef` may carry is NOT part of identity: it is the fence, and it is
 * compared against the lease's own epoch by `mayAct`.
 */
export function sameClient(a: ClientRefWire | ClientRef, b: ClientRefWire | ClientRef): boolean {
  return a.tokenId === b.tokenId && a.clientId === b.clientId;
}

/** The wire form of a `ClientRef`, with the fence stripped — a holder is an identity, not a bet. */
export function toWire(who: ClientRef): ClientRefWire {
  return { tokenId: who.tokenId, clientId: who.clientId };
}

/**
 * Is `who`'s fencing epoch stale? (§16.1 rule L7.)
 *
 * ABSENT means "the client sent no fence", which L7 defines as no check — `Omni-Lease-Epoch` is
 * optional and a client that never sends one is never fenced. PRESENT and different is stale,
 * INCLUDING a value from the future: an epoch the daemon has not issued describes a lease state
 * that never existed, and "I am acting on a state you have never been in" is not a claim worth
 * honouring. Either way the answer is the same 423, carrying the current snapshot so the caller
 * learns the epoch it should have used (rule L10).
 */
export function isStaleEpoch(lease: LeaseSnapshot, epoch: number | undefined): boolean {
  return epoch !== undefined && epoch !== lease.epoch;
}

/**
 * May `who` perform a GATED verb (`prompt` / `cancel` / `hibernate` / `wake` / `DELETE`)?
 *
 * The order is the argument:
 *
 *  1. **The fence first** (L7), before identity and before the admin bypass. A stale epoch is
 *     the client saying "I am acting on a world that has moved", and an admin acting on a stale
 *     world hijacks a turn exactly as loudly as anyone else.
 *  2. **`admin` next** (L3). The lease itself never passes `true` here — it does not know who is
 *     asking with what authority — but `registry.delete()` does, which is where "the lease **or**
 *     `role:"admin"`" actually lives. Keeping the arm in the pure function is what lets the
 *     conformance matrix test the rule rather than the call site.
 *  3. **An unheld lease grants** (L5): a worker nobody controls should not 423 the first client
 *     that reaches for it. The CALLER turns that grant into an implicit acquire.
 *  4. Otherwise: identity (L4).
 */
export function mayAct(
  lease: LeaseSnapshot,
  who: ClientRef,
  o: { admin: boolean; epoch?: number },
): boolean {
  if (isStaleEpoch(lease, o.epoch)) return false;
  if (o.admin) return true;
  if (lease.holder === null) return true;
  return sameClient(lease.holder, who);
}

/**
 * May `who` STEAL the lease? (§16.1 rule L8, D13.)
 *
 * `nowMs` and `lastUseMs` are parameters rather than a clock, so the idle rule is a table and
 * not a timing test. `lastUseMs` is the holder's last use — the instant it acquired, renewed, or
 * exercised a gated verb.
 *
 * NO fencing check here, deliberately, and it is the one place the fence does not apply: a fence
 * is the claim "I still hold this at epoch N", and a stealer's whole premise is that it does
 * NOT. Fencing `steal` would lock out exactly the client the verb exists for — the one whose
 * cached epoch is old because somebody else has been holding the worker.
 */
export function maySteal(
  lease: LeaseSnapshot,
  who: ClientRef,
  o: { admin: boolean; nowMs: number; lastUseMs: number; config: ResolvedLeaseConfig },
): boolean {
  // D13: an admin token may always preempt, and never waits. That is the "换个设备接管" lever.
  if (o.admin) return true;
  // Nothing to take, or already yours: `steal` degrades to `acquire` rather than failing.
  if (lease.holder === null) return true;
  if (sameClient(lease.holder, who)) return true;
  // D13 again: a worker belongs to a token. A different token cannot take it at any idle time —
  // over HTTP it cannot even see the worker (`canSee`), and the object must not be laxer than
  // the wire.
  if (lease.holder.tokenId !== who.tokenId) return false;
  // L8: a same-token peer waits `stealAfterIdleMs` after the holder's last use. The default is
  // 0 — D5's plain reading — so a peer takes over immediately unless an operator says otherwise.
  return o.nowMs - o.lastUseMs >= o.config.stealAfterIdleMs;
}
