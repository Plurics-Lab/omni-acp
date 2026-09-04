import {
  OmniError,
  type AgentCapabilitiesSnapshot,
  type RuntimeDescriptor,
} from "@omni-acp/protocol";

/**
 * The `initialize` / `session/new` response → `AgentCapabilitiesSnapshot`, mapped per-field and
 * idempotently on fields that are already v2 (F24). Resolves `resume.method` ONCE from the
 * descriptor's preference order (F18) and captures `modes` / `configOptions`, which
 * `current_mode_update -> config_option_update` cannot be built without.
 *
 * Owned by M1-WP-B (the map) and consumed by M1-WP-C's `handshake.ts`.
 */
export function mapCapabilities(
  _initialize: unknown,
  _sessionBody: unknown,
  _descriptor: RuntimeDescriptor,
): AgentCapabilitiesSnapshot {
  throw new OmniError("internal", "unimplemented: M1-WP-B");
}
