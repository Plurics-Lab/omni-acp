import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  HEADER,
  OmniError,
  type Daemon,
  type LeaseSnapshot,
  type ResumeReport,
  type WorkerHandle,
  type WorkerId,
  type WorkerSnapshot,
} from "@omni-acp/protocol";
import { stubDaemon } from "@omni-acp/testkit";
import { createHttpApp } from "../../src/http/app.js";
import { someWorkerId } from "../fake-core.js";

vi.mock("@omni-acp/core", async (importOriginal) => {
  const { fakeCoreModule } = await import("./../fake-core.js");
  return await fakeCoreModule(importOriginal as never);
});

const WID: WorkerId = someWorkerId(1);
const TOKEN = "any-secret-the-stub-accepts";

const LEASE: LeaseSnapshot = {
  workerId: WID,
  holder: { tokenId: "other", clientId: "c_01ABCDEF" },
  epoch: 7,
  expiresAt: null,
  acquiredAt: "2026-09-04T00:00:00.000Z",
  pinned: false,
};

const RESUME: ResumeReport = {
  outcome: "rejected_permanent",
  hint: "not_found",
  rule: "rule2:not-found",
  method: "session/resume",
  requested: null,
  landedOn: null,
  historyLost: true,
  acp: { code: -32002, message: "Resource not found" },
  replayedEvents: 0,
  replayDropped: 0,
} as unknown as ResumeReport;

function fixture(overrides: Partial<Daemon>): Daemon {
  let app: ReturnType<typeof createHttpApp> | null = null;
  const daemon = stubDaemon({
    ...overrides,
    fetch: (req: Request) =>
      Promise.resolve(app?.fetch(req) ?? new Response(null, { status: 500 })),
  });
  app = createHttpApp(daemon);
  return daemon;
}

const send = (daemon: Daemon, method: string, path: string): Promise<Response> =>
  daemon.fetch(
    new Request(`http://daemon.invalid${path}`, {
      method,
      headers: { [HEADER.auth]: `Bearer ${TOKEN}` },
    }),
  );

/**
 * WP-E acceptance 8, second and third clauses: `423`/`422` flow through the SINGLE existing error
 * mapper with NO new status logic, and the bodies carry `lease` / `resume` so a caller never has
 * to re-`GET` a worker it may no longer control.
 *
 * The failures are raised where the real ones will be — inside a daemon method — and the route
 * is not consulted about the status at any point. That is the property: `http/errors.ts` reads
 * `ERROR_STATUS` and nothing in `http/` decides a status of its own (the `http-has-no-logic`
 * guard proves the second half statically; this proves the first half at runtime).
 */
describe("423 lease_held flows through the ONE mapper, carrying the holder (§16.1 rule L10)", () => {
  const throwing = (e: OmniError): Partial<Daemon> => ({
    workers: {
      size: 0,
      create: () => Promise.reject(e),
      get: () => {
        throw e;
      },
      list: () => [],
      delete: () => Promise.reject(e),
      closeAll: () => Promise.resolve(),
      snapshot: () => {
        throw e;
      },
      prompt: () => Promise.reject(e),
      cancel: () => Promise.reject(e),
      turn: () => {
        throw e;
      },
      logFor: () => {
        throw e;
      },
    } as unknown as Daemon["workers"],
  });

  it("`DELETE /v1/workers/{wid}` answers 423 with the holder and the epoch", async () => {
    const daemon = fixture(
      throwing(new OmniError("lease_held", "another client holds this worker", { lease: LEASE })),
    );
    const res = await send(daemon, "DELETE", `/v1/workers/${WID}`);
    expect(res.status).toBe(423);
    expect(await res.json()).toEqual({
      code: "lease_held",
      message: "another client holds this worker",
      lease: LEASE,
    });
  });

  it("`POST …/prompt` answers 423 the same way — one mapper, every route", async () => {
    const daemon = fixture(throwing(new OmniError("lease_held", "held", { lease: LEASE })));
    const res = await daemon.fetch(
      new Request(`http://daemon.invalid/v1/workers/${WID}/prompt`, {
        method: "POST",
        headers: { [HEADER.auth]: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ content: [{ type: "text", text: "hi" }] }),
      }),
    );
    expect(res.status).toBe(423);
    expect(((await res.json()) as { lease: LeaseSnapshot }).lease.epoch).toBe(7);
  });
});

