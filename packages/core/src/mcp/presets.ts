import { OmniError } from "@omni-acp/protocol";
import type { McpServerPreset, ResolvedDaemonConfig } from "@omni-acp/protocol";

/**
 * Preset NAMES → resolved server objects. The one place a client's `mcp: string[]` becomes a
 * command line, and it reads that command line from CONFIG and from nowhere else (DESIGN §8's
 * 🔴).
 *
 * An unknown name is `400` NAMING it; a name outside the token's `mcpPresets` allowlist is `403`.
 * Never a silent drop: a client that believes a tool is available and is not will spend a whole
 * turn discovering it, and the agent will explain the failure in prose we are forbidden to parse.
 *
 * Owned by M2-B-WP-S.
 */
export function resolveMcpPresets(
  _names: readonly string[],
  _cfg: ResolvedDaemonConfig,
  _allow: readonly string[] | "*",
): readonly { name: string; server: McpServerPreset }[] {
  throw new OmniError("internal", "unimplemented: M2-B-WP-S");
}
