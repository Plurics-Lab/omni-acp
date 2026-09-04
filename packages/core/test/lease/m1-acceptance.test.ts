import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  LeaseConfig,
  OmniError,
  eventEnvelopeSchema,
  type ClientRef,
  type DaemonId,
  type EventEnvelope,
  type Lease,
  type LeaseEventPayload,
  type TokenId,
  type WorkerId,
} from "@omni-acp/protocol";
import { fakeClock, scriptedAgent, type FakeClock } from "@omni-acp/testkit";
import { createLease, createMemoryEventLog } from "@omni-acp/core";
import { harness, OWNER, TEXT } from "../worker/support/harness.js";

/**
 * M1-WP-D's acceptance bullets (M1-PLAN §2, WP-D), one `describe` each.
 *
 * Three of them are only half-expressible from `@omni-acp/core`, because their other half is an
 * HTTP status: bullet 1's second surface, bullet 2's `DELETE` and `hibernate`, and bullet 3's
 * "`attach` and `GET` are never 423". Those halves live in
 * `packages/daemon/test/http/lease.test.ts`, which runs the SAME conformance suite over
 * `daemon.fetch`, and each is named where it is deferred.
 */

const REPO_TEST_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const DAEMON_ID = "d_00000000000000000000000001" as DaemonId;
const WID = "w_00000000000000000000000001" as WorkerId;
const OTHER: ClientRef = { tokenId: OWNER.tokenId, clientId: "cli_other" };

interface Wired {
  readonly lease: Lease;
  readonly log: ReturnType<typeof createMemoryEventLog>;
  readonly clock: FakeClock;
}

/**
 * A lease wired to a REAL event log exactly as rule L9 requires: every transition is appended to
 * the worker's own log as an `omni.lease` envelope. This is the shape `create-daemon.ts` must
 * produce through `DaemonDeps.leaseFactory` (M1-WP-E); asserting it here is what makes the
 * envelope's field-by-field validity somebody's problem before it is an operator's.
 */
function wired(o?: { config?: Record<string, unknown>; initialHolder?: ClientRef }): Wired {
  const clock = fakeClock();
  const log = createMemoryEventLog({
    workerId: WID,
    daemonId: DAEMON_ID,
    clock,
    maxEvents: 1_000,
    subscriberQueueSize: 64,
  });
  // Seq 1 is always `omni.worker_state{starting}` (§8.2 rule 2) — modelled, so that an
  // `omni.lease` at seq 1 would show up here as the ordering bug it is.
  log.append({
    kind: "omni.worker_state",
    payloadVersion: 2,
    turnId: null,
    payload: { state: "starting", previous: null, reason: "created" },
  });
  const lease = createLease({
    workerId: WID,
    clock,
    config: LeaseConfig.parse(o?.config ?? {}),
    ...(o?.initialHolder === undefined ? {} : { initialHolder: o.initialHolder }),
    onEvent: (e: LeaseEventPayload) => {
      log.append({ kind: "omni.lease", payloadVersion: 2, turnId: null, payload: e });
    },
  });
  return { lease, log, clock };
}

const leaseEnvelopes = (log: Wired["log"]): EventEnvelope[] =>
  log.read(0).filter((e) => e.kind === "omni.lease");

/** The thrown `OmniError`, or a failure naming the call that was supposed to throw. */
async function rejects(what: string, p: Promise<unknown>): Promise<OmniError> {
  let caught: unknown;
  let ok = false;
  try {
    await p;
    ok = true;
  } catch (e) {
    caught = e;
  }
  if (ok) throw new Error(`${what}: expected a rejection, but the call succeeded`);
  expect(caught, `${what} must reject with an OmniError`).toBeInstanceOf(OmniError);
  return caught as OmniError;
}

// ── 1 ────────────────────────────────────────────────────────────────────────

