import { OmniError } from "@omni-acp/protocol";
import type { PermissionOption } from "@omni-acp/protocol";
import type { ScriptedAgent } from "../scripted-agent.js";

/**
 * A `session/request_permission` with an arbitrary `options` menu, including menus no real agent
 * sends — the empty one, the unknown-kind-only one, and the `allow_always`-only one whose correct
 * answer is `-32603` (D4 rules 3 and 4, F26).
 *
 * It goes through the GENERIC client-request hook rather than `ScriptedAgent.requestPermission`
 * for one reason: that verb folds every JSON-RPC error into `{error: code}` after mapping a
 * `cancelled` outcome onto the same shape, and the whole point here is to tell `-32603` (rule 4's
 * only correct answer) apart from every other way an answer can be wrong. `params` therefore
 * reaches the wire untouched, exactly as `elicitationScript`'s does.
 *
 * Resolves with the selected option id, or `null` for rule 4's `-32603`. Any OTHER answer —
 * another error code, a `cancelled` outcome (rule 5), a shape we cannot read — throws, because a
 * fixture that quietly turned a rule violation into `null` would make every caller agree with it.
 *
 * Owned by M2-B-WP-P.
 */
export function permissionScript(
  a: ScriptedAgent,
  offered: readonly PermissionOption[],
): Promise<string | null> {
  const sessionId = a.sessionIds.at(-1);
  if (sessionId === undefined) {
    throw new OmniError("internal", "permissionScript: the agent has opened no session yet");
  }
  const toolCallId = `call_${String(a.sessionIds.length)}_${String(offered.length)}`;

  return a
    .request("session/request_permission", {
      sessionId,
      // v1's shape (§12.6): `{sessionId, toolCall, options}`. The normalizer is what turns it
      // into v2's tagged subject before any rule sees it (ruling M1-R14).
      toolCall: {
        toolCallId,
        title: "Write src/main.ts",
        kind: "edit",
        locations: [{ path: "src/main.ts" }],
      },
      options: [...offered],
    })
    .then((answer) => {
      if ("error" in answer) {
        // D4 rule 4: the ONE error a correct client may answer with.
        if (answer.error === -32603) return null;
        throw new OmniError(
          "internal",
          `permissionScript: the client answered JSON-RPC ${String(answer.error)}, and rule 4 permits only -32603`,
        );
      }
      const outcome = (answer.result as { outcome?: { outcome?: unknown; optionId?: unknown } })
        .outcome;
      if (outcome?.outcome === "cancelled") {
        // D4 rule 5: cancelling kills the whole prompt turn rather than this one action.
        throw new OmniError("internal", "permissionScript: the client cancelled the turn (rule 5)");
      }
      if (outcome?.outcome !== "selected" || typeof outcome.optionId !== "string") {
        throw new OmniError(
          "internal",
          `permissionScript: unreadable answer ${JSON.stringify(answer.result)}`,
        );
      }
      return outcome.optionId;
    });
}
