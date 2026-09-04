import { describe, expect, it } from "vitest";
import {
  DaemonConfig,
  HEADER,
  LeaseConfig,
  LeaseRequestBody,
  OmniError,
  PromptRequestBody,
  hashSecret,
  type ClientRef,
  type CloseResult,
  type Daemon,
  type DaemonId,
  type EventEnvelope,
  type EventLog,
  type Lease,
  type LeaseSnapshot,
  type PromptAccepted,
  type ResolvedDaemonConfig,
  type TokenId,
  type TurnId,
  type WorkerId,
  type WorkerRegistry,
  type WorkerSnapshot,
} from "@omni-acp/protocol";
import { createLease, createMemoryEventLog } from "@omni-acp/core";
import {
  collectSse,
  fakeClock,
  runLeaseConformance,
  stubDaemon,
  type LeaseHttpBinding,
  type LeaseSurface,
} from "@omni-acp/testkit";
import { createTokenStore } from "../../src/auth.js";
import { createHttpApp } from "../../src/http/app.js";

/**
 * H17 and rule L2's other half: D5 over the WIRE.
 *
 * Every test here drives `daemon.fetch(new Request(...))` — zero `listen`, zero ports — through
 * the REAL `createHttpApp`, the REAL `createTokenStore` (so `Omni-Client-Id` and
 * `Omni-Lease-Epoch` are parsed by the code that parses them in production, not by a double) and
 * the REAL `createLease`.
 *
 * The one double is the `WorkerRegistry` façade, because `registry.ts` belongs to M1-WP-E and
 * still throws `unimplemented` for half its M1 rows. `enforcingRegistry()` below is a LINE-FOR-
 * LINE transcription of the three enforcement points the Land step already wrote there, and each
 * one quotes the original: if this drifts from `registry.ts`, `acceptance 9` in
 * `packages/core/test/lease/m1-acceptance.test.ts` fails, because it reads that file.
 *
 * The second half of `runLeaseConformance` runs here — the same table as
 * `packages/core/test/lease/conformance.test.ts`, over HTTP — which is what §16.4 means by "so
 * the two cannot drift".
 */

const WID = "w_00000000000000000000000001" as WorkerId;
const DID = "d_00000000000000000000000001" as DaemonId;
const TID = `t_${"0".repeat(25)}1` as TurnId;

/** Three tokens, because §16.4's matrix is 3 clients × {same token, other token, admin}. */
const SECRETS: Record<string, string> = {
  tok_user: "user-secret-0123456789abcdef",
  tok_admin: "admin-secret-0123456789abcdef",
  tok_stranger: "stranger-secret-0123456789abcdef",
};

const IDENTITIES = {
  holder: { tokenId: "tok_user" as TokenId, clientId: "cli_a" },
  peer: { tokenId: "tok_user" as TokenId, clientId: "cli_b" },
  stranger: { tokenId: "tok_stranger" as TokenId, clientId: "cli_c" },
  admin: { tokenId: "tok_admin" as TokenId, clientId: "cli_admin" },
} as const;

function daemonConfig(lease?: Record<string, unknown>): ResolvedDaemonConfig {
  return DaemonConfig.parse({
    daemonId: DID,
    tokens: [
      { id: "tok_user", secretSha256: hashSecret(SECRETS["tok_user"] ?? "") },
      { id: "tok_admin", secretSha256: hashSecret(SECRETS["tok_admin"] ?? ""), role: "admin" },
      { id: "tok_stranger", secretSha256: hashSecret(SECRETS["tok_stranger"] ?? "") },
    ],
    ...(lease === undefined ? {} : { lease }),
  });
}

interface Fixture {
  readonly daemon: Daemon & { readonly calls: readonly { method: string; args: unknown[] }[] };
  readonly lease: Lease;
  readonly log: EventLog;
  /** Every `CloseResult` the double produced, so `DELETE` is observable. */
  readonly deleted: string[];
  request(who: ClientRef | null, method: string, path: string, body?: unknown): Promise<Response>;
}