describe("acceptance 1 — runLeaseConformance runs against the OBJECT and the HTTP SURFACE", () => {
  it("is called from both suites, so neither surface can drift alone", () => {
    // The suite itself is `packages/testkit/src/lease-conformance.ts` and is one table of
    // scenarios over a `LeaseSurface`. What this asserts is the thing a reader cannot see from
    // either file alone: that the table has TWO callers, and which they are.
    const object = readFileSync(
      join(REPO_TEST_ROOT, "core/test/lease/conformance.test.ts"),
      "utf8",
    );
    const http = readFileSync(join(REPO_TEST_ROOT, "daemon/test/http/lease.test.ts"), "utf8");
    expect(object).toContain("runLeaseConformance(");
    expect(http).toContain("runLeaseConformance(");
    // The HTTP caller must actually pass the fourth argument — a binding that is never supplied
    // would make the second run a silent no-op and the drift invisible. A `LeaseHttpBinding` is
    // the only thing that argument accepts, and it is the only thing that makes the suite drive
    // `daemon.fetch`.
    expect(http).toContain("LeaseHttpBinding");
    expect(http).toContain("identities:");
    expect(http).toContain("daemon.fetch(");
  });
});

// ── 2 ────────────────────────────────────────────────────────────────────────

describe("acceptance 2 — a non-holder's controlling call is lease_held, naming the holder", () => {
  /**
   * SEAM 3, end to end against the FROZEN `worker.ts`: `prompt`, `cancel` and `wake` each call
   * `this.#deps.lease.assertHolder(who)` as their first statement (F22), so swapping the factory
   * is the whole of D5 enforcement. No core worker file was edited to make this pass.
   */
  it("prompt / cancel / wake on a real Worker, with createLease injected", async () => {
    const clock = fakeClock();
    const lease = createLease({ workerId: WID, clock, config: LeaseConfig.parse({}) });
    const h = harness();
    h.supervisor.enqueue(scriptedAgent());
    const w = await h.create({ overrides: { lease } });

    // The owner reaches for it first: rule L5's implicit acquire, through `prompt`.
    await w.prompt([TEXT("hello")], OWNER);
    const held = lease.snapshot();
    expect(held.holder).toEqual({ tokenId: OWNER.tokenId, clientId: OWNER.clientId });

    for (const [what, call] of [
      ["prompt", () => w.prompt([TEXT("mine now")], OTHER)],
      ["cancel", () => w.cancel(OTHER)],
      ["wake", () => w.wake(OTHER)],
    ] as const) {
      const error = await rejects(what, call());
      expect({ what, code: error.code, status: error.status }).toEqual({
        what,
        code: "lease_held",
        status: 423,
      });
      // The 423 body carries the holder AND the epoch (rule L10) — no second round trip.
      expect(error.toBody().lease?.holder).toEqual({
        tokenId: OWNER.tokenId,
        clientId: OWNER.clientId,
      });
      expect(error.toBody().lease?.epoch).toBe(held.epoch);
    }

    // Nothing moved, and the holder is still in control.
    expect(lease.snapshot()).toEqual(held);
    await w.cancel(OWNER);
    await w.close("client_request");
  });

  it("hibernate and DELETE are enforced one level up, and this says where", () => {
    // `WorkerHandle.hibernate(reason)` and `WorkerHandle.close(reason)` take NO `ClientRef` — the
    // lease cannot be consulted by a call that does not say who is calling. §16.1 rule L3 and
    // H18 therefore live in `registry.delete()` (Land-written: `if (auth.role !== "admin")
    // entry.handle.lease.assertHolder(auth.asClientRef())`) and in `registry.hibernate()`.
    // `DELETE`'s half is asserted over HTTP in `packages/daemon/test/http/lease.test.ts`.
    const { lease } = wired();
    lease.acquire(OWNER);
    // What the lease itself owes those two call sites is an `assertHolder` that refuses, and a
    // `releaseForHibernate` that does not ask permission.
    expect(() => lease.assertHolder(OTHER)).toThrow(OmniError);
    expect(lease.releaseForHibernate().holder).toBeNull();
  });
});

// ── 3 ────────────────────────────────────────────────────────────────────────

