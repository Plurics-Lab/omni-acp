import type {
  MappedPermissionRequest,
  PermissionOption,
  RuntimeDescriptor,
} from "@omni-acp/protocol";
import { record, str, type Json } from "./json.js";

/**
 * The offered options, defensively narrowed.
 *
 * `PermissionOptionKind` is a closed enum in the schema, and D4 rule 6 requires an UNKNOWN kind
 * to survive far enough to be treated as a non-grant — so the shape check is structural and the
 * option objects are passed through BY IDENTITY. The field is `optionId`, not `id` (corpus
 * finding 5), and the three observed options pass through untouched, in order.
 */
function options(raw: unknown): readonly PermissionOption[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (o): o is PermissionOption =>
      typeof o === "object" &&
      o !== null &&
      typeof (o as { optionId?: unknown }).optionId === "string" &&
      typeof (o as { kind?: unknown }).kind === "string",
  );
}

/**
 * `title`, in the EVIDENCE order §12.6 fixes, never empty because v2 requires a string:
 *
 *   1. `_meta.permission.title` — present on BOTH observed requests, and the agent's own
 *      human-facing label for the action.
 *   2. `toolCall.title` — the schema'd field.
 *   3. a constructed `"<kind>: <name|toolCallId>"`, which is the last thing that is still TRUE
 *      about the request rather than a placeholder.
 *
 * The order matters for a policy engine, not just for a UI: `title` is what
 * `omni.policy_decision` records and therefore what an audit reads back (review R9).
 */
function titleOf(request: Json, toolCall: Json | null): string {
  const fromMeta = str(record(record(request["_meta"])?.["permission"])?.["title"]);
  if (fromMeta !== null && fromMeta !== "") return fromMeta;

  const top = str(request["title"]);
  if (top !== null && top !== "") return top;

  const fromToolCall = toolCall === null ? null : str(toolCall["title"]);
  if (fromToolCall !== null && fromToolCall !== "") return fromToolCall;

  if (toolCall === null) return "permission request";
  const kind = str(toolCall["kind"]) ?? "tool_call";
  const what = str(toolCall["name"]) ?? str(toolCall["toolCallId"]);
  return what === null ? kind : `${kind}: ${what}`;
}

/**
 * v1 `{sessionId, toolCall, options, _meta}` → v2 `{sessionId, title, subject, options, _meta}`
 * (CONTRACTS.md §12.6), and the RESPONDER RECEIVES THE MAPPED FORM (ruling M1-R14).
 *
 * PURE and IDEMPOTENT: a request that already carries a v2 `subject` comes back with that
 * subject BY IDENTITY, so `map(map(x))` is `map(x)`. `toolCall` is passed BY IDENTITY into the
 * subject, so `kind` / `locations` / `content` / `rawInput` — what M2's rule engine matches on —
 * arrive unmodified, and `_meta` survives for the vendor extractors.
 *
 * `raw` is the agent's params by identity — `InteractionRequest.raw`'s "Verbatim params. NEVER
 * reshaped" starts here, and a second application keeps the first's so idempotency holds.
 *
 * `options` is NEVER RESHAPED, including an unknown `kind`, which D4 rule 6 needs in order to
 * fail closed. And `toolCallId` is lifted out here rather than in the responder: it is the join
 * §13.4 needs to turn "we denied" into `TurnResult.deniedToolCalls` without ever reading the
 * agent's English `rawOutput`.
 *
 * The descriptor's `permissionRequestShape` quirk is READ rather than branched on: both shapes
 * are handled structurally, and the quirk is the recorded claim about which one to expect. A
 * disagreement between the claim and the wire is a fact about the descriptor, not a reason to
 * refuse a request the agent is waiting on (F1: it waits forever).
 */
export function mapPermissionRequest(
  req: unknown,
  descriptor: RuntimeDescriptor,
): MappedPermissionRequest {
  const r = record(req) ?? {};

  // Already v2: a tagged `subject` is present. Keep it by identity rather than rebuilding it,
  // which is what makes the second application a no-op.
  const existing = record(r["subject"]);
  const toolCall = record(r["toolCall"]);
  const subject = existing ?? (toolCall === null ? null : { type: "tool_call", toolCall });

  const subjectToolCall = existing === null ? toolCall : record(existing["toolCall"]);
  const meta = record(r["_meta"]);
  void descriptor.quirks.permissionRequestShape;

  return {
    sessionId: str(r["sessionId"]) ?? "",
    title: titleOf(r, subjectToolCall),
    subject,
    options: options(r["options"]),
    toolCallId: subjectToolCall === null ? null : str(subjectToolCall["toolCallId"]),
    // The agent's params VERBATIM and by identity (review R11, §7.5): `worker.ts` maps before the
    // strategy sees the request (M1-R14) and is frozen, so without this the raw bytes
    // `acp.interaction.raw` audits the AGENT with — as opposed to auditing our mapping — would
    // be dropped at the seam. A request that already carries one keeps the FIRST one, which is
    // what keeps `map(map(x))` equal to `map(x)`.
    raw: record(r["raw"]) ?? r,
    ...(meta === null ? {} : { _meta: meta }),
  };
}
