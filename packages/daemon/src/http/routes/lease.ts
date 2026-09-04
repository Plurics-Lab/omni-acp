import type { Hono } from "hono";
import type { Daemon } from "../../types.js";

/**
 * H17: `POST /v1/workers/{wid}/lease/{acquire|release|steal}` (CONTRACTS.md §16, D5).
 *
 * Three lines when it lands — `LeaseRequestBody.parse`, `daemon.workers.lease(...)`, serialize —
 * because the `423 lease_held` body flows through the ONE existing error mapper: `OmniError`
 * carries `lease`, `toBody()` spreads it, and `http/errors.ts` needs no new status logic.
 *
 * It registers NOTHING yet, deliberately. A stub that threw would be reached by
 * `createHttpApp()` on every daemon this repository builds; a stub that registered a throwing
 * route would answer `500` where the daemon's honest answer today is `400 unknown route`, which
 * is what an unimplemented route IS (§9, D29).
 *
 * Owned by M1-WP-D.
 */
export function registerLeaseRoutes(_app: Hono, _daemon: Daemon): void {
  // Intentionally empty until M1-WP-D. See the doc comment: the route family is wired into
  // `registerRoutes` NOW so that landing it is an edit to this file alone.
}
