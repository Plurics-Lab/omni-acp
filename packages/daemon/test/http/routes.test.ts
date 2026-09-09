import { describe, expect, it } from "vitest";
import {
  HEADER,
  OmniError,
  type CloseResult,
  type Daemon,
  type EventLog,
  type PromptAccepted,
  type TurnId,
  type TurnStatus,
  type WorkerHandle,
  type WorkerSnapshot,
} from "@omni-acp/protocol";
import { fakeClock, stubDaemon } from "@omni-acp/testkit";
import { createHttpApp } from "../../src/http/app.js";
import { someWorkerId, testEventLog } from "../fake-core.js";

const WID = someWorkerId(1);
const TID = `t_${"0".repeat(25)}1` as TurnId;
const TOKEN = "any-secret-the-stub-accepts";

type Recorder = Daemon & { readonly calls: readonly { method: string; args: unknown[] }[] };

/**
 * Every route test drives `daemon.fetch(new Request(...))` — zero `listen`, zero ports
 * (WP-5 acceptance 3). The stub daemon's own `fetch` is wired to the adapter under test, so the
 * suite exercises the entry point a caller uses rather than a private handle on the app.
 */
function fixture(overrides?: Partial<Daemon>): Recorder {
  let app: ReturnType<typeof createHttpApp> | null = null;
  const daemon = stubDaemon({
    ...overrides,
    fetch: (req: Request) =>
      Promise.resolve(app?.fetch(req) ?? new Response(null, { status: 500 })),
  });
  app = createHttpApp(daemon);
  return daemon;
}

const get = (daemon: Daemon, path: string, init?: RequestInit): Promise<Response> =>
  daemon.fetch(
    new Request(`http://daemon.invalid${path}`, {
      ...init,
      headers: { [HEADER.auth]: `Bearer ${TOKEN}`, ...(init?.headers ?? {}) },
    }),
  );

const send = (daemon: Daemon, method: string, path: string, body?: unknown): Promise<Response> =>
  get(daemon, path, {
    method,
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  });

const snapshot: WorkerSnapshot = {
  workerId: WID,
  daemonId: `d_${"0".repeat(25)}1`,
  ref: `d_${"0".repeat(25)}1:${WID}`,
  sessionId: "sess-1",
  agentId: "example",
  state: "ready",
  cwd: "/work",
  label: null,
  ownerTokenId: "stub",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  headSeq: 2,
  currentTurnId: null,
  capabilities: null,
  process: null,
  closeReason: null,
};

const accepted: PromptAccepted = { turnId: TID, seq: 3 };

const turn: TurnStatus = {
  turnId: TID,
  state: "unknown",
  startSeq: null,
  endSeq: null,
  stopReason: null,
  result: null,
};

const closeResult: CloseResult = {
  workerId: WID,
  state: "closed",
  reason: "client_request",
  leaderExited: true,
  treeGone: true,
};

const emptyLog = (): EventLog =>
  testEventLog({
    workerId: WID,
    daemonId: `d_${"0".repeat(25)}1`,
    clock: fakeClock(),
    maxEvents: 10,
    subscriberQueueSize: 8,
  });

/** A registry whose every façade method answers, so the shape of each route can be asserted. */
const answering = (): Partial<Daemon> => ({
  workers: {
    size: 1,
    create: () => Promise.resolve({ snapshot: () => snapshot } as WorkerHandle),
    get: () => ({ snapshot: () => snapshot }) as WorkerHandle,
    list: () => [snapshot],
    delete: () => Promise.resolve(closeResult),
    closeAll: () => Promise.resolve(),
    snapshot: () => snapshot,
    prompt: () => Promise.resolve(accepted),
    cancel: () => Promise.resolve(),
    turn: () => turn,
    logFor: () => emptyLog(),
  },
});

describe("H1 GET /v1/health (D21)", () => {
  it("is unauthenticated and returns exactly {ok:true}", async () => {
    const daemon = fixture();
    const res = await daemon.fetch(new Request("http://daemon.invalid/v1/health"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // No daemonId, no version, no ACL data on an open port — and no auth call was made.
    expect(daemon.calls.some((c) => c.method === "authenticate")).toBe(false);
  });
});

describe("H2-H4 the read-only routes", () => {
  it("GET /v1/info returns DaemonInfo with the ownership honesty fields (§6.6)", async () => {
    const daemon = fixture();
    const res = await get(daemon, "/v1/info");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ daemonId: daemon.info.daemonId, protocolVersions: [1] });
    expect(body["ownership"]).toEqual(daemon.info.ownership);
  });

  it("GET /v1/whoami returns WhoAmIResponse with policyCeiling present and null", async () => {
    const res = await get(fixture(), "/v1/whoami");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ tokenId: "stub", policyCeiling: null });
  });

  it("GET /v1/agents returns the catalog with probed:null", async () => {
    const daemon = fixture({
      catalog: {
        list: () => [
          { id: "example", command: "node", args: ["a.js"], source: "config", probed: null },
        ],
        get: () => {
          throw new OmniError("bad_request", 'unknown agent "x"');
        },
        toSpawnSpec: () => {
          throw new OmniError("internal", "unused");
        },
      },
    });
    expect(await (await get(daemon, "/v1/agents")).json()).toEqual({
      agents: [{ id: "example", command: "node", args: ["a.js"], source: "config", probed: null }],
    });
  });
});

