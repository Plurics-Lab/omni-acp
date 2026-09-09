import { SetConfigBody } from "@omni-acp/protocol";
import type { Hono } from "hono";
import type { Daemon } from "../../types.js";
import { authMiddleware, authOf } from "../auth-middleware.js";
import { readJson, workerId } from "./index.js";

/**
 * H24: `POST /v1/workers/{wid}/config` → `session/set_config_option` (§22).
 *
 * One option per call, mirroring the agent method. The body names `configId` — the REQUEST
 * spelling (F34) — and the descriptor's `configIdField` quirk decides what actually reaches
 * the wire, so neither this file nor the worker names a spelling.
 *
 * Every other answer is an `OmniError` from the registry: `409 worker_busy` while a turn is live,
 * `423` without the lease or with a stale epoch, and `502` carrying the agent's `-32603`
 * `data.details` verbatim for a bad value.
 *
 * Owned by M2-A-WP-C.
 */
export function registerConfigRoutes(app: Hono, daemon: Daemon): void {
  const auth = authMiddleware(daemon);

  app.post("/v1/workers/:wid/config", auth, async (c) => {
    const body = SetConfigBody.parse(await readJson(c));
    return c.json(await daemon.workers.setConfig(workerId(c), authOf(c.req.raw), body));
  });
}
