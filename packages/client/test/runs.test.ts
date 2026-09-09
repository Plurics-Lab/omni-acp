import { describe, expect, it } from "vitest";
import {
  HEADER,
  SSE_CONTROL,
  type CreateRunRequest,
  type DaemonId,
  type EventEnvelope,
  type RunId,
  type RunSnapshot,
  type Seq,
  type WorkerId,
} from "@omni-acp/protocol";
import { createRunsChannel } from "../src/runs.js";
import { createTransport } from "../src/transport.js";

/**
 * `server.runs` — DESIGN §9.3's fire-and-forget half of the SDK.
 *
 * The fixture is a bare `/v1/runs` wire, written here rather than added to
 * `support/wire-daemon.ts` (which belongs to another work package): four JSON verbs and one SSE
 * stream, with a scriptable drop, because the only interesting thing about `events()` is that it
 * RESUMES.
 *
 * Owned by M2-B-WP-R.
 */

const DID = "d_00000000000000000000000001" as DaemonId;
const WID = "w_00000000000000000000000001" as WorkerId;
const RID = "r_00000000000000000000000001" as RunId;
const TOKEN = "runs-token-0123456789";

const snapshot = (state: RunSnapshot["state"] = "starting"): RunSnapshot => ({
  runId: RID,
  daemonId: DID,
  state,
  agentId: "fixture",
  cwd: "/tmp/fixture",
  workerId: WID,
  turnId: null,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  result: null,
  error: null,
  persistence: "durable",
  webhook: null,
});

const envelope = (seq: number, text: string): EventEnvelope =>
  ({
    seq: seq as Seq,
    ts: new Date(seq * 1_000).toISOString(),
    daemonId: DID,
    workerId: WID,
    sessionId: null,
    turnId: null,
    kind: "acp.session_update",
    payloadVersion: 1,
    payload: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
  }) as EventEnvelope;

interface Wire {
  readonly requests: readonly { method: string; path: string; body: string | null }[];
  /** Every `?since=` an SSE connection carried, in order — how a resume is observed. */
  readonly cursors: readonly number[];
  readonly fetch: typeof globalThis.fetch;
}

