import { HEADER, type EventEnvelope, type LeaseSnapshot } from "@omni-acp/protocol";
import { OmniACP, OmniError, type Server, type Worker } from "@omni-acp/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  curl,
  fixtureAgent,
  readEnvelopes,
  scaled,
  startHarness,
  until,
  type Harness,
} from "./support/harness.js";

/**
 * D5 over the wire: two SDK clients, ONE token, distinct client ids (M1-PLAN §2, WP-F 9).
 *
 * The pairing is the whole point — observer mode is what makes the lease worth having, so the
 * second client must stream the holder's entire turn while its own `prompt` is `423`.
 *
 * ONE token, not two, and that is §16.1 rule L4 rather than a convenience: D13 makes a SECOND
 * token's view of the first's worker a `404`, so pointing the observer at another token would
 * test invisibility while claiming to test contention. The two client ids come from the SDK,
 * which mints a ULID per `connect()`.
 *
 * Owned by M1-WP-F.
 */

let harness: Harness | null = null;
afterEach(async () => {
  await harness?.dispose();
  harness = null;
});

interface Pair {
  readonly h: Harness;
  readonly A: Server;
  readonly B: Server;
  readonly holder: Worker;
  readonly observer: Worker;
}

async function pair(): Promise<Pair> {
  const h = await startHarness({ agents: [fixtureAgent("chatty", "chatty")] });
  harness = h;
  const url = h.daemon.url ?? "";
  const A = await OmniACP.connect({ url, token: h.token });
  const B = await OmniACP.connect({ url, token: h.token });
  const holder = await A.createAgent("chatty", { cwd: h.roots[0] ?? "" });
  const observer = await B.attach(holder.id);
  return { h, A, B, holder, observer };
}

