import {
  CreateWorkerRequest,
  HEADER,
  OmniError,
  PromptRequestBody,
  assertTurnId,
  assertWorkerId,
  type Seq,
} from "@omni-acp/protocol";
import type { Context, Hono } from "hono";
import type { Daemon } from "../types.js";
import { authMiddleware, authOf } from "./auth-middleware.js";
import { sseResponse } from "./sse.js";

/**
 * Registers H1-H15 of CONTRACTS.md §2.1.
 *
 * Every route is exactly three moves: parse with zod, call ONE daemon method, serialize. That is
 * literally satisfiable because `WorkerRegistry` carries the result-returning façade
 * (`snapshot` / `prompt` / `cancel` / `turn` / `logFor`, review R11); the single exception is
 * `POST /v1/workers`, which serializes `snapshot()` on the handle `create()` just returned — a
 * pure accessor, not a decision.
 *
 * No branching on domain state, no import of `@omni-acp/core`, no `node:child_process` — the
 * `http-has-no-logic` guard (CONTRACTS.md §10.2) fails the build on any of those, and a
 * companion test with a recording `stubDaemon()` asserts the one-method rule per route.
 */
export function registerRoutes(app: Hono, daemon: Daemon): Hono {
  const auth = authMiddleware(daemon);

  // H1. The ONLY unauthenticated route, and it says `{ok:true}` and nothing else: no daemonId,
  // no version, no ACL data on an open port (D21).
  app.get("/v1/health", (c) => c.json({ ok: true }));

  // H2.
  app.get("/v1/info", auth, (c) => c.json(daemon.info));

  // H3. The one call `OmniACP.connect()` makes.
  app.get("/v1/whoami", auth, (c) => c.json(daemon.whoami(authOf(c.req.raw))));

  // H4.
  app.get("/v1/agents", auth, (c) => c.json({ agents: daemon.catalog.list() }));

  // H5. Synchronously ready: the 201 body carries the REAL handshake capabilities.
  app.post("/v1/workers", auth, async (c) => {
    const body = CreateWorkerRequest.parse(await readJson(c));
    const handle = await daemon.workers.create(body, authOf(c.req.raw), c.req.raw.signal);
    return c.json(handle.snapshot(), 201);
  });

  // H6.
  app.get("/v1/workers", auth, (c) => c.json({ workers: daemon.workers.list(authOf(c.req.raw)) }));

  // H7.
  app.get("/v1/workers/:wid", auth, (c) =>
    c.json(daemon.workers.snapshot(workerId(c), authOf(c.req.raw))),
  );

  // H8.
  app.post("/v1/workers/:wid/prompt", auth, async (c) => {
    const body = PromptRequestBody.parse(await readJson(c));
    return c.json(await daemon.workers.prompt(workerId(c), authOf(c.req.raw), body), 202);
  });

  // H9. Idempotent, and a no-op when the worker is not running — the registry decides that.
  app.post("/v1/workers/:wid/cancel", auth, async (c) => {
    await daemon.workers.cancel(workerId(c), authOf(c.req.raw));
    return c.json({}, 202);
  });

  // H10. The log comes back from ONE registry call, which is also where visibility is checked;
  // the writer below only knows how to turn a log into frames (§8.4).
  app.get("/v1/workers/:wid/events", auth, (c) =>
    sseResponse(daemon.workers.logFor(workerId(c), authOf(c.req.raw)), {
      since: sinceOf(c),
      heartbeatMs: daemon.config.eventLog.sseHeartbeatMs,
      queueSize: daemon.config.eventLog.subscriberQueueSize,
      signal: c.req.raw.signal,
    }),
  );

  // H11. An unknown turn is `state:"unknown"` at 200, never a 404 (D29).
  app.get("/v1/workers/:wid/turns/:turnId", auth, (c) =>
    c.json(
      daemon.workers.turn(workerId(c), authOf(c.req.raw), assertTurnId(c.req.param("turnId"))),
    ),
  );

  // H12. `200 CloseResult`, not `204`: the body is where `treeGone` / `leaderExited` reach the
  // operator (§6.6, D32).
  app.delete("/v1/workers/:wid", auth, async (c) =>
    c.json(await daemon.workers.delete(workerId(c), authOf(c.req.raw))),
  );

  return app;
}

/**
 * A malformed id is a request parameter error: `400`, with the value elided (§9, ids.ts).
 *
 * The `?? ""` is not defensive noise: the router types every param as possibly absent, and an
 * empty string is exactly what `assertWorkerId` rejects — so an impossible route match still
 * leaves through the one door instead of an `undefined` reaching the registry.
 */
function workerId(c: Context) {
  return assertWorkerId(c.req.param("wid") ?? "");
}

/**
 * `?since=N` (exclusive) wins; else `Last-Event-ID`; else 0 — a full retained replay, which is
 * the normal path and what removes the create-then-subscribe race (§8.4).
 *
 * An explicit `?since=` that is not a number is a client bug worth a 400. A malformed
 * `Last-Event-ID` is NOT: the browser's own EventSource sends it back unprompted on every
 * reconnect, and failing that request would break exactly the recovery the header exists for.
 */
function sinceOf(c: Context): Seq {
  const query = c.req.query("since");
  if (query !== undefined) {
    if (!/^\d+$/.test(query)) {
      throw new OmniError("bad_request", "since must be a non-negative integer");
    }
    return Number(query);
  }
  const lastEventId = c.req.header(HEADER.lastEventId);
  if (lastEventId !== undefined && /^\d+$/.test(lastEventId)) return Number(lastEventId);
  return 0;
}

/**
 * The body, or a `400`.
 *
 * The content type is checked rather than sniffed: a daemon that accepts a JSON body under
 * `text/plain` is one CSRF-shaped request away from being driven by a form post, and "wrong
 * content type yields 400, never 500" is an acceptance bullet of its own.
 */
async function readJson(c: Context): Promise<unknown> {
  const contentType = c.req.header("content-type") ?? "";
  if (!/^application\/json\s*(;|$)/i.test(contentType.trim())) {
    throw new OmniError("bad_request", "expected content-type: application/json");
  }
  return await c.req.json();
}
