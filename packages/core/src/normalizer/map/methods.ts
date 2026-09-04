import { OmniError, type OutboundCall, type RuntimeDescriptor } from "@omni-acp/protocol";

/**
 * A canonical (v2) client→agent call → the spelling THIS runtime answers (§17.3).
 *
 * Preference order over SEVERAL spellings per capability, not one name per capability: F18 has
 * `session/set_mode` and `session/set_config_option` both live on one process while
 * `session/set_model` is `-32601`. The first spelling not already known-unsupported wins; a
 * `-32601` marks one unsupported for the life of the process and is never persisted, because a
 * version bump may add it back.
 *
 * Owned by M1-WP-B.
 */
export function mapRequest(
  _method: string,
  _params: Record<string, unknown>,
  _descriptor: RuntimeDescriptor,
  _unsupported: ReadonlySet<string>,
): OutboundCall {
  throw new OmniError("internal", "unimplemented: M1-WP-B");
}
