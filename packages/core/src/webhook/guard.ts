import { OmniError } from "@omni-acp/protocol";
import type { ResolvedWebhookConfig, Resolver } from "@omni-acp/protocol";

/**
 * The SSRF gate on the daemon's FIRST OUTBOUND SURFACE — and the URL comes from a client.
 *
 * Two controls, in order. The ALLOWLIST is primary: exact scheme+host+port, no wildcards,
 * `mode:"allowlist"` with an empty `allow` refusing everything until an operator names an origin.
 * The CIDR check over EVERY resolved address is defence in depth against DNS rebinding — a
 * hostname that resolves into `169.254.0.0/16` is the cloud metadata endpoint whatever the
 * allowlist says.
 *
 * The CIDR check is ABSOLUTE: an entry in `allow` does NOT exempt an address from `denyCidrs`
 * (review R16). The two controls answer different questions — "may this ORIGIN be called" and
 * "may this ADDRESS be called" — and an allowlist entry that lifted the SSRF gate would make
 * `webhooks.allow` the one config line that turns the daemon into a proxy for the metadata
 * endpoint. The consequence is stated rather than discovered: a LOOPBACK receiver needs
 * `denyCidrs: []`, which is why the acceptance script, `run-webhook.itest.ts` and the CI matrix
 * all set it, and why the deny-CIDR fixture uses `169.254.169.254` rather than `127.0.0.1`.
 *
 * It runs at CREATE, so the `403` reaches the operator where they can act on it, not at delivery
 * time in a background dispatcher's log (§24.6).
 *
 * Owned by M2-B-WP-R.
 */
export function assertWebhookUrl(
  _raw: string,
  _cfg: ResolvedWebhookConfig,
  _resolve: Resolver,
): Promise<URL> {
  throw new OmniError("internal", "unimplemented: M2-B-WP-R");
}
