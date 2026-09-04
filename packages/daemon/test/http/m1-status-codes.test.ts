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
   * `POST …/wake` (H19) is the other door and it is not registered yet — see the block below,
   * which says so out loud rather than leaving the gap to a comment.
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
 * H18 and H19 have no route yet, and this test exists so that fact is a RED LINE in the suite
 * rather than a sentence in a hand-off note.
 *
 * `WorkerRegistry.hibernate` / `.wake` are implemented (M1-WP-E, `registry.ts`) and their
 * behaviour is proven in `registry-persistence.test.ts`. What is missing is two lines in
 * `src/http/routes/workers.ts`, which the ownership map (M1-PLAN §3) freezes to the Land step —
 * and CONTRACTS §5.7 names only `registerLeaseRoutes` and `registerAgentRoutes` as new route
 * registrars, so there is no other file either of them could legally live in.
 *
 * The exact change, ready to apply:
 *
 *   app.post("/v1/workers/:wid/hibernate", auth, async (c) =>
 *     c.json(await daemon.workers.hibernate(workerId(c), authOf(c.req.raw))));
 *   app.post("/v1/workers/:wid/wake", auth, async (c) =>
 *     c.json(await daemon.workers.wake(workerId(c), authOf(c.req.raw))));
 *
 * DELETE this block in the same commit that adds them, and the two 200/422 cases move here.
 */
describe("H18 / H19 are NOT registered — two lines are owed to a Land-frozen file", () => {
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

  it("`src/http/routes/workers.ts` registers neither /hibernate nor /wake", () => {
    expect(workersRoutes).not.toContain("/hibernate");
    expect(workersRoutes).not.toContain("/wake");
  });

  it("so both paths are `400 unknown route`, which is at least an honest answer", async () => {
    const daemon = fixture({});
    for (const path of [`/v1/workers/${WID}/hibernate`, `/v1/workers/${WID}/wake`]) {
      const res = await send(daemon, "POST", path);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "bad_request", message: "unknown route" });
    }
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