/**
 * The three enforcement points `registry.ts` already carries, transcribed.
 *
 *  - `get(id, auth)` → `404 worker_not_found` when the token cannot SEE the worker (D13). This
 *    runs BEFORE the lease on every id-addressed row, which is why a stranger gets a 404 rather
 *    than a 423 and learns nothing about a worker that is not theirs.
 *  - `prompt` / `cancel` → `handle.prompt(content, auth.asClientRef())`, and `worker.ts` calls
 *    `lease.assertHolder(who)` as its first statement (F22). The double calls it directly, in
 *    the same position.
 *  - `delete` → `if (auth.role !== "admin") entry.handle.lease.assertHolder(auth.asClientRef())`
 *    — §16.1 rule L3's "the lease **or** admin", verbatim.
 *  - `lease(id, auth, op, body)` → parse, then ONE call on the injected lease, with
 *    `admin: auth.role === "admin"` passed into `steal`.
 */
function enforcingRegistry(fixture: {
  lease: Lease;
  log: EventLog;
  deleted: string[];
  snapshot: () => WorkerSnapshot;
}): WorkerRegistry {
  const notFound = (id: string): never => {
    throw new OmniError("worker_not_found", `no worker ${id}`);
  };
  const see = (id: WorkerId, auth: { canSee(w: WorkerSnapshot): boolean }): WorkerSnapshot => {
    if (id !== WID) return notFound(id);
    const snapshot = fixture.snapshot();
    if (!auth.canSee(snapshot)) return notFound(id);
    return snapshot;
  };

  return {
    size: 1,
    hibernatedSize: 0,
    create: () => {
      throw new OmniError("internal", "not part of this suite");
    },
    get: (id) => notFound(id),
    list: () => [],
    closeAll: () => Promise.resolve(),
    turn: (id) => notFound(id),
    adopt: () => Promise.resolve({ hibernated: 0, closed: 0, orphans: [] }),
    hibernate: (id) => Promise.resolve(notFound(id)),
    wake: (id) => Promise.resolve(notFound(id)),

    snapshot: (id, auth) => see(id, auth),

    logFor: (id, auth) => {
      see(id, auth);
      return fixture.log;
    },

    prompt: (id, auth, body): Promise<PromptAccepted> => {
      see(id, auth);
      PromptRequestBody.parse(body);
      // `worker.ts:498` — the first statement of `Worker.prompt`.
      fixture.lease.assertHolder(auth.asClientRef());
      return Promise.resolve({ turnId: TID, seq: 2 });
    },

    cancel: (id, auth): Promise<void> => {
      see(id, auth);
      // `worker.ts:603` — the first statement of `Worker.cancel`.
      fixture.lease.assertHolder(auth.asClientRef());
      return Promise.resolve();
    },

    delete: (id, auth): Promise<CloseResult> => {
      see(id, auth);
      // `registry.ts` — rule L3, Land-written, admin half included.
      if (auth.role !== "admin") fixture.lease.assertHolder(auth.asClientRef());
      fixture.deleted.push(auth.tokenId);
      return Promise.resolve({
        workerId: WID,
        state: "closed",
        reason: "client_request",
        leaderExited: true,
        treeGone: true,
      });
    },

    lease: (id, auth, op, body): LeaseSnapshot => {
      see(id, auth);
      const parsed = LeaseRequestBody.parse(body);
      const who = auth.asClientRef();
      switch (op) {
        case "acquire":
          return fixture.lease.acquire(
            who,
            parsed.ttlMs === undefined ? {} : { ttlMs: parsed.ttlMs },
          );
        case "release":
          return fixture.lease.release(who);
        case "steal":
          return fixture.lease.steal(who, {
            reason: parsed.reason ?? null,
            admin: auth.role === "admin",
          });
      }
    },
  };
}