describe("lease contention between two SDK clients", () => {
  it("the observer streams the holder's WHOLE turn (omni.lease included) while its own prompt is 423 with the holder named", async () => {
    const { h, holder, observer } = await pair();

    const seen: EventEnvelope[] = [];
    const off = observer.on("event", (e) => seen.push(e));

    // §16.1 rule L2: `prompt` is gated, and the refusal NAMES the holder (rule L10) so the loser
    // does not have to re-GET a worker it does not control just to find out who won.
    const refused = await observer.prompt("hello").then(
      () => null,
      (e: unknown) => e as OmniError,
    );
    expect(refused?.code).toBe("lease_held");
    expect(refused?.status).toBe(423);
    expect(refused?.lease?.holder?.clientId).toBe(holder.snapshot.lease.holder?.clientId);
    expect(refused?.lease?.holder?.clientId).not.toBeNull();

    // The holder's whole turn, watched from the outside.
    const result = await holder.prompt("say something");
    expect(result.stopReason).toBe("end_turn");

    await until(
      () => seen.some((e) => e.turnId === result.turnId && e.kind === "omni.worker_state"),
      scaled(10_000),
      25,
    );
    off();

    const mine = await readEnvelopes(h.daemon.url ?? "", h.token, holder.id, {
      quietMs: scaled(200),
    });
    const turnEnvelopes = mine.filter((e) => e.turnId === result.turnId).map((e) => e.seq);
    const observed = new Set(seen.map((e) => e.seq));
    // EVERY envelope of the holder's turn, not merely some of them: an observer that saw a
    // sample would be a lease with a peephole rather than the "多观察者" D5 promises.
    for (const seq of turnEnvelopes)
      expect(observed.has(seq), `missed seq ${String(seq)}`).toBe(true);
    // …including the control history. Rule L9 puts every lease TRANSITION in the worker's own
    // log, so an observer reconstructs who held it and when without a second API. A worker whose
    // lease never moved has none — the initial holder is a construction argument, not an event —
    // so the transition is made and then watched.
    seen.length = 0;
    const watching = observer.on("event", (e) => seen.push(e));
    await holder.lease.release();
    await holder.lease.acquire();
    await until(() => seen.filter((e) => e.kind === "omni.lease").length >= 2, scaled(10_000), 25);
    watching();
    expect(
      seen
        .filter((e) => e.kind === "omni.lease")
        .map((e) => (e.kind === "omni.lease" ? e.payload.op : "")),
    ).toEqual(["released", "acquired"]);
  });

  it("steal transfers the lease, bumps the epoch, and the first client's next call is 423", async () => {
    const { holder, observer } = await pair();
    const before = holder.snapshot.lease.epoch;

    const stolen = await observer.lease.steal("the laptop went to sleep");
    expect(stolen.epoch).toBe(before + 1);
    expect(stolen.holder?.clientId).not.toBe(holder.snapshot.lease.holder?.clientId);

    // D5: 带审计. The reason is on the wire VERBATIM, and both holders are named, so a transfer
    // is auditable rather than inferred from a gap in the log.
    const audited = await observer.events({ since: 0 })[Symbol.asyncIterator]();
    const collected: EventEnvelope[] = [];
    for (let i = 0; i < 32; i++) {
      const next = await audited.next();
      if (next.done === true) break;
      collected.push(next.value);
      if (next.value.kind === "omni.lease" && next.value.payload.op === "stolen") break;
    }
    await audited.return?.(undefined);
    const event = collected.find((e) => e.kind === "omni.lease" && e.payload.op === "stolen");
    expect(event?.kind === "omni.lease" && event.payload.reason).toBe("the laptop went to sleep");
    expect(event?.kind === "omni.lease" && event.payload.previous?.clientId).toBe(
      holder.snapshot.lease.holder?.clientId,
    );
    expect(event?.kind === "omni.lease" && event.payload.how).toBe("steal");

    const after = await holder.prompt("mine, surely").then(
      () => null,
      (e: unknown) => e as OmniError,
    );
    expect(after?.code).toBe("lease_held");
    // And the new holder works.
    expect((await observer.prompt("hello")).stopReason).toBe("end_turn");
  });

  it("a stale Omni-Lease-Epoch is 423 even from the right client id", async () => {
    // Rule L7, and the difference between a lease and a hint. The SDK cannot produce this state
    // on its own — it never sends an epoch it did not receive — so it is driven with raw headers.
    const { h, holder } = await pair();
    const clientId = holder.snapshot.lease.holder?.clientId ?? "";
    expect(clientId).not.toBe("");
    const current = holder.snapshot.lease.epoch;

    const request = curl(h.daemon.url ?? "", h.token);
    const body = JSON.stringify({ content: [{ type: "text", text: "hi" }] });

    // The RIGHT client id and the CURRENT epoch: accepted.
    const ok = await request(`/v1/workers/${holder.id}/prompt`, {
      method: "POST",
      body,
      headers: { [HEADER.clientId]: clientId, [HEADER.leaseEpoch]: String(current) },
    });
    expect(ok.status).toBe(202);

    // The RIGHT client id and a STALE epoch: refused. A cached "I hold it" cannot act after the
    // lease moved, which is the one thing that makes a fence a fence.
    const stale = await request(`/v1/workers/${holder.id}/cancel`, {
      method: "POST",
      body: "{}",
      headers: { [HEADER.clientId]: clientId, [HEADER.leaseEpoch]: String(current - 1) },
    });
    expect(stale.status).toBe(423);
    const refused = (await stale.json()) as { code: string; lease?: LeaseSnapshot };
    expect(refused.code).toBe("lease_held");
    expect(refused.lease?.epoch).toBe(current);
    // The holder is unchanged: a refused call must not move the lease it was refused by.
    expect(refused.lease?.holder?.clientId).toBe(clientId);

    // A non-numeric fence is a `bad_request`, not a silently ignored header: a fence the daemon
    // dropped on the floor is worse than no fence at all.
    const malformed = await request(`/v1/workers/${holder.id}/cancel`, {
      method: "POST",
      body: "{}",
      headers: { [HEADER.clientId]: clientId, [HEADER.leaseEpoch]: "not-a-number" },
    });
    expect(malformed.status).toBe(400);
  });

  it("GET and the SSE stream are NEVER lease-gated", async () => {
    const { h, holder, observer, B } = await pair();

    // Rule L2's ungated half, from a client that provably does not hold the lease.
    expect(
      (await observer.prompt("nope").catch((e: unknown) => e as OmniError)) instanceof OmniError,
    ).toBe(true);

    expect((await B.attach(holder.id)).id).toBe(holder.id);
    expect((await B.workers()).map((w) => w.workerId)).toContain(holder.id);

    const tail = observer.events({ since: 0 })[Symbol.asyncIterator]();
    const first = await tail.next();
    expect(first.done).not.toBe(true);
    await tail.return?.(undefined);

    // And a raw GET with NO client id at all — the shape `curl-shapes.itest.ts` uses — is still
    // a 200, because `lease.requireClientId` defaults to false (§16.1, WP-D acceptance 8).
    const request = curl(h.daemon.url ?? "", h.token);
    expect((await request(`/v1/workers/${holder.id}`)).status).toBe(200);
  });
});
