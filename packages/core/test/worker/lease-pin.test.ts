import { describe, expect, it } from "vitest";
import { LeaseConfig, OmniError, type ClientRef, type LeaseEventPayload } from "@omni-acp/protocol";
import { createLease } from "@omni-acp/core";
import { scriptedAgent } from "@omni-acp/testkit";
import { flush, harness, OWNER, TEXT, WORKER_ID } from "./support/harness.js";

/**
 * §16.1 rule L6, WIRED: "Expiry never fires mid-turn. `pinExpiry()` is taken when the turn goes
 * `running` and released when it settles."
 *
 * `pinExpiry` was implemented and unit-tested from the start, but for a while nothing in a
 * production path called it — every caller was a test double or the conformance suite, which
 * takes the pin itself and says so ("the TURN takes it, not a client"). With the shipped
 * defaults (`ttlMs: 900_000`, `renewOnUse: true`) that is invisible until a turn runs longer than
 * the TTL, which is routine for a real agent on a large task: nothing renews during a turn,
 * because `renewOnUse` only fires inside `assertHolder` and no gated verb is called while the
 * agent is working. The lease would then expire MID-TURN, a same-token peer could cancel or
 * delete the worker (rule L5 grants on `holder === null`), and the client still reading its own
 * stream would find its next call a 423.
 *
 * So this file drives the real `createLease` under the real `Worker`, with a TTL shorter than the
 * turn, and asserts the whole rule: no `omni.lease{expired}` mid-turn, `pinned: true` and
 * `expiresAt: null` on the wire, a peer still refused, and the expiry landing normally once the
 * turn is over.
 */

const PEER: ClientRef = { tokenId: OWNER.tokenId, clientId: "cli_peer" };
const TTL = 1_000;

async function running(o?: { renewOnUse?: boolean }): Promise<{
  h: ReturnType<typeof harness>;
  worker: Awaited<ReturnType<ReturnType<typeof harness>["create"]>>;
  agent: ReturnType<typeof scriptedAgent>;
  events: LeaseEventPayload[];
}> {
  const h = harness();
  const events: LeaseEventPayload[] = [];
  const lease = createLease({
    workerId: WORKER_ID,
    clock: h.clock,
    // `renewOnUse: false` by default here, so the pin is the ONLY thing that can keep the lease
    // alive across the turn — a renewal would make a green run unattributable.
    config: LeaseConfig.parse({ ttlMs: TTL, renewOnUse: o?.renewOnUse ?? false }),
    initialHolder: OWNER,
    onEvent: (e) => events.push(e),
  });
  const agent = scriptedAgent();
  h.supervisor.enqueue(agent);
  const worker = await h.create({ overrides: { lease } });
  await worker.prompt([TEXT("a long task")], OWNER);
  await flush();
  return { h, worker, agent, events };
}

describe("rule L6 — the TURN pins the lease (§16.1)", () => {
  it("no expiry fires while the turn runs, however far past the TTL the clock goes", async () => {
    const { h, worker, events } = await running();

    // Ten times the TTL, through the same clock the lease armed its timer on. The lazy sweep is
    // exercised too: `snapshot()` sweeps on every call, so this is not a starved-timer pass.
    h.clock.advance(TTL * 10);
    await flush();
    expect(worker.snapshot().state).toBe("running");
    expect(events.filter((e) => e.op === "expired")).toEqual([]);

    // Rule L6's wire half: a pinned lease reports `expiresAt: null`, because an expiry we will
    // not honour is a lie an operator would plan around.
    const snapshot = worker.snapshot().lease;
    expect(snapshot.pinned).toBe(true);
    expect(snapshot.expiresAt).toBeNull();
    expect(snapshot.holder?.clientId).toBe(OWNER.clientId);

    await worker.close("client_request");
  });

  it("a same-token peer is STILL refused mid-turn — the single controller is what L6 protects", async () => {
    const { h, worker } = await running();
    h.clock.advance(TTL * 10);
    await flush();

    // Without the pin the lease would be unheld by now, `mayAct` would grant on `holder === null`
    // (rule L5), and this cancel would kill a turn its owner is still reading.
    const refused = await worker.cancel(PEER).then(
      () => null,
      (e: unknown) => e as OmniError,
    );
    expect(OmniError.is(refused, "lease_held")).toBe(true);
    expect((refused as OmniError).lease?.holder?.clientId).toBe(OWNER.clientId);

    await worker.close("client_request");
  });

  it("the pin is RELEASED when the turn settles, and the overdue expiry then lands", async () => {
    const { h, worker, agent, events } = await running();
    h.clock.advance(TTL * 10);
    await flush();
    expect(events.filter((e) => e.op === "expired")).toEqual([]);

    agent.resolvePrompt("end_turn");
    await flush();
    // The quiet window closes the turn (§13.1); the worker is `ready` again.
    h.clock.advance(300);
    await flush();
    expect(worker.snapshot().state).toBe("ready");

    // `renewOnUse: false` is the operator asking for exactly this: expire the moment the turn is
    // no longer at risk. The un-pin re-arms and sweeps, so it happens without a further tick.
    const expired = events.filter((e) => e.op === "expired");
    expect(expired).toHaveLength(1);
    expect(expired[0]?.how).toBe("timeout");
    expect(worker.snapshot().lease.holder).toBeNull();
    expect(worker.snapshot().lease.pinned).toBe(false);

    await worker.close("client_request");
  });

  it("a close from `running` releases the pin too, so a dead worker's lease is not un-expirable", async () => {
    const { h, worker, events } = await running();
    h.clock.advance(TTL * 10);
    await worker.close("client_request");
    await flush();
    expect(worker.snapshot().lease.pinned).toBe(false);
    // The lease's own sweep is what expires it; what this asserts is that the WORKER stopped
    // holding it open.
    expect(events.some((e) => e.op === "expired")).toBe(true);
  });

  it("an admission that never reaches `running` leaves no pin behind", async () => {
    const h = harness();
    const events: LeaseEventPayload[] = [];
    const lease = createLease({
      workerId: WORKER_ID,
      clock: h.clock,
      config: LeaseConfig.parse({ ttlMs: TTL, renewOnUse: false }),
      initialHolder: OWNER,
      onEvent: (e) => events.push(e),
    });
    const agent = scriptedAgent();
    h.supervisor.enqueue(agent);
    const worker = await h.create({ overrides: { lease } });

    // A prompt the worker refuses (§15.2's half-open window is the other one) must not leave the
    // lease pinned forever: a pin nobody releases is a TTL that never fires again.
    await expect(worker.prompt([], OWNER)).rejects.toBeInstanceOf(OmniError);
    expect(worker.snapshot().lease.pinned).toBe(false);

    h.clock.advance(TTL * 2);
    expect(worker.snapshot().lease.holder).toBeNull();
    await worker.close("client_request");
  });
});
