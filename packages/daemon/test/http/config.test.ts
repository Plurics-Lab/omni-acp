import { describe, expect, it } from "vitest";
import {
  HEADER,
  OmniError,
  type ConfigOptionView,
  type Daemon,
  type LeaseSnapshot,
  type SetConfigBody,
  type SetConfigResponse,
  type WorkerId,
  type WorkerRegistry,
  type WorkerSnapshot,
} from "@omni-acp/protocol";
import { stubDaemon } from "@omni-acp/testkit";
import { createHttpApp } from "../../src/http/app.js";
import { someWorkerId } from "../fake-core.js";

/**
 * H24's route and its status table, against a recording `stubDaemon()`.
 *
 * The route is `parse → ONE registry call → serialize` and nothing else (D15 constraint 1): every
 * status below is raised by the daemon method and travels through the SINGLE error mapper, and
 * `daemon.calls` is what proves the route made exactly one call rather than orchestrating a
 * get-then-act of its own. The gates themselves — the lease, `worker_busy`, the auto-wake, the
 * spelling loop — are `Worker.setConfig`'s and are tested in
 * `packages/core/test/worker/config-options.test.ts` against a real link.
 *
 * Owned by M2-A-WP-C.
 */

const WID: WorkerId = someWorkerId(1);
const TOKEN = "any-secret-the-stub-accepts";
const PATH = `/v1/workers/${WID}/config`;

type Recorder = Daemon & { readonly calls: readonly { method: string; args: unknown[] }[] };

const LEASE: LeaseSnapshot = {
  workerId: WID,
  holder: { tokenId: "other", clientId: "c_01ABCDEF" },
  epoch: 7,
  expiresAt: null,
  acquiredAt: "2026-09-04T00:00:00.000Z",
  pinned: false,
};

/** claude `15`'s answer, shrunk to two entries — the shape §22.2's `result` row describes. */
const RESPONSE: SetConfigResponse = {
  configOptions: [
    { id: "mode", currentValue: "default", raw: { id: "mode", currentValue: "default" } },
    { id: "model", currentValue: "haiku", raw: { id: "model", currentValue: "haiku" } },
  ] as readonly ConfigOptionView[],
  removed: ["effort", "fast"],
  added: [],
  stale: false,
};

function fixture(overrides: Partial<Daemon>): Recorder {
  let app: ReturnType<typeof createHttpApp> | null = null;
  const daemon = stubDaemon({
    ...overrides,
    fetch: (req: Request) =>
      Promise.resolve(app?.fetch(req) ?? new Response(null, { status: 500 })),
  });
  app = createHttpApp(daemon);
  return daemon;
}

/** A registry whose `setConfig` is the only row a test overrides; every other row still refuses. */
function withSetConfig(
  setConfig: WorkerRegistry["setConfig"],
  extra?: Partial<WorkerRegistry>,
): Partial<Daemon> {
  const base = stubDaemon().workers;
  return { workers: { ...base, ...extra, setConfig } as WorkerRegistry };
}