describe("422 not_resumable flows through the same mapper, carrying the ResumeReport", () => {
  /**
   * Raised from `prompt`, which is where a `422` is REACHABLE today: H8 says a `hibernated`
   * worker auto-wakes, so a wake that the agent refuses surfaces on the prompt the client made.
   *
   * `POST …/wake` (H19) is the other door, registered now, and the block below drives a `422`
   * through it directly.
   */
  it("names which of D2's four states fired, and on what evidence", async () => {
    const daemon = fixture({
      workers: {
        size: 0,
        create: () => Promise.resolve({} as WorkerHandle),
        get: () => ({}) as WorkerHandle,
        list: () => [],
        delete: () => Promise.resolve({} as never),
        closeAll: () => Promise.resolve(),
        snapshot: () => ({}) as WorkerSnapshot,
        cancel: () => Promise.resolve(),
        turn: () => ({}) as never,
        logFor: () => ({}) as never,
        prompt: () =>
          Promise.reject(
            new OmniError("not_resumable", "the agent forgot this session", { resume: RESUME }),
          ),
      } as unknown as Daemon["workers"],
    });

    const res = await daemon.fetch(
      new Request(`http://daemon.invalid/v1/workers/${WID}/prompt`, {
        method: "POST",
        headers: { [HEADER.auth]: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ content: [{ type: "text", text: "hi" }] }),
      }),
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      code: "not_resumable",
      message: "the agent forgot this session",
      resume: RESUME,
    });
  });
});

/**
 * H18 and H19, now that the two lines `src/http/routes/workers.ts` owed them are there.
 *
 * This block replaces the red line that stood here while they were missing (it asserted both
 * paths were `400 unknown route`). Registration is asserted structurally AND at runtime, because
 * a route that exists in the source but was never reached by a request is not a route.
 */