describe("acceptance 3 — an observer receives EVERY envelope of the holder's turn", () => {
  it("including omni.lease, at every cursor, with no subscriber ever refused", () => {
    const { lease, log } = wired();
    // Two observers at different cursors: one from birth, one joining mid-turn. D5's 多观察者.
    const fromBirth: EventEnvelope[] = [];
    log.subscribe(0, (e) => fromBirth.push(e));

    lease.assertHolder(OWNER); // implicit acquire → omni.lease
    log.append({
      kind: "acp.session_update",
      payloadVersion: 2,
      turnId: null,
      payload: { sessionUpdate: "state_update", state: "running" } as never,
    });

    const late: EventEnvelope[] = [];
    log.subscribe(1, (e) => late.push(e));

    lease.steal(OTHER, { reason: "taking over", admin: false }); // → omni.lease
    log.append({
      kind: "acp.session_update",
      payloadVersion: 2,
      turnId: null,
      payload: { sessionUpdate: "state_update", state: "idle" } as never,
    });

    // Nothing about being an observer is gated: the log is the same log for everyone (rule L2).
    expect(fromBirth.map((e) => e.kind)).toEqual([
      "omni.worker_state",
      "omni.lease",
      "acp.session_update",
      "omni.lease",
      "acp.session_update",
    ]);
    expect(late).toEqual(fromBirth.slice(1));
    expect(fromBirth.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);

    // ...and every `omni.lease` is a VALID envelope on the wire, field by field.
    for (const envelope of leaseEnvelopes(log)) {
      expect(eventEnvelopeSchema.safeParse(JSON.parse(JSON.stringify(envelope))).success).toBe(
        true,
      );
    }
    // Seq 1 is `worker_state{starting}`, never a lease line (§8.2 rule 2).
    expect(log.read(0)[0]?.kind).toBe("omni.worker_state");
  });

  it("M1-R22: attaching NEVER wakes anything — a Lease has no wake lever at all", () => {
    // Ruling M1-R22 supersedes DESIGN §3.2's `attach` trigger: attach and SSE are ungated
    // OBSERVER operations, and forcing a ~7 s npx cold start on a passive reader would let it
    // spend the holder's quota. The structural half of that is here — subscribing touches the
    // log and nothing else — and the wire half (a `GET .../events` that calls no `workers.wake`)
    // is asserted in `packages/daemon/test/http/lease.test.ts`.
    const { lease, log } = wired({ initialHolder: OWNER });
    const before = lease.snapshot();
    const seen: EventEnvelope[] = [];
    const sub = log.subscribe(0, (e) => seen.push(e));
    expect(seen).toHaveLength(1);
    expect(lease.snapshot()).toEqual(before);
    sub.close();
    expect(log.subscriberCount).toBe(0);
  });
});

// ── 4 ────────────────────────────────────────────────────────────────────────

describe("acceptance 4 — steal transfers, bumps the epoch, and is audited", () => {
  it("writes ONE omni.lease carrying the verbatim reason, and fences the old holder", () => {
    const { lease, log } = wired();
    lease.acquire(OWNER);
    const before = lease.snapshot();

    const after = lease.steal(OTHER, { reason: "took over from the office machine", admin: false });
    expect(after.holder).toEqual({ tokenId: OTHER.tokenId, clientId: OTHER.clientId });
    expect(after.epoch).toBe(before.epoch + 1);

    const envelopes = leaseEnvelopes(log);
    expect(envelopes).toHaveLength(2);
    const stolen = envelopes[1]?.payload as LeaseEventPayload;
    expect(stolen.op).toBe("stolen");
    expect(stolen.how).toBe("steal");
    // D5: 强制抢占（带审计）. The reason is the audit, so it is stored VERBATIM.
    expect(stolen.reason).toBe("took over from the office machine");
    expect(stolen.previous).toEqual({ tokenId: OWNER.tokenId, clientId: OWNER.clientId });
    expect(stolen.by).toEqual({ tokenId: OTHER.tokenId, clientId: OTHER.clientId });

    const error = (() => {
      try {
        lease.assertHolder(OWNER);
      } catch (e) {
        return e as OmniError;
      }
      throw new Error("the stolen-from client was not refused");
    })();
    expect(error.code).toBe("lease_held");
    expect(error.lease?.holder).toEqual({ tokenId: OTHER.tokenId, clientId: OTHER.clientId });
  });
});

