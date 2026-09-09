import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DaemonConfig,
  HEADER,
  hashSecret,
  type DaemonId,
  type Daemon,
  type DeliveryId,
  type DeliveryListResponse,
  type DeliveryRecord,
  type DeliveryStore,
  type ResolvedDaemonConfig,
  type Resolver,
  type RunId,
  type Seq,
  type TokenId,
  type WorkerId,
} from "@omni-acp/protocol";
import { createWebhookDispatcher, openPersistence } from "@omni-acp/core";
import { fakeClock, nullLogger, seqIds, stubDaemon } from "@omni-acp/testkit";
import { createTokenStore } from "../../src/auth.js";
import { createHttpApp } from "../../src/http/app.js";

/**
 * H26: the delivery log and `redeliver`, over the REAL app, the REAL token store and the REAL
 * SQLite delivery store.
 *
 * The store is real rather than a double because the two claims this route family makes are
 * claims about the store's queries: "admin **or the owning token** only" is a WHERE clause, and
 * "cursor-paginated, survives a restart" is a fact about a file. A double would let both pass
 * while the shipped SQL did something else.
 *
 * Owned by M2-B-WP-R.
 */

const DID = "d_00000000000000000000000001" as DaemonId;
const WID = "w_00000000000000000000000001" as WorkerId;

const SECRETS: Record<string, string> = {
  admin: "admin-secret-value-0123456789",
  alice: "alice-secret-value-0123456789",
  bob: "bob-secret-value-01234567890",
};

const runId = (n: number): RunId => `r_${String(n).padStart(26, "0")}` as RunId;
const deliveryId = (n: number): DeliveryId => `dl_${String(n).padStart(26, "0")}` as DeliveryId;

function config(dataDir: string): ResolvedDaemonConfig {
  return DaemonConfig.parse({
    dataDir,
    eventLog: { driver: "sqlite" },
    // `mode:"any"` so the SSRF gate's verdict is decided by `denyCidrs` and the RESOLVER alone,
    // which is what the redelivery re-check test below moves.
    webhooks: { enabled: true, mode: "any" },
    tokens: [
      { id: "admin", role: "admin", secretSha256: hashSecret(SECRETS["admin"] ?? "") },
      { id: "alice", role: "user", secretSha256: hashSecret(SECRETS["alice"] ?? "") },
      { id: "bob", role: "user", secretSha256: hashSecret(SECRETS["bob"] ?? "") },
    ],
  });
}

interface Rig {
  readonly daemon: Daemon;
  readonly deliveries: DeliveryStore;
  /** What the SSRF gate's resolver answers for `hooks.example.com`, movable mid-test. */
  resolvesTo(...addresses: readonly string[]): void;
  /** Every URL the dispatcher actually POSTed to. */
  readonly posted: readonly string[];
  request(who: string | null, method: string, path: string): Promise<Response>;
  /** Close and re-open the same data dir — the restart, without the temp dir going. */
  restart(): Promise<void>;
  dispose(): Promise<void>;
}

const T0 = Date.UTC(2026, 0, 1);

