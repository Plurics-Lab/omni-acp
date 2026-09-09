import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DaemonConfig,
  HEADER,
  OmniError,
  hashSecret,
  type AuthContext,
  type CreateRunRequest,
  type Daemon,
  type DaemonId,
  type EventLog,
  type ResolvedDaemonConfig,
  type RunId,
  type RunRegistry,
  type RunSnapshot,
  type Seq,
  type WorkerId,
} from "@omni-acp/protocol";
import { createMemoryEventLog, openPersistence } from "@omni-acp/core";
import { fakeClock, nullLogger, seqIds, stubDaemon } from "@omni-acp/testkit";
import { createTokenStore } from "../../src/auth.js";
import { createHttpApp } from "../../src/http/app.js";
import { createRunSubsystem } from "../../src/runs.js";

/**
 * H25's routes against a recording `stubDaemon()`, plus `createRunSubsystem` end to end on both
 * drivers.
 *
 * The routes half drives the REAL `createHttpApp` and the REAL `createTokenStore` with a
 * recording `RunRegistry`, so "parse → ONE daemon call → serialize" is a fact about the adapter
 * (D15 constraint 1) rather than a claim about it.
 *
 * Owned by M2-B-WP-R.
 */

const DID = "d_00000000000000000000000001" as DaemonId;
const WID = "w_00000000000000000000000001" as WorkerId;
const RID = "r_00000000000000000000000001" as RunId;

const SECRETS: Record<string, string> = {
  admin: "admin-secret-value-0123456789",
  alice: "alice-secret-value-0123456789",
};

function config(): ResolvedDaemonConfig {
  return DaemonConfig.parse({
    tokens: [
      { id: "admin", role: "admin", secretSha256: hashSecret(SECRETS["admin"] ?? "") },
      { id: "alice", role: "user", secretSha256: hashSecret(SECRETS["alice"] ?? "") },
    ],
  });
}

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

interface Http {
  readonly daemon: Daemon;
  /**
   * Every `daemon.runs.*` method a request reached, in order.
   *
   * `stubDaemon().calls` does not cover `runs` — it wraps `workers` and `catalog` and nothing
   * else — so the recorder lives on the double itself, which is where D15's "ONE daemon call per
   * route" can actually be observed.
   */
  readonly seen: readonly string[];
  request(who: string | null, method: string, path: string, body?: unknown): Promise<Response>;
}

