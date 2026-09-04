import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A tier-2 fixture agent that REPLAYS a recorded transcript over a REAL pipe, so the corpus also
 * exercises the Supervisor, the frame limiter and the AcpLink — not only the mapper
 * (CONTRACTS.md §5.7, §12.7).
 *
 * That distinction matters more than it looks. Every other corpus test hands `mapUpdate` a
 * JavaScript object that a `JSON.parse` in the test produced; this one makes the same bytes
 * arrive the way they actually arrived — one ndJSON line at a time, through the frame limiter,
 * into the SDK's own client — so a 12.7 KB `available_commands_update` (F13) is a real frame and
 * not a literal.
 *
 * It is driven ENTIRELY by the environment, because a fixture agent's only inputs are its argv
 * and its environment (it is launched as `process.execPath <path>`, never through npx, §6.3):
 *
 *   WIRE_TRANSCRIPT=<name>   required; a name from `transcriptNames()`, e.g. "02-tool-read"
 *   WIRE_SPEED=<factor>      replay speed. 0 (the default) = as fast as the pipe allows, with
 *                            recorded ORDER preserved but not recorded TIMING. 1 = real time.
 *   WIRE_STOP_REASON=<r>     override the recorded prompt response's stop reason.
 *
 * Owned by M1-WP-B.
 */
export function wireAgentPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/wire-agent.js -> <package root>/fixtures/agents/wire.mjs
  return join(here, "..", "fixtures", "agents", "wire.mjs");
}
