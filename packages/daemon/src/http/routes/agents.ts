import type { Hono } from "hono";
import type { Daemon } from "../../types.js";
import { authMiddleware, authOf } from "../auth-middleware.js";

/**
 * The agent catalog and the probe: H4 and H16.
 *
 * H4 `GET /v1/agents` is M0's route, moved here unchanged by the Land-step split (M1-PLAN §1.1)
 * so that M1-WP-E can add `POST /v1/agents/{id}/probe` beside it without editing a frozen file.
 * `args` stay redacted through `redactArgs`, and `probed` is the cached summary or null — the
 * probe result must not become the leak `catalog.ts` closed.
 *
 * H16 is M1-WP-E's: `auth.assertAgent(id)` FIRST, so a forbidden agent 403s before a process
 * exists, then ONE throwaway process through `Supervisor.spawn`. It is not registered yet, for
 * the reason spelled out in `lease.ts`.
 */
export function registerAgentRoutes(app: Hono, daemon: Daemon): void {
  const auth = authMiddleware(daemon);

  // H4.
  app.get("/v1/agents", auth, (c) => c.json({ agents: daemon.catalog.list() }));

  // H16 lands here (M1-WP-E). `authOf` is imported because that route reads the AuthContext for
  // `assertAgent`, and an unused import is the kind of thing a rebase silently deletes.
  void authOf;
}
