import { OmniError, assertDeliveryId, assertRunId } from "@omni-acp/protocol";
import type {
  DeliveryId,
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
 * a row a token may not LIST is a row it may not REPLAY.
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
  redeliver(id: DeliveryId, nowMs: number, tokenId?: TokenId): DeliveryRecord;
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

  app.post("/v1/webhooks/deliveries/:deliveryId/redeliver", auth, (c) => {
    const who = authOf(c.req.raw);
    const store = daemon.deliveries as OwnerScopedDeliveryStore;
    return c.json(
      store.redeliver(
        assertDeliveryId(c.req.param("deliveryId") ?? ""),
        // The wall clock, read here because nothing on the `Daemon` contract exposes the injected
        // one and a route may not import the library that owns it. `redeliver` schedules the row
        // for "now"; a millisecond of skew moves nothing that matters.
        Date.now(),
        ...(who.role === "admin" ? [] : [who.tokenId]),
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
