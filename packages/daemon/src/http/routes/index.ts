import { HEADER, OmniError, assertWorkerId, type Seq } from "@omni-acp/protocol";
import type { Context, Hono } from "hono";
import type { Daemon } from "../../types.js";
import { authMiddleware, authOf } from "../auth-middleware.js";
import { registerAgentRoutes } from "./agents.js";
import { registerLeaseRoutes } from "./lease.js";
import { registerWorkerRoutes } from "./workers.js";

/**
 * Registers H1-H21 of CONTRACTS.md §2.1, in four modules.
 *
 * Every route is exactly three moves: parse with zod, call ONE daemon method, serialize. That is
 * literally satisfiable because `WorkerRegistry` carries the result-returning façade
 * (`snapshot` / `prompt` / `cancel` / `turn` / `logFor`, and from M1 `lease` / `hibernate` /
 * `wake`, review R11); the single exception is `POST /v1/workers`, which serializes `snapshot()`
 * on the handle `create()` just returned — a pure accessor, not a decision.
 *
 * THE SPLIT (M1-PLAN §1.1). `routes.ts` became this directory so that three work packages can
 * add routes without meeting in one file: `workers.ts` and this index are Land-owned and frozen,
 * `lease.ts` is M1-WP-D's, `agents.ts` is M1-WP-E's. Nothing about a route CHANGED in the move —
 * the `http-has-no-logic` guard still covers every file here, recursively.
 *
 * No branching on domain state, no import of `@omni-acp/core`, no `node:child_process` — the
 * guard (CONTRACTS.md §10.2) fails the build on any of those, and a companion test with a
 * recording `stubDaemon()` asserts the one-method rule per route.
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

  registerAgentRoutes(app, daemon);
  registerWorkerRoutes(app, daemon);
  registerLeaseRoutes(app, daemon);

  return app;
}

// The three helpers below are EXPORTED so every route module parses a path parameter, a cursor
// and a body the same way. They live in this index rather than a fifth file because the split
// (M1-PLAN §1.1) names exactly `index.ts` and `workers.ts` as Land-owned; the import edge back
// from `workers.ts` is a module cycle only in the graph sense — every binding it reaches is a
// hoisted function declaration, and route registration happens inside a call, never at load.

/**
 * A malformed id is a request parameter error: `400`, with the value elided (§9, ids.ts).
 *
 * The `?? ""` is not defensive noise: the router types every param as possibly absent, and an
 * empty string is exactly what `assertWorkerId` rejects — so an impossible route match still
 * leaves through the one door instead of an `undefined` reaching the registry.
 */
export function workerId(c: Context) {
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
export function sinceOf(c: Context): Seq {
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
export async function readJson(c: Context): Promise<unknown> {
  const contentType = c.req.header("content-type") ?? "";
  if (!/^application\/json\s*(;|$)/i.test(contentType.trim())) {
    throw new OmniError("bad_request", "expected content-type: application/json");
  }
  return await c.req.json();
}