const post = (daemon: Daemon, body: unknown, headers?: Record<string, string>): Promise<Response> =>
  daemon.fetch(
    new Request(`http://daemon.invalid${PATH}`, {
      method: "POST",
      headers: {
        [HEADER.auth]: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );

describe("config route (H24) — parse, ONE registry call, serialize", () => {
  it("parses SetConfigBody, calls exactly one registry method, and returns its answer verbatim", async () => {
    const seen: SetConfigBody[] = [];
    const daemon = fixture(
      withSetConfig((_id, _auth, body) => {
        seen.push(body);
        return Promise.resolve(RESPONSE);
      }),
    );

    const res = await post(daemon, { configId: "model", value: "haiku" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(RESPONSE);
    // The body reached the registry PARSED, and the id came off the path.
    expect(seen).toEqual([{ configId: "model", value: "haiku" }]);
    const registryCalls = daemon.calls.filter((c) => c.method.startsWith("workers."));
    expect(registryCalls.map((c) => c.method)).toEqual(["workers.setConfig"]);
    expect(registryCalls[0]?.args[0]).toBe(WID);
    // No get-then-act in the adapter: the façade row is the whole route (§5.8.5 review R11).
    expect(daemon.calls.some((c) => c.method === "workers.get")).toBe(false);
    expect(daemon.calls.some((c) => c.method === "workers.snapshot")).toBe(false);
  });

  it("authenticates before it does anything else", async () => {
    const daemon = fixture(withSetConfig(() => Promise.resolve(RESPONSE)));
    const res = await daemon.fetch(
      new Request(`http://daemon.invalid${PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ configId: "model", value: "haiku" }),
      }),
    );
    expect(res.status).toBe(401);
    expect(daemon.calls.some((c) => c.method === "workers.setConfig")).toBe(false);
  });

  it("forwards the AuthContext the middleware produced, not one of its own", async () => {
    let tokenId: string | null = null;
    const daemon = fixture(
      withSetConfig((_id, auth) => {
        tokenId = auth.tokenId;
        return Promise.resolve(RESPONSE);
      }),
    );
    await post(daemon, { configId: "model", value: "haiku" });
    expect(tokenId).toBe("stub");
  });

  it("passes a number and a boolean through unchanged — `value` is not stringified", async () => {
    const seen: SetConfigBody[] = [];
    const daemon = fixture(
      withSetConfig((_id, _auth, body) => {
        seen.push(body);
        return Promise.resolve(RESPONSE);
      }),
    );
    await post(daemon, { configId: "temperature", value: 0.5 });
    await post(daemon, { configId: "fast", value: true });
    expect(seen).toEqual([
      { configId: "temperature", value: 0.5 },
      { configId: "fast", value: true },
    ]);
  });

  it("`Omni-Lease-Epoch` reaches the daemon rather than being read here", async () => {
    // The fence is `daemon.authenticate`'s (§16.1 rule L7); the route only has to not swallow it.
    const daemon = fixture(withSetConfig(() => Promise.resolve(RESPONSE)));
    await post(daemon, { configId: "model", value: "haiku" }, { [HEADER.leaseEpoch]: "7" });
    const authenticate = daemon.calls.find((c) => c.method === "authenticate");
    expect((authenticate?.args[0] as Headers).get(HEADER.leaseEpoch)).toBe("7");
  });
});

describe("config route (H24) — the body is validated, and the route decides nothing", () => {
  const badBodies: { name: string; body: unknown }[] = [
    { name: "no configId", body: { value: "haiku" } },
    { name: "an empty configId", body: { configId: "", value: "haiku" } },
    { name: "a non-string configId", body: { configId: 7, value: "haiku" } },
    { name: "no value", body: { configId: "model" } },
    { name: "a null value", body: { configId: "model", value: null } },
    { name: "an object value", body: { configId: "model", value: { nested: true } } },
    { name: "an array value", body: { configId: "model", value: ["haiku"] } },
    // `SetConfigBody` is a STRICT object: one option per call, mirroring the agent method.
    { name: "an unknown extra key", body: { configId: "model", value: "haiku", force: true } },
    { name: "a configId over 200 characters", body: { configId: "x".repeat(201), value: "a" } },
    { name: "a value over 4096 characters", body: { configId: "model", value: "x".repeat(4_097) } },
  ];

  for (const row of badBodies) {
    it(`400s on ${row.name}, without reaching the registry`, async () => {
      const daemon = fixture(withSetConfig(() => Promise.resolve(RESPONSE)));
      const res = await post(daemon, row.body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe("bad_request");
      expect(daemon.calls.some((c) => c.method === "workers.setConfig")).toBe(false);
    });
  }

  it("400s on a malformed JSON body with a sentence, never a 500", async () => {
    const daemon = fixture(withSetConfig(() => Promise.resolve(RESPONSE)));
    const res = await daemon.fetch(
      new Request(`http://daemon.invalid${PATH}`, {
        method: "POST",
        headers: { [HEADER.auth]: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: "{not json",
      }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("bad_request");
  });

  it("400s on a malformed worker id, and the id never reaches the registry", async () => {
    const daemon = fixture(withSetConfig(() => Promise.resolve(RESPONSE)));
    const res = await daemon.fetch(
      new Request("http://daemon.invalid/v1/workers/not-a-worker-id/config", {
        method: "POST",
        headers: { [HEADER.auth]: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ configId: "model", value: "haiku" }),
      }),
    );
    expect(res.status).toBe(400);
    expect(daemon.calls.some((c) => c.method === "workers.setConfig")).toBe(false);
  });

  it("accepts the boundary values `SetConfigBody` declares", async () => {
    const daemon = fixture(withSetConfig(() => Promise.resolve(RESPONSE)));
    const at200 = await post(daemon, { configId: "x".repeat(200), value: "a" });
    const at4096 = await post(daemon, { configId: "model", value: "x".repeat(4_096) });
    expect([at200.status, at4096.status]).toEqual([200, 200]);
  });
});

describe("config route (H24) — the status table flows through the ONE mapper (§22.2)", () => {
  const rows: { code: ConstructorParameters<typeof OmniError>[0]; status: number; why: string }[] =
    [
      { code: "worker_busy", status: 409, why: "a turn is live (M2-R22)" },
      { code: "lease_held", status: 423, why: "no lease, or a stale epoch" },
      { code: "worker_not_found", status: 404, why: "absent or invisible" },
      { code: "worker_closed", status: 410, why: "the worker is gone" },
      { code: "not_resumable", status: 422, why: "the auto-wake was refused" },
      { code: "agent_error", status: 502, why: "the agent said no" },
      { code: "agent_timeout", status: 504, why: "the agent said nothing" },
      { code: "forbidden", status: 403, why: "the ACL refused the wake's cwd" },
    ];

  for (const row of rows) {
    it(`${row.code} → ${String(row.status)} (${row.why}) with no status logic in the route`, async () => {
      const daemon = fixture(
        withSetConfig(() => Promise.reject(new OmniError(row.code, `refused: ${row.why}`))),
      );
      const res = await post(daemon, { configId: "model", value: "haiku" });
      expect(res.status).toBe(row.status);
      expect(await res.json()).toEqual({ code: row.code, message: `refused: ${row.why}` });
    });
  }

  it("423 carries the holder and the epoch, so a loser does not have to re-GET the worker", async () => {
    const daemon = fixture(
      withSetConfig(() =>
        Promise.reject(
          new OmniError("lease_held", "another client holds this worker", { lease: LEASE }),
        ),
      ),
    );
    const res = await post(daemon, { configId: "model", value: "haiku" });
    expect(res.status).toBe(423);
    expect(await res.json()).toEqual({
      code: "lease_held",
      message: "another client holds this worker",
      lease: LEASE,
    });
  });

  it("a bad VALUE is 502 carrying the agent's -32603 and its data.details verbatim (F44)", async () => {
    // §22.2's bad-value row. The classification that separates a wrong value from a genuine
    // internal error is the DESCRIPTOR's (`errorRules`: code `-32603` plus the `/details`
    // pointer, never message text) and is asserted in
    // `packages/core/test/worker/config-options.test.ts`; what the route owes is to carry the
    // agent's own error across untouched.
    const acp = {
      code: -32603,
      message: "Internal error",
      data: { details: "Invalid value for config option model: no-such-model-xyz" },
    };
    const daemon = fixture(
      withSetConfig(() =>
        Promise.reject(new OmniError("agent_error", "the agent refused the value", { acp })),
      ),
    );

    const res = await post(daemon, { configId: "model", value: "no-such-model-xyz" });

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      code: "agent_error",
      message: "the agent refused the value",
      acp,
    });
  });

  it("an agent that cannot do it at all is 502 carrying -32601 (D29)", async () => {
    const acp = { code: -32601, message: "session/set_config_option is not supported" };
    const daemon = fixture(
      withSetConfig(() =>
        Promise.reject(
          new OmniError("agent_error", "agent x does not implement session/set_config_option", {
            acp,
          }),
        ),
      ),
    );
    const res = await post(daemon, { configId: "model", value: "haiku" });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { acp: unknown }).acp).toEqual(acp);
  });

  it("an unclassified throw from the registry is a generic 500, never a stack", async () => {
    const daemon = fixture(
      withSetConfig(() => Promise.reject(new Error("sqlite: disk image is malformed"))),
    );
    const res = await post(daemon, { configId: "model", value: "haiku" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ code: "internal", message: "internal error" });
  });
});

describe("config route (H24) — the auto-wake is the daemon's, not the adapter's (§22.2)", () => {
  it("a hibernated worker is woken behind ONE route call, and the route never asks about state", async () => {
    // The registry double models §22.2's state row: `Worker.setConfig` auto-wakes exactly as
    // `prompt` does, and `registry.setConfig` re-runs the ACL that `wake()` would. The route
    // sees one call and one answer either way — which is the property being asserted here.
    let state: WorkerSnapshot["state"] = "hibernated";
    const woke: string[] = [];
    const daemon = fixture(
      withSetConfig(
        () => {
          if (state === "hibernated") {
            woke.push("wake");
            state = "ready";
          }
          return Promise.resolve(RESPONSE);
        },
        {
          snapshot: () => ({ state }) as WorkerSnapshot,
        },
      ),
    );

    const res = await post(daemon, { configId: "model", value: "haiku" });

    expect(res.status).toBe(200);
    expect(woke).toEqual(["wake"]);
    // ONE registry call. A route that had asked "is it hibernated?" and then acted would show
    // two, and would be the get-then-act D15 constraint 1 forbids.
    expect(daemon.calls.filter((c) => c.method.startsWith("workers."))).toHaveLength(1);
    expect(daemon.calls.some((c) => c.method === "workers.wake")).toBe(false);
  });

  it("a wake that the agent refuses surfaces as the daemon's own 422, unchanged", async () => {
    const daemon = fixture(
      withSetConfig(() =>
        Promise.reject(new OmniError("not_resumable", "the agent forgot this session")),
      ),
    );
    const res = await post(daemon, { configId: "model", value: "haiku" });
    expect(res.status).toBe(422);
  });
});

describe("config route (H24) — the route is registered where the contract says", () => {
  it("only POST is routed: every other verb falls to the app's `unknown route`, never to the registry", async () => {
    // §9 / D29: an unmatched path (or verb) is `400 bad_request`, because "no such route" is a
    // request parameter naming nothing and a `404 worker_not_found` here would be a lie about a
    // worker that exists. What matters for this route is the second half — nothing reached the
    // registry, so a `GET …/config` can never be mistaken for a read of the catalogue.
    const daemon = fixture(withSetConfig(() => Promise.resolve(RESPONSE)));
    for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
      const res = await daemon.fetch(
        new Request(`http://daemon.invalid${PATH}`, {
          method,
          headers: { [HEADER.auth]: `Bearer ${TOKEN}` },
        }),
      );
      expect({ method, status: res.status, body: await res.json() }).toEqual({
        method,
        status: 400,
        body: { code: "bad_request", message: "unknown route" },
      });
    }
    expect(daemon.calls.some((c) => c.method === "workers.setConfig")).toBe(false);
  });

  it("`stale: true` is serialized as itself — a KEPT list is still a 200", async () => {
    const kept: SetConfigResponse = {
      configOptions: RESPONSE.configOptions,
      removed: [],
      added: [],
      stale: true,
    };
    const daemon = fixture(withSetConfig(() => Promise.resolve(kept)));
    const res = await post(daemon, { configId: "mode", value: "plan" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(kept);
  });
});
