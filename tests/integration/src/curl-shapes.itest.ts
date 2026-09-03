import type {
  AgentListResponse,
  CloseResult,
  DaemonInfo,
  HealthResponse,
  OmniErrorBody,
  PromptAccepted,
  TurnStatus,
  WhoAmIResponse,
  WorkerListResponse,
  WorkerSnapshot,
} from "@omni-acp/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { curl, startHarness, until, type Harness } from "./support/harness.js";

/**
 * M0's own milestone wording: raw `fetch` against every route, asserting the literal JSON shapes
 * of CONTRACTS.md §2.1 with no SDK in the loop. If the SDK and the wire ever disagree, this is
 * the test that says which one moved. WP-6 owns this file.
 */
describe("raw HTTP shapes", () => {
  let harness: Harness;
  let http: (path: string, init?: RequestInit) => Promise<Response>;
  let anon: (path: string, init?: RequestInit) => Promise<Response>;
  let worker: WorkerSnapshot;
  let turnId = "";

  /** Polls the snapshot until the worker is back to `ready`, and reports what it saw. */
  async function waitReady(timeoutMs = 10_000): Promise<string> {
    let state = "";
    await until(async () => {
      state = ((await (await http(`/v1/workers/${worker.workerId}`)).json()) as WorkerSnapshot)
        .state;
      return state === "ready";
    }, timeoutMs);
    return state;
  }

  beforeAll(async () => {
    harness = await startHarness({ roots: 1 });
    const base = harness.daemon.url;
    if (base === null) throw new Error("the harness bound no socket");
    http = curl(base, harness.token);
    anon = curl(base, null);
  }, 30_000);

  afterAll(async () => {
    await harness?.dispose();
  });

  it("GET /v1/health is unauthenticated and returns exactly {ok:true}", async () => {
    const res = await anon("/v1/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthResponse;
    // Liveness only. No daemonId and no version: an identifier leak on an unauthenticated route
    // is how an internal daemon becomes fingerprintable from the outside (D21).
    expect(body).toEqual({ ok: true });
  });

  it("rejects every other route without a bearer token, with the §9 error body", async () => {
    for (const path of ["/v1/info", "/v1/whoami", "/v1/agents", "/v1/workers"]) {
      const res = await anon(path);
      expect(`${path} -> ${String(res.status)}`).toBe(`${path} -> 401`);
      const body = (await res.json()) as OmniErrorBody;
      expect(Object.keys(body).sort()).toEqual(["code", "message"]);
      expect(body.code).toBe("unauthorized");
    }
    const wrong = await curl(harness.daemon.url ?? "", "not-the-token")("/v1/whoami");
    expect(wrong.status).toBe(401);
  });

  it("GET /v1/info returns DaemonInfo including the ownership honesty fields", async () => {
    const res = await http("/v1/info");
    expect(res.status).toBe(200);
    const body = (await res.json()) as DaemonInfo;

    expect(body.daemonId).toMatch(/^d_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(body.protocolVersions).toEqual([1]);
    expect(body.platform).toBe(process.platform);
    expect(body.nodeVersion).toBe(process.version);
    expect(typeof body.startedAt).toBe("string");
    // §6.6: the caveat is a sentence an operator can read BEFORE anything goes wrong.
    expect(body.ownership.kind).toBe(
      process.platform === "win32" ? "windows-taskkill-tree" : "posix-process-group",
    );
    expect(body.ownership.confirmsTreeGone).toBe(process.platform !== "win32");
    if (process.platform === "win32") expect(body.ownership.caveat).toBeTruthy();
  });

  it("GET /v1/whoami returns WhoAmIResponse with policyCeiling present and null", async () => {
    const res = await http("/v1/whoami");
    expect(res.status).toBe(200);
    const body = (await res.json()) as WhoAmIResponse;
    expect(body).toMatchObject({ tokenId: "local", role: "admin", maxWorkers: 16 });
    expect(body.daemonId).toBe(harness.daemon.id);
    // Present-and-null so the field never appears and disappears between milestones.
    expect("policyCeiling" in body).toBe(true);
    expect(body.policyCeiling).toBeNull();
  });

  it("GET /v1/agents returns the static catalog with probed:null", async () => {
    const res = await http("/v1/agents");
    expect(res.status).toBe(200);
    const body = (await res.json()) as AgentListResponse;
    expect(body.agents.map((a) => a.id)).toEqual(["example"]);
    expect(body.agents[0]).toMatchObject({ source: "config", probed: null });
    expect(body.agents[0]?.command).toBe(process.execPath);
  });

  it("POST /v1/workers returns 201 WorkerSnapshot{state:'ready'} with real handshake capabilities", async () => {
    const res = await http("/v1/workers", {
      method: "POST",
      body: JSON.stringify({ agent: "example", cwd: harness.roots[0] }),
    });
    expect(res.status).toBe(201);
    worker = (await res.json()) as WorkerSnapshot;

    // H5 is SYNCHRONOUSLY ready: spawn, initialize and session/new have all happened.
    expect(worker.state).toBe("ready");
    expect(worker.workerId).toMatch(/^w_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(worker.ref).toBe(`${worker.daemonId}:${worker.workerId}`);
    expect(worker.sessionId).toBeTruthy();
    expect(worker.process?.pid).toBeGreaterThan(0);
    // The real handshake answer, never a placeholder: the example agent says loadSession:false,
    // which is what makes it an M0 fixture (no resume path to get wrong).
    expect(worker.capabilities?.protocolVersion).toBe(1);
    expect(worker.capabilities?.loadSession).toBe(false);
    expect(worker.capabilities?.raw).toMatchObject({ loadSession: false });
  }, 30_000);

  it("GET /v1/workers and /v1/workers/{wid} return the listing and the snapshot", async () => {
    const list = (await (await http("/v1/workers")).json()) as WorkerListResponse;
    expect(list.workers.map((w) => w.workerId)).toContain(worker.workerId);

    const one = await http(`/v1/workers/${worker.workerId}`);
    expect(one.status).toBe(200);
    expect(((await one.json()) as WorkerSnapshot).workerId).toBe(worker.workerId);
  });

  it("404s an unknown worker without leaking whether it exists", async () => {
    const res = await http("/v1/workers/w_00000000000000000000000000");
    expect(res.status).toBe(404);
    expect((await res.json()) as OmniErrorBody).toMatchObject({ code: "worker_not_found" });

    // A malformed id is a request parameter problem, which is what 400 describes (§9).
    const bad = await http("/v1/workers/not-a-worker-id");
    expect(bad.status).toBe(400);
    expect((await bad.json()) as OmniErrorBody).toMatchObject({ code: "bad_request" });
  });

  it("POST /v1/workers/{wid}/prompt returns 202 {turnId, seq}", async () => {
    const res = await http(`/v1/workers/${worker.workerId}/prompt`, {
      method: "POST",
      body: JSON.stringify({ content: [{ type: "text", text: "who are you?" }] }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as PromptAccepted;
    expect(Object.keys(body).sort()).toEqual(["seq", "turnId"]);
    expect(body.turnId).toMatch(/^t_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(body.seq).toBeGreaterThan(0);

    // 409 while that turn is live — the answer `{queue:false}` exists to surface.
    const second = await http(`/v1/workers/${worker.workerId}/prompt`, {
      method: "POST",
      body: JSON.stringify({ content: [{ type: "text", text: "again" }] }),
    });
    expect(second.status).toBe(409);
    expect((await second.json()) as OmniErrorBody).toMatchObject({ code: "worker_busy" });

    // Let the turn finish before the next test reads it.
    const events = await http(
      `/v1/workers/${worker.workerId}/events?since=${String(body.seq - 1)}`,
    );
    await drainUntilIdle(events, body.turnId);
    turnId = body.turnId;
  }, 45_000);

  it("rejects a content block whose type is not 'text' (review R12)", async () => {
    // `idle` is the NORMALIZER's event; the worker's own return to `ready` follows it. Asserting
    // 400 without waiting for that would be racing a 409, and the flake would be one line of
    // scheduling apart on a loaded runner.
    await waitReady();

    const res = await http(`/v1/workers/${worker.workerId}/prompt`, {
      method: "POST",
      body: JSON.stringify({
        content: [{ type: "resource_link", uri: "file:///etc/passwd", name: "p" }],
      }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as OmniErrorBody).toMatchObject({ code: "bad_request" });
  });

  it("GET /v1/workers/{wid}/turns/{turnId} returns TurnStatus", async () => {
    expect(await waitReady()).toBe("ready");
    expect(turnId).not.toBe("");

    const res = await http(`/v1/workers/${worker.workerId}/turns/${turnId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as TurnStatus;
    expect(body.turnId).toBe(turnId);
    expect(body.state).toBe("completed");
    expect(body.stopReason).toBe("end_turn");
    expect(body.result?.text).toContain("I'll skip the configuration update");
  }, 30_000);

  it("GET /v1/workers/{wid}/turns/{unknown} returns 200 {state:'unknown', result:null}, not 404", async () => {
    // Turn state is DERIVED from the log, and after ring eviction "unknown" is the honest
    // answer — which is why no `turn_not_found` code exists (D29).
    const res = await http(`/v1/workers/${worker.workerId}/turns/t_00000000000000000000000000`);
    expect(res.status).toBe(200);
    expect((await res.json()) as TurnStatus).toEqual({
      turnId: "t_00000000000000000000000000",
      state: "unknown",
      startSeq: null,
      endSeq: null,
      stopReason: null,
      result: null,
    });
  });

  it("POST /v1/workers/{wid}/cancel returns 202 {} and is a no-op when not running", async () => {
    const res = await http(`/v1/workers/${worker.workerId}/cancel`, { method: "POST" });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({});
  });

  it("403s a cwd outside the token's cwdRoots and an unknown agent 400s", async () => {
    const outside = await http("/v1/workers", {
      method: "POST",
      body: JSON.stringify({ agent: "example", cwd: process.cwd() }),
    });
    expect(outside.status).toBe(403);
    expect((await outside.json()) as OmniErrorBody).toMatchObject({ code: "forbidden" });

    // An agent id is a request PARAMETER, so an unknown one is 400 — no `agent_not_found`
    // code is introduced (D29).
    const unknown = await http("/v1/workers", {
      method: "POST",
      body: JSON.stringify({ agent: "nope", cwd: harness.roots[0] }),
    });
    expect(unknown.status).toBe(400);
    expect((await unknown.json()) as OmniErrorBody).toMatchObject({ code: "bad_request" });
  });

  it("DELETE /v1/workers/{wid} returns 200 CloseResult and is idempotent", async () => {
    const first = await http(`/v1/workers/${worker.workerId}`, { method: "DELETE" });
    expect(first.status).toBe(200);
    const body = (await first.json()) as CloseResult;
    expect(body).toMatchObject({
      workerId: worker.workerId,
      state: "closed",
      reason: "client_request",
      leaderExited: true,
      treeGone: process.platform !== "win32",
    });

    // Not 204: the body is where `treeGone`/`leaderExited` reach the operator (D32, §6.6).
    const second = await http(`/v1/workers/${worker.workerId}`, { method: "DELETE" });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(body);
  }, 30_000);

  it("returns exactly {code, message, acp?} for every error body", async () => {
    const bodies: OmniErrorBody[] = [];
    bodies.push((await (await anon("/v1/info")).json()) as OmniErrorBody);
    bodies.push(
      (await (
        await http("/v1/workers", { method: "POST", body: "{not json" })
      ).json()) as OmniErrorBody,
    );
    bodies.push(
      (await (await http("/v1/workers/w_00000000000000000000000000")).json()) as OmniErrorBody,
    );

    for (const body of bodies) {
      const keys = Object.keys(body).sort();
      expect(keys.filter((k) => k !== "acp")).toEqual(["code", "message"]);
      expect(typeof body.message).toBe("string");
    }
  });
});

/** Reads an SSE response until this turn's `state_update{idle}`, then releases it. */
async function drainUntilIdle(res: Response, turnId: string): Promise<void> {
  await forEachEnvelope(res, (e) => {
    const payload = e["payload"] as Record<string, unknown> | undefined;
    return (
      e["turnId"] === turnId &&
      payload?.["sessionUpdate"] === "state_update" &&
      payload["state"] === "idle"
    );
  });
}

/** A hand-rolled SSE reader, on purpose: this file's whole point is to use no SDK. */
async function forEachEnvelope(
  res: Response,
  stop: (envelope: Record<string, unknown>) => boolean,
): Promise<void> {
  const body = res.body;
  if (body === null) throw new Error("the event stream has no body");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return;
      buffer = (buffer + decoder.decode(chunk.value, { stream: true })).replace(/\r\n/g, "\n");
      for (;;) {
        const at = buffer.indexOf("\n\n");
        if (at === -1) break;
        const block = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        const data = block
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        if (data === "" || block.includes("event: omni.stream_")) continue;
        if (stop(JSON.parse(data) as Record<string, unknown>)) return;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}
