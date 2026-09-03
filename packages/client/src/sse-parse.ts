import { OmniError, type EventEnvelope } from "@omni-acp/protocol";

export type SseMessage =
  | { readonly type: "envelope"; readonly envelope: EventEnvelope }
  | { readonly type: "control"; readonly event: string; readonly data: unknown };

/**
 * An incremental SSE frame parser over the response body.
 *
 * It has to distinguish the two frame families the daemon emits: envelopes (which carry `id:`
 * and advance the client's resume cursor) and out-of-band control frames (which carry no `id:`
 * and must not) — CONTRACTS.md §8.4.
 */
export function parseSseStream(res: Response, signal?: AbortSignal): AsyncIterable<SseMessage> {
  throw new OmniError("internal", "unimplemented: WP-6 (client.parseSseStream)");
}
