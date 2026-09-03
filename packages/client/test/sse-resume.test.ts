import { OmniACP } from "@omni-acp/client";
import type { EventEnvelope } from "@omni-acp/protocol";
import { collectSse } from "@omni-acp/testkit";
import { describe, expect, it } from "vitest";
import { createWireDaemon, fetchOf, type WireDaemon } from "./support/wire-daemon.js";

async function attach(wire: WireDaemon, workerId: string) {
  const server = await OmniACP.connect({
    url: wire.url,
    token: wire.token,
    fetch: fetchOf(wire.daemon),
  });
  return server.attach(workerId);
}

/**
 * WP-6 acceptance 4: five mid-turn drops still yield a gap-free, duplicate-free envelope
 * sequence identical to a reference full replay.
 *
 * The reference is not "what the client happened to receive"; it is the daemon's own log, read
 * with `?since=0`. That is what makes this a test of the RESUME rule rather than a test of the
 * client agreeing with itself.
 */
describe("SSE resume", () => {
  it("survives five mid-turn drops with no gaps and no duplicates", async () => {
    const wire = createWireDaemon({
      emit: "async",
      stepMs: 1,
      chaos: { dropAfter: 2, maxDrops: 5 },
    });
    const snapshot = wire.createWorker();
    const worker = await attach(wire, snapshot.workerId);

    const result = await worker.prompt("who are you?");

    // The turn completed anyway.
    expect(result.stopReason).toBe("end_turn");
    expect(result.text).toContain("I'll skip the configuration update.");

    // The connections tell the story: the first at `accepted.seq - 1`, each later one at the
    // last seq the client actually saw. A client that reconnected at 0 would duplicate; one
    // that reconnected at `last + 1` would skip.
    expect(wire.connections.length).toBeGreaterThan(5);
    const cursors = wire.connections.map((c) => c.since);
    expect(cursors).toEqual([...cursors].sort((a, b) => a - b));

    // The union the client folded is exactly the daemon's log for this turn, in order.
    const reference = wire
      .envelopes(snapshot.workerId)
      .filter((e) => e.turnId === result.turnId)
      .map((e) => e.seq);
    const seen: number[] = [];
    for await (const e of worker.events({ since: 0 })) {
      seen.push(e.seq);
      if (e.seq >= (reference.at(-1) ?? 0)) break;
    }
    expect(new Set(seen).size).toBe(seen.length); // no duplicates
    expect(seen).toEqual(
      wire
        .envelopes(snapshot.workerId)
        .map((e) => e.seq)
        .filter((s) => s <= (reference.at(-1) ?? 0)),
    ); // no gaps
  });

  it("reconnects with ?since=<last seq> after a drop, never from zero", async () => {
    const wire = createWireDaemon({
      emit: "async",
      stepMs: 1,
      chaos: { dropAfter: 3, maxDrops: 2 },
    });
    const snapshot = wire.createWorker();
    const worker = await attach(wire, snapshot.workerId);

    await worker.prompt("who are you?");

    const [first, ...rest] = wire.connections;
    expect(first).toBeDefined();
    for (const connection of rest) {
      expect(connection.since).toBeGreaterThan(first?.since ?? 0);
    }
  });

  it("accepts an out-of-band stream_truncated notice and keeps going from the tail", async () => {
    // `since < tail` is answered with a control frame and a truthful PARTIAL replay, not an
    // error and not a silent gap (CONTRACTS.md §8.4, D6/D24).
    const wire = createWireDaemon({ emit: "sync", tail: 4 });
    const snapshot = wire.createWorker();
    const worker = await attach(wire, snapshot.workerId);
    await worker.prompt("who are you?"); // gives the log something above the tail

    // First, on the wire: the notice is a CONTROL frame — no `id:`, not an envelope, consuming
    // no seq. An `omni.error` envelope here would need a fabricated seq that two subscribers
    // would then disagree about (D24).
    const raw = await wire.daemon.fetch(
      new Request(`${wire.url}/v1/workers/${snapshot.workerId}/events?since=0`, {
        headers: { authorization: `Bearer ${wire.token}` },
      }),
    );
    const { envelopes, control } = await collectSse(raw, { count: 1, timeoutMs: 2_000 });
    expect(control).toEqual([{ event: "omni.stream_truncated", data: { tail: 4 } }]);
    expect(envelopes[0]?.seq).toBe(4);

    // Then, through the SDK: the client is told, keeps the stream, and starts at the tail.
    const seen: EventEnvelope[] = [];
    for await (const e of worker.events({ since: 0 })) {
      seen.push(e);
      break;
    }
    expect(seen[0]?.seq).toBe(4);
  });

  it("returns the daemon's subscriber count to zero when the reader goes away", async () => {
    const wire = createWireDaemon({ emit: "async", stepMs: 5 });
    const snapshot = wire.createWorker();
    const worker = await attach(wire, snapshot.workerId);

    const controller = new AbortController();
    const iterator = worker.events({ since: 0, signal: controller.signal })[Symbol.asyncIterator]();
    await iterator.next();
    expect(wire.subscriberCount(snapshot.workerId)).toBe(1);

    controller.abort();
    await iterator.next().catch(() => undefined);
    await iterator.return?.(undefined);

    expect(wire.subscriberCount(snapshot.workerId)).toBe(0);
  });

  it("ends events() at the worker's close rather than reconnecting into a 404", async () => {
    const wire = createWireDaemon({ emit: "async", stepMs: 1 });
    const snapshot = wire.createWorker();
    const worker = await attach(wire, snapshot.workerId);

    const collected: EventEnvelope[] = [];
    const reading = (async () => {
      for await (const e of worker.events({ since: 0 })) collected.push(e);
    })();

    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    wire.closeWorker(snapshot.workerId, "client_request");
    await reading;

    const last = collected.at(-1);
    expect(last?.kind).toBe("omni.worker_state");
    expect(wire.subscriberCount(snapshot.workerId)).toBe(0);
  });
});
