import type {
  MappedPermissionRequest,
  PermissionOption,
  RuntimeDescriptor,
} from "@omni-acp/protocol";

function record(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/**
 * The offered options, defensively narrowed.
 *
 * `PermissionOptionKind` is a closed enum in the schema, and D4 rule 6 requires an UNKNOWN kind
 * to survive far enough to be treated as a non-grant — so the shape check is structural and the
 * option objects are passed through by identity.
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
 * v1 `{sessionId, toolCall, options}` → v2 `{title, subject, options}` (CONTRACTS.md §12.6).
 *
 * PURE and IDEMPOTENT: a request that already carries a v2 `subject` comes back with that
 * subject by identity, so `map(map(x))` is `map(x)`. `toolCall` is passed BY IDENTITY into the
 * subject, so `kind` / `locations` / `content` / `rawInput` — what M2's rule engine matches on —
 * arrive unmodified, and `_meta` survives for the vendor extractors.
 *
 * Owned by M1-WP-B, which adds the descriptor's `permissionRequestShape` quirk, the golden
 * cases, and the idempotency property test over all 216 recorded updates. What is here is the
 * subset the M0 permission path (F1: the SDK example agent asks mid-turn and waits forever)
 * needs in order to keep working under ruling M1-R14 — no descriptor branch, no invention.
 */
export function mapPermissionRequest(
  req: unknown,
  _descriptor: RuntimeDescriptor,
): MappedPermissionRequest {
  const r = record(req) ?? {};

  // Already v2: a tagged `subject` is present. Keep it by identity rather than rebuilding it,
  // which is what makes the second application a no-op.
  const existing = record(r["subject"]);
  const toolCall = record(r["toolCall"]);
  const subject = existing ?? (toolCall === null ? null : { type: "tool_call", toolCall });

  const subjectToolCall = existing === null ? toolCall : record(existing["toolCall"]);
  const meta = record(r["_meta"]);

  return {
    sessionId: str(r["sessionId"]) ?? "",
    // v1 has no top-level title; `toolCall.title` is the only place it is recoverable (§7.4).
    title:
      str(r["title"]) ?? (subjectToolCall === null ? "" : (str(subjectToolCall["title"]) ?? "")),
    subject,
    options: options(r["options"]),
    toolCallId: subjectToolCall === null ? null : str(subjectToolCall["toolCallId"]),
    ...(meta === null ? {} : { _meta: meta }),
  };
}
