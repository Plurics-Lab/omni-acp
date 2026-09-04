import { LeaseRequestBody, OmniError } from "@omni-acp/protocol";
import type { Context, Hono } from "hono";
import type { Daemon } from "../../types.js";
import { authMiddleware, authOf } from "../auth-middleware.js";
import { workerId } from "./index.js";

/**
 * H17: `POST /v1/workers/{wid}/lease/{acquire|release|steal}` (CONTRACTS.md §16, D5).
 *
 * Three moves per route, like everything else under `http/`: `LeaseRequestBody.parse`, ONE
 * `daemon.workers.lease(...)` call, serialize. The `423 lease_held` body flows through the ONE
 * existing error mapper — `OmniError` carries `lease`, `toBody()` spreads it, and
 * `http/errors.ts` needs no new status logic — which is why there is no error handling here at
 * all.
 *
 * The three operations are three REGISTRATIONS rather than one `:op` parameter. A parameter
 * would have to be validated against a set, and "which of these three words did the caller
 * write" is a decision; three literal paths let the router make it, and an unknown fourth word
 * falls through to `app.notFound()` — the same `400 unknown route` every other unrouted path
 * gets (§9, D29).
 *
 * Owned by M1-WP-D.
 */
export function registerLeaseRoutes(app: Hono, daemon: Daemon): void {
  const auth = authMiddleware(daemon);

  app.post("/v1/workers/:wid/lease/acquire", auth, async (c) =>
    c.json(daemon.workers.lease(workerId(c), authOf(c.req.raw), "acquire", await body(c))),
  );

  app.post("/v1/workers/:wid/lease/release", auth, async (c) =>
    c.json(daemon.workers.lease(workerId(c), authOf(c.req.raw), "release", await body(c))),
  );

  app.post("/v1/workers/:wid/lease/steal", auth, async (c) =>
    c.json(daemon.workers.lease(workerId(c), authOf(c.req.raw), "steal", await body(c))),
  );
}

/**
 * The request body, which is OPTIONAL for all three verbs — `{}` is a complete `acquire` and a
 * complete `release`, and `curl -X POST …/lease/release` with no body at all is the shape an
 * operator actually types.
 *
 * So an empty body is `{}`, and a NON-empty one still has to be `application/json` for the
 * reason `readJson` states: a daemon that accepts a JSON body under `text/plain` is one
 * CSRF-shaped request away from being driven by a form post, and `steal` is precisely the verb
 * you would want to drive that way.
 */
async function body(c: Context): Promise<LeaseRequestBody> {
  const text = await c.req.text();
  if (text.trim() === "") return LeaseRequestBody.parse({});

  // The check `readJson` makes, restated here rather than reused, because `readJson` reads the
  // body itself and this function has already consumed it. `JSON.parse`'s `SyntaxError` reaches
  // the same one mapper and comes back as the same "malformed JSON body" a caller of
  // `POST /v1/workers` would get.
  const contentType = (c.req.header("content-type") ?? "").trim();
  if (!/^application\/json\s*(;|$)/i.test(contentType)) {
    throw new OmniError("bad_request", "expected content-type: application/json");
  }
  return LeaseRequestBody.parse(JSON.parse(text));
}
