import { OmniError, type Clock, type PermissionResponder } from "@omni-acp/protocol";

/**
 * D4's hard rules, no rule engine:
 *  1. only ever selects an optionId the agent actually offered
 *  2. allow: session-grant id -> any kind === "allow_once"; NEVER "allow_always"
 *  3. deny: offered kind === "reject_once"
 *  4. nothing acceptable offered => response: null => the caller replies -32603
 *  5. NEVER returns outcome: "cancelled"
 *  6. unknown `kind` is treated as non-grant (fail closed)
 *
 * M0 wires only mode "deny"; "allow" is implemented and unit-tested but unreachable from the
 * wire. Shipping the first remote-execution surface fail-closed is the point, and it leaves M2's
 * policy engine nothing to invent.
 *
 * Required, not optional: the M0 acceptance fixture issues `session/request_permission` mid-turn
 * and awaits it forever, so without a responder `session/prompt` never returns (CONTRACTS.md F1).
 */
export function createBaselineResponder(mode: "allow" | "deny", clock: Clock): PermissionResponder {
  throw new OmniError("internal", "unimplemented: WP-4 (worker.createBaselineResponder)");
}
