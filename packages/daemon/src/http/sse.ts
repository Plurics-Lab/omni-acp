import {
  SSE_CONTROL,
  type EventEnvelope,
  type EventLog,
  type Seq,
  type Subscription,
} from "@omni-acp/protocol";

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
  const encoder = new TextEncoder();
  let subscription: Subscription | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let finished = false;
  // Assigned by `start`, called by `cancel` — the consumer can abandon the body without ever
  // aborting the request, and that path has to release the subscription too.
  let finish = (): void => {
    finished = true;
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      finish = (): void => {
        if (finished) return;
        finished = true;
        if (heartbeat !== null) clearInterval(heartbeat);
        subscription?.close();
        o.signal.removeEventListener("abort", finish);
        try {
          controller.close();
        } catch {
          // Already closed or errored by the transport; there is nothing left to do about it.
        }
      };

      const write = (text: string): void => {
        if (finished) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          // The peer went away between two frames. Tear the subscription down rather than
          // spinning on a dead controller for the rest of the worker's life.
          finish();
        }
      };

      if (o.signal.aborted) {
        finish();
        return;
      }
      o.signal.addEventListener("abort", finish, { once: true });

      // The reconnect delay a browser's own EventSource honours, once, at stream open.
      write("retry: 2000\n\n");

      // `since < tail - 1` rather than the `since < tail` of §8.4's table: `since` is EXCLUSIVE,
      // so `since === tail - 1` has lost nothing, and a fresh log (tail 1, `?since=0`) is the
      // normal case — the literal reading would put a truncation notice on the front of every
      // default stream and teach clients to ignore it.
      if (o.since < log.tail - 1) {
        write(controlFrame(SSE_CONTROL.truncated, { tail: log.tail }));
      }

      // ONE synchronous call: replay and the live tail, with nothing able to slip between them.
      subscription = log.subscribe(
        o.since,
        (envelope) => {
          write(envelopeFrame(envelope));
          if (isStreamTerminal(envelope)) {
            write(
              controlFrame(SSE_CONTROL.end, { reason: "worker_closed", lastSeq: envelope.seq }),
            );
            finish();
          }
        },
        {
          queueSize: o.queueSize,
          onOverflow: (lastDelivered) => {
            // The producer is never blocked and no event is silently dropped: the client is told
            // where it got to and reconnects with `?since=<lastSeq>`.
            write(controlFrame(SSE_CONTROL.overflow, { lastSeq: lastDelivered }));
            finish();
          },
        },
      );
      // The replay above can finish the stream synchronously (a worker that is already closed),
      // in which case `subscription` was still null when `finish()` ran.
      if (finished) subscription.close();

      if (!finished) {
        heartbeat = setInterval(() => {
          // A comment frame: no `id`, no `event`, no seq — it exists to keep a proxy from
          // reaping an idle connection, and a client's parser ignores it.
          write(": hb\n\n");
        }, o.heartbeatMs);
        // Never let the heartbeat alone hold the process open.
        heartbeat.unref?.();
      }
    },

    cancel() {
      finish();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // nginx buffers `text/event-stream` by default, which turns a live tail into a batch.
      "x-accel-buffering": "no",
    },
  });
}

/** `data` alone is enough to reconstruct everything: one parse, one type (§8.4). */
function envelopeFrame(e: EventEnvelope): string {
  return `id: ${e.seq}\nevent: ${e.kind}\ndata: ${JSON.stringify(e)}\n\n`;
}

/** Out of band: no `id:`, so it consumes no seq and cannot be mistaken for an envelope. */
function controlFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * The stream-terminal predicate — one of this file's two documented exemptions from the
 * `http-has-no-logic` guard (review R7). It decides nothing about the worker; it recognises the
 * envelope after which no further envelope can ever arrive, which is the only moment an SSE
 * writer may close a stream without that looking like a network drop.
 */
function isStreamTerminal(e: EventEnvelope): boolean {
  return e.kind === "omni.worker_state" && e.payload.state === "closed";
}
