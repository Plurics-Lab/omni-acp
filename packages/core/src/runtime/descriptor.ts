import { createHash } from "node:crypto";
import {
  OmniError,
  type AgentDescriptor,
  type RuntimeDescriptor,
  type RuntimeOverlay,
  type UpdateRule,
} from "@omni-acp/protocol";

/**
 * The hashing SCHEME's own version.
 *
 * It is inside the hashed material rather than beside it so that changing what a fingerprint is
 * computed over invalidates every cached probe by construction. Without it, a scheme change
 * would leave stale `<dataDir>/probes/<id>.json` files that hash-match under the OLD rule and
 * are therefore served as if they described the current agent.
 */
const FINGERPRINT_SCHEME = 1;

/**
 * `sha256` over command ⊕ args ⊕ descriptor version ⊕ `agentInfo.name`/`version` — the cache and
 * audit key that invalidates a probe when the thing being probed changed (CONTRACTS.md §17.2).
 *
 * Three properties this has to keep, and each is a decision:
 *
 *  - **The REAL args, never `redactArgs`.** `--api-key sk-A` and `--api-key sk-B` launch two
 *    different agents; redacting first would collapse them to one cache entry and serve B the
 *    capabilities we learned from A. The digest is one-way, so no credential leaves this
 *    function — and `AgentCatalogEntry.runtimeId` publishes only the first 12 hex characters.
 *  - **Order-preserving and unambiguous.** The inputs are hashed as a JSON array with an
 *    explicit field order, so `["--a", "b"]` and `["--a b"]` cannot produce the same digest the
 *    way a naive `join(" ")` would.
 *  - **`agentInfo` is OPTIONAL and absent is not the same as empty.** Before the first probe
 *    there is no `agentInfo` at all, and that state hashes to something different from a probe
 *    that came back with a nameless agent.
 *
 * The operator's `runtime` overlay is deliberately NOT part of it: the fingerprint answers "is
 * this still the same program?", which is what a probe result is a claim about. A quirk edit
 * changes how we TALK to that program, is visible in `RuntimeDescriptor.source`, and re-probing
 * on every quirk edit would throw away a cache entry for a reason unrelated to it.
 */
export function descriptorFingerprint(
  d: AgentDescriptor,
  agentInfo?: { name?: string; version?: string },
): string {
  const material = JSON.stringify([
    FINGERPRINT_SCHEME,
    d.command,
    [...d.args],
    d.protocolVersion,
    agentInfo === undefined ? null : [agentInfo.name ?? null, agentInfo.version ?? null],
  ]);
  return createHash("sha256").update(material, "utf8").digest("hex");
}

/**
 * The short form published in `AgentCatalogEntry.runtimeId`.
 *
 * Twelve hex characters — 48 bits — is a display id, not a security boundary: it names which
 * descriptor governed a worker in a log line an operator reads, and the full digest stays in the
 * probe cache for anyone who needs to compare exactly.
 */
export function runtimeIdOf(agentId: string, fingerprint: string): string {
  return `${agentId}@${fingerprint.slice(0, 12)}`;
}

/**
 * `stream:false, store:true` is the shape §14.6 forbids: an envelope that consumes a `seq` but is
 * withheld from the live tail makes `?since=N` deliver a gap the client cannot tell from loss,
 * and two subscribers who reconnect at different times disagree about the log. The legal shapes
 * are stream+store, or drop (neither).
 *
 * `digest` without `store` is rejected for the adjacent reason: a digest is an instruction about
 * HOW to store, so a rule that digests what it never stores is a typo, and a silently ignored
 * typo in a descriptor is how an operator comes to believe a knob is on.
 */
export function assertDescriptorLegal(d: RuntimeDescriptor): void {
  for (const [kind, rule] of Object.entries(d.updates)) {
    assertUpdateRuleLegal(kind, rule);
  }
}

export function assertUpdateRuleLegal(kind: string, rule: UpdateRule): void {
  if (!rule.stream && rule.store) {
    throw new OmniError(
      "bad_request",
      `updates.${kind}: {stream:false, store:true} is forbidden — an envelope withheld from the ` +
        `live tail but present in ?since= makes two subscribers disagree about the log ` +
        `(CONTRACTS.md §14.6). Use {stream:true, store:true} to keep it, or ` +
        `{stream:false, store:false} to drop it before append.`,
    );
  }
  if (rule.digest && !rule.store) {
    throw new OmniError(
      "bad_request",
      `updates.${kind}: {digest:true, store:false} digests a payload that is never stored`,
    );
  }
}

/** The typed shape an operator's `agents[].runtime` block resolves to. */
export type ResolvedRuntimeOverlay = RuntimeOverlay;
