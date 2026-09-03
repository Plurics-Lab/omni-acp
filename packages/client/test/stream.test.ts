import { OmniACP, type StreamEvent, type TurnResult } from "@omni-acp/client";
import { describe, expect, it } from "vitest";
import { createWireDaemon, fetchOf } from "./support/wire-daemon.js";

/**
 * WP-6 acceptance 6: `stream()` yields `text` deltas in seq order and a terminal `done` whose
 * result deep-equals `prompt()`'s.
 *
 * The deep-equality is not a coincidence to be checked; it is structural — both fold the same
 * envelopes with the same `reduceTurn`. The test is here so that any future short-cut in
 * `stream()` (say, accumulating text as it goes) shows up as a disagreement immediately.
 */
describe("Worker.stream", () => {
  it("yields text deltas in seq order and a done whose result equals prompt()'s", async () => {
    const wire = createWireDaemon({ emit: "async", stepMs: 1 });
    const server = await OmniACP.connect({
      url: wire.url,
      token: wire.token,
      fetch: fetchOf(wire.daemon),
    });
    const worker = await server.attach(wire.createWorker().workerId);

    const events: StreamEvent[] = [];
    for await (const event of worker.stream("who are you?")) events.push(event);

    const done = events.at(-1);
    expect(done?.type).toBe("done");
    const streamed = (done as { type: "done"; result: TurnResult }).result;

    const texts = events.filter((e) => e.type === "text").map((e) => e.delta);
    expect(texts).toEqual(["I'll help you with that.", " I'll skip the configuration update."]);
    expect(texts.join("")).toBe(streamed.text);

    expect(events.filter((e) => e.type === "thought").map((e) => e.delta)).toEqual([
      "considering the config change",
    ]);

    // Every envelope is also available raw, and the raw sequence is strictly ascending in seq —
    // which is the property `?since=` resume has to preserve.
    const seqs = events.filter((e) => e.type === "raw").map((e) => e.envelope.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);

    // The lifecycle brackets the turn: running first, idle last.
    const states = events.filter((e) => e.type === "state");
    expect(states.map((s) => s.state)).toEqual(["running", "idle"]);
    expect(states.at(-1)?.stopReason).toBe("end_turn");

    // Tool calls arrive as views built by the SAME reducer, so the last view of each id is its
    // terminal state.
    const calls = events.filter((e) => e.type === "tool_call").map((e) => e.toolCall);
    expect(calls.map((c) => c.toolCallId)).toEqual(["call_1", "call_1", "call_2"]);
    expect(calls.at(1)?.status).toBe("completed");

    // The whole point (DESIGN §5.5): the streamed aggregate and the daemon's own aggregate for
    // THAT turn are one object. Comparing against a second turn would compare timestamps, not
    // the property under test.
    const polled = await worker.turn(streamed.turnId);
    expect(polled.result).toEqual(streamed);

    // And a plain prompt() on the same worker folds the same shape, id and timing aside.
    const second = await worker.prompt("who are you?");
    const shape = (r: TurnResult): unknown => ({
      ...r,
      turnId: "t",
      workerId: "w",
      interactions: r.interactions.map((i) => ({ ...i, at: "t" })),
    });
    expect(shape(streamed)).toEqual(shape(second));
  });

  it("does not start the turn until the caller actually iterates", async () => {
    // An async generator body runs on the first `next()`. Anything else would take the worker's
    // one turn slot for a stream nobody consumes.
    const wire = createWireDaemon({ emit: "async", stepMs: 1 });
    const server = await OmniACP.connect({
      url: wire.url,
      token: wire.token,
      fetch: fetchOf(wire.daemon),
    });
    const snapshot = wire.createWorker();
    const worker = await server.attach(snapshot.workerId);

    const iterable = worker.stream("who are you?");
    expect(wire.requests.filter((r) => r.path.endsWith("/prompt"))).toEqual([]);

    const iterator = iterable[Symbol.asyncIterator]();
    await iterator.next();
    expect(wire.requests.filter((r) => r.path.endsWith("/prompt"))).toHaveLength(1);

    // Abandoning the stream releases the queue slot and closes the subscription.
    await iterator.return?.(undefined);
    expect(wire.subscriberCount(snapshot.workerId)).toBe(0);
  });

  it("settles a stream on worker close, ending with done rather than hanging", async () => {
    const wire = createWireDaemon({ emit: "async", stepMs: 2 });
    const server = await OmniACP.connect({
      url: wire.url,
      token: wire.token,
      fetch: fetchOf(wire.daemon),
    });
    const snapshot = wire.createWorker();
    const worker = await server.attach(snapshot.workerId);

    const events: StreamEvent[] = [];
    const consuming = (async () => {
      for await (const event of worker.stream("who are you?")) events.push(event);
    })();

    // Kill the worker out of band, the way a crash would.
    await new Promise<void>((resolve) => setTimeout(resolve, 6));
    wire.closeWorker(snapshot.workerId, "agent_crashed");
    await consuming;

    const done = events.at(-1);
    expect(done?.type).toBe("done");
    expect((done as { result: TurnResult }).result.stopReason).toBeNull();
    expect((done as { result: TurnResult }).result.error).toMatchObject({ code: "agent_error" });
  });
});
