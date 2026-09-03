import { OmniError } from "@omni-acp/protocol";
import type { MiddlewareHandler } from "hono";
import type { AuthContext, Daemon } from "../types.js";

/**
 * The `AuthContext` for the request being served, keyed by the `Request` itself.
 *
 * A `WeakMap` rather than Hono's context variables so this file needs no generic `Env` and the
 * routes stay plain `Hono` — the entry is collected with the request, and one request's verdict
 * can never be read by another.
 */
const CONTEXTS = new WeakMap<Request, AuthContext>();

/**
 * Calls `daemon.authenticate(headers)` and stashes the `AuthContext`. It makes no policy
 * decision of its own — the verdict, the timing-safe comparison and the per-request
 * re-evaluation all live in the daemon (DESIGN §8).
 *
 * `GET /v1/health` is the only route this does not cover.
 */
export function authMiddleware(daemon: Daemon): MiddlewareHandler {
  return async (c, next) => {
    CONTEXTS.set(c.req.raw, daemon.authenticate(c.req.raw.headers));
    await next();
  };
}

/**
 * The verdict this request already got. A miss means the route was registered without the
 * middleware, which is a wiring bug — and the fail-closed answer to a wiring bug on an
 * authenticated route is `unauthorized`, not "carry on".
 */
export function authOf(req: Request): AuthContext {
  const auth = CONTEXTS.get(req);
  if (auth === undefined) throw new OmniError("unauthorized", "missing Authorization header");
  return auth;
}