describe("H5-H12 the worker routes", () => {
  it("POST /v1/workers returns 201 with the snapshot of the handle create() returned", async () => {
    const daemon = fixture(answering());
    const res = await send(daemon, "POST", "/v1/workers", { agent: "example", cwd: "/work" });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(snapshot);
    const registryCalls = daemon.calls.filter((c) => c.method.startsWith("workers."));
    expect(registryCalls).toHaveLength(1);
    // The request's own AbortSignal is handed down, so a client disconnect can cancel a spawn.
    expect(registryCalls[0]?.args[2]).toBeInstanceOf(AbortSignal);
  });

  it("GET /v1/workers lists snapshots", async () => {
    expect(await (await get(fixture(answering()), "/v1/workers")).json()).toEqual({
      workers: [snapshot],
    });
  });

  it("GET /v1/workers/{wid} returns the snapshot", async () => {
    const res = await get(fixture(answering()), `/v1/workers/${WID}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(snapshot);
  });

  it("POST /v1/workers/{wid}/prompt returns 202 {turnId, seq}", async () => {
    const res = await send(fixture(answering()), "POST", `/v1/workers/${WID}/prompt`, {
      content: [{ type: "text", text: "hi" }],
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual(accepted);
  });

  it("POST /v1/workers/{wid}/cancel returns 202 {}", async () => {
    const res = await send(fixture(answering()), "POST", `/v1/workers/${WID}/cancel`);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({});
  });

  it("GET /v1/workers/{wid}/turns/{turnId} returns TurnStatus, unknown at 200 (D29)", async () => {
    const res = await get(fixture(answering()), `/v1/workers/${WID}/turns/${TID}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(turn);
  });

  it("DELETE /v1/workers/{wid} returns 200 CloseResult with the honesty fields", async () => {
    const res = await send(fixture(answering()), "DELETE", `/v1/workers/${WID}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(closeResult);
  });

  it("GET /v1/workers/{wid}/events opens an SSE stream", async () => {
    const res = await get(fixture(answering()), `/v1/workers/${WID}/events?since=0`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/event-stream/);
    await res.body?.cancel();
  });
});

describe("the adapter makes no decision of its own (D15 constraint 1, acceptance 2)", () => {
  const cases: { name: string; run: (d: Recorder) => Promise<unknown>; method: string }[] = [
    {
      name: "POST /v1/workers",
      method: "workers.create",
      run: (d) => send(d, "POST", "/v1/workers", { agent: "example", cwd: "/work" }),
    },
    { name: "GET /v1/workers", method: "workers.list", run: (d) => get(d, "/v1/workers") },
    {
      name: "GET /v1/workers/{wid}",
      method: "workers.snapshot",
      run: (d) => get(d, `/v1/workers/${WID}`),
    },
    {
      name: "POST …/prompt",
      method: "workers.prompt",
      run: (d) =>
        send(d, "POST", `/v1/workers/${WID}/prompt`, { content: [{ type: "text", text: "x" }] }),
    },
    {
      name: "POST …/cancel",
      method: "workers.cancel",
      run: (d) => send(d, "POST", `/v1/workers/${WID}/cancel`),
    },
    {
      name: "GET …/turns/{turnId}",
      method: "workers.turn",
      run: (d) => get(d, `/v1/workers/${WID}/turns/${TID}`),
    },
    {
      name: "DELETE /v1/workers/{wid}",
      method: "workers.delete",
      run: (d) => send(d, "DELETE", `/v1/workers/${WID}`),
    },
    {
      name: "GET …/events",
      method: "workers.logFor",
      run: async (d) => {
        const res = await get(d, `/v1/workers/${WID}/events`);
        await res.body?.cancel();
      },
    },
  ];

  for (const { name, method, run } of cases) {
    it(`${name} calls exactly one WorkerRegistry method: ${method}`, async () => {
      const daemon = fixture(answering());
      await run(daemon);
      // The façade (review R11) is what makes this literally satisfiable: no get-then-act
      // orchestration is possible in the adapter when one call returns the result.
      expect(daemon.calls.filter((c) => c.method.startsWith("workers."))).toEqual([
        expect.objectContaining({ method }),
      ]);
    });
  }

  it("authenticates exactly once per request, and never for /v1/health", async () => {
    const daemon = fixture(answering());
    await get(daemon, "/v1/workers");
    expect(daemon.calls.filter((c) => c.method === "authenticate")).toHaveLength(1);
    await daemon.fetch(new Request("http://daemon.invalid/v1/health"));
    expect(daemon.calls.filter((c) => c.method === "authenticate")).toHaveLength(1);
  });
});

describe("request parsing (acceptance 9)", () => {
  it("rejects malformed JSON, a wrong content type and an unknown key with 400, never 500", async () => {
    const daemon = fixture(answering());

    const malformed = await get(daemon, "/v1/workers", {
      method: "POST",
      body: "{oops",
      headers: { "content-type": "application/json" },
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ code: "bad_request", message: "malformed JSON body" });

    const wrongType = await get(daemon, "/v1/workers", {
      method: "POST",
      body: JSON.stringify({ agent: "example", cwd: "/work" }),
      headers: { "content-type": "text/plain" },
    });
    expect(wrongType.status).toBe(400);

    // `policy` became a REAL field in M2 (§5.8.6), so the unknown-key case needs a key that is
    // still unknown — the assertion is about `strictObject` refusing what it does not model, not
    // about any particular word.
    const unknownKey = await send(daemon, "POST", "/v1/workers", {
      agent: "example",
      cwd: "/work",
      nope: "surprise",
    });
    expect(unknownKey.status).toBe(400);
    expect(((await unknownKey.json()) as { message: string }).message).toMatch(/nope/);

    const noBody = await get(daemon, "/v1/workers", { method: "POST" });
    expect(noBody.status).toBe(400);

    // Nothing above reached the registry.
    expect(daemon.calls.filter((c) => c.method.startsWith("workers."))).toEqual([]);
  });

  it("accepts application/json with a charset parameter", async () => {
    const daemon = fixture(answering());
    const res = await get(daemon, "/v1/workers", {
      method: "POST",
      body: JSON.stringify({ agent: "example", cwd: "/work" }),
      headers: { "content-type": "application/json; charset=utf-8" },
    });
    expect(res.status).toBe(201);
  });

  it("rejects a malformed worker or turn id with 400, echoing no value back", async () => {
    const daemon = fixture(answering());
    const bad = await get(daemon, "/v1/workers/not-a-worker-id");
    expect(bad.status).toBe(400);
    const body = (await bad.json()) as { code: string; message: string };
    expect(body.code).toBe("bad_request");
    expect(body.message).toBe("malformed worker id");
    expect(body.message).not.toContain("not-a-worker-id");

    const badTurn = await get(daemon, `/v1/workers/${WID}/turns/nope`);
    expect(badTurn.status).toBe(400);
    expect(((await badTurn.json()) as { message: string }).message).toBe("malformed turn id");
  });

  /**
   * H28 (§5.8.6): the block-TYPE decision moved out of the schema and into
   * `assertPromptContent`, which is the only layer holding this agent's `promptCapabilities` and
   * this token's `cwdRoots`.
   *
   * So the ROUTE now forwards a `resource_link` to the registry — that is the change — while the
   * SHAPE checks it still owns (an empty array, an unknown key) are still refused before the
   * registry sees anything. The route did not gain a decision; it lost one.
   */
  it("forwards block types to the registry and still refuses a malformed body (H28)", async () => {
    const daemon = fixture(answering());
    const forwarded = await send(daemon, "POST", `/v1/workers/${WID}/prompt`, {
      content: [{ type: "image", data: "…", mimeType: "image/png" }],
    });
    expect(forwarded.status).toBe(202);
    expect(daemon.calls.filter((c) => c.method === "workers.prompt")).toHaveLength(1);

    const empty = await send(daemon, "POST", `/v1/workers/${WID}/prompt`, { content: [] });
    expect(empty.status).toBe(400);
    const unknownKey = await send(daemon, "POST", `/v1/workers/${WID}/prompt`, {
      content: [{ type: "text", text: "hi" }],
      stream: true,
    });
    expect(unknownKey.status).toBe(400);
    // Still exactly ONE registry call across all three: the two malformed bodies never reached it.
    expect(daemon.calls.filter((c) => c.method === "workers.prompt")).toHaveLength(1);
  });

  it("answers an unknown route with a 400 body in the standard shape", async () => {
    const res = await get(fixture(), "/v1/nope");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: "bad_request", message: "unknown route" });
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
  });
});

describe("error propagation (H15)", () => {
  it("maps whatever the registry throws through the one table, with acp verbatim", async () => {
    const daemon = fixture({
      workers: {
        ...(answering().workers as Daemon["workers"]),
        snapshot: () => {
          throw new OmniError("agent_error", "the agent said no", {
            acp: { code: -32000, message: "denied", data: { why: "policy" } },
          });
        },
      },
    });
    const res = await get(daemon, `/v1/workers/${WID}`);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      code: "agent_error",
      message: "the agent said no",
      acp: { code: -32000, message: "denied", data: { why: "policy" } },
    });
  });

  it("does not leak an unclassified throw", async () => {
    const daemon = fixture({
      workers: {
        ...(answering().workers as Daemon["workers"]),
        list: () => {
          throw new Error("connect ECONNREFUSED /run/secret.sock");
        },
      },
    });
    const res = await get(daemon, "/v1/workers");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ code: "internal", message: "internal error" });
  });
});
