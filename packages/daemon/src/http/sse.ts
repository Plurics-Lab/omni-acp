import { OmniError, type EventLog, type Seq } from "@omni-acp/protocol";

export interface SseOptions {
  readonly since: Seq;
  readonly heartbeatMs: number;
  readonly queueSize: number;
  readonly signal: AbortSignal;
}

/**
 * The SSE writer of CONTRACTS.md §8.4.
 *
 * `id: <seq>` / `event: <kind>` / `data: <full envelope JSON>`; a `retry: 2000` preamble; a
 * `: hb` comment heartbeat that consumes no seq. The three control frames
 * (`omni.stream_truncated` / `_overflow` / `_end`) are deliberately OUT OF BAND — no `id:`, not
 * envelopes, no seq — because an envelope would need a fabricated `seq` that two subscribers
 * would then disagree about (D24).
 *
 * The request's AbortSignal must close the `Subscription`; a leaked subscription per reconnect
 * is the classic SSE memory leak, and a test asserts `log.subscriberCount` returns to 0.
 */
export function sseResponse(log: EventLog, o: SseOptions): Response {
  throw new OmniError("internal", "unimplemented: WP-5 (http.sseResponse)");
}
