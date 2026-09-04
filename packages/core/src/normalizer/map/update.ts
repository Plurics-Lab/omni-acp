import type { MappedUpdate, NormalizedSessionUpdate, RuntimeDescriptor } from "@omni-acp/protocol";
import { mapDiffBlock } from "./diff.js";
import { arr, has, record, str, type Json } from "./json.js";
import { applyMessageId, messageIdField, messageIdFor } from "./message-id.js";
import { mapToolCall } from "./tool-call.js";
import { isV2SessionUpdate } from "./v2-shape.js";

/**
 * The v1→v2 `session/update` map — CONTRACTS.md §12.3, rows 1–18.
 *
 * PURE, TOTAL and IDEMPOTENT. Three properties, and every one of them is a corpus test:
 *
 *  - **TOTAL**: no input — `null`, a number, an array, a payload with the wrong type in every
 *    field — makes this throw. An update that killed the mapper would take the worker down.
 *  - **IDEMPOTENT**: `mapUpdate(mapUpdate(x).payload).payload` deep-equals `mapUpdate(x).payload`,
 *    because every rule tests the TARGET shape before rewriting (§12.2). F24 is why this matters
 *    rather than being tidy: claude-acp answers `protocolVersion: 1` while already emitting
 *    `usage_update` and `config_option_update`, so the switch is PER FIELD, never per version.
 *  - **`_meta` BY IDENTITY**: an update whose `_meta` this map does not rewrite comes back
 *    carrying the very object the agent sent. 198 of the 216 recorded updates keep theirs by
 *    `===`; the rest are the diff rows, where §12.5 requires the v1 text to be carried under
 *    `omni/v1Diff` and the ORIGINAL ENTRIES still survive by identity.
 *
 * `payloadVersion` is ruling M1-R10, stated once: `2` iff the mapper LANDED on a known v2 arm —
 * mapped or already v2-shaped — and `1` otherwise. "Landed" is checked, not assumed: a payload
 * carrying a known tag over a shape its arm does not admit is forwarded BY IDENTITY at `1`,
 * which is both honest and byte-for-byte what M0 did.
 *
 * No rule reads a protocol version (F24) and no rule reads an agent id — the descriptor is the
 * only branch, and `descriptor-is-the-only-branch` (§17.1) fails the build on a hit.
 *
 * Owned by M1-WP-B.
 */

/** Everything a rewrite may need beyond the update itself. All of it is DATA, never a switch. */
export interface MapContext {
  /** `plan_<turnId>`, stable across the turn so successive `plan` updates upsert one plan. */
  readonly planId: string;
  /** v1 `NewSessionResponse.modes`, for row 11. Absent ⇒ `options: []`, honest, not invented. */
  readonly modes: Json | null;
}

const NO_CONTEXT: MapContext = { planId: "plan_unknown", modes: null };

/** Identity / pass-through. `MappedUpdate.rule` is `""` for both (§5.1). */
const IDENTITY = "";
const RULE_TOOL_CALL = "tool_call->tool_call_update";
const RULE_PLAN = "plan->plan_update";
const RULE_MODE = "current_mode_update->config_option_update";
const RULE_DIFF = "diff->changes";
const RULE_SYNTH_ID = "messageId->synthesized";

