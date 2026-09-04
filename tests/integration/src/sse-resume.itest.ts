import type { EventEnvelope, WorkerSnapshot } from "@omni-acp/protocol";
import { collectSse } from "@omni-acp/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { curl, fixtureAgent, startHarness, until, type Harness } from "./support/harness.js";

/**
 * WP-6. Drop the stream mid-turn, reconnect with `?since=`, union is gap-free.
 *
 * The reference is a FULL replay of the same log (`?since=0`), read after the fact. The claim is
 * that a client which loses its connection N times ends up holding exactly what a client that
 * never lost it would hold — no gaps, no duplicates, same order. That is the whole of §8.4's
 * resume contract, and it is what `prompt()` silently depends on.
 */
describe("SSE resume", () => {
  let harness: Harness;
  let http: (path: string, init?: RequestInit) => Promise<Response>;
  let worker: WorkerSnapshot;

  beforeAll(async () => {
    // `chatty` emits a chunk 400 ms AFTER the prompt response, so there is a turn long enough to
    // interrupt without racing the fixture's own completion.
    harness = await startHarness({ roots: 1, agents: [fixtureAgent("chatty", "chatty")] });
    const base = harness.daemon.url;
    if (base === null) throw new Error("the harness bound no socket");
    http = curl(base, harness.token);

    worker = (await (
      await http("/v1/workers", {
        method: "POST",
        body: JSON.stringify({ agent: "chatty", cwd: harness.roots[0] }),
      })
    ).json()) as WorkerSnapshot;
  }, 30_000);

  afterAll(async () => {
    await harness?.dispose();
  });

  it("reconnects with ?since= and yields a union identical to a full-replay reference", async () => {
    const accepted = (await (
      await http(`/v1/workers/${worker.workerId}/prompt`, {
        method: "POST",
        body: JSON.stringify({ content: [{ type: "text", text: "hello" }] }),
      })
    ).json()) as { turnId: string; seq: number };

    // Read two envelopes, drop the connection, resume from the last seq we saw.
    const first = await collectSse(await http(`/v1/workers/${worker.workerId}/events?since=0`), {
      count: 2,
      timeoutMs: 10_000,
    });
    expect(first.envelopes).toHaveLength(2);
    const cursor = first.envelopes.at(-1)?.seq ?? 0;

    const rest = await collectSse(
      await http(`/v1/workers/${worker.workerId}/events?since=${String(cursor)}`),
      { until: isIdle(accepted.turnId), timeoutMs: 15_000 },
    );

    const union = [...first.envelopes, ...rest.envelopes];
    const reference = await collectSse(
      await http(`/v1/workers/${worker.workerId}/events?since=0`),
      { until: isIdle(accepted.turnId), timeoutMs: 15_000 },
    );

    expect(union.map(identity)).toEqual(reference.envelopes.map(identity));
    // `?since=N` is EXCLUSIVE, so the two halves abut rather than overlap.
    expect(union.map((e) => e.seq)).toEqual(union.map((_, i) => i + 1));
  }, 45_000);

  it("survives five mid-turn drops with no gaps and no duplicates", async () => {
    const accepted = (await (
      await http(`/v1/workers/${worker.workerId}/prompt`, {
        method: "POST",
        body: JSON.stringify({ content: [{ type: "text", text: "again" }] }),
      })
    ).json()) as { turnId: string; seq: number };

    const union: EventEnvelope[] = [];
    let cursor = accepted.seq - 1;
    for (let drop = 0; drop < 5; drop++) {
      const chunk = await collectSse(
        await http(`/v1/workers/${worker.workerId}/events?since=${String(cursor)}`),
        { count: 1, timeoutMs: 15_000 },
      );
      union.push(...chunk.envelopes);
      cursor = union.at(-1)?.seq ?? cursor;
      if (union.some(isIdle(accepted.turnId))) break;
    }
    if (!union.some(isIdle(accepted.turnId))) {
      const tail = await collectSse(
        await http(`/v1/workers/${worker.workerId}/events?since=${String(cursor)}`),
        { until: isIdle(accepted.turnId), timeoutMs: 15_000 },
      );
      union.push(...tail.envelopes);
    }

    const seqs = union.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs).toEqual(seqs.map((_, i) => (seqs[0] ?? 1) + i));

    // The chatty fixture's whole reason for existing: its late chunk lands BEFORE `idle`,
    // because of the quiet window (L5, §7.2). Without the window, this ordering inverts.
    const idleSeq = union.find(isIdle(accepted.turnId))?.seq ?? 0;
    const lateChunk = union.filter(
      (e) =>
        e.turnId === accepted.turnId &&
        // Ruling M1-R10 flipped `payloadVersion` to 2 for a mapped `agent_message_chunk`; the
        // chunk itself is what this case is about, so it is matched by kind and content.
        e.kind === "acp.session_update" &&
        JSON.stringify(e.payload).includes("tail arriving after the response"),
    );
    expect(lateChunk).toHaveLength(1);
    expect(lateChunk[0]?.seq).toBeLessThan(idleSeq);
  }, 60_000);

  it("emits omni.stream_truncated when since < tail and keeps the stream open", async () => {
    // The M0 ring is 10 000 events and this suite writes tens, so a genuine eviction cannot be
    // provoked cheaply. What CAN be asserted here is the other half of the rule: a cursor BELOW
    // the tail is not an error, and a cursor ABOVE the head is accepted with no replay.
    const head = ((await (await http(`/v1/workers/${worker.workerId}`)).json()) as WorkerSnapshot)
      .headSeq;

    const ahead = await http(`/v1/workers/${worker.workerId}/events?since=${String(head + 100)}`);
    expect(ahead.status).toBe(200);
    // Accepted, live only: cursor skew must not be an error (§8.4).
    await ahead.body?.cancel();

    const behind = await http(`/v1/workers/${worker.workerId}/events?since=0`);
    expect(behind.status).toBe(200);
    const replay = await collectSse(behind, { count: 1, timeoutMs: 10_000 });
    expect(replay.envelopes[0]?.seq).toBe(1);
    // No truncation notice, because nothing was truncated — the notice is a fact, not a habit.
    expect(replay.control).toEqual([]);
  }, 30_000);

  it("returns log.subscriberCount to its baseline when the client aborts", async () => {
    // A worker of its own, created here: the shared one has had four streams opened against it
    // by the tests above, and a server notices a dropped connection asynchronously, so its count
    // is still draining. On a fresh log the only subscriber is the daemon's own.
    const mine = (await (
      await http("/v1/workers", {
        method: "POST",
        body: JSON.stringify({ agent: "chatty", cwd: harness.roots[0] }),
      })
    ).json()) as WorkerSnapshot;
    const log = harness.daemon.workers.logFor(
      mine.workerId,
      harness.daemon.authContextFor("local"),
    );

    // The assembled daemon holds ONE long-lived subscription per worker — the fan-out that feeds
    // `daemon.on(...)`, attached before the handshake so a listener sees a worker's whole life —
    // so `subscriberCount` has a baseline of 1 while the daemon is running, and it is the DELTA
    // a client's stream adds that must come back. (`daemon.stop()` closes that one too, which is
    // what `create-daemon.test.ts` asserts as an absolute 0.)
    const baseline = log.subscriberCount;
    expect(baseline).toBe(1);

    const controller = new AbortController();
    const res = await fetch(
      `${harness.daemon.url ?? ""}/v1/workers/${mine.workerId}/events?since=0`,
      {
        headers: { authorization: `Bearer ${harness.token}` },
        signal: controller.signal,
      },
    );
    expect(res.status).toBe(200);
    expect(await until(() => log.subscriberCount === baseline + 1, 5_000)).toBe(true);

    controller.abort();

    // A leaked subscription per reconnect is the classic SSE memory leak, and reconnects are
    // the normal path here, so it compounds.
    expect(await until(() => log.subscriberCount === baseline, 5_000)).toBe(true);
  }, 30_000);
});

function isIdle(turnId: string) {
  return (e: EventEnvelope): boolean => {
    if (e.kind !== "acp.session_update" || e.turnId !== turnId) return false;
    const payload = e.payload as unknown as Record<string, unknown>;
    return payload["sessionUpdate"] === "state_update" && payload["state"] === "idle";
  };
}

/** An envelope IS its `(workerId, seq)` pair; everything else is derived (turn.ts). */
function identity(e: EventEnvelope): string {
  return `${e.workerId}#${String(e.seq)}#${e.kind}`;
}