// ── 5 ────────────────────────────────────────────────────────────────────────

describe("acceptance 5 — a stale Omni-Lease-Epoch is 423 even from the right client id", () => {
  it("travels on the ClientRef, which is seam 3's other half", async () => {
    const clock = fakeClock();
    const lease = createLease({ workerId: WID, clock, config: LeaseConfig.parse({}) });
    const h = harness();
    h.supervisor.enqueue(scriptedAgent());
    const w = await h.create({ overrides: { lease } });

    // The lease is taken explicitly, so the epoch is known BEFORE the first prompt — and the
    // prompt then carries a fence, which is the plumbing under test.
    const epoch = lease.acquire(OWNER).epoch;
    await w.prompt([TEXT("one")], { ...OWNER, epoch });
    expect(lease.snapshot().epoch, "a fenced prompt by the holder moves nothing").toBe(epoch);

    // Somebody steals; the holder's cached epoch is now one behind.
    lease.steal(OTHER, { reason: null, admin: false });
    const now = lease.snapshot().epoch;
    expect(now).toBe(epoch + 1);

    // The NEW holder, with the OLD fence: still 423. Without this, a stolen-from client silently
    // hijacks the new holder's turn. `wake()` is the gated verb used here because the worker is
    // mid-turn and a second `prompt` would be refused as `worker_busy` before the lease is even
    // consulted — `wake` on a live worker is a pure lease check that returns the snapshot.
    const error = await rejects("stale fence", w.wake({ ...OTHER, epoch }));
    expect(error.code).toBe("lease_held");
    expect(error.lease?.epoch).toBe(now);

    // The same client, with the current fence, is through.
    await w.wake({ ...OTHER, epoch: now });
    // ...and so is a client that sends no fence at all: `Omni-Lease-Epoch` is optional (L7).
    await w.wake(OTHER);
    await w.close("client_request");
  });
});

// ── 6 ────────────────────────────────────────────────────────────────────────

describe("acceptance 6 — a lease never expires mid-turn", () => {
  it("a ttl SHORTER than the turn, a refcounted pin, and expiresAt: null while pinned", () => {
    // Rule L6's exact scenario: the turn outlives the TTL by a factor of four.
    const { lease, clock, log } = wired({ config: { ttlMs: 30_000, renewOnUse: false } });
    lease.acquire(OWNER);

    const unpinOuter = lease.pinExpiry(); // the turn goes `running`
    const unpinInner = lease.pinExpiry(); // ...and something nested pins it too
    expect(lease.snapshot().pinned).toBe(true);
    expect(lease.snapshot().expiresAt, "a pinned lease reports no deadline").toBeNull();

    clock.advance(120_000);
    expect(lease.snapshot().holder).not.toBeNull();
    expect(leaseEnvelopes(log)).toHaveLength(1); // the acquire, and nothing else

    unpinInner();
    expect(lease.snapshot().pinned, "refcounted — one release is not two").toBe(true);
    clock.advance(120_000);
    expect(lease.snapshot().holder).not.toBeNull();

    // The turn settles. NOW the deadline the operator configured applies — and with
    // `renewOnUse: false` it has long since passed, so the lease goes in the same tick.
    unpinOuter();
    expect(lease.snapshot().holder).toBeNull();
    const ops = leaseEnvelopes(log).map((e) => (e.payload as LeaseEventPayload).op);
    expect(ops).toEqual(["acquired", "expired"]);
  });
});

// ── 7 ────────────────────────────────────────────────────────────────────────