function fixture(o?: { lease?: Lease; config?: ResolvedDaemonConfig }): Fixture {
  const config = o?.config ?? daemonConfig();
  const clock = fakeClock();
  const lease = o?.lease ?? createLease({ workerId: WID, clock, config: config.lease });
  const log = createMemoryEventLog({
    workerId: WID,
    daemonId: DID,
    clock,
    maxEvents: 1_000,
    subscriberQueueSize: 64,
  });
  log.append({
    kind: "omni.worker_state",
    payloadVersion: 2,
    turnId: null,
    payload: { state: "starting", previous: null, reason: "created" },
  });
  // Rule L9: every transition lands in the WORKER'S OWN log. This is the wiring M1-WP-E owes
  // `create-daemon.ts` (see the note in `DaemonDeps.leaseFactory`); doing it here is what lets
  // the SSE observer test below be about the stream rather than about a fake.
  lease.onChange((payload) => {
    log.append({ kind: "omni.lease", payloadVersion: 2, turnId: null, payload });
  });

  const deleted: string[] = [];
  const snapshot = (): WorkerSnapshot => ({
    workerId: WID,
    daemonId: DID,
    ref: `${DID}:${WID}`,
    sessionId: "sess-1",
    agentId: "example",
    state: "ready",
    cwd: "/tmp/omni",
    label: null,
    ownerTokenId: "tok_user" as TokenId,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    headSeq: log.head,
    currentTurnId: null,
    capabilities: null,
    process: null,
    closeReason: null,
    lease: lease.snapshot(),
    hibernatedAt: null,
    crashed: false,
    resume: null,
    wakeCount: 0,
    wakeFailures: 0,
    orphan: null,
    generation: 1,
    runtimeId: "example@unresolved",
    persistence: "memory",
  });

  const tokens = createTokenStore(config);
  let app: ReturnType<typeof createHttpApp> | null = null;
  const daemon = stubDaemon({
    config,
    // The REAL token store: `Omni-Client-Id` and `Omni-Lease-Epoch` are parsed by `auth.ts`, and
    // `asClientRef()` is the code that actually spreads the fence onto the identity (seam 3).
    authenticate: (headers: Headers) => tokens.verify(headers),
    workers: enforcingRegistry({ lease, log, deleted, snapshot }),
    fetch: (req: Request) =>
      Promise.resolve(app?.fetch(req) ?? new Response(null, { status: 500 })),
  });
  app = createHttpApp(daemon);

  return {
    daemon,
    lease,
    log,
    deleted,
    request: (who, method, path, body) =>
      daemon.fetch(
        new Request(`http://daemon.invalid${path}`, {
          method,
          headers: headersFor(who, body !== undefined),
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      ),
  };
}

/** A caller's credentials, exactly as the SDK sends them (§5.7, rule L4, rule L7). */
function headersFor(who: ClientRef | null, hasBody: boolean): Record<string, string> {
  if (who === null) return hasBody ? { "content-type": "application/json" } : {};
  return {
    [HEADER.auth]: `Bearer ${SECRETS[who.tokenId] ?? "no-such-token"}`,
    ...(who.clientId === null ? {} : { [HEADER.clientId]: who.clientId }),
    ...(who.epoch === undefined ? {} : { [HEADER.leaseEpoch]: String(who.epoch) }),
    ...(hasBody ? { "content-type": "application/json" } : {}),
  };
}

/** The wire error, back in the shape the conformance suite asserts against (rule L10). */
async function throwForStatus(what: string, res: Response): Promise<never> {
  const body = (await res.json()) as {
    code?: string;
    message?: string;
    lease?: LeaseSnapshot;
  };
  throw new OmniError(
    (body.code ?? "internal") as "internal",
    body.message ?? `${what}: HTTP ${String(res.status)}`,
    body.lease === undefined ? {} : { lease: body.lease },
  );
}

async function json<T>(what: string, res: Promise<Response>): Promise<T> {
  const answer = await res;
  if (!answer.ok) await throwForStatus(what, answer);
  return (await answer.json()) as T;
}

/**
 * The HTTP half of §16.4's suite.
 *
 * `snapshot()` is read as the PEER — a client that never holds the lease — so every single
 * assertion the shared table makes about a snapshot is simultaneously an assertion that reading
 * is ungated (rule L2). And `steal`'s `admin` flag is IGNORED here on purpose: the wire has no
 * such parameter, the TOKEN carries the role, and `registry.lease()` derives it with
 * `admin: auth.role === "admin"`. The conformance passes `ids.admin` for the admin cases, so the
 * derivation is what is under test.
 */
function httpSurface(f: Fixture): LeaseSurface {
  const leasePath = (op: string): string => `/v1/workers/${WID}/lease/${op}`;
  return {
    snapshot: async () =>
      (
        await json<WorkerSnapshot>(
          "GET worker",
          f.request(IDENTITIES.peer, "GET", `/v1/workers/${WID}`),
        )
      ).lease,
    act: async (who) => {
      await json(
        "POST prompt",
        f.request(who, "POST", `/v1/workers/${WID}/prompt`, {
          content: [{ type: "text", text: "hello" }],
        }),
      );
    },
    acquire: (who, opts) =>
      json<LeaseSnapshot>(
        "POST lease/acquire",
        f.request(who, "POST", leasePath("acquire"), opts?.ttlMs === undefined ? {} : opts),
      ),
    release: (who) =>
      json<LeaseSnapshot>("POST lease/release", f.request(who, "POST", leasePath("release"), {})),
    steal: (who, opts) =>
      json<LeaseSnapshot>(
        "POST lease/steal",
        f.request(
          who,
          "POST",
          leasePath("steal"),
          opts.reason === null ? {} : { reason: opts.reason },
        ),
      ),
    destroy: async (who) => {
      await json("DELETE worker", f.request(who, "DELETE", `/v1/workers/${WID}`));
    },
  };
}

// ── the shared table, over the wire ──────────────────────────────────────────

describe("createLease over /v1", () => {
  const clock = fakeClock();
  const binding: LeaseHttpBinding = {
    identities: IDENTITIES,
    surface: (lease) => httpSurface(fixture({ lease })),
  };
  runLeaseConformance(
    "createLease over HTTP",
    () => createLease({ workerId: WID, clock, config: LeaseConfig.parse({}) }),
    clock,
    binding,
  );
});

// ── the wire's own concerns ──────────────────────────────────────────────────

describe("H17 — POST /v1/workers/{wid}/lease/{acquire|release|steal}", () => {
  const A = IDENTITIES.holder;

  it("returns 200 LeaseSnapshot for each of the three verbs", async () => {
    const f = fixture();
    const acquired = await f.request(A, "POST", `/v1/workers/${WID}/lease/acquire`, {});
    expect(acquired.status).toBe(200);
    expect(await acquired.json()).toMatchObject({
      workerId: WID,
      holder: { tokenId: A.tokenId, clientId: A.clientId },
      epoch: 1,
      pinned: false,
    });

    const stolen = await f.request(IDENTITIES.peer, "POST", `/v1/workers/${WID}/lease/steal`, {
      reason: "the laptop went to sleep",
    });
    expect(stolen.status).toBe(200);
    expect(await stolen.json()).toMatchObject({ epoch: 2 });

    const released = await f.request(
      IDENTITIES.peer,
      "POST",
      `/v1/workers/${WID}/lease/release`,
      {},
    );
    expect(released.status).toBe(200);
    expect(await released.json()).toMatchObject({ holder: null, epoch: 2 });
  });

  it("calls exactly ONE registry method per route (parse → one call → serialize)", async () => {
    for (const op of ["acquire", "release", "steal"] as const) {
      const f = fixture();
      await f.request(A, "POST", `/v1/workers/${WID}/lease/${op}`, {});
      expect(f.daemon.calls.filter((c) => c.method.startsWith("workers."))).toEqual([
        expect.objectContaining({ method: "workers.lease" }),
      ]);
    }
  });

  it("accepts a body-less POST — `curl -X POST …/lease/release` is a real shape", async () => {
    const f = fixture();
    const acquired = await f.daemon.fetch(
      new Request(`http://daemon.invalid/v1/workers/${WID}/lease/acquire`, {
        method: "POST",
        headers: headersFor(A, false),
      }),
    );
    expect(acquired.status).toBe(200);
    const released = await f.daemon.fetch(
      new Request(`http://daemon.invalid/v1/workers/${WID}/lease/release`, {
        method: "POST",
        headers: headersFor(A, false),
      }),
    );
    expect(released.status).toBe(200);
    expect(await released.json()).toMatchObject({ holder: null });
  });

  it("honours ttlMs, and rejects an unknown key, a wrong content type and malformed JSON with 400", async () => {
    const f = fixture();
    const ok = await f.request(A, "POST", `/v1/workers/${WID}/lease/acquire`, { ttlMs: 1_000 });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as LeaseSnapshot).expiresAt).not.toBeNull();

    const unknownKey = await f.request(A, "POST", `/v1/workers/${WID}/lease/acquire`, {
      ttl: 1_000,
    });
    expect(unknownKey.status).toBe(400);
    expect(await unknownKey.json()).toMatchObject({ code: "bad_request" });

    const wrongType = await f.daemon.fetch(
      new Request(`http://daemon.invalid/v1/workers/${WID}/lease/steal`, {
        method: "POST",
        headers: { ...headersFor(A, false), "content-type": "text/plain" },
        body: JSON.stringify({ reason: "csrf-shaped" }),
      }),
    );
    expect(wrongType.status).toBe(400);
    expect(await wrongType.json()).toEqual({
      code: "bad_request",
      message: "expected content-type: application/json",
    });

    const malformed = await f.daemon.fetch(
      new Request(`http://daemon.invalid/v1/workers/${WID}/lease/acquire`, {
        method: "POST",
        headers: headersFor(A, true),
        body: "{oops",
      }),
    );
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ code: "bad_request", message: "malformed JSON body" });
  });

  it("routes only the three verbs: a fourth word is `400 unknown route`, not a 500", async () => {
    const f = fixture();
    const res = await f.request(A, "POST", `/v1/workers/${WID}/lease/frobnicate`, {});
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: "bad_request", message: "unknown route" });
  });

  it("is authenticated like everything else: no bearer token is 401", async () => {
    const f = fixture();
    const res = await f.request(null, "POST", `/v1/workers/${WID}/lease/acquire`, {});
    expect(res.status).toBe(401);
  });

  it("a malformed worker id is 400 and never reaches the registry", async () => {
    const f = fixture();
    const res = await f.request(A, "POST", "/v1/workers/not-an-id/lease/acquire", {});
    expect(res.status).toBe(400);
    expect(f.daemon.calls.filter((c) => c.method.startsWith("workers."))).toEqual([]);
  });
});

