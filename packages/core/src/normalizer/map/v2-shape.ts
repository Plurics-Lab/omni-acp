/**
 * "Every rule tests the TARGET shape before rewriting" (CONTRACTS.md §12.2), made executable.
 *
 * These predicates are what decide `MappedUpdate.payloadVersion`: ruling M1-R10 says `2` iff the
 * mapper LANDED on a known v2 arm, and "landed" has to mean the result really is that arm — a
 * `sessionUpdate` tag alone is not an arm, because v2's union ends in an open
 * `{sessionUpdate: string}` escape hatch that accepts anything (F2). A payload that carries a
 * known tag and a shape its arm does not admit is therefore reported as `1` and forwarded BY
 * IDENTITY, which is exactly what M0 did and is the honest answer: we could not produce v2.
 *
 * WHY THESE ARE HAND-WRITTEN rather than the SDK's own `SessionUpdate.is*` guards:
 *
 *  - `protocol/src/acp.ts` is "the ONE place the ACP SDK is imported", and `experimental/v2` is
 *    an unstable entry point (§11.6's risk row). A zod parse per update on the ingest path would
 *    make every agent update's `payloadVersion` depend on an entry point the SDK may reshape.
 *  - The SDK guards are deliberately CONSERVATIVE, not exact ("guards are conservative where
 *    wire parsing may still accept the value") — `{content: "x"}` passes `isToolCallUpdate`.
 *
 * So these are written to IMPLY the SDK guard: everything this file calls v2 is accepted by the
 * SDK guard for the same arm, and `SessionUpdate.isCustom` is false for it. That implication is
 * not a comment — `map/v2-shape.test.ts` asserts it over a hand-written matrix AND over all 216
 * recorded corpus updates (§12.7(b)(1)).
 */

import { arr, has, num, record, str, type Json } from "./json.js";

/** v2 `ContentBlock`: a tagged object. The union's last arm is `{type: string}`, so the tag is
 *  the whole requirement for a custom block; the known arms add their own required fields. */
export function isContentBlock(v: unknown): boolean {
  const b = record(v);
  if (b === null) return false;
  const type = str(b["type"]);
  if (type === null) return false;
  if (type === "text") return str(b["text"]) !== null;
  if (type === "image" || type === "audio") return str(b["data"]) !== null;
  if (type === "resource_link") return str(b["uri"]) !== null;
  if (type === "resource") return record(b["resource"]) !== null;
  return true;
}

/** v2 `Diff`: `{changes: DiffChange[], patch?: {format,text}}`. It has NO `oldText`/`newText`
 *  at all — that is the whole of §12.5's problem, and this is the predicate that detects a v1
 *  diff hiding inside an otherwise-valid `tool_call_update` (§12.7(b)(2)). */
export function isV2Diff(v: unknown): boolean {
  const d = record(v);
  if (d === null || d["type"] !== "diff") return false;
  const changes = arr(d["changes"]);
  if (changes === null) return false;
  if (!changes.every(isDiffChange)) return false;
  if (!has(d, "patch") || d["patch"] === null || d["patch"] === undefined) return true;
  const patch = record(d["patch"]);
  return patch !== null && str(patch["format"]) !== null && str(patch["text"]) !== null;
}

function isDiffChange(v: unknown): boolean {
  const c = record(v);
  if (c === null) return false;
  const operation = str(c["operation"]);
  if (operation === null) return false;
  if (operation === "move" || operation === "copy") {
    return str(c["path"]) !== null && str(c["oldPath"]) !== null;
  }
  if (operation === "add" || operation === "delete" || operation === "modify") {
    return str(c["path"]) !== null;
  }
  return true;
}

/** v2 `ToolCallContent`: `content` | `diff` | `terminal`, tagged. A v1 diff block fails here. */
export function isToolCallContent(v: unknown): boolean {
  const c = record(v);
  if (c === null) return false;
  const type = str(c["type"]);
  if (type === null) return false;
  if (type === "content") return isContentBlock(c["content"]);
  if (type === "diff") return isV2Diff(c);
  if (type === "terminal") return str(c["terminalId"]) !== null;
  return true;
}

function isToolCallLocation(v: unknown): boolean {
  const l = record(v);
  if (l === null) return false;
  if (str(l["path"]) === null) return false;
  const line = l["line"];
  return line === undefined || line === null || num(line) !== null;
}

function isPlanEntry(v: unknown): boolean {
  const e = record(v);
  return (
    e !== null &&
    str(e["content"]) !== null &&
    str(e["priority"]) !== null &&
    str(e["status"]) !== null
  );
}

function optionalStringArray(o: Json, key: string, item: (v: unknown) => boolean): boolean {
  if (!has(o, key) || o[key] === null || o[key] === undefined) return true;
  const list = arr(o[key]);
  return list !== null && list.every(item);
}

function optionalString(o: Json, key: string): boolean {
  return !has(o, key) || o[key] === null || o[key] === undefined || str(o[key]) !== null;
}

/** `{messageId, content}` — v2's `ContentChunk`, used by the three chunk kinds. v1 types
 *  `messageId` OPTIONAL and v2 REQUIRES it, which is the whole of §12.4. */
function isContentChunk(p: Json): boolean {
  return str(p["messageId"]) !== null && isContentBlock(p["content"]);
}

