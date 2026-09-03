import { OmniError } from "@omni-acp/protocol";
import { Hono } from "hono";
import type { Daemon } from "../types.js";
import { toErrorResponse } from "./errors.js";
import { registerRoutes } from "./routes.js";

/**
 * The HTTP adapter, in full. ZERO business logic (D15 constraint 1).
 *
 * `createDaemon()` imports this statically and `daemon.fetch` is therefore always available,
 * port or no port (D27). Module-graph purity here would be theatre that costs `fetch()` without
 * `start()` — the property the whole route suite is built on.
 */
export function createHttpApp(daemon: Daemon): Hono {
  const app = new Hono();

  // ONE mapper for every failure, wherever it was raised: a route's zod parse, the auth
  // middleware, or the daemon itself (§9).
  app.onError((e) => {
    const { status, body } = toErrorResponse(e);
    return Response.json(body, { status });
  });

  // An unmatched path is a request parameter that names nothing — the same class as an unknown
  // agent id, so the same code (§9, D29). A `404 worker_not_found` here would be a lie about a
  // worker, and no other code in DESIGN §5.4's settled table describes a route.
  app.notFound(() => {
    const { status, body } = toErrorResponse(new OmniError("bad_request", "unknown route"));
    return Response.json(body, { status });
  });

  return registerRoutes(app, daemon);
}
