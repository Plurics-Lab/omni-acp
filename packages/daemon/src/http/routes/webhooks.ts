import { OmniError, assertDeliveryId } from "@omni-acp/protocol";
import type { Hono } from "hono";
import type { Daemon } from "../../types.js";
import { authMiddleware, authOf } from "../auth-middleware.js";

/**
 * H26: `GET /v1/webhooks/deliveries`, and `POST …/{deliveryId}/redeliver` (D9).
 *
 * The delivery log is admin-or-owner only and cursor-paginated. `redeliver` KEEPS the
 * `deliveryId` — it is the idempotency key a receiver deduplicates on, and minting a new one
 * would turn an operator's retry into a second event.
 *
 * A delivery record never carries the payload's secret, and a secret VALUE never crosses this
 * wire in either direction: a client names a secret, the daemon signs with it.
 *
 * Owned by M2-B-WP-R.
 */
export function registerWebhookRoutes(app: Hono, daemon: Daemon): void {
  const auth = authMiddleware(daemon);

  app.get("/v1/webhooks/deliveries", auth, (c) => {
    void authOf(c.req.raw);
    throw new OmniError("internal", "unimplemented: M2-B-WP-R (delivery listing)");
  });

  app.post("/v1/webhooks/deliveries/:deliveryId/redeliver", auth, (c) => {
    void authOf(c.req.raw);
    void assertDeliveryId(c.req.param("deliveryId") ?? "");
    throw new OmniError("internal", "unimplemented: M2-B-WP-R (redeliver)");
  });
}
