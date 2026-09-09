import { OmniError } from "@omni-acp/protocol";
import type { PermissionOption } from "@omni-acp/protocol";
import type { ScriptedAgent } from "../scripted-agent.js";

/**
 * A `session/request_permission` with an arbitrary `options` menu, including menus no real agent
 * sends — the empty one, the unknown-kind-only one, and the `allow_always`-only one whose correct
 * answer is `-32603` (D4 rules 3 and 4, F26).
 *
 * Owned by M2-B-WP-P.
 */
export function permissionScript(
  _a: ScriptedAgent,
  _offered: readonly PermissionOption[],
): Promise<string | null> {
  throw new OmniError("internal", "unimplemented: M2-B-WP-P");
}
