import { OmniError } from "@omni-acp/protocol";

/**
 * The two vendor dialects M1 knows how to read, both from claude-acp's `_meta` (§12.5, F19/F20):
 *
 *  - `claude_structured_patch` — `_meta.claudeCode.toolResponse.{structuredPatch, originalFile,
 *    content}`, which reconstructs a patch `git apply --check` accepts, surfaced as
 *    `TurnResult.vendorPatch` and NEVER as `TurnResult.patch` (D8, ruling M1-R11). `null` rather
 *    than wrong when the hunk line counts disagree with `oldLines`/`newLines`.
 *  - `claude_rate_limit` — `usage_update._meta["_claude/rateLimit"]`, the structured signal
 *    DESIGN §6.2's "`end_turn` ≠ success" needs. It arrives BEFORE the failure and is not
 *    stderr text.
 *
 * Owned by M1-WP-B.
 */
export function readStructuredPatch(
  _meta: unknown,
): { format: "git_patch"; text: string; source: string } | null {
  throw new OmniError("internal", "unimplemented: M1-WP-B");
}

export function readRateLimit(_meta: unknown): Readonly<Record<string, unknown>> | null {
  throw new OmniError("internal", "unimplemented: M1-WP-B");
}
