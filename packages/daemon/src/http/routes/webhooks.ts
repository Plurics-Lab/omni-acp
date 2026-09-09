import { OmniError, assertDeliveryId, assertRunId } from "@omni-acp/protocol";
import type {
  DeliveryListResponse,
  DeliveryRecord,
  DeliveryStore,
  RunId,
  TokenId,
} from "@omni-acp/protocol";
import type { Hono } from "hono";
import type { Daemon } from "../../types.js";
import { authMiddleware, authOf } from "../auth-middleware.js";

/**
 * `DeliveryStore`, with the one filter §24.5 needs and the frozen seam does not carry.
 *
 * "admin **or the owning token** only" is a FILTER, and the route is the only place that knows
 * which token is asking. Applying it after the fact — fetching a page and dropping rows the
 * caller may not see — would page wrongly: a page of 50 filtered down to 3 is not a page of 3,
 * and the cursor would silently skip everything it dropped. So the predicate goes into the query,
 * through a widened parameter every store this daemon installs honours, and each verb stays
 * `parse → ONE daemon call → serialize` (D15 constraint 1).
 *
 * `tokenId` is OPTIONAL and means "no scope" — which is admin. Making the scope explicit at the
 * call site rather than implicit in a second method is what keeps the two verbs' rules identical:
 * a row a token may not LIST is a row it may not REPLAY — and `WebhookDispatcher.redeliver` takes
 * the same optional `tokenId` for that reason, so the REPLAY half of the rule lives on the one
 * object that also re-runs the SSRF gate (review finding V1).
 *
 * It is declared HERE, in the route that uses it, because `http-has-no-logic` allows this layer
 * `@omni-acp/protocol` and its own siblings and nothing else — and a type describing what a route
 * needs belongs beside the route rather than in a module the route may not import.
 */
interface OwnerScopedDeliveryStore extends DeliveryStore {
  list(o: { runId?: RunId; state?: string; limit: number; cursor?: string; tokenId?: TokenId }): {
    rows: readonly DeliveryRecord[];
    cursor: string | null;
  };
}

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
    const who = authOf(c.req.raw);
    const store = daemon.deliveries as OwnerScopedDeliveryStore;
    const runId = c.req.query("runId");
    const state = c.req.query("state");
    const cursor = c.req.query("cursor");

    const page = store.list({
      // D13's rule, unchanged: admin sees all, everybody else sees their own token's.
      ...(who.role === "admin" ? {} : { tokenId: who.tokenId }),
      ...(runId === undefined ? {} : { runId: assertRunId(runId) }),
      ...(state === undefined ? {} : { state }),
      ...(cursor === undefined ? {} : { cursor }),
      limit: limitOf(c.req.query("limit")),
    });
    const body: DeliveryListResponse = { deliveries: page.rows, cursor: page.cursor };
    return c.json(body);
  });

  /**
   * The replay goes through the DISPATCHER, never through the store (review finding V1).
   *
   * `WebhookDispatcher.redeliver` is the one code path that re-runs `assertWebhookUrl` before a
   * replay; the store's own `redeliver` only flips the row back to `pending`, after which the
   * background poll POSTs it. An operator replaying a dead letter hours or days later would
   * otherwise re-send to a host whose name now resolves into `denyCidrs` — with the create-time
   * check the only one that had ever run — which is exactly what §24.6 exists to stop.
   *
   * Still `parse → ONE daemon call → serialize`: the admin-or-owner scope rides on the call as
   * `tokenId`, and `undefined` is admin, which is the same spelling `list` above uses.
   */
  app.post("/v1/webhooks/deliveries/:deliveryId/redeliver", auth, async (c) => {
    const who = authOf(c.req.raw);
    return c.json(
      await daemon.dispatcher.redeliver(
        assertDeliveryId(c.req.param("deliveryId") ?? ""),
        who.role === "admin" ? undefined : who.tokenId,
      ),
    );
  });
}

/** `limit`, parsed once and clamped by the store. A malformed one is a `bad_request`, not a guess. */
function limitOf(raw: string | undefined): number {
  if (raw === undefined) return 50;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new OmniError("bad_request", "malformed limit");
  return n;
}
