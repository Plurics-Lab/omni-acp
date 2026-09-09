import { randomBytes } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  WEBHOOK_HEADER,
  reduceTurn,
  type CreateRunRequest,
  type Daemon,
  type DaemonConfig,
  type DeliveryRecord,
  type EventEnvelope,
  type RunId,
  type RunSnapshot,
  type WebhookPayload,
} from "@omni-acp/protocol";
import { createDaemon } from "@omni-acp/daemon";
import { createRunRegistry, createWebhookDispatcher, openPersistence } from "@omni-acp/core";
import {
  collectSse,
  fakeWebhookReceiver,
  fixtureAgentPath,
  sdkExampleAgentPath,
  type FakeReceiver,
} from "@omni-acp/testkit";

/**
 * The Run API and one real delivery, against `fakeWebhookReceiver()` on loopback.
 *
 * Real processes, real ndJSON, real loopback HTTP, a real SQLite file and a real HTTP receiver:
 * everything in this file that could be faked is not.
 *
 * The one piece of scaffolding is `deps.runs`, and the reason is ownership rather than taste:
 * `create-daemon.ts` (M2-WP-J) is what will build the run subsystem at boot, and it cannot be
 * edited from here. `deps.runs` is the seam §5.8.8 declares for exactly this, so the daemon below
 * is wired through a LAZY registry — the registry needs `daemon.workers`, which does not exist
 * until `createDaemon` has returned. Everything downstream of that seam is the shipped code:
 * `createRunRegistry`, `createWebhookDispatcher`, and schema v2's two real stores.
 *
 * Those stores are opened on `":memory:"` rather than on the daemon's own file, and that is a
 * LOCK rather than a shortcut: §14.10 allows one daemon per data dir and `create-daemon.ts` holds
 * this one's handle privately. The durable half — a v2 file, a restart, a listing read back — is
 * asserted in `packages/core/test/persist/**` and `packages/daemon/test/http/webhooks.test.ts`,
 * where the file is the subject rather than a dependency.
 *
 * Owned by M2-B-WP-R.
 */

const SECRET = "run-webhook-itest-secret-32-bytes!";

interface Rig {
  readonly daemon: Daemon;
  readonly base: string;
  readonly token: string;
  readonly cwd: string;
  readonly receiver: FakeReceiver;
  readonly runs: ReturnType<typeof createRunRegistry>;
  readonly dispatcher: ReturnType<typeof createWebhookDispatcher>;
  readonly persistence: Awaited<ReturnType<typeof openPersistence>>;
  http(path: string, init?: RequestInit): Promise<Response>;
  dispose(): Promise<void>;
}

let rig: Rig;