describe("H20 — the gated set, and the 423 body", () => {
  const A = IDENTITIES.holder;
  const B = IDENTITIES.peer;

  it("prompt / cancel / DELETE are 423 for a non-holder, with body.lease.holder and .epoch", async () => {
    const f = fixture();
    await f.request(A, "POST", `/v1/workers/${WID}/lease/acquire`, {});
    const epoch = f.lease.snapshot().epoch;

    for (const [what, method, path, body] of [
      ["prompt", "POST", `/v1/workers/${WID}/prompt`, { content: [{ type: "text", text: "hi" }] }],
      ["cancel", "POST", `/v1/workers/${WID}/cancel`, {}],
      ["delete", "DELETE", `/v1/workers/${WID}`, undefined],
    ] as const) {
      const res = await f.request(B, method, path, body);
      expect({ what, status: res.status }).toEqual({ what, status: 423 });
      // The whole body, so a 423 cannot quietly grow a field or lose one (§9: `lease` appears
      // ONLY on 423, `resume` ONLY on 422, and two bodies for one failure stay deep-equal).
      expect(await res.json()).toEqual({
        code: "lease_held",
        message: expect.stringContaining(String(A.clientId)) as unknown as string,
        lease: {
          workerId: WID,
          holder: { tokenId: A.tokenId, clientId: A.clientId },
          epoch,
          expiresAt: expect.any(String) as unknown as string,
          acquiredAt: expect.any(String) as unknown as string,
          pinned: false,
        },
      });
    }
    expect(f.deleted, "not one of those DELETEs got through").toEqual([]);
  });

  it("L3: an admin who does NOT hold the lease still succeeds on DELETE — and only on DELETE", async () => {
    const f = fixture();
    await f.request(A, "POST", `/v1/workers/${WID}/lease/acquire`, {});

    const prompt = await f.request(IDENTITIES.admin, "POST", `/v1/workers/${WID}/prompt`, {
      content: [{ type: "text", text: "hi" }],
    });
    expect(prompt.status, "the admin bypass is for DELETE alone").toBe(423);

    const deleted = await f.request(IDENTITIES.admin, "DELETE", `/v1/workers/${WID}`);
    expect(deleted.status).toBe(200);
    expect(f.deleted).toEqual(["tok_admin"]);
  });

  it("D13: another token gets 404 before the lease is ever consulted", async () => {
    const f = fixture();
    await f.request(A, "POST", `/v1/workers/${WID}/lease/acquire`, {});
    for (const [method, path] of [
      ["POST", `/v1/workers/${WID}/lease/steal`],
      ["GET", `/v1/workers/${WID}`],
      ["DELETE", `/v1/workers/${WID}`],
    ] as const) {
      const res = await f.request(
        IDENTITIES.stranger,
        method,
        path,
        method === "GET" ? undefined : {},
      );
      expect({ path, status: res.status }).toEqual({ path, status: 404 });
      // Worker EXISTENCE is the thing that must never leak (D13): the body says nothing about a
      // lease, a holder or an epoch.
      expect(await res.json()).toEqual({
        code: "worker_not_found",
        message: expect.any(String) as unknown as string,
      });
    }
  });

  it("L7: `Omni-Lease-Epoch` is parsed by auth.ts — stale is 423, garbage is 400, absent is fine", async () => {
    const f = fixture();
    await f.request(A, "POST", `/v1/workers/${WID}/lease/acquire`, {});
    const epoch = f.lease.snapshot().epoch;

    const fresh = await f.request({ ...A, epoch }, "POST", `/v1/workers/${WID}/cancel`, {});
    expect(fresh.status).toBe(202);

    const stale = await f.request(
      { ...A, epoch: epoch - 1 },
      "POST",
      `/v1/workers/${WID}/cancel`,
      {},
    );
    expect(stale.status).toBe(423);
    expect(((await stale.json()) as { lease: LeaseSnapshot }).lease.epoch).toBe(epoch);

    const absent = await f.request(A, "POST", `/v1/workers/${WID}/cancel`, {});
    expect(absent.status).toBe(202);

    // A fence the daemon silently ignored is worse than no fence at all (`auth.ts`).
    const garbage = await f.daemon.fetch(
      new Request(`http://daemon.invalid/v1/workers/${WID}/cancel`, {
        method: "POST",
        headers: { ...headersFor(A, true), [HEADER.leaseEpoch]: "one" },
        body: "{}",
      }),
    );
    expect(garbage.status).toBe(400);
    expect(await garbage.json()).toEqual({
      code: "bad_request",
      message: "Omni-Lease-Epoch must be a non-negative integer",
    });
  });

  it("L4: `requireClientId: true` makes a header-less gated request 400; the default keeps curl working", async () => {
    const strict = fixture({ config: daemonConfig({ requireClientId: true }) });
    const anonymous: ClientRef = { tokenId: "tok_user" as TokenId, clientId: null };

    const refused = await strict.request(anonymous, "POST", `/v1/workers/${WID}/cancel`, {});
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ code: "bad_request" });
    // A 400, never a 423: the request did not say who it is, so there is no lease to report.
    expect(
      Object.keys(
        (await (
          await strict.request(anonymous, "POST", `/v1/workers/${WID}/cancel`, {})
        ).json()) as object,
      ).sort(),
    ).toEqual(["code", "message"]);

    // The default is false, which is what `curl-shapes.itest.ts` relies on: a bearer token and
    // nothing else is a real controller.
    const lax = fixture();
    expect((await lax.request(anonymous, "POST", `/v1/workers/${WID}/cancel`, {})).status).toBe(
      202,
    );
    expect((await lax.request(anonymous, "POST", `/v1/workers/${WID}/cancel`, {})).status).toBe(
      202,
    );
    expect(lax.lease.snapshot().holder).toEqual({ tokenId: "tok_user", clientId: null });
  });
});

