import { OmniError, type RuntimeDescriptor } from "@omni-acp/protocol";

/**
 * The vendor-extension registry (§17.3): which `_meta` pointers this runtime promotes into typed
 * slots, and which method spellings it has been PROVEN to answer.
 *
 * It learns from `-32601` per process and never from message text (F17). Registrations are keyed
 * by descriptor, so a compatible fork is a new descriptor rather than new code.
 *
 * Owned by M1-WP-E; consumed by M1-WP-B's map.
 */
export interface VendorRegistry {
  /** The spellings to try, in order, minus everything this process has proven unsupported. */
  spellingsFor(capability: "resume" | "setConfig" | "list" | "close"): readonly string[];
  /** Record a `-32601`. Process-local: never persisted, because a version bump may add it back. */
  noteUnsupported(method: string): void;
  readonly unsupported: ReadonlySet<string>;
}

export function createVendorRegistry(_descriptor: RuntimeDescriptor): VendorRegistry {
  throw new OmniError("internal", "unimplemented: M1-WP-E");
}
