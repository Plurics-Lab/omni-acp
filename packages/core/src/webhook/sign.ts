import { createHmac } from "node:crypto";

/**
 * `Omni-Signature: t=<unix-seconds>,v1=<hex>` — HMAC-SHA256 over `"<t>.<raw body>"`, through
 * `node:crypto`, which is why D9 needs no new dependency (Land exit criterion 7).
 *
 * The timestamp is INSIDE the signed string, and that is the design: a receiver can then reject a
 * replay by AGE without parsing the JSON first, which is the only order that is safe when the
 * body is attacker-influenced. 300 s is the recommended window, documented for receivers.
 *
 * The RETURN VALUE is the whole header value, `t=…,v1=…`, not the bare hex. One function
 * therefore owns both halves of the format — a caller cannot assemble the header with a
 * different `t` from the one that was signed, which is the single mistake that makes every
 * signature in a deployment verify against nothing.
 *
 * Owned by M2-B-WP-R.
 */
export function signDelivery(secret: string, tsSec: number, body: string): string {
  const t = Math.floor(tsSec);
  const mac = createHmac("sha256", secret)
    .update(`${String(t)}.${body}`, "utf8")
    .digest("hex");
  return `t=${String(t)},v1=${mac}`;
}

// The VERIFYING half deliberately does not live here. `fakeWebhookReceiver()` re-implements it
// from this comment's description — parse `t` and `v1`, HMAC `"<t>.<body>"`, compare in constant
// time — because a receiver that verified by calling our own signer would agree with us about a
// format we had both got wrong. Two implementations that agree is the assertion; one shared
// function is a tautology (and `@omni-acp/testkit` may not depend on `@omni-acp/core` anyway).