async function startRig(): Promise<Rig> {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "omni-acp-run-")));
  const dataDir = await realpath(await mkdtemp(join(tmpdir(), "omni-acp-run-data-")));
  const receiver = await fakeWebhookReceiver();
  const token = randomBytes(32).toString("hex");

  const config: DaemonConfig = {
    dataDir,
    listen: { host: "127.0.0.1", port: 0 },
    // A REAL file: half of §24's obligations are about what survives a restart.
    eventLog: { driver: "sqlite" },
    webhooks: {
      enabled: true,
      mode: "allowlist",
      allow: [new URL(receiver.url).origin],
      // Ruling M2-R16, spelled where it is needed: §24.6's CIDR check is ABSOLUTE, so the default
      // `denyCidrs` (which contains `127.0.0.0/8`) would 403 every webhook run against a loopback
      // receiver. The consequence is stated rather than discovered.
      denyCidrs: [],
      secrets: { ci: SECRET },
      timeoutMs: 2_000,
    },
    tokens: [
      {
        id: "local",
        secret: token,
        role: "admin",
        cwdRoots: [cwd],
        maxWorkers: 16,
        webhookSecret: SECRET,
      },
    ],
    agents: [
      { id: "example", command: process.execPath, args: [sdkExampleAgentPath()] },
      { id: "echo", command: process.execPath, args: [fixtureAgentPath("echo")] },
    ],
  };

  // The lazy seam: the registry needs `daemon.workers`, and `deps.runs` is read while the daemon
  // is being built. The box is filled a few lines later and every call goes to the real thing.
  let real: ReturnType<typeof createRunRegistry> | null = null;
  const box = (): ReturnType<typeof createRunRegistry> => {
    if (real === null) throw new Error("the run registry is not wired yet");
    return real;
  };

  const daemon = await createDaemon(config, {
    runs: {
      create: (req, auth) => box().create(req, auth),
      get: (id, auth) => box().get(id, auth),
      list: (auth, o) => box().list(auth, o),
      cancel: (id, auth) => box().cancel(id, auth),
      logFor: (id, auth) => box().logFor(id, auth),
      recover: () => box().recover(),
    },
  });

  const clock = { now: () => Date.now(), iso: () => new Date().toISOString(), setTimer: timer };
  const ids = idGen();
  const logger = quiet();
  const persistence = await openPersistence({
    dataDir,
    file: ":memory:",
    config: daemon.config.eventLog,
    clock,
    logger,
  });

  const dispatcher = createWebhookDispatcher({
    store: persistence.deliveries,
    config: daemon.config.webhooks,
    secrets: daemon.config.webhooks.secrets,
    tokenSecrets: { local: SECRET },
    secretRefFor: ({ runId }) => persistence.runs.get(runId)?.webhook?.secret ?? null,
    bootId: persistence.bootId,
    clock,
    ids,
    logger,
    resolve: async (host) => await Promise.resolve([host]),
  });

  real = createRunRegistry({
    daemonId: daemon.id,
    bootId: persistence.bootId,
    workers: daemon.workers,
    store: persistence.runs,
    deliveries: persistence.deliveries,
    dispatcher,
    config: daemon.config.run,
    clock,
    ids,
    logger,
    webhooks: daemon.config.webhooks,
    // The receiver is on loopback and a literal address skips DNS in the gate anyway, so this
    // resolver only ever sees the hostname it is handed.
    resolve: async (host) => await Promise.resolve([host]),
    tokenSecrets: { local: SECRET },
    persistence: "durable",
    transaction: (fn) => persistence.transaction(fn),
  });
  dispatcher.start();

  await daemon.start();
  const base = daemon.url;
  if (base === null) throw new Error("the daemon bound no socket");

  return {
    daemon,
    base,
    token,
    cwd,
    receiver,
    runs: real,
    dispatcher,
    persistence,
    http: (path, init) =>
      fetch(`${base}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
          ...(init?.headers as Record<string, string> | undefined),
        },
      }),
    async dispose(): Promise<void> {
      await dispatcher.stop().catch(() => {});
      await daemon.stop({ graceful: true }).catch(() => {});
      persistence.close();
      await receiver.close().catch(() => {});
      for (const dir of [cwd, dataDir])
        await rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

/** A real `Clock` — this suite is about wall-clock HTTP, not about a simulated one. */
const timer = (delayMs: number, fn: () => void): { cancel(): void } => {
  const handle = setTimeout(fn, delayMs);
  handle.unref?.();
  return {
    cancel(): void {
      clearTimeout(handle);
    },
  };
};

/** ULID-shaped ids, monotonic, so `assertRunId` and `assertDeliveryId` are satisfied for real. */
function idGen() {
  let n = 0;
  const body = (): string => {
    const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    const value = String(++n).padStart(26, "0");
    return [...value].map((c) => alphabet[Number(c)] ?? "0").join("");
  };
  const gen = {
    daemon: () => `d_${body()}`,
    worker: () => `w_${body()}`,
    turn: () => `t_${body()}`,
    request: () => `q_${body()}`,
    interaction: () => `x_${body()}`,
    run: () => `r_${body()}`,
    delivery: () => `dl_${body()}`,
  };
  return gen as unknown as Parameters<typeof createRunRegistry>[0]["ids"];
}

function quiet(): Parameters<typeof createRunRegistry>[0]["logger"] {
  const logger = {
    child: () => logger,
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  return logger;
}

const runRequest = (o: Partial<CreateRunRequest> = {}): unknown => ({
  agent: "echo",
  cwd: rig.cwd,
  prompt: [{ type: "text", text: "hello" }],
  ...o,
});

const settle = async (id: RunId, timeoutMs = 30_000): Promise<RunSnapshot> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snapshot = (await (await rig.http(`/v1/runs/${id}`)).json()) as RunSnapshot;
    if (["succeeded", "failed", "cancelled", "abandoned"].includes(snapshot.state)) return snapshot;
    if (Date.now() > deadline) throw new Error(`run ${id} never settled (${snapshot.state})`);
    await new Promise<void>((r) => setTimeout(r, 25));
  }
};

const waitFor = async (p: () => boolean, timeoutMs = 15_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!p()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise<void>((r) => setTimeout(r, 10));
  }
};

describe("runs and webhooks (M2-B, D9)", () => {
  beforeAll(async () => {
    rig = await startRig();
  }, 60_000);

  afterAll(async () => {
    await rig?.dispose();
  });

  it("POST /v1/runs creates, prompts, settles and closes, and .../events?since= replays with M1's exact semantics", async () => {
    const created = await rig.http("/v1/runs", {
      method: "POST",
      body: JSON.stringify(runRequest()),
    });
    // `202`: the run is ACCEPTED and converges on the daemon's own time (H25).
    expect(created.status).toBe(202);
    const run = (await created.json()) as RunSnapshot;
    expect(run.state).toBe("starting");
    expect(run.workerId).not.toBeNull();

    const done = await settle(run.runId);
    expect(done.state).toBe("succeeded");
    expect(done.result?.stopReason).toBe("end_turn");
    expect(done.result?.text).toContain("echo: hello");

    // ── the run's stream IS the worker's stream ──────────────────────────
    //
    // `sse-resume.itest.ts`'s frame comparison, run against a RUN's url: a full replay is the
    // reference, and a client that read a prefix and resumed from its last seq must hold
    // exactly the same envelopes — no gaps, no duplicates, same order.
    const full = await collectSse(await rig.http(`/v1/runs/${run.runId}/events?since=0`), {
      until: (e: EventEnvelope) => e.kind === "omni.worker_state" && e.payload.state === "closed",
      timeoutMs: 20_000,
    });
    expect(full.envelopes.length).toBeGreaterThan(4);

    const first = await collectSse(await rig.http(`/v1/runs/${run.runId}/events?since=0`), {
      count: 3,
      timeoutMs: 20_000,
    });
    const cursor = first.envelopes.at(-1)?.seq ?? 0;
    const rest = await collectSse(
      await rig.http(`/v1/runs/${run.runId}/events?since=${String(cursor)}`),
      {
        until: (e: EventEnvelope) => e.kind === "omni.worker_state" && e.payload.state === "closed",
        timeoutMs: 20_000,
      },
    );
    const union = [...first.envelopes, ...rest.envelopes];
    expect(union.map((e) => e.seq)).toEqual(full.envelopes.map((e) => e.seq));
    expect(union).toEqual(full.envelopes);
    // `?since=` is EXCLUSIVE, byte for byte with M1's: nothing at or below the cursor came back.
    expect(rest.envelopes.every((e) => e.seq > cursor)).toBe(true);

    // The `omni.run` envelopes ride on that same log, which is why `sse.ts` never learned about
    // runs at all (Land exit criterion 6).
    const runEvents = full.envelopes.filter((e) => e.kind === "omni.run");
    expect(runEvents.map((e) => (e.payload as { state: string }).state)).toEqual([
      "starting",
      "running",
      "succeeded",
    ]);

    // D7: the daemon's fold and a local one agree, over the wire, on real envelopes.
    const local = reduceTurn(done.turnId ?? ("t_x" as never), full.envelopes);
    expect(done.result).toEqual(local);

    // ...and the worker was CLOSED, because `keepWorker` defaults to false (DESIGN §9.3).
    const worker = await rig.http(`/v1/workers/${String(run.workerId)}`);
    expect(((await worker.json()) as { state: string }).state).toBe("closed");
  }, 60_000);

  it("a delivery carries exactly the eight thin-payload keys and a verifiable Omni-Signature", async () => {
    const before = rig.receiver.received.length;
    const created = await rig.http("/v1/runs", {
      method: "POST",
      body: JSON.stringify(
        runRequest({ webhook: { url: rig.receiver.url, secret: "ci" } as never }),
      ),
    });
    expect(created.status).toBe(202);
    const run = (await created.json()) as RunSnapshot;
    const done = await settle(run.runId);
    expect(done.state).toBe("succeeded");

    await waitFor(() => rig.receiver.received.length > before);
    await rig.dispatcher.drain({ timeoutMs: 5_000 });

    // EXACTLY ONE delivery for one terminal event.
    const mine = rig.receiver.received.filter((r) => r.body.includes(`"runId":"${run.runId}"`));
    expect(mine).toHaveLength(1);

    const index = rig.receiver.received.indexOf(mine[0] as never);
    const payload = JSON.parse(mine[0]?.body ?? "{}") as WebhookPayload;
    expect(Object.keys(payload).sort()).toEqual([
      "daemonId",
      "deliveryId",
      "event",
      "runId",
      "seq",
      "sessionId",
      "ts",
      "workerId",
    ]);
    expect(payload.event).toBe("run.completed");
    expect(payload.daemonId).toBe(rig.daemon.id);
    expect(payload.workerId).toBe(run.workerId);

    // The signature verifies against the CONFIGURED secret, and against nothing else.
    expect(rig.receiver.verify(index, SECRET)).toBe(true);
    expect(rig.receiver.verify(index, `${SECRET}x`)).toBe(false);
    expect(mine[0]?.headers[WEBHOOK_HEADER.deliveryId]).toBe(payload.deliveryId);
    expect(mine[0]?.headers[WEBHOOK_HEADER.event]).toBe("run.completed");

    // `deliveryId` is the idempotency key, and `redeliver` KEEPS it: a dead-letter replay is
    // the event the receiver already has, not a second one.
    const record = await rig.dispatcher.redeliver(payload.deliveryId);
    expect(record.deliveryId).toBe(payload.deliveryId);
    expect(record.attempt).toBe(0);
    await rig.dispatcher.drain({ timeoutMs: 5_000 });
    const replayed = rig.receiver.received.filter((r) =>
      r.body.includes(`"deliveryId":"${payload.deliveryId}"`),
    );
    expect(replayed).toHaveLength(2);
    expect(replayed[0]?.body).toBe(replayed[1]?.body);
  }, 60_000);

  it("a hung receiver never delays the run's TurnResult", async () => {
    // The receiver holds the socket for the whole `timeoutMs`; the run must not notice.
    rig.receiver.respond(["hang"]);

    const hung = Date.now();
    const withHook = (await (
      await rig.http("/v1/runs", {
        method: "POST",
        body: JSON.stringify(
          runRequest({ webhook: { url: rig.receiver.url, secret: "ci" } as never }),
        ),
      })
    ).json()) as RunSnapshot;
    const hungResult = await settle(withHook.runId);
    const hungMs = Date.now() - hung;

    const plain = Date.now();
    const withoutHook = (await (
      await rig.http("/v1/runs", { method: "POST", body: JSON.stringify(runRequest()) })
    ).json()) as RunSnapshot;
    await settle(withoutHook.runId);
    const plainMs = Date.now() - plain;

    expect(hungResult.state).toBe("succeeded");
    // The claim is structural — `dispatch` enqueues and returns — so the comparison is generous
    // on purpose: what would fail here is a run that WAITED on the socket, which would cost the
    // full 2 000 ms `timeoutMs` and be unmistakable.
    expect(hungMs).toBeLessThan(plainMs + 1_500);

    await rig.dispatcher.drain({ timeoutMs: 5_000 });
  }, 60_000);

  it("a run with an off-allowlist url is 403 AT CREATE, and starts no worker", async () => {
    const before = rig.daemon.workers.size;
    const res = await rig.http("/v1/runs", {
      method: "POST",
      body: JSON.stringify(
        runRequest({ webhook: { url: "https://not-allowlisted.example.com/x" } as never }),
      ),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("forbidden");
    // Nothing was spent: the gate runs where the operator can see it, not in a background log.
    expect(rig.daemon.workers.size).toBe(before);
  });

  it("idempotencyKey returns the ORIGINAL run and starts no second agent", async () => {
    const key = "itest-idempotency-key-0001";
    const first = (await (
      await rig.http("/v1/runs", {
        method: "POST",
        body: JSON.stringify(runRequest({ idempotencyKey: key })),
      })
    ).json()) as RunSnapshot;
    const second = (await (
      await rig.http("/v1/runs", {
        method: "POST",
        body: JSON.stringify(runRequest({ idempotencyKey: key })),
      })
    ).json()) as RunSnapshot;

    expect(second.runId).toBe(first.runId);
    expect(second.workerId).toBe(first.workerId);
    await settle(first.runId);
  }, 60_000);

  it("GET /v1/runs lists the token's runs, and an unknown run is a 404", async () => {
    const listed = (await (await rig.http("/v1/runs")).json()) as {
      runs: RunSnapshot[];
      cursor: string | null;
    };
    expect(listed.runs.length).toBeGreaterThan(0);
    expect(listed.cursor).toBeNull();

    const missing = await rig.http(`/v1/runs/r_${"0".repeat(26)}`);
    expect(missing.status).toBe(404);
    // Ruling M2-R2 declines a `run_not_found` code: `/v1/runs/{rid}` addresses exactly one
    // resource, so its 404 is already unambiguous.
    expect(((await missing.json()) as { code: string }).code).toBe("worker_not_found");
  });

  it("the delivery log records every attempt, and survives being read back", () => {
    const page = rig.persistence.deliveries.list({ limit: 50 });
    expect(page.rows.length).toBeGreaterThan(0);
    for (const row of page.rows as readonly DeliveryRecord[]) {
      expect(row.attempt).toBeGreaterThan(0);
      // A secret VALUE never crosses this wire in either direction (§24.5).
      expect(JSON.stringify(row)).not.toContain(SECRET);
    }
  });
});
