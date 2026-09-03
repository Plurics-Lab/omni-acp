import { OmniError } from "@omni-acp/protocol";
import type { MiddlewareHandler } from "hono";
import type { Daemon } from "../types.js";

/**
 * Calls `daemon.authenticate(headers)` and stashes the `AuthContext`. It makes no policy
 * decision of its own — the verdict, the timing-safe comparison and the per-request
 * re-evaluation all live in the daemon (DESIGN §8).
 *
 * `GET /v1/health` is the only route this does not cover.
 */
export function authMiddleware(daemon: Daemon): MiddlewareHandler {
  throw new OmniError("internal", "unimplemented: WP-5 (http.authMiddleware)");
}
