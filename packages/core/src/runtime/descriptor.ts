import {
  OmniError,
  type AgentDescriptor,
  type RuntimeDescriptor,
  type RuntimeOverlay,
} from "@omni-acp/protocol";

/**
 * `sha256` over command ⊕ args ⊕ descriptor version ⊕ `agentInfo.name`/`version` — the cache and
 * audit key that invalidates a probe when the thing being probed changed (CONTRACTS.md §17.2).
 *
 * Owned by M1-WP-E.
 */
export function descriptorFingerprint(
  _d: AgentDescriptor,
  _agentInfo?: { name?: string; version?: string },
): string {
  throw new OmniError("internal", "unimplemented: M1-WP-E");
}

/**
 * Validate a merged descriptor and reject the shapes §14.6 forbids — notably an `UpdateRule` of
 * `stream:false, store:true`, which would make two subscribers disagree about the log.
 *
 * Owned by M1-WP-E.
 */
export function assertDescriptorLegal(_d: RuntimeDescriptor): void {
  throw new OmniError("internal", "unimplemented: M1-WP-E");
}

/** The typed shape an operator's `agents[].runtime` block resolves to. */
export type ResolvedRuntimeOverlay = RuntimeOverlay;
