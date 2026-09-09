import { describe, expect, it } from "vitest";
import { OmniError } from "@omni-acp/protocol";
import type {
  EventEnvelope,
  EventInput,
  InteractionId,
  InteractionRequest,
  Seq,
  TokenId,
  WorkerId,
} from "@omni-acp/protocol";
import { fakeClock } from "@omni-acp/testkit";
import { createParkTimer } from "../../../src/worker/interaction/park.js";
import {
  createPendingInteractions,
  type HeldInteraction,
  type Settlement,
} from "../../../src/worker/interaction/registry.js";

/**
 * `createPendingInteractions` and `createParkTimer` on their own, with no Worker, no link and no
 * strategy — the two pieces §19.5 and §19.8 are written against.
 *
 * Owned by M2-A-WP-I.
 */

const WORKER = "w_00000000000000000000000001" as WorkerId;
const WHO = { tokenId: "tok_test" as TokenId, clientId: "cli_test" };

const requestOf = (n: number): InteractionRequest => ({
  id: `x_0000000000000000000000000${String(n)}` as InteractionId,
  kind: "permission",
  method: "session/request_permission",
  title: `request ${String(n)}`,
  message: null,
  subject: null,
  options: [],
  fields: [],
  toolCallId: `call_${String(n)}`,
  turnId: null,
  raw: {},
});

const settlementOf = (over?: Partial<Settlement["record"]>): Settlement => ({
  wire: { kind: "resolve", value: { ok: true } },
  record: {
    status: "answered",
    decision: "deny",
    by: "human",
    byToken: null,
    rule: "test",
    ruleSource: null,
    clamped: null,
    optionId: null,
    action: null,
    contentKeys: null,
    parkedMs: 0,
    blindsPolicy: false,
    ...over,
  },
});

function rig(o?: { maxParked?: number; cursor?: () => EventEnvelope | null }) {
  const clock = fakeClock();
  const emitted: EventInput[] = [];
  const released: string[] = [];
  let held: HeldInteraction | null = null;
  const registry = createPendingInteractions({
    maxParked: o?.maxParked ?? 8,
    clock,
    workerId: WORKER,
    decideAnswer: (h) => {
      held = h;
      return settlementOf();
    },
    decideSettleAll: (h, reason) =>
      settlementOf({ status: reason === "timeout" ? "expired" : "cancelled", by: "daemon" }),
    cursor: o?.cursor ?? (() => ({ seq: 7 as Seq }) as EventEnvelope),
  });
  const hold = (n: number, over?: { expiresAtMs?: number | null }): Promise<unknown> =>
    registry.hold(requestOf(n), {
      expiresAtMs: over?.expiresAtMs ?? null,
      onTimeout: "deny",
      emit: (inputs) => emitted.push(...inputs),
      release: () => released.push(String(n)),
    });
  return {
    clock,
    registry,
    emitted,
    released,
    hold,
    get held(): HeldInteraction | null {
      return held;
    },
  };
}

