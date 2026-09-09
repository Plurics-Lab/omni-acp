import type { InteractionRecord, ToolCallView, TurnWarning } from "@omni-acp/protocol";

/**
 * §20.6 - the thing that is invisible in the frame.
 *
 * F40: a read-only `ls -A <cwd>` (`kind:"execute"`) ran to `completed` with NO permission request,
 * while `python3 -c ...` in the same cwd raised one. The split is decided inside the host and is
 * not visible anywhere in the `tool_call` frame, so the daemon CANNOT predict which calls will
 * reach the engine.
 *
 * Two consequences, both binding: policy is evaluated on what actually ARRIVES, never on what we
 * expected to arrive; and "no permission request" must never be read as "no tool ran".
 * `PolicyPreset.alertOnUnpoliced` lists the kinds that must never pass unnoticed, and a tool call
 * of a listed kind that never reached the engine becomes
 * `TurnWarning{code:"unpoliced_tool_call", source:"policy"}` on the turn.
 *
 * PURE, and deliberately a fold over what the turn already has: the tool calls it saw and the
 * interactions it recorded. It invents nothing about the agent - it reports a gap between two
 * things we watched.
 *
 * Owned by M2-B-WP-P.
 */
export function unpolicedToolCalls(o: {
  readonly alertOnUnpoliced: readonly string[];
  readonly toolCalls: readonly Pick<ToolCallView, "toolCallId" | "kind">[];
  readonly interactions: readonly Pick<InteractionRecord, "toolCallId">[];
}): readonly TurnWarning[] {
  if (o.alertOnUnpoliced.length === 0) return [];
  const watched = new Set(o.alertOnUnpoliced);
  const policed = new Set(
    o.interactions.map((i) => i.toolCallId).filter((id): id is string => id !== null),
  );

  const out: TurnWarning[] = [];
  const seen = new Set<string>();
  for (const call of o.toolCalls) {
    const kind = call.kind;
    if (kind === null || !watched.has(kind)) continue;
    if (policed.has(call.toolCallId)) continue;
    if (seen.has(call.toolCallId)) continue;
    seen.add(call.toolCallId);
    out.push({
      code: "unpoliced_tool_call",
      message: `a "${kind}" tool call ran without reaching the policy engine`,
      source: "policy",
      detail: { toolCallId: call.toolCallId, kind },
    });
  }
  return out;
}