async function rig(): Promise<Rig> {
  const dataDir = await mkdtemp(join(tmpdir(), "omni-acp-deliveries-"));
  const resolved = config(dataDir);
  const tokens = createTokenStore(resolved);
  const clock = fakeClock();

  let handle = await openPersistence({
    dataDir,
    config: resolved.eventLog,
    clock,
    logger: nullLogger(),
  });
  let app: ReturnType<typeof createHttpApp> | null = null;

  /**
   * A DELEGATING facade, not a getter.
   *
   * `stubDaemon` merges its overrides with a spread, and a spread EVALUATES an accessor — so a
   * `get deliveries()` would be frozen at construction and a restart would leave the daemon
   * pointing at a closed database. Reading `handle` inside each method is what makes the swap
   * real, and it is also closer to what `create-daemon.ts` does: the store is a member, not a
   * snapshot of one.
   */
  const deliveries: DeliveryStore & {
    get(id: DeliveryId): { url: string; tokenId: TokenId } | null;
    redeliver(id: DeliveryId, nowMs: number, tokenId?: TokenId): DeliveryRecord;
  } = {
    enqueue: (r) => handle.deliveries.enqueue(r),
    due: (nowMs, limit) => handle.deliveries.due(nowMs, limit),
    claim: (id, bootId, nowMs) => handle.deliveries.claim(id, bootId, nowMs),
    settle: (r) => handle.deliveries.settle(r),
    requeueStale: (bootId, nowMs) => handle.deliveries.requeueStale(bootId, nowMs),
    list: (o) => handle.deliveries.list(o),
    // `get` is the row the DISPATCHER reads before it re-runs the SSRF gate on a replay, so the
    // facade has to carry it too — a delegating double that stopped one method short of the real
    // store is how the wiring under test would answer 500 instead of 403 (review finding V1).
    get: (id) => handle.deliveries.get(id),
    redeliver: (id, nowMs, tokenId?: TokenId) => handle.deliveries.redeliver(id, nowMs, tokenId),
  };

  /**
   * The REAL dispatcher, over the real store — because `POST …/redeliver` goes through it now
   * (review finding V1) and it is the only thing that re-runs `assertWebhookUrl` before a replay.
   * A double here would let the route look wired while the gate never ran, which is precisely the
   * shape of the bug: `WebhookDispatcher.redeliver` had a passing unit test and no caller.
   */
  let answers: readonly string[] = ["93.184.216.34"];
  const posted: string[] = [];
  const resolve: Resolver = (hostname: string) => {
    if (hostname !== "hooks.example.com") throw new Error(`unexpected lookup: ${hostname}`);
    return Promise.resolve(answers);
  };
  const dispatcher = createWebhookDispatcher({
    store: deliveries,
    config: resolved.webhooks,
    secrets: resolved.webhooks.secrets,
    tokenSecrets: { alice: "alice-webhook-signing-key", admin: "admin-webhook-signing-key" },
    bootId: "boot_test",
    clock,
    ids: seqIds(),
    logger: nullLogger(),
    resolve,
    // No socket, ever: the dispatcher pumps on its own after a successful redeliver.
    fetch: (input) => {
      posted.push(String(input));
      return Promise.resolve(new Response("", { status: 200 }));
    },
  });

  const daemon = stubDaemon({
    config: resolved,
    authenticate: (headers: Headers) => tokens.verify(headers),
    deliveries,
    dispatcher,
    fetch: (req: Request) =>
      Promise.resolve(app?.fetch(req) ?? new Response(null, { status: 500 })),
  });
  app = createHttpApp(daemon);

  return {
    daemon,
    deliveries,
    posted,
    resolvesTo(...addresses: readonly string[]): void {
      answers = addresses;
    },
    request: (who, method, path) =>
      daemon.fetch(
        new Request(`http://daemon.invalid${path}`, {
          method,
          headers: who === null ? {} : { [HEADER.auth]: `Bearer ${SECRETS[who] ?? "nope"}` },
        }),
      ),
    async restart(): Promise<void> {
      handle.close();
      // `PersistenceHandle.close()` is SYNCHRONOUS by contract and releases the §14.10 data-dir
      // lock asynchronously, so a same-process reopen can arrive before the unlink — and the lock
      // is held by a pid that is very much alive, so it is not stale and will not be broken.
      // Retrying is the honest wait; a fixed sleep would be a race with a nicer name.
      const deadline = Date.now() + 5_000;
      for (;;) {
        try {
          handle = await openPersistence({
            dataDir,
            config: resolved.eventLog,
            clock,
            logger: nullLogger(),
          });
          return;
        } catch (e) {
          if (Date.now() > deadline) throw e;
          await new Promise<void>((r) => setTimeout(r, 10));
        }
      }
    },
    async dispose(): Promise<void> {
      try {
        handle.close();
      } catch {
        // Already closed.
      }
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

const seed = (r: Rig, n: number, token: string): void => {
  r.deliveries.enqueue({
    deliveryId: deliveryId(n),
    runId: runId(n),
    tokenId: token as TokenId,
    event: "run.completed",
    url: "https://hooks.example.com/x",
    payload: {
      deliveryId: deliveryId(n),
      event: "run.completed",
      daemonId: DID,
      workerId: WID,
      runId: runId(n),
      sessionId: null,
      seq: 1 as Seq,
      ts: new Date(T0).toISOString(),
    },
    nowMs: T0 + n * 1_000,
  });
};

const listed = async (res: Response): Promise<DeliveryListResponse> =>
  (await res.json()) as DeliveryListResponse;

const rigs: Rig[] = [];
const make = async (): Promise<Rig> => {
  const r = await rig();
  rigs.push(r);
  return r;
};
afterEach(async () => {
  while (rigs.length > 0) await rigs.pop()?.dispose();
});

describe("webhook routes (H26)", () => {
  it("GET /v1/webhooks/deliveries is admin-or-owner only", async () => {
    const r = await make();
    seed(r, 1, "alice");
    seed(r, 2, "bob");

    const admin = await listed(await r.request("admin", "GET", "/v1/webhooks/deliveries"));
    expect(admin.deliveries.map((d) => d.deliveryId)).toEqual([deliveryId(2), deliveryId(1)]);

    // A user sees ONLY their own token's rows — not a filtered page of somebody else's.
    const alice = await listed(await r.request("alice", "GET", "/v1/webhooks/deliveries"));
    expect(alice.deliveries.map((d) => d.deliveryId)).toEqual([deliveryId(1)]);
    const bob = await listed(await r.request("bob", "GET", "/v1/webhooks/deliveries"));
    expect(bob.deliveries.map((d) => d.deliveryId)).toEqual([deliveryId(2)]);

    expect((await r.request(null, "GET", "/v1/webhooks/deliveries")).status).toBe(401);
  });

  it("never returns a secret, a url or a payload — the wire record is the wire record", async () => {
    const r = await make();
    seed(r, 1, "alice");
    const res = await r.request("alice", "GET", "/v1/webhooks/deliveries");
    const text = await res.text();
    // `DeliveryRecord` is what an operator sees; `url`, `tokenId` and `payload` are the store's
    // own columns and have no business on this wire.
    expect(text).not.toContain("hooks.example.com");
    expect(text).not.toContain("payload");
    expect(text).not.toContain("tokenId");
    const record = (JSON.parse(text) as DeliveryListResponse).deliveries[0] as DeliveryRecord;
    expect(Object.keys(record).sort()).toEqual([
      "attempt",
      "createdAt",
      "deliveryId",
      "event",
      "lastError",
      "lastStatus",
      "nextAttemptAt",
      "responseMs",
      "runId",
      "state",
      "updatedAt",
    ]);
  });

  it("is cursor-paginated, and the cursor is scoped the same way the page is", async () => {
    const r = await make();
    for (let n = 1; n <= 5; n++) seed(r, n, "alice");
    seed(r, 6, "bob");

    const first = await listed(await r.request("alice", "GET", "/v1/webhooks/deliveries?limit=2"));
    expect(first.deliveries.map((d) => d.deliveryId)).toEqual([deliveryId(5), deliveryId(4)]);
    expect(first.cursor).toBe(deliveryId(4));

    const second = await listed(
      await r.request(
        "alice",
        "GET",
        `/v1/webhooks/deliveries?limit=2&cursor=${first.cursor ?? ""}`,
      ),
    );
    expect(second.deliveries.map((d) => d.deliveryId)).toEqual([deliveryId(3), deliveryId(2)]);

    const third = await listed(
      await r.request(
        "alice",
        "GET",
        `/v1/webhooks/deliveries?limit=2&cursor=${second.cursor ?? ""}`,
      ),
    );
    expect(third.deliveries.map((d) => d.deliveryId)).toEqual([deliveryId(1)]);
    // The last page says so, rather than making a client ask for an empty one.
    expect(third.cursor).toBeNull();
  });

  it("filters by runId and by state", async () => {
    const r = await make();
    seed(r, 1, "alice");
    seed(r, 2, "alice");
    r.deliveries.claim(deliveryId(2), "boot_a", T0);

    const byRun = await listed(
      await r.request("alice", "GET", `/v1/webhooks/deliveries?runId=${runId(1)}`),
    );
    expect(byRun.deliveries.map((d) => d.deliveryId)).toEqual([deliveryId(1)]);

    const byState = await listed(
      await r.request("alice", "GET", "/v1/webhooks/deliveries?state=delivering"),
    );
    expect(byState.deliveries.map((d) => d.deliveryId)).toEqual([deliveryId(2)]);

    // A malformed filter is a `400`, not a silently-ignored one that returns the wrong page.
    expect((await r.request("alice", "GET", "/v1/webhooks/deliveries?runId=nope")).status).toBe(
      400,
    );
    expect((await r.request("alice", "GET", "/v1/webhooks/deliveries?limit=0")).status).toBe(400);
    expect((await r.request("alice", "GET", "/v1/webhooks/deliveries?limit=x")).status).toBe(400);
  });

  it("survives a restart", async () => {
    const r = await make();
    for (let n = 1; n <= 3; n++) seed(r, n, "alice");
    await r.restart();
    const res = await r.request("alice", "GET", "/v1/webhooks/deliveries");
    if (res.status !== 200) throw new Error(`${String(res.status)}: ${await res.text()}`);
    const page = await listed(res);
    expect(page.deliveries.map((d) => d.deliveryId)).toEqual([
      deliveryId(3),
      deliveryId(2),
      deliveryId(1),
    ]);
  });

  it("redeliver KEEPS the deliveryId — it is the receiver's idempotency key", async () => {
    const r = await make();
    seed(r, 1, "alice");
    r.deliveries.claim(deliveryId(1), "boot_a", T0);
    r.deliveries.settle({
      deliveryId: deliveryId(1),
      ok: false,
      status: 500,
      error: "receiver answered 500",
      responseMs: 4,
      nextAttemptMs: null,
      state: "failed",
      nowMs: T0 + 4,
    });

    const res = await r.request(
      "alice",
      "POST",
      `/v1/webhooks/deliveries/${deliveryId(1)}/redeliver`,
    );
    if (res.status !== 200) throw new Error(`${String(res.status)}: ${await res.text()}`);
    expect(res.status).toBe(200);
    const record = (await res.json()) as DeliveryRecord;
    // The SAME id, and `attempt` back to 0: a dead-letter REPLAY, not a second event.
    expect(record.deliveryId).toBe(deliveryId(1));
    expect(record.attempt).toBe(0);
    expect(record.state).toBe("pending");
    expect(record.lastStatus).toBeNull();
  });

  it("redeliver is admin-or-owner: another token's delivery is a 404, never a 403", async () => {
    const r = await make();
    seed(r, 1, "alice");

    // A 403 would confirm the id is real (D13's rule, applied to a delivery).
    const bob = await r.request(
      "bob",
      "POST",
      `/v1/webhooks/deliveries/${deliveryId(1)}/redeliver`,
    );
    expect(bob.status).toBe(404);
    // ...and it did not re-queue it as a side effect.
    expect(r.deliveries.list({ limit: 1 }).rows[0]?.attempt).toBe(0);

    expect(
      (await r.request("admin", "POST", `/v1/webhooks/deliveries/${deliveryId(1)}/redeliver`))
        .status,
    ).toBe(200);
    expect(
      (await r.request("alice", "POST", `/v1/webhooks/deliveries/${deliveryId(1)}/redeliver`))
        .status,
    ).toBe(200);
  });

  it("a malformed delivery id is a 400 with the value elided", async () => {
    const r = await make();
    const res = await r.request("alice", "POST", "/v1/webhooks/deliveries/nope/redeliver");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toBe("malformed delivery id");
  });

  /**
   * Review finding V1, end to end over the real route, the real store and the real dispatcher.
   *
   * The route used to call the delivery STORE's `redeliver`, which only flips the row back to
   * `pending`; the background poll then POSTed it. So the SSRF gate ran exactly once, at CREATE,
   * and an operator replaying a dead letter hours or days later re-sent to whatever the name
   * resolves to NOW — which is the DNS-rebinding-to-metadata case §24.6 exists for.
   *
   * Reverting the route to `store.redeliver(...)` makes the second block answer `200` and the
   * receiver get a POST, which is exactly the behaviour that was shipped.
   */
  it("a REDELIVERY re-runs the SSRF gate, so a name that has since rebound is refused", async () => {
    const r = await make();
    seed(r, 1, "alice");
    r.deliveries.claim(deliveryId(1), "boot_a", T0);
    r.deliveries.settle({
      deliveryId: deliveryId(1),
      ok: false,
      status: 500,
      error: "receiver answered 500",
      responseMs: 4,
      nextAttemptMs: null,
      state: "failed",
      nowMs: T0 + 4,
    });

    // Hours later, the same NAME resolves into the metadata range.
    r.resolvesTo("169.254.169.254");
    const rebound = await r.request(
      "alice",
      "POST",
      `/v1/webhooks/deliveries/${deliveryId(1)}/redeliver`,
    );
    expect(rebound.status).toBe(403);
    const body = (await rebound.json()) as { code: string; message: string };
    expect(body.code).toBe("forbidden");
    expect(body.message).toContain("169.254.169.254");
    // Refused BEFORE the write: the dead letter is still a dead letter, so the poll that would
    // have sent it has nothing to pick up.
    expect(r.deliveries.list({ limit: 1 }).rows[0]?.state).toBe("failed");
    expect(r.posted).toEqual([]);

    // …and the gate is not simply always-closed: back on a public address it replays and SENDS.
    r.resolvesTo("93.184.216.34");
    const ok = await r.request(
      "alice",
      "POST",
      `/v1/webhooks/deliveries/${deliveryId(1)}/redeliver`,
    );
    expect(ok.status).toBe(200);
    await vi.waitFor(() => {
      expect(r.posted).toEqual(["https://hooks.example.com/x"]);
    });
  });

  it("redelivering an id nobody enqueued is a 404", async () => {
    const r = await make();
    expect(
      (await r.request("admin", "POST", `/v1/webhooks/deliveries/${deliveryId(9)}/redeliver`))
        .status,
    ).toBe(404);
  });
});
