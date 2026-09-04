import { OmniError, type ExtensionPath } from "@omni-acp/protocol";

/**
 * Read a descriptor-registered vendor field out of an update's `_meta` by RFC-6901 pointer
 * (CONTRACTS.md §17.3, §12.5). `~1` escapes a "/" inside a key. Returns `undefined` when the
 * pointer does not resolve — a missing vendor field is normal, not an error.
 *
 * Owned by M1-WP-E.
 */
export function readExtension(_meta: unknown, _path: ExtensionPath): unknown {
  throw new OmniError("internal", "unimplemented: M1-WP-E");
}