describe("createPendingInteractions — the pending set (§19.5, §19.6)", () => {
  it("holds a promise, publishes a pending snapshot, and settles it exactly once", async () => {
    const r = rig();
    const promise = r.hold(1);
    expect(r.registry.pending.map((p) => p.status)).toEqual(["pending"]);
    expect(r.registry.get(requestOf(1).id)).toMatchObject({
      workerId: WORKER,
      status: "pending",
      expiresAt: null,
      settledAt: null,
      settledBy: null,
      answer: null,
    });

    const result = r.registry.answer(requestOf(1).id, { action: "deny" }, WHO);
    expect(await promise).toEqual({ ok: true });
    expect(result.seq).toBe(7);
    expect(result.state).toBe("running");
    expect(result.interaction.status).toBe("answered");
    // Two envelopes, one release, in that order.
    expect(r.emitted.map((e) => e.kind)).toEqual(["acp.interaction", "omni.policy_decision"]);
    expect(r.released).toEqual(["1"]);
    expect(r.registry.pending).toEqual([]);
  });

  it("keeps a settled row so a double-submit is 409 with the snapshot, not 404", async () => {
    const r = rig();
    const promise = r.hold(1);
    r.registry.answer(requestOf(1).id, { action: "deny" }, WHO);
    await promise;

    let thrown: unknown;
    try {
      r.registry.answer(requestOf(1).id, { action: "deny" }, WHO);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(OmniError);
    expect((thrown as OmniError).code).toBe("interaction_settled");
    expect((thrown as OmniError).interaction).toMatchObject({ status: "answered" });
    // Exactly one settlement reached the wire.
    expect(r.emitted).toHaveLength(2);
    expect(r.released).toEqual(["1"]);
  });

  it("an id it never held is interaction_not_found", () => {
    const r = rig();
    expect(() => r.registry.answer(requestOf(9).id, { action: "deny" }, WHO)).toThrow(
      /no interaction .* is awaiting an answer/,
    );
  });

  it("refuses to hold past maxParked and reports the bound BEFORE the hold", async () => {
    const r = rig({ maxParked: 2 });
    const a = r.hold(1);
    const b = r.hold(2);
    expect(r.registry.atCapacity).toBe(true);
    expect(() => r.hold(3)).toThrow(OmniError);

    r.registry.answer(requestOf(1).id, { action: "deny" }, WHO);
    await a;
    expect(r.registry.atCapacity).toBe(false);
    // The freed slot is usable, and the SETTLED row does not occupy one.
    const c = r.hold(3);
    r.registry.answer(requestOf(2).id, { action: "deny" }, WHO);
    r.registry.answer(requestOf(3).id, { action: "deny" }, WHO);
    await Promise.all([b, c]);
  });

  it("settleOne is the deadline's path and loses the race to a human, silently", async () => {
    const r = rig();
    const promise = r.hold(1);
    r.registry.answer(requestOf(1).id, { action: "deny" }, WHO);
    await promise;
    expect(
      r.registry.settleOne(requestOf(1).id, () => settlementOf({ by: "timeout" }), "timeout"),
    ).toBe(false);
    // Nothing extra reached the wire: a timer that fires one tick late must not settle twice.
    expect(r.emitted).toHaveLength(2);
  });

  it("settleAll settles every open request and is idempotent", async () => {
    const r = rig();
    const a = r.hold(1);
    const b = r.hold(2);
    await r.registry.settleAll("close");
    expect(await a).toEqual({ ok: true });
    expect(await b).toEqual({ ok: true });
    expect(r.registry.pending).toEqual([]);
    expect(r.emitted).toHaveLength(4);
    expect(r.released.sort()).toEqual(["1", "2"]);

    await r.registry.settleAll("close");
    expect(r.emitted).toHaveLength(4);
  });

  it("settleAll returns only once every held promise's continuation has run (review R1)", async () => {
    const r = rig();
    const order: string[] = [];
    const a = r.hold(1).then(() => order.push("held-resolved"));
    await r.registry.settleAll("cancel");
    order.push("settleAll-returned");
    await a;
    expect(order).toEqual(["held-resolved", "settleAll-returned"]);
  });

  it("reports parkedMs from the clock, not from a guess", async () => {
    const r = rig();
    const promise = r.hold(1);
    r.clock.advance(1_234);
    r.registry.answer(requestOf(1).id, { action: "deny" }, WHO);
    await promise;
    expect(r.held?.parkedMs(r.clock.now())).toBe(1_234);
  });

  it("publishes expiresAt while pending and clears it the moment it settles", async () => {
    const r = rig();
    const at = fakeClock().now() + 5_000;
    const promise = r.hold(1, { expiresAtMs: at });
    expect(r.registry.get(requestOf(1).id)?.expiresAt).toBe(new Date(at).toISOString());
    r.registry.answer(requestOf(1).id, { action: "deny" }, WHO);
    await promise;
    // NEVER a lie: a settled row must not advertise a countdown nothing is running.
    expect(r.registry.get(requestOf(1).id)?.expiresAt).toBeNull();
  });

  it("says which wire is missing when no log is available for the answer's seq (§8.2)", async () => {
    const r = rig({ cursor: () => null });
    const promise = r.hold(1);
    let thrown: unknown;
    try {
      r.registry.answer(requestOf(1).id, { action: "deny" }, WHO);
    } catch (e) {
      thrown = e;
    }
    expect((thrown as OmniError).code).toBe("internal");
    expect((thrown as OmniError).message).toContain("EventLog");
    // The request is still parked: a wiring bug must not settle somebody's turn.
    expect(r.registry.pending).toHaveLength(1);
    await r.registry.settleAll("close");
    await promise;
  });
});

describe("createParkTimer (§5.8.9, ruling M2-R7)", () => {
  it("timeoutMs 0 never arms — a park that waits forever is a real configuration", () => {
    const clock = fakeClock();
    let fired = 0;
    const timer = createParkTimer({ clock, timeoutMs: 0, onExpire: () => fired++ });
    expect(timer.armed).toBe(false);
    clock.advance(86_400_000);
    expect(fired).toBe(0);
    expect(clock.pendingTimers).toBe(0);
    expect(() => timer.cancel()).not.toThrow();
  });

  it("fires once at the deadline and is disarmed BEFORE the callback runs", () => {
    const clock = fakeClock();
    let armedInside: boolean | null = null;
    let fired = 0;
    const timer = createParkTimer({
      clock,
      timeoutMs: 5_000,
      onExpire: () => {
        fired += 1;
        armedInside = timer.armed;
      },
    });
    expect(timer.armed).toBe(true);
    clock.advance(4_999);
    expect(fired).toBe(0);
    clock.advance(1);
    expect(fired).toBe(1);
    // The snapshot built inside `onExpire` must not advertise a deadline that has just passed.
    expect(armedInside).toBe(false);
    expect(timer.armed).toBe(false);
  });

  it("cancel is idempotent, disarms, and is safe after firing", () => {
    const clock = fakeClock();
    let fired = 0;
    const timer = createParkTimer({ clock, timeoutMs: 1_000, onExpire: () => fired++ });
    timer.cancel();
    timer.cancel();
    expect(timer.armed).toBe(false);
    expect(clock.pendingTimers).toBe(0);
    clock.advance(10_000);
    expect(fired).toBe(0);

    const second = createParkTimer({ clock, timeoutMs: 1_000, onExpire: () => fired++ });
    clock.advance(1_000);
    expect(fired).toBe(1);
    expect(() => second.cancel()).not.toThrow();
    expect(fired).toBe(1);
  });

  it("treats a negative or non-finite budget as `never arms`, not as `expire now`", () => {
    const clock = fakeClock();
    let fired = 0;
    for (const timeoutMs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const timer = createParkTimer({ clock, timeoutMs, onExpire: () => fired++ });
      expect(timer.armed).toBe(false);
    }
    clock.advance(86_400_000);
    expect(fired).toBe(0);
  });
});