function isToolCallUpdate(p: Json): boolean {
  if (str(p["toolCallId"]) === null) return false;
  if (!optionalString(p, "title") || !optionalString(p, "kind") || !optionalString(p, "status")) {
    return false;
  }
  if (!optionalString(p, "name")) return false;
  // Checked RECURSIVELY: the open arm otherwise accepts a v1-shaped diff nested inside an
  // otherwise-valid `tool_call_update`, which is §12.7(b)(2)'s named hole.
  if (!optionalStringArray(p, "content", isToolCallContent)) return false;
  return optionalStringArray(p, "locations", isToolCallLocation);
}

function isPlanUpdate(p: Json): boolean {
  const plan = record(p["plan"]);
  if (plan === null) return false;
  const type = str(plan["type"]);
  if (type === null || str(plan["planId"]) === null) return false;
  if (type === "items") {
    const entries = arr(plan["entries"]);
    return entries !== null && entries.every(isPlanEntry);
  }
  if (type === "file") return str(plan["uri"]) !== null;
  if (type === "markdown") return str(plan["content"]) !== null;
  return true;
}

function isAvailableCommand(v: unknown): boolean {
  const c = record(v);
  return c !== null && str(c["name"]) !== null && str(c["description"]) !== null;
}

/**
 * v2 `SessionConfigOption`. The identifier is spelled `configId` in the SDK type and `id` on
 * claude-acp's wire (corpus `08`), and CONTRACTS.md §12.3 row 11 writes the SYNTHESIZED option
 * with `id`. Both spellings are accepted here — refusing the one the only real agent emits would
 * report a genuine v2 payload as v1 — and neither is rewritten (row 12 is `=`).
 */
function isSessionConfigOption(v: unknown): boolean {
  const o = record(v);
  if (o === null) return false;
  if (str(o["configId"]) === null && str(o["id"]) === null) return false;
  if (str(o["name"]) === null) return false;
  const type = str(o["type"]);
  if (type === null) return true;
  if (type === "select") {
    return str(o["currentValue"]) !== null && arr(o["options"]) !== null;
  }
  if (type === "boolean") return typeof o["currentValue"] === "boolean";
  return true;
}

function isStateUpdate(p: Json): boolean {
  const state = str(p["state"]);
  if (state === null) return false;
  if (state !== "idle") return true;
  if (!optionalString(p, "stopReason")) return false;
  if (!has(p, "usage") || p["usage"] === null || p["usage"] === undefined) return true;
  const usage = record(p["usage"]);
  return (
    usage !== null &&
    num(usage["totalTokens"]) !== null &&
    num(usage["inputTokens"]) !== null &&
    num(usage["outputTokens"]) !== null
  );
}

/**
 * The one table: v2 `sessionUpdate` kind -> the predicate its arm requires.
 *
 * Absence from this table means "not a known v2 arm", which is `payloadVersion: 1`. The two v2
 * upsert forms §12.3 row 16 declines to synthesize (`agent_message`, `user_message`, …) and the
 * two terminal kinds row 17 rules out are present, because an AGENT may legitimately send them
 * even though M1 never SYNTHESIZES one — declining to synthesize is not declining to carry.
 */
const ARMS: Readonly<Record<string, (p: Json) => boolean>> = {
  user_message_chunk: isContentChunk,
  agent_message_chunk: isContentChunk,
  agent_thought_chunk: isContentChunk,
  user_message: (p) => str(p["messageId"]) !== null,
  agent_message: (p) => str(p["messageId"]) !== null,
  agent_thought: (p) => str(p["messageId"]) !== null,
  state_update: isStateUpdate,
  tool_call_update: isToolCallUpdate,
  tool_call_content_chunk: (p) => str(p["toolCallId"]) !== null && isContentBlock(p["content"]),
  terminal_update: (p) => str(p["terminalId"]) !== null,
  terminal_output_chunk: (p) => str(p["terminalId"]) !== null && str(p["output"]) !== null,
  plan_update: isPlanUpdate,
  plan_removed: (p) => str(p["planId"]) !== null,
  available_commands_update: (p) =>
    (arr(p["availableCommands"]) ?? []).every(isAvailableCommand) &&
    arr(p["availableCommands"]) !== null,
  config_option_update: (p) =>
    arr(p["configOptions"]) !== null && (arr(p["configOptions"]) ?? []).every(isSessionConfigOption),
  session_info_update: (p) => optionalString(p, "title") && optionalString(p, "updatedAt"),
  usage_update: (p) => num(p["used"]) !== null && num(p["size"]) !== null,
  compaction_update: (p) => str(p["compactionId"]) !== null && str(p["status"]) !== null,
  compaction_summary_chunk: (p) =>
    str(p["compactionId"]) !== null && isContentBlock(p["content"]),
};

/** The known v2 kinds, so the map can say "this tag names an arm" without knowing the arm. */
export function isKnownV2Kind(kind: string): boolean {
  return has(ARMS, kind);
}

/**
 * TRUE iff `payload` is a valid instance of the v2 arm its own `sessionUpdate` names.
 *
 * TOTAL: any input, including `null`, a number or an array, answers `false` rather than throwing.
 */
export function isV2SessionUpdate(payload: unknown): boolean {
  const p = record(payload);
  if (p === null) return false;
  const kind = str(p["sessionUpdate"]);
  if (kind === null) return false;
  const arm = ARMS[kind];
  if (arm === undefined) return false;
  // `_meta` is `{[k:string]: unknown} | null` on every arm: an array or a scalar is not one.
  if (has(p, "_meta") && p["_meta"] !== null && record(p["_meta"]) === null) return false;
  return arm(p);
}