describe("acceptance 7 — hibernate releases, an expired lease is free, one envelope each", () => {
  it("in one worker's log, in order", () => {
    const { lease, clock, log } = wired({ config: { ttlMs: 60_000 } });

    lease.acquire(OWNER); //                                    acquired
    lease.releaseForHibernate(); //                             released{hibernate}
    lease.releaseForHibernate(); //                             (nothing — already unheld)
    expect(lease.acquire(OTHER).holder).toEqual({
      tokenId: OTHER.tokenId,
      clientId: OTHER.clientId,
    }); //                                                      acquired
    clock.advance(60_001); //                                   expired
    expect(lease.snapshot().holder).toBeNull();
    lease.assertHolder(OWNER); //                               acquired{implicit}

    const payloads = leaseEnvelopes(log).map((e) => e.payload as LeaseEventPayload);
    expect(payloads.map((p) => [p.op, p.how])).toEqual([
      ["acquired", "explicit"],
      ["released", "hibernate"],
      ["acquired", "explicit"],
      ["expired", "timeout"],
      ["acquired", "implicit"],
    ]);
    // The epoch is monotonic across all of it, and moved exactly where control was taken away
    // (the expiry) or granted by a verb whose answer carries the new value (the two explicit
    // acquires). It does NOT move for the voluntary release, nor for the implicit acquire — see
    // decision 1 in `src/lease/lease.ts`.
    expect(payloads.map((p) => p.lease.epoch)).toEqual([1, 1, 2, 3, 3]);
    // Every one of them is a well-formed envelope: `seq` gap-free, one per transition.
    expect(leaseEnvelopes(log).map((e) => e.seq)).toEqual([2, 3, 4, 5, 6]);
  });

  it("L1: the DAEMON-RESTART expiry is a fifth `how`, and this pins the shape it must have", () => {
    // Ruling M1-R8: the lease is NOT persisted across a restart, but D5 says preemption is
    // audited — so §15.7 step 4 has boot adoption emit `omni.lease{op:"expired",
    // how:"daemon_restart"}` for every abandoned worker, and the transfer is audited rather
    // than silent.
    //
    // That envelope is written by `recoverFromPreviousBoot` / `registry.adopt()`, both of which
    // are M1-WP-E's files and both of which still throw `unimplemented`. What WP-D owes it is
    // the SHAPE — a payload the schema accepts and a reader can act on — so the shape is pinned
    // here rather than discovered when the adoption pass first runs.
    const { log, lease } = wired();
    const payload: LeaseEventPayload = {
      op: "expired",
      // A restart leaves every worker UNHELD: leases are registry state, not process state, and
      // nothing about the previous holder survived (rule L1).
      lease: lease.snapshot(),
      // Not persisted, so genuinely unknown. `null` is the honest answer, and it is the same
      // `previous: null` a reader gets for a lease nobody held.
      previous: null,
      // `by` is null for every `expired`: the clock did it, or a daemon restart did (§5.1).
      by: null,
      how: "daemon_restart",
      reason: null,
    };
    const envelope = log.append({
      kind: "omni.lease",
      payloadVersion: 2,
      turnId: null,
      payload,
    });
    const parsed = eventEnvelopeSchema.safeParse(JSON.parse(JSON.stringify(envelope)));
    expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
    expect(envelope.kind).toBe("omni.lease");
    expect((envelope.payload as LeaseEventPayload).how).toBe("daemon_restart");
    // ...and it is NOT something a live lease can produce on its own: `createLease` only ever
    // emits `timeout` for an expiry, because a restart is not a thing an object survives.
    expect(lease.snapshot().holder).toBeNull();
  });
});

// ── 8 ────────────────────────────────────────────────────────────────────────

