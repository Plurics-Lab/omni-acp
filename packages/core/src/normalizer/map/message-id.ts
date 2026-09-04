import type { MappedUpdate, RuntimeDescriptor } from "@omni-acp/protocol";
import { has, str, type Json } from "./json.js";

/**
 * `messageId`: PASS THROUGH, synthesize only when absent (CONTRACTS.md §12.4).
 *
 * v1 types it optional and v2 requires it. A synthesized id is marked as such so a consumer can
 * tell it from the agent's own — F14 shows a replayed `messageId` is byte-identical to the live
 * one, which is what makes replay de-duplication possible AT ALL, and a fabricated id that looked
 * real would destroy that property.
 *
 * THIS IS THE ONLY MODULE OUTSIDE `protocol` THAT MAY NAME THE FIELD. The
 * `message-id-optional` guard (§10.2) enforces that, which is why `applyMessageId` hands the
 * caller a ready-made object to spread rather than a bare string: `map/update.ts` must be able
 * to build a `MappedUpdate` without ever spelling the identifier.
 *
 * Owned by M1-WP-B.
 */

/** The three v1 kinds that carry one. Every other kind reports `null` and synthesizes nothing. */
const CHUNK_KINDS: ReadonlySet<string> = new Set([
  "user_message_chunk",
  "agent_message_chunk",
  "agent_thought_chunk",
]);

export function isChunkKind(kind: string): boolean {
  return CHUNK_KINDS.has(kind);
}

/**
 * The id in force after mapping, and whether we invented it.
 *
 * The result field is `id`, not the protocol's own name: `map/update.ts` destructures it, and
 * the `message-id-optional` guard (§10.2) allows the identifier in THIS file alone.
 *
 * Synthesis is DETERMINISTIC and MARKED, never opportunistic: `ids.synth(kind)` returns
 * `omni:<turnId>:<kind>:<runOrdinal>` where the ordinal advances on every kind change, so a run
 * of id-less chunks of one kind is grouped as ONE message — the only grouping the wire supports.
 * The generator is injected, which is what keeps this module pure.
 */
export function messageIdFor(
  payload: Json,
  descriptor: RuntimeDescriptor,
  ids: { synth(prefix: string): string },
): { readonly id: string | null; readonly synthesized: boolean } {
  const kind = str(payload["sessionUpdate"]);
  if (kind === null || !CHUNK_KINDS.has(kind)) return { id: null, synthesized: false };

  const present = str(payload["messageId"]);
  if (present !== null) return { id: present, synthesized: false };

  // The descriptor's `messageIdPresent` is an OBSERVATION, not a switch: an agent that is
  // documented to send one and did not still needs a v2-legal payload. It is read only so a
  // synthesis on such an agent is visibly a contradiction of what we recorded, which is what
  // `synthesized: true` reports upward.
  void descriptor.quirks.messageIdPresent;
  return { id: ids.synth(kind), synthesized: true };
}

/** True when the payload already carries a usable id — the idempotency test of §12.2. */
export function hasMessageId(payload: Json): boolean {
  return has(payload, "messageId") && str(payload["messageId"]) !== null;
}

/**
 * `payload` with the id in force written on, by copy, or BY IDENTITY when nothing changed.
 *
 * Returning the input object unchanged in the pass-through case is what makes rows 1–3 of §12.3
 * genuine `=` rows: 86 of 86 recorded chunks come back as the very object the agent sent.
 */
export function applyMessageId(payload: Json, id: string | null): Json {
  if (id === null || str(payload["messageId"]) === id) return payload;
  return { ...payload, messageId: id };
}

/** The `MappedUpdate` slice that names the field, so no other module has to. */
export function messageIdField(id: string | null): Pick<MappedUpdate, "messageId"> {
  return { messageId: id };
}

/**
 * The default id generator: deterministic, per normalizer instance, and marked.
 *
 * `omni:` is the prefix that says "synthesized by omni-acp"; no real agent id in the corpus
 * begins with it (`msg_011Ceh…` for the agent, a plain UUID for a replayed user message), so a
 * consumer can tell ours from theirs by inspection as well as by `MappedUpdate`.
 */
export function synthesizedIds(turnIdOf: () => string | null): { synth(prefix: string): string } {
  let lastPrefix: string | null = null;
  let ordinal = 0;
  return {
    synth(prefix: string): string {
      if (prefix !== lastPrefix) {
        lastPrefix = prefix;
        ordinal += 1;
      }
      return `omni:${turnIdOf() ?? "no-turn"}:${prefix}:${String(ordinal)}`;
    },
  };
}