export function mapUpdate(
  update: unknown,
  descriptor: RuntimeDescriptor,
  ids: { synth(prefix: string): string },
  context: MapContext = NO_CONTEXT,
): MappedUpdate {
  const payload = record(update);
  // Row 18, degenerate case: not an object at all. Forwarded by identity so the log keeps
  // whatever the agent sent; `payloadVersion: 1` is the flag that says we did not understand it.
  if (payload === null) return passthrough(update);

  const kind = str(payload["sessionUpdate"]);
  if (kind === null) return passthrough(update);

  const mapped = applyRow(kind, payload, descriptor, ids, context);

  // "Landed on a known v2 arm", checked. A rewrite that did not produce its target arm is a
  // rewrite we must not claim: forward the ORIGINAL, by identity, at 1.
  const landed = isV2SessionUpdate(mapped.payload);
  const result: MappedUpdate = landed
    ? {
        payload: mapped.payload as unknown as NormalizedSessionUpdate,
        payloadVersion: 2,
        rule: mapped.rule,
        ...messageIdField(mapped.id),
        keep: true,
      }
    : passthrough(update);

  // The descriptor's overlay (§14.6). `stream:false, store:false` is the operator's drop hatch
  // and the ONLY way an update is not appended; it is decided HERE, in the Normalizer, before
  // `append()` is ever called, so the log stays gap-free by construction and no `seq` is spent.
  // The forbidden third shape — store but do not stream — is rejected at descriptor resolution.
  const overlay = descriptor.updates[kind];
  if (overlay !== undefined && !overlay.stream && !overlay.store) {
    return { ...result, keep: false };
  }
  return result;
}

interface Rewritten {
  readonly payload: Json;
  readonly rule: string;
  readonly id: string | null;
}

function passthrough(update: unknown): MappedUpdate {
  return {
    // BY IDENTITY. Rebuilding the object is what drops `_meta` and every field this milestone
    // has not enumerated (§7.5, still binding for the rows §12.3 does not cover).
    payload: update as NormalizedSessionUpdate,
    payloadVersion: 1,
    rule: IDENTITY,
    ...messageIdField(null),
    keep: true,
  };
}

function applyRow(
  kind: string,
  payload: Json,
  descriptor: RuntimeDescriptor,
  ids: { synth(prefix: string): string },
  context: MapContext,
): Rewritten {
  switch (kind) {
    // Rows 1–3: `=` except the id. The three chunk kinds are structurally identical in v1 and
    // v2 apart from `messageId`, which v1 types optional and v2 requires (§12.4).
    case "user_message_chunk":
    case "agent_message_chunk":
    case "agent_thought_chunk": {
      const { id, synthesized } = messageIdFor(payload, descriptor, ids);
      return {
        payload: applyMessageId(payload, id),
        rule: synthesized ? RULE_SYNTH_ID : IDENTITY,
        id,
      };
    }

    // Row 4: rename the discriminant, and nothing else. The merge is `reduceTurn`'s (F23).
    case "tool_call": {
      const renamed = mapToolCall(payload);
      const withDiffs = mapContentBlocks(renamed, descriptor);
      return {
        payload: withDiffs.payload,
        rule: withDiffs.changed ? `${RULE_TOOL_CALL}+${RULE_DIFF}` : RULE_TOOL_CALL,
        id: null,
      };
    }

    // Row 5: `=` verbatim, `_meta` by identity — except that a v1 diff nested in `content` is
    // still a v1 diff (row 6), and the open arm of v2's union would happily carry it.
    case "tool_call_update": {
      const withDiffs = mapContentBlocks(payload, descriptor);
      return {
        payload: withDiffs.payload,
        rule: withDiffs.changed ? RULE_DIFF : IDENTITY,
        id: null,
      };
    }

    // Row 7: `{entries}` → `{plan:{type:"items", planId, entries}}`.
    case "plan":
      return { payload: mapPlan(payload, context), rule: RULE_PLAN, id: null };

    // Row 8: `=` when `plan.type` is a string; otherwise a v1 agent using the v2 name loosely,
    // which is row 7 again.
    case "plan_update": {
      const plan = record(payload["plan"]);
      if (plan !== null && str(plan["type"]) !== null) {
        return { payload, rule: IDENTITY, id: null };
      }
      return { payload: mapPlan(payload, context), rule: RULE_PLAN, id: null };
    }

    // Row 11: the one row that needs the HANDSHAKE, not just the update.
    case "current_mode_update":
      return { payload: mapCurrentMode(payload, context), rule: RULE_MODE, id: null };

    // Rows 9, 10, 12, 13 and v2's own `state_update`: `=`. Identity, by identity.
    default:
      return { payload, rule: IDENTITY, id: null };
  }
}

