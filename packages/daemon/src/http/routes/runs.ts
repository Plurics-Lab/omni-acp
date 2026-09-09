import { CreateRunRequest, OmniError, assertRunId } from "@omni-acp/protocol";
import type { Hono } from "hono";
import type { Daemon } from "../../types.js";
import { authMiddleware, authOf } from "../auth-middleware.js";
import { readJson, sinceOf } from "./index.js";
import { sseResponse } from "../sse.js";

/**
 * H25: the Run API (D9, DESIGN §9.3).
 *
 * `…/events?since=` proxies the RUN'S WORKER's log through the SAME `sseResponse` writer every
 * worker stream uses — `daemon/src/http/sse.ts` is byte-identical to M0's and the
 * `sse-is-unchanged` checksum guard says so (Land exit criterion 6). A second stream writer is
 * exactly how two `?since=` implementations start disagreeing.
 *
 * With no `RunRegistry` injected every verb answers `bad_request` naming M2-B-WP-R, which is
 * D29's honest "not implemented yet" rather than a 500.
 *
 * Owned by M2-B-WP-R.
 */
export function registerRunRoutes(app: Hono, daemon: Daemon): void {
  const auth = authMiddleware(daemon);

  app.post("/v1/runs", auth, async (c) => {
    const body = CreateRunRequest.parse(await readJson(c));
    return c.json(await daemon.runs.create(body, authOf(c.req.raw)), 201);
  });

  app.get("/v1/runs", auth, (c) => c.json({ runs: daemon.runs.list(authOf(c.req.raw)) }));

  app.get("/v1/runs/:rid", auth, (c) =>
    c.json(daemon.runs.get(runId(c.req.param("rid")), authOf(c.req.raw))),
  );

  app.post("/v1/runs/:rid/cancel", auth, async (c) =>
    c.json(await daemon.runs.cancel(runId(c.req.param("rid")), authOf(c.req.raw))),
  );

  app.get("/v1/runs/:rid/events", auth, (c) =>
    sseResponse(daemon.runs.logFor(runId(c.req.param("rid")), authOf(c.req.raw)), {
      since: sinceOf(c),
      heartbeatMs: daemon.config.eventLog.sseHeartbeatMs,
      queueSize: daemon.config.eventLog.subscriberQueueSize,
      signal: c.req.raw.signal,
    }),
  );
}

/** The `workerId(c)` of this family: a malformed id is a `400` with the value elided (§9). */
function runId(raw: string | undefined) {
  if (raw === undefined) throw new OmniError("bad_request", "malformed run id");
  return assertRunId(raw);
}
