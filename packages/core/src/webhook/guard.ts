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
