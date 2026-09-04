import { CreateWorkerRequest, PromptRequestBody, assertTurnId } from "@omni-acp/protocol";
import type { Hono } from "hono";
import type { Daemon } from "../../types.js";
import { authMiddleware, authOf } from "../auth-middleware.js";
import { sseResponse } from "../sse.js";
import { readJson, sinceOf, workerId } from "./index.js";

/**
 * H5-H12: the worker lifecycle. Land-owned and frozen for the whole of M1 (M1-PLAN §1.1), so
 * that the lease and agent route families can land beside it without a merge conflict.
 *
 * Same three moves as everything else under `http/`: parse, ONE daemon call, serialize.
 */
export function registerWorkerRoutes(app: Hono, daemon: Daemon): void {
  const auth = authMiddleware(daemon);

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

  // H18. `200 WorkerSnapshot{state:"hibernated"}`. Every other answer — `409 worker_busy` while a
  // turn is live, `422 not_resumable`, `423 lease_held`, `429 worker_limit` — is an `OmniError`
  // the registry throws and the ONE error mapper turns into a status (§9, D15).
  app.post("/v1/workers/:wid/hibernate", auth, async (c) =>
    c.json(await daemon.workers.hibernate(workerId(c), authOf(c.req.raw))),
  );

  // H19. Same shape: `200 WorkerSnapshot`, and `429` / `422` / `502` / `504` arrive as codes.
  app.post("/v1/workers/:wid/wake", auth, async (c) =>
    c.json(await daemon.workers.wake(workerId(c), authOf(c.req.raw))),
  );
}