/** `envelopes` is the whole log; `dropAfter` closes the first N streams mid-flight. */
function wire(o: { envelopes: EventEnvelope[]; dropAfter?: number; maxDrops?: number }): Wire {
  const requests: { method: string; path: string; body: string | null }[] = [];
  const cursors: number[] = [];
  let drops = 0;

  const fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    requests.push({
      method: req.method,
      path: `${url.pathname}${url.search}`,
      body: req.body === null ? null : await req.text(),
    });
    expect(req.headers.get(HEADER.auth)).toBe(`Bearer ${TOKEN}`);

    if (url.pathname === "/v1/runs" && req.method === "POST") {
      return new Response(JSON.stringify(snapshot()), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname === "/v1/runs" && req.method === "GET") {
      return new Response(JSON.stringify({ runs: [snapshot("succeeded")], cursor: null }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname === `/v1/runs/${RID}` && req.method === "GET") {
      return new Response(JSON.stringify(snapshot("succeeded")), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname === `/v1/runs/${RID}/cancel` && req.method === "POST") {
      return new Response(JSON.stringify(snapshot("cancelled")), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname === `/v1/runs/${RID}/events`) {
      const since = Number(url.searchParams.get("since") ?? "0");
      cursors.push(since);
      const due = o.envelopes.filter((e) => e.seq > since);
      const drop = drops < (o.maxDrops ?? 0) ? (o.dropAfter ?? 0) : Number.POSITIVE_INFINITY;
      if (drops < (o.maxDrops ?? 0)) drops += 1;

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          let written = 0;
          for (const e of due) {
            if (written >= drop) {
              // An ABRUPT close: no `omni.stream_end`, exactly as a dropped connection looks.
              controller.close();
              return;
            }
            controller.enqueue(
              encoder.encode(`id: ${String(e.seq)}\ndata: ${JSON.stringify(e)}\n\n`),
            );
            written += 1;
          }
          controller.enqueue(encoder.encode(`event: ${SSE_CONTROL.end}\ndata: {}\n\n`));
          controller.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    }
    return new Response(JSON.stringify({ code: "bad_request", message: url.pathname }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;

  return { requests, cursors, fetch };
}

const channelOver = (w: Wire) =>
  createRunsChannel(
    createTransport({
      url: "http://daemon.invalid",
      token: TOKEN,
      fetch: w.fetch,
      requestTimeoutMs: 5_000,
    }),
  );

const request = (): CreateRunRequest =>
  ({
    agent: "fixture",
    cwd: "/tmp/fixture",
    prompt: [{ type: "text", text: "Reply with exactly the word PONG." }],
  }) as CreateRunRequest;

describe("server.runs", () => {
  it("is parse -> ONE request -> the snapshot, for all four verbs", async () => {
    const w = wire({ envelopes: [] });
    const runs = channelOver(w);

    expect((await runs.create(request())).state).toBe("starting");
    expect((await runs.get(RID)).state).toBe("succeeded");
    expect((await runs.list()).map((r) => r.runId)).toEqual([RID]);
    expect((await runs.cancel(RID)).state).toBe("cancelled");

    expect(w.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /v1/runs",
      `GET /v1/runs/${RID}`,
      "GET /v1/runs",
      `POST /v1/runs/${RID}/cancel`,
    ]);
    // The request body reaches the daemon unaltered — the SDK is a client, not a translator.
    expect(JSON.parse(w.requests[0]?.body ?? "{}")).toEqual(request());
  });

  it("unwraps `RunListResponse` so a caller gets runs rather than an envelope", async () => {
    const w = wire({ envelopes: [] });
    const list = await channelOver(w).list();
    expect(Array.isArray(list)).toBe(true);
    expect(list[0]?.runId).toBe(RID);
  });

  it("events() is the SAME resumable tail worker.events() uses, pointed at the run's route", async () => {
    const w = wire({ envelopes: [1, 2, 3, 4].map((n) => envelope(n, `m${String(n)}`)) });
    const seen: EventEnvelope[] = [];
    for await (const e of channelOver(w).events(RID)) seen.push(e);

    expect(seen.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    // The RUN's route, not a worker's: `GET /v1/runs/{rid}/events` PROXIES the run's worker log
    // (§24.1), so the SDK never has to know the worker's id to follow a run.
    expect(w.requests.every((r) => r.path.startsWith(`/v1/runs/${RID}/events`))).toBe(true);
    expect(w.cursors).toEqual([0]);
  });

  it("honours `since` as an EXCLUSIVE lower bound, exactly as M1's `?since=` does", async () => {
    const w = wire({ envelopes: [1, 2, 3].map((n) => envelope(n, `m${String(n)}`)) });
    const seen: EventEnvelope[] = [];
    for await (const e of channelOver(w).events(RID, { since: 2 })) seen.push(e);
    expect(seen.map((e) => e.seq)).toEqual([3]);
    expect(w.cursors).toEqual([2]);
  });

  it("recovers a dropped connection from the cursor — gap-free AND duplicate-free", async () => {
    // Two drops after two envelopes each: the union over three connections must be the log.
    const w = wire({
      envelopes: [1, 2, 3, 4, 5, 6].map((n) => envelope(n, `m${String(n)}`)),
      dropAfter: 2,
      maxDrops: 2,
    });
    const seen: EventEnvelope[] = [];
    for await (const e of channelOver(w).events(RID)) seen.push(e);

    expect(seen.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    // Each reconnection resumed from the last seq it actually received — which is the whole of
    // §8.4's reconnect contract, and the reason a run's stream needs no second implementation.
    expect(w.cursors).toEqual([0, 2, 4]);
  });

  it("stops on an abort signal without throwing", async () => {
    const w = wire({ envelopes: [1, 2, 3].map((n) => envelope(n, `m${String(n)}`)) });
    const controller = new AbortController();
    const seen: EventEnvelope[] = [];
    for await (const e of channelOver(w).events(RID, { signal: controller.signal })) {
      seen.push(e);
      if (seen.length === 2) controller.abort();
    }
    // The caller's abort ENDS the tail rather than throwing at them: a cancelled stream is a
    // decision, and turning it into an exception makes every caller write a catch that does
    // nothing.
    expect(seen.map((e) => e.seq)).toEqual([1, 2]);
  });

  it("does NOT retry a fatal error — replaying it from the same cursor would loop forever", async () => {
    const failing = (async () =>
      new Response(JSON.stringify({ code: "worker_not_found", message: "no run" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;
    const runs = createRunsChannel(
      createTransport({
        url: "http://daemon.invalid",
        token: TOKEN,
        fetch: failing,
        requestTimeoutMs: 5_000,
      }),
    );
    await expect(
      (async () => {
        for await (const _ of runs.events(RID)) void _;
      })(),
    ).rejects.toThrow(/no run/);
  });
});
