import { OmniError } from "@omni-acp/protocol";

/**
 * `Omni-Signature: t=<unix-seconds>,v1=<hex>` — HMAC-SHA256 over `"<t>.<raw body>"`, through
 * `node:crypto`, which is why D9 needs no new dependency (Land exit criterion 7).
 *
 * The timestamp is INSIDE the signed string, and that is the design: a receiver can then reject a
 * replay by AGE without parsing the JSON first, which is the only order that is safe when the
 * body is attacker-influenced.
 *
 * Owned by M2-B-WP-R.
 */
export function signDelivery(_secret: string, _tsSec: number, _body: string): string {
  throw new OmniError("internal", "unimplemented: M2-B-WP-R");
}