/** The REAL app and token store, over a recording `RunRegistry`. Zero ports, zero `listen`. */
function http(runs: Partial<RunRegistry>): Http {
  const resolved = config();
  const tokens = createTokenStore(resolved);
  const seen: string[] = [];
  let app: ReturnType<typeof createHttpApp> | null = null;
  const recorded = Object.fromEntries(
    Object.entries(runs).map(([name, fn]) => [
      name,
      (...args: unknown[]) => {
        seen.push(name);
        return (fn as (...a: unknown[]) => unknown)(...args);
      },
    ]),
  ) as Partial<RunRegistry>;
  const daemon = stubDaemon({
    config: resolved,
    authenticate: (headers: Headers) => tokens.verify(headers),
    runs: recorded as RunRegistry,
    fetch: (req: Request) =>
      Promise.resolve(app?.fetch(req) ?? new Response(null, { status: 500 })),
  });
  app = createHttpApp(daemon);
  return {
    daemon,
    seen,
    request: (who, method, path, body) =>
      daemon.fetch(
        new Request(`http://daemon.invalid${path}`, {
          method,
          headers: {
            ...(who === null ? {} : { [HEADER.auth]: `Bearer ${SECRETS[who] ?? "nope"}` }),
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      ),
  };
}

const body = (): CreateRunRequest =>
  ({
    agent: "fixture",
    cwd: "/tmp/fixture",
    prompt: [{ type: "text", text: "Reply with exactly the word PONG." }],
  }) as CreateRunRequest;

describe("run routes (H25)", () => {
  it("each route is parse -> ONE daemon.runs call -> serialize", async () => {
    const passed: string[] = [];
    const h = http({
      create: (req: CreateRunRequest, auth: AuthContext) => {
        passed.push(`${req.agent}:${auth.tokenId}`);
        return Promise.resolve(snapshot());
      },
      get: () => snapshot("succeeded"),
      list: () => [snapshot("succeeded")],
      cancel: () => Promise.resolve(snapshot("cancelled")),
      logFor: () => {
        throw new OmniError("worker_not_found", "not this test");
      },
      recover: () => ({ abandoned: 0 }),
    });

    // POST /v1/runs -> 202 (H25). ACCEPTED, not Created: the run converges on the daemon's own
    // time, and a `201` would promise a finished resource.
    const created = await h.request("alice", "POST", "/v1/runs", body());
    expect(created.status).toBe(202);
    expect(await created.json()).toEqual(snapshot());
    // The parsed body and the authenticated caller, both, reach the registry unaltered.
    expect(passed).toEqual(["fixture:alice"]);
    expect(h.seen).toEqual(["create"]);

    const got = await h.request("alice", "GET", `/v1/runs/${RID}`);
    expect(got.status).toBe(200);
    expect(((await got.json()) as RunSnapshot).state).toBe("succeeded");

    const listed = await h.request("alice", "GET", "/v1/runs");
    expect(await listed.json()).toEqual({ runs: [snapshot("succeeded")], cursor: null });

    const cancelled = await h.request("alice", "POST", `/v1/runs/${RID}/cancel`);
    expect(((await cancelled.json()) as RunSnapshot).state).toBe("cancelled");

    // ONE call per request, and never two.
    expect(h.seen).toEqual(["create", "get", "list", "cancel"]);
  });

  it("a malformed body is a 400 from the schema, and never reaches the registry", async () => {
    const h = http({
      create: () => Promise.reject(new Error("the route must not have called create")),
    });
    for (const bad of [{}, { agent: "x" }, { ...body(), prompt: [] }, { ...body(), nope: 1 }]) {
      const res = await h.request("alice", "POST", "/v1/runs", bad);
      expect(res.status).toBe(400);
    }
    expect(h.seen).toHaveLength(0);
  });

  it("a malformed run id is a 400 with the value elided (§9)", async () => {
    const h = http({
      get: () => {
        throw new Error("the route must not have called get");
      },
    });
    const res = await h.request("alice", "GET", "/v1/runs/not-a-run-id");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toBe("malformed run id");
  });

  it("is authenticated: no token is 401 and never reaches the registry", async () => {
    const h = http({
      list: () => {
        throw new Error("the route must not have called list");
      },
    });
    expect((await h.request(null, "GET", "/v1/runs")).status).toBe(401);
    expect(h.seen).toHaveLength(0);
  });

  it("an unknown run is 404 `worker_not_found` — ruling M2-R2 declines a `run_not_found` code", async () => {
    const h = http({
      get: () => {
        throw new OmniError("worker_not_found", `no run ${RID}`);
      },
    });
    const res = await h.request("alice", "GET", `/v1/runs/${RID}`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("worker_not_found");
  });

  it(".../events?since= reuses the SAME sse writer as a worker stream", async () => {
    const clock = fakeClock();
    const log: EventLog = createMemoryEventLog({ workerId: WID, daemonId: DID, clock });
    for (const text of ["a", "b", "c"]) {
      log.append({
        kind: "acp.session_update",
        payloadVersion: 1,
        payload: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
      });
    }
    log.append({
      kind: "omni.worker_state",
      payloadVersion: 1,
      payload: { state: "closed", previous: "ready", reason: "client_request" },
    });

    let asked: Seq | null = null;
    const h = http({
      logFor: (_id: RunId, auth: AuthContext) => {
        asked = 0 as Seq;
        expect(auth.tokenId).toBe("alice");
        return log;
      },
    });

    const res = await h.request("alice", "GET", `/v1/runs/${RID}/events?since=2`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(asked).not.toBeNull();

    // `?since=` is an EXCLUSIVE lower bound over the run's WORKER's log — M1's semantics, byte
    // for byte, because it is M1's writer over M1's log and not a second implementation.
    expect(text).not.toContain('"text":"a"');
    expect(text).not.toContain('"text":"b"');
    expect(text).toContain('"text":"c"');
    // `omni.stream_end` is the daemon saying "this worker is closed", from the same writer.
    expect(text).toContain("omni.stream_end");
    expect(h.seen).toEqual(["logFor"]);
  });
});

// ── the subsystem, on both drivers ───────────────────────────────────────────

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

async function subsystem(o: { durable: boolean }): Promise<ReturnType<typeof createRunSubsystem>> {
  const resolved = config();
  const clock = fakeClock();
  let persistence = null;
  if (o.durable) {
    const dir = await mkdtemp(join(tmpdir(), "omni-acp-subsystem-"));
    dirs.push(dir);
    persistence = await openPersistence({
      dataDir: dir,
      config:
        resolved.eventLog.driver === "sqlite"
          ? resolved.eventLog
          : { ...resolved.eventLog, driver: "sqlite" },
      clock,
      logger: nullLogger(),
    });
  }
  return createRunSubsystem({
    config: resolved,
    persistence,
    workers: stubDaemon().workers,
    clock,
    ids: seqIds(),
    logger: nullLogger(),
    daemonId: DID,
  });
}

describe("createRunSubsystem", () => {
  it("uses the MEMORY stores when there is no persistence handle (M2-R14)", async () => {
    const sub = await subsystem({ durable: false });
    // A run under the memory driver is ALLOWED — refusing would break `OmniACP.local()` — and it
    // says so rather than letting `GET /v1/runs/{rid}` 404 mysteriously after a restart. The
    // stubbed registry cannot create a worker, so the observable claim here is that the stores
    // exist and answer, and `recover()` is total.
    expect(sub.deliveries.list({ limit: 10 })).toEqual({ rows: [], cursor: null });
    expect(sub.recover()).toEqual({ abandoned: 0, requeued: 0 });
    // Webhooks default to disabled, which is what "no dispatcher" means here.
    expect(sub.dispatcher).toBeNull();
  });

  it("uses the DURABLE stores when one is handed to it, and `recover()` is safe on a fresh file", async () => {
    const sub = await subsystem({ durable: true });
    expect(sub.deliveries.list({ limit: 10 })).toEqual({ rows: [], cursor: null });
    expect(sub.recover()).toEqual({ abandoned: 0, requeued: 0 });
  });

  it("the memory delivery store honours claim / requeueStale / redeliver exactly as SQLite does", async () => {
    const sub = await subsystem({ durable: false });
    const id = "dl_00000000000000000000000001" as never;
    sub.deliveries.enqueue({
      deliveryId: id,
      runId: RID,
      tokenId: "alice" as never,
      event: "run.completed",
      url: "https://hooks.example.com/x",
      payload: {
        deliveryId: id,
        event: "run.completed",
        daemonId: DID,
        workerId: WID,
        runId: RID,
        sessionId: null,
        seq: 1 as Seq,
        ts: new Date(0).toISOString(),
      },
      nowMs: 1_000,
    });

    expect(sub.deliveries.due(1_000, 10)).toHaveLength(1);
    // Exactly one claim wins, the same rule the SQL statement enforces under a write lock.
    expect(sub.deliveries.claim(id, "boot_a", 1_000)).toBe(true);
    expect(sub.deliveries.claim(id, "boot_b", 1_000)).toBe(false);
    // A foreign boot's in-flight row comes back with `attempt` UNCHANGED (§24.4 rule 3).
    expect(sub.deliveries.requeueStale("boot_b", 2_000)).toBe(1);
    expect(sub.deliveries.list({ limit: 1 }).rows[0]?.attempt).toBe(0);
    // ...and a replay keeps the id, which is the receiver's dedupe key (rule 6).
    expect(sub.deliveries.redeliver(id, 3_000).deliveryId).toBe(id);
  });
});
