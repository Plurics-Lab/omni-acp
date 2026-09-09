import { OmniError } from "@omni-acp/protocol";
import type { McpResolution, McpServerPreset } from "@omni-acp/protocol";

/**
 * `mcpCapabilities` filtering — and the one rule that is easy to get backwards.
 *
 * **stdio is NEVER filtered.** v1 has no stdio bit at all, and codex advertises
 * `{acp:false, http:true, sse:false}` while happily taking stdio servers. Filtering on the absent
 * bit would drop every stdio preset from the agent that uses them most.
 *
 * Whether an ABSENT capability block means "everything" or "nothing" is decided from the
 * DESCRIPTOR (`toleratesOmittedMcpCapabilities`), never from an agent-id branch —
 * `descriptor-is-the-only-branch` is the guard.
 *
 * An unusable `http` preset is NOT an error: it lands as `applied:[] / dropped:[{name, reason}]`
 * on the snapshot plus a `TurnWarning`, because a capability the client did not get is something
 * to report, not something to fail a worker over.
 *
 * Owned by M2-B-WP-S.
 */
export function filterMcpCapabilities(_o: {
  presets: readonly { name: string; server: McpServerPreset }[];
  caps: Readonly<Record<string, unknown>> | null;
  tolerateOmitted: boolean;
}): McpResolution {
  throw new OmniError("internal", "unimplemented: M2-B-WP-S");
}