describe("acceptance 8 — lease.requireClientId", () => {
  it("true ⇒ a header-less gated call is bad_request (400), not lease_held", () => {
    const { lease } = wired({ config: { requireClientId: true } });
    const anonymous: ClientRef = { tokenId: OWNER.tokenId, clientId: null };
    let caught: unknown;
    try {
      lease.assertHolder(anonymous);
    } catch (e) {
      caught = e;
    }
    expect(OmniError.is(caught, "bad_request")).toBe(true);
    expect((caught as OmniError).status).toBe(400);
    expect((caught as OmniError).lease, "a 400 carries no lease body").toBeUndefined();
  });

  it("false — the DEFAULT — keeps raw curl working: no header, no 400, one shared controller", () => {
    const { lease, config } = { ...wired(), config: LeaseConfig.parse({}) };
    expect(config.requireClientId).toBe(false);
    const anonymous: ClientRef = { tokenId: OWNER.tokenId, clientId: null };
    // `curl-shapes.itest.ts` sends a bearer token and nothing else. Two such calls are ONE
    // controller (rule L4), so the second must not be refused.
    expect(lease.assertHolder(anonymous).holder).toEqual({
      tokenId: OWNER.tokenId,
      clientId: null,
    });
    expect(() => lease.assertHolder({ tokenId: OWNER.tokenId, clientId: null })).not.toThrow();
  });
});

// ── 9 ────────────────────────────────────────────────────────────────────────

describe("acceptance 9 — M0's two-workers-do-not-interfere.itest.ts still passes untouched", () => {
  it("because nothing here changes what a daemon does WITHOUT a leaseFactory", () => {
    // The M1 integration step flipped the daemon's default from `alwaysGrantedLease` to
    // `createLease`, so this is no longer "the enforcing lease never runs". It is the narrower
    // and now load-bearing claim that the ONE seam is still the only way it gets there, which is
    // what keeps `two-workers-do-not-interfere.itest.ts` and `curl-shapes.itest.ts` green: the
    // creator holds its own worker's lease from birth (H5 `lease: "take"`), so a single-client
    // daemon behaves exactly as it did under `alwaysGrantedLease`.
    //
    //  1. `registry.ts` DELEGATES — it never reaches for the enforcing lease itself, so an
    //     embedder passing `DaemonDeps.leaseFactory` still fully controls what a worker gets.
    //  2. `alwaysGrantedLease` is still the fallback when no factory is supplied, which is the
    //     behaviour every core-level harness in this repo depends on.
    const registry = readFileSync(join(REPO_TEST_ROOT, "daemon/src/registry.ts"), "utf8");
    // FOUR arguments, not two: rule L9's `omni.lease` envelope needs the worker's own log, and
    // the registry is the only frame that has one; rule L7's epoch is monotonic per worker, so a
    // REHYDRATED lease resumes from the row's persisted value rather than restarting at 0.
    // `DaemonDeps.leaseFactory` stays frozen at two and stays assignable.
    // Whitespace-insensitive: the expression is one prettier reflow away from failing a literal
    // substring match, and what this asserts is the DELEGATION, not the line breaks.
    expect(registry.replace(/\s+/g, " ")).toContain(
      "o.leaseFactory?.(owner, workerId, log, initialEpoch) ?? alwaysGrantedLease(",
    );
    // A CALL, not the word: `registry.ts`'s own comment names `createLease` as the thing WP-D
    // implements elsewhere, and a guard that fired on its own rationale would teach the next
    // person to delete the rationale (amendment A8).
    expect(registry, "the registry must not reach for the enforcing lease itself").not.toContain(
      "createLease(",
    );

    const createDaemon = readFileSync(join(REPO_TEST_ROOT, "daemon/src/create-daemon.ts"), "utf8");
    // The composition point, and the only one. An INJECTED factory still WINS, which is the
    // property that lets a test take the enforcing lease back out again without editing the
    // daemon.
    //
    // It stopped being a bare `??` at the M1 integration step and the reason is worth stating:
    // `DaemonDeps.leaseFactory` is frozen at `(owner: ClientRef, …)` and has no way to express
    // "nobody holds this yet", which is exactly what a REHYDRATED worker needs (ruling M1-R8 —
    // the lease is not persisted across a restart). So the injected factory is consulted for
    // every held case and the null case composes the daemon's own. The assertion is on the
    // precedence, not on the operator that expresses it.
    const flat = createDaemon.replace(/\s+/g, " ");
    expect(flat).toContain("const injected = deps?.leaseFactory;");
    expect(flat).toContain(
      "if (injected !== undefined && owner !== null) return injected(owner, workerId);",
    );
    expect(createDaemon).toContain("createLease({");
  });
});
