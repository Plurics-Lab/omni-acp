import { filterMcpCapabilities, resolveMcpPresets } from "@omni-acp/core";
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
 * THE COMMAND COMES FROM `config`, AND FROM NOWHERE ELSE. Nothing in this module reads a request
 * body: its only client-supplied input is `names`, whose type is `string[]` on both
 * `CreateWorkerRequest` and `CreateRunRequest`. That is the second half of the
 * `client-never-sends-a-command` guard — the first being the type itself — and it is why this
 * function takes a `ResolvedDaemonConfig` rather than anything shaped like a preset.
 *
 * Owned by M2-B-WP-S.
 */
export function resolveMcpForWorker(o: {
  names: readonly string[] | undefined;
  config: ResolvedDaemonConfig;
  allow: readonly string[] | "*";
  descriptor: RuntimeDescriptor;
  caps: Readonly<Record<string, unknown>> | null;
}): McpResolution {
  // A request that named no preset resolves to nothing, and it must not touch the config at all
  // — that is every M1 request, and `session/new{mcpServers: []}` is what M1 sent.
  const names = o.names ?? [];
  if (names.length === 0) {
    return { servers: [], applied: [], dropped: [], warnings: [] };
  }

  // Step 1 THROWS (400 / 403); step 2 never does. The split is the whole error model of §23:
  // what the CLIENT got wrong is an error, and what the AGENT cannot host is a report.
  const presets = resolveMcpPresets(names, o.config, o.allow);

  return filterMcpCapabilities({
    presets,
    // The agent's verbatim `agentCapabilities` (or a probe's), from which `filterMcpCapabilities`
    // reads whichever spelling this protocol version used. `null` is "we have not handshaken
    // yet", which is a DIFFERENT thing from an agent that declared an empty block, and only the
    // descriptor decides what to do about it.
    caps: o.caps,
    // FROM THE DESCRIPTOR, never from an agent id (§17.1). `descriptor-is-the-only-branch` is
    // the guard, and this line is the reason it can stay true: teaching the daemon that a new
    // runtime accepts http servers without declaring the block is a descriptor edit.
    tolerateOmitted: o.descriptor.quirks.toleratesOmittedMcpCapabilities,
  });
}