describe("H18 / H19 — hibernate and wake are three moves, like every other worker route", () => {
  const workersRoutes = readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "src",
      "http",
      "routes",
      "workers.ts",
    ),
    "utf8",
  );

  it("registers exactly one POST for each, and decides no status of its own", () => {
    expect(workersRoutes).toContain('app.post("/v1/workers/:wid/hibernate"');
    expect(workersRoutes).toContain('app.post("/v1/workers/:wid/wake"');
    // D15 constraint 1: parse, ONE daemon call, serialize. A status literal or a branch in the
    // route body is the thing this forbids — `http-has-no-logic` proves it for the whole file,
    // and this pins it to the two routes that were just added.
    for (const verb of ["hibernate", "wake"]) {
      const from = workersRoutes.indexOf(`app.post("/v1/workers/:wid/${verb}"`);
      expect(from, `${verb} must be registered`).toBeGreaterThan(-1);
      // Up to the statement's own terminator at the registration's indent — NOT to the next
      // `app.`, which would swallow the following route's comment and its `429 / 422 / 502`.
      const rest = workersRoutes.slice(from);
      const end = rest.indexOf("\n  );");
      expect(end, `${verb}'s registration must be one statement`).toBeGreaterThan(-1);
      const body = rest.slice(0, end);
      expect(body).toContain(`daemon.workers.${verb}(workerId(c), authOf(c.req.raw))`);
      expect(body, `${verb} must not name a status`).not.toMatch(/\b[45]\d\d\b/);
      // Exactly one daemon call: a second would be a decision the route is making.
      expect([...body.matchAll(/\bdaemon\./g)]).toHaveLength(1);
    }
  });

  it("200 WorkerSnapshot on the happy path, for both", async () => {
    const hibernated = { workerId: WID, state: "hibernated" } as unknown as WorkerSnapshot;
    const ready = { workerId: WID, state: "ready" } as unknown as WorkerSnapshot;
    const calls: string[] = [];
    const daemon = fixture({
      workers: {
        hibernate: (id: WorkerId) => {
          calls.push(`hibernate:${id}`);
          return Promise.resolve(hibernated);
        },
        wake: (id: WorkerId) => {
          calls.push(`wake:${id}`);
          return Promise.resolve(ready);
        },
      } as unknown as Daemon["workers"],
    });

    const h = await send(daemon, "POST", `/v1/workers/${WID}/hibernate`);
    expect(h.status).toBe(200);
    expect(await h.json()).toEqual(hibernated);

    const w = await send(daemon, "POST", `/v1/workers/${WID}/wake`);
    expect(w.status).toBe(200);
    expect(await w.json()).toEqual(ready);

    // The worker id came off the PATH and reached the daemon; exactly one call per request.
    expect(calls).toEqual([`hibernate:${WID}`, `wake:${WID}`]);
  });

  it("423 lease_held on hibernate carries the holder — H18 is lease-gated (rule L2)", async () => {
    const daemon = fixture({
      workers: {
        hibernate: () => Promise.reject(new OmniError("lease_held", "held", { lease: LEASE })),
      } as unknown as Daemon["workers"],
    });
    const res = await send(daemon, "POST", `/v1/workers/${WID}/hibernate`);
    expect(res.status).toBe(423);
    expect(await res.json()).toEqual({ code: "lease_held", message: "held", lease: LEASE });
  });

  it("422 not_resumable on hibernate carries the ResumeReport (M1-R15)", async () => {
    const daemon = fixture({
      workers: {
        hibernate: () =>
          Promise.reject(
            new OmniError("not_resumable", "the agent advertises no resume spelling", {
              resume: RESUME,
            }),
          ),
      } as unknown as Daemon["workers"],
    });
    const res = await send(daemon, "POST", `/v1/workers/${WID}/hibernate`);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      code: "not_resumable",
      message: "the agent advertises no resume spelling",
      resume: RESUME,
    });
  });

  it("429 worker_limit on wake — the capacity answer arrives BEFORE a cold start (H14)", async () => {
    const daemon = fixture({
      workers: {
        wake: () => Promise.reject(new OmniError("worker_limit", "daemon worker limit reached")),
      } as unknown as Daemon["workers"],
    });
    const res = await send(daemon, "POST", `/v1/workers/${WID}/wake`);
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ code: "worker_limit" });
  });
});

/**
 * Acceptance 8's FIRST clause: the new route family is three moves — parse, call ONE daemon
 * method, serialize.
 *
 * Counted structurally rather than by eye: a route body that grew a branch, a second daemon call
 * or a status decision would show up as another statement here, and the guard would say so.
 */
describe("routes/agents.ts is three moves per route (D15 constraint 1)", () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "http", "routes", "agents.ts"),
    "utf8",
  );

  it("registers exactly the two routes H4 and H16 name", () => {
    const registrations = [...source.matchAll(/\bapp\.(get|post|put|delete)\(/g)].map(
      (m) => m[1] ?? "",
    );
    expect(registrations).toEqual(["get", "post"]);
  });

  it("calls exactly ONE daemon method per route", () => {
    // `daemon.catalog.list()` for H4, `daemon.catalog.probe(...)` for H16. Anything else — a
    // `daemon.workers.get()` to check something first, say — is the orchestration D15 forbids.
    const calls = [...source.matchAll(/\bdaemon\.[A-Za-z.]+\(/g)].map((m) => m[0]);
    expect(calls).toEqual(["daemon.catalog.list(", "daemon.catalog.probe("]);
  });

  it("decides no status, and reads ERROR_STATUS nowhere", () => {
    expect(/\b[45]\d\d\b/.test(source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ""))).toBe(false);
    expect(source).not.toContain("ERROR_STATUS");
  });
});
