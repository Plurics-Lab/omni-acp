import { OmniError } from "@omni-acp/protocol";
import type { McpResolution, ResolvedDaemonConfig, RuntimeDescriptor } from "@omni-acp/protocol";

/**
 * The daemon half of MCP presets: names → resolved servers → capability filter, and the two error
 * statuses a client can actually receive.
 *
 * `400` NAMING an unknown preset; `403` for one outside the token's `mcpPresets`, which defaults
 * to `[]` and not `"*"` because an MCP server is arbitrary code on this machine (DESIGN §8's 🔴).
 * A preset the AGENT cannot take is neither: it lands as `dropped` on the snapshot with a
 * `TurnWarning`, because that is a capability the client did not get rather than a request it got
 * wrong.
 *
 * Owned by M2-B-WP-S.
 */
export function resolveMcpForWorker(_o: {
  names: readonly string[] | undefined;
  config: ResolvedDaemonConfig;
  allow: readonly string[] | "*";
  descriptor: RuntimeDescriptor;
  caps: Readonly<Record<string, unknown>> | null;
}): McpResolution {
  throw new OmniError("internal", "unimplemented: M2-B-WP-S");
}