describe("D5 observer mode over the wire (§16.2)", () => {
  it("an observer streams EVERY envelope of the holder's turn, omni.lease included", async () => {
    const f = fixture();

    // B attaches first and keeps the stream for the whole scenario. It never holds the lease.
    const stream = await f.request(IDENTITIES.peer, "GET", `/v1/workers/${WID}/events?since=0`);
    expect(stream.status, "attaching is never gated (rule L2)").toBe(200);

    // A takes the lease, prompts, and is then preempted — three lease lines and one turn line.
    await f.request(IDENTITIES.holder, "POST", `/v1/workers/${WID}/lease/acquire`, {});
    await f.request(IDENTITIES.holder, "POST", `/v1/workers/${WID}/prompt`, {
      content: [{ type: "text", text: "hello" }],
    });
    f.log.append({
      kind: "acp.session_update",
      payloadVersion: 2,
      turnId: TID,
      payload: { sessionUpdate: "state_update", state: "running" } as never,
    });

    // §16.2, verbatim: B saw the holder's turn while its OWN prompt is a 423 naming A.
    const refused = await f.request(IDENTITIES.peer, "POST", `/v1/workers/${WID}/prompt`, {
      content: [{ type: "text", text: "mine" }],
    });
    expect(refused.status).toBe(423);
    expect(((await refused.json()) as { lease: LeaseSnapshot }).lease.holder).toEqual({
      tokenId: IDENTITIES.holder.tokenId,
      clientId: IDENTITIES.holder.clientId,
    });

    await f.request(IDENTITIES.admin, "POST", `/v1/workers/${WID}/lease/steal`, {
      reason: "operator preemption",
    });
    await f.request(IDENTITIES.admin, "POST", `/v1/workers/${WID}/lease/release`, {});

    const collected = await collectSse(stream, { count: 5, timeoutMs: 2_000 });
    expect(collected.envelopes.map((e) => e.kind)).toEqual([
      "omni.worker_state",
      "omni.lease",
      "acp.session_update",
      "omni.lease",
      "omni.lease",
    ]);
    expect(collected.envelopes.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);

    const ops = collected.envelopes
      .filter((e): e is EventEnvelope & { kind: "omni.lease" } => e.kind === "omni.lease")
      .map((e) => [e.payload.op, e.payload.how, e.payload.reason]);
    expect(ops).toEqual([
      ["acquired", "explicit", null],
      ["stolen", "steal", "operator preemption"],
      ["released", "explicit", null],
    ]);
    // The refusal itself wrote nothing: an observer's stream is not polluted by the 423s the
    // observer earned.
    expect(collected.control).toEqual([]);
  });

  it("M1-R22: attaching never wakes anything — GET .../events calls logFor and NOTHING else", async () => {
    const f = fixture();
    const stream = await f.request(IDENTITIES.peer, "GET", `/v1/workers/${WID}/events?since=0`);
    expect(stream.status).toBe(200);
    await collectSse(stream, { count: 1, timeoutMs: 2_000 });

    // DESIGN §3.2 lists `attach` as a `hibernated → starting` trigger; ruling M1-R22 supersedes
    // it. Forcing a ~7 s npx cold start on a passive observer would contradict D5's 多观察者 and
    // let a reader spend the holder's quota, so `POST …/wake` is the only lever.
    expect(f.daemon.calls.filter((c) => c.method.startsWith("workers."))).toEqual([
      expect.objectContaining({ method: "workers.logFor" }),
    ]);
    expect(f.daemon.calls.map((c) => c.method)).not.toContain("workers.wake");
  });

  it("GET /v1/workers/{wid} is never 423, for the holder or anyone else", async () => {
    const f = fixture();
    await f.request(IDENTITIES.holder, "POST", `/v1/workers/${WID}/lease/acquire`, {});
    for (const who of [IDENTITIES.holder, IDENTITIES.peer, IDENTITIES.admin]) {
      const res = await f.request(who, "GET", `/v1/workers/${WID}`);
      expect({ who: who.clientId, status: res.status }).toEqual({ who: who.clientId, status: 200 });
      expect(((await res.json()) as WorkerSnapshot).lease.holder).toEqual({
        tokenId: IDENTITIES.holder.tokenId,
        clientId: IDENTITIES.holder.clientId,
      });
    }
  });
});
