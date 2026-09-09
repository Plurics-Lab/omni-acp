import { InteractionAnswerBody, assertInteractionId } from "@omni-acp/protocol";
import type { Hono } from "hono";
import type { Daemon } from "../../types.js";
import { authMiddleware, authOf } from "../auth-middleware.js";
import { readJson, workerId } from "./index.js";

/**
 * H22 / H23: `GET|POST /v1/workers/{wid}/interactions[/{reqId}]` (§19).
 *
 * The same three moves as everything else under `http/`: parse, ONE daemon call, serialize. The
 * §19.6 status table — visibility → state → existence → lease → shape → semantics → deliver — is
 * the REGISTRY's and the handle's, in that order, and every row of it arrives here as an
 * `OmniError` the one mapper turns into a status. That ordering is why a worker this token cannot
 * see is a `404` and not a `423`: existence must never leak through a lease check.
 *
 * `GET` is UNGATED (rule L2): reading the pending set is an observer's right, and a lease governs
 * who may ANSWER.
 *
 * Owned by M2-A-WP-I. (`routes/index.ts` and `routes/workers.ts` stay Land-frozen; each feature
 * adds its OWN module beside them, which is M1's routes split reused unchanged.)
 */
export function registerInteractionRoutes(app: Hono, daemon: Daemon): void {
  const auth = authMiddleware(daemon);

  // H23.
  app.get("/v1/workers/:wid/interactions", auth, (c) =>
    c.json(daemon.workers.interactions(workerId(c), authOf(c.req.raw))),
  );

  // H22.
  app.post("/v1/workers/:wid/interactions/:reqId", auth, async (c) => {
    const body = InteractionAnswerBody.parse(await readJson(c));
    return c.json(
      daemon.workers.answer(
        workerId(c),
        authOf(c.req.raw),
        assertInteractionId(c.req.param("reqId")),
        body,
      ),
    );
  });
}
