import { ProbeRequestBody } from "@omni-acp/protocol";
import type { Context, Hono } from "hono";
import type { Daemon } from "../../types.js";
import { authMiddleware, authOf } from "../auth-middleware.js";
import { readJson } from "./index.js";

/**
 * The agent catalog and the probe: H4 and H16.
 *
 * H4 `GET /v1/agents` is M0's route, moved here unchanged by the Land-step split (M1-PLAN §1.1)
 * so that M1-WP-E can add `POST /v1/agents/{id}/probe` beside it without editing a frozen file.
 * `args` stay redacted through `redactArgs`, and `probed` is the cached summary or null — the
 * probe result must not become the leak `catalog.ts` closed.
 *
 * H16 is three moves like every other route (D15 constraint 1): parse with zod, call ONE daemon
 * method, serialize. Everything that makes it H16 — `auth.assertAgent(id)` FIRST so a forbidden
 * agent 403s before a process exists, the single throwaway process through `Supervisor.spawn`,
 * the shared in-flight probe, the cache — is `probe-service.ts`'s, behind `catalog.probe`. A
 * route that checked the ACL itself would be the adapter making a policy decision.
 */
export function registerAgentRoutes(app: Hono, daemon: Daemon): void {
  const auth = authMiddleware(daemon);

  // H4.
  app.get("/v1/agents", auth, (c) => c.json({ agents: daemon.catalog.list() }));

  // H16. An empty body is legal — every field of `ProbeRequestBody` is optional — so a bare
  // `POST` with no `content-type` is the common case and must not be a 400.
  app.post("/v1/agents/:id/probe", auth, async (c) =>
    c.json(
      await daemon.catalog.probe(
        c.req.param("id"),
        ProbeRequestBody.parse(await optionalJson(c)),
        authOf(c.req.raw),
      ),
    ),
  );
}

/**
 * The request body, or `{}` when there is none.
 *
 * `readJson` insists on `application/json` (a daemon that accepts a JSON body under
 * `text/plain` is one CSRF-shaped request away from being driven by a form post), and that rule
 * stands. This only says that a probe with NOTHING to configure need not send a body at all —
 * `curl -X POST .../probe` is the shape an operator actually types.
 */
async function optionalJson(c: Context): Promise<unknown> {
  const contentType = c.req.header("content-type");
  if (contentType === undefined || contentType.trim() === "") return {};
  return await readJson(c);
}