/**
 * Row 6, applied where a diff can appear: `ToolCallUpdate.content`.
 *
 * The array and the payload are rebuilt ONLY when a block actually changed, so a tool call with
 * no diff — 32 of the 36 recorded updates — keeps its payload and its `_meta` by identity.
 */
function mapContentBlocks(
  payload: Json,
  descriptor: RuntimeDescriptor,
): { payload: Json; changed: boolean } {
  const content = arr(payload["content"]);
  if (content === null) return { payload, changed: false };

  let changed = false;
  const mapped = content.map((raw) => {
    const block = record(raw);
    if (block === null || block["type"] !== "diff") return raw;
    const next = mapDiffBlock(block, descriptor);
    if (next !== block) changed = true;
    return next;
  });

  return changed ? { payload: { ...payload, content: mapped }, changed } : { payload, changed };
}

function mapPlan(payload: Json, context: MapContext): Json {
  const entries = arr(payload["entries"]);
  // No entries, no rewrite. Defaulting to `[]` would tell a client the agent has an EMPTY plan,
  // which is a different claim from "this payload carried no plan" — and §12.3 row 7 maps
  // `{entries}`, not the absence of it. The payload is forwarded untouched and reported as v1.
  if (entries === null) return payload;
  const rest: Record<string, unknown> = {};
  for (const key of Object.keys(payload)) {
    if (key === "entries" || key === "sessionUpdate" || key === "plan") continue;
    rest[key] = payload[key];
  }
  return {
    ...rest,
    sessionUpdate: "plan_update",
    // `planId` is `plan_<turnId>` and STABLE across the turn, so successive `plan` updates
    // upsert one plan rather than accumulating a plan per notification (§12.3 row 7).
    plan: { type: "items", planId: context.planId, entries },
  };
}

/**
 * Row 11: `{currentModeId}` → one `configOptions` entry.
 *
 * The option catalogue comes from the HANDSHAKE's `modes.availableModes`, mapped
 * `{id,name,description}` → `{value,name,description}`. If the handshake carried no `modes`,
 * `options: []` — honest, not invented: a select with fabricated choices would be a lie about
 * what the agent will accept.
 *
 * The identifier is spelled `id`, which is what §12.3 row 11 writes and what claude-acp's own
 * `config_option_update` uses on the wire (corpus `08`). The SDK's v2 type declares `configId`;
 * both are accepted by `isSessionConfigOption`, and matching the wire keeps a synthesized option
 * indistinguishable in shape from a real one.
 */
function mapCurrentMode(payload: Json, context: MapContext): Json {
  const currentValue = str(payload["currentModeId"]);
  // No mode id, no rewrite: the payload is forwarded untouched and reported as v1. Emitting a
  // select whose `currentValue` is `""` would claim the agent is in a mode that does not exist.
  if (currentValue === null) return payload;
  const available = arr(context.modes?.["availableModes"]) ?? [];
  const options = available.flatMap((raw) => {
    const mode = record(raw);
    const value = mode === null ? null : str(mode["id"]);
    if (mode === null || value === null) return [];
    const name = str(mode["name"]) ?? value;
    const description = str(mode["description"]);
    return [description === null ? { value, name } : { value, name, description }];
  });

  const meta = record(payload["_meta"]);
  return {
    sessionUpdate: "config_option_update",
    configOptions: [
      {
        id: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue,
        options,
      },
    ],
    _meta: { ...(meta ?? {}), "omni/derivedFrom": "current_mode_update" },
  };
}

/** True when the descriptor asks for this kind's payload to be stored by content digest. */
export function wantsDigest(kind: string, descriptor: RuntimeDescriptor): boolean {
  return descriptor.updates[kind]?.digest === true;
}

/** The `_meta` object of a mapped payload, for the extension readers. Never rebuilt. */
export function metaOf(payload: unknown): Json | null {
  const p = record(payload);
  if (p === null || !has(p, "_meta")) return null;
  return record(p["_meta"]);
}
