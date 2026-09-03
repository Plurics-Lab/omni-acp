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
 *
 * This file is the ONE file under `src/http/**` that the `http-has-no-logic` guard exempts, and
 * for exactly two things (CONTRACTS.md §10.2, review R7): the `heartbeatMs` interval, and the
 * stream-terminal predicate — recognising `kind === "omni.worker_state"` with a closed state in
 * order to write `omni.stream_end`. Both are transport concerns that D15 constraint 1 was never
 * about. Everything else the guard forbids still applies here: no `@omni-acp/core` import, no
 * `node:child_process`, and no decision about what a worker may do.
 */
export function sseResponse(log: EventLog, o: SseOptions): Response {
  throw new OmniError("internal", "unimplemented: WP-5 (http.sseResponse)");
}
