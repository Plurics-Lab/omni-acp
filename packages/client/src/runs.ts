import { OmniError, SSE_CONTROL } from "@omni-acp/protocol";
import type {
  CreateRunRequest,
  EventEnvelope,
  RunId,
  RunListResponse,
  RunSnapshot,
} from "@omni-acp/protocol";
import { isMalformedFrame, parseSseStream } from "./sse-parse.js";
import type { Transport } from "./transport.js";

/**
 * `server.runs` — DESIGN §9.3's fire-and-forget half of the SDK.
 *
 * `events()` is the SAME resumable tail `worker.events()` uses, pointed at the run's own route,
 * so a dropped connection is recovered by `?since=` with M1's exact semantics rather than by a
 * second implementation of the same idea.
 *
 * Owned by M2-B-WP-R.
 */
export interface RunsChannel {
  create(r: CreateRunRequest): Promise<RunSnapshot>;
  get(id: RunId): Promise<RunSnapshot>;
  list(): Promise<readonly RunSnapshot[]>;
  cancel(id: RunId): Promise<RunSnapshot>;
  events(id: RunId, o?: { since?: number; signal?: AbortSignal }): AsyncIterable<EventEnvelope>;
}

/** M1's reconnect ladder, verbatim: a stream that drops is reopened from the cursor, not restarted. */
const RECONNECT_BACKOFF_MS = [0, 25, 50, 100, 200, 400, 800] as const;
/** A stream that reopens and immediately ends, over and over, is a broken daemon, not a tail. */
const MAX_EMPTY_RECONNECTS = 20;

export function createRunsChannel(transport: Transport): RunsChannel {
  return {
    create(r: CreateRunRequest): Promise<RunSnapshot> {
      return transport.request<RunSnapshot>("POST", "/v1/runs", r);
    },
    get(id: RunId): Promise<RunSnapshot> {
      return transport.request<RunSnapshot>("GET", `/v1/runs/${id}`);
    },
    async list(): Promise<readonly RunSnapshot[]> {
      const body = await transport.request<RunListResponse>("GET", "/v1/runs");
      return body.runs;
    },
    cancel(id: RunId): Promise<RunSnapshot> {
      return transport.request<RunSnapshot>("POST", `/v1/runs/${id}/cancel`);
    },
    events(id: RunId, o?: { since?: number; signal?: AbortSignal }): AsyncIterable<EventEnvelope> {
      return tail(transport, id, Math.max(0, o?.since ?? 0), o?.signal);
    },
  };
}

/**
 * The resumable envelope tail, pointed at `/v1/runs/{rid}/events`.
 *
 * One connection is never the unit of work: the stream is re-opened with `?since=<last seq seen>`
 * after every drop, and an envelope at or below the cursor is discarded, so the union over N
 * connections is gap-free AND duplicate-free by construction.
 *
 * That is the same paragraph `worker.ts` carries, because the daemon route is the same writer
 * over the same log — `GET /v1/runs/{rid}/events` PROXIES the run's worker's stream (§24.1) — and
 * `run-webhook.itest.ts` proves the equivalence by running `sse-resume.itest.ts`'s frame
 * comparison against a run's URL rather than a worker's.
 */
async function* tail(
  transport: Transport,
  id: RunId,
  since: number,
  signal?: AbortSignal,
): AsyncGenerator<EventEnvelope> {
  let cursor = since;
  let attempt = 0;
  let empty = 0;

  const stopped = (): boolean => signal?.aborted === true;

  while (!stopped()) {
    let res: Response;
    try {
      res = await transport.open(`/v1/runs/${id}/events?since=${String(cursor)}`, {
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (e) {
      if (stopped()) return;
      if (isFatal(e)) throw e;
      if (++attempt > MAX_EMPTY_RECONNECTS) throw OmniError.from(e);
      await delay(backoff(attempt), signal);
      continue;
    }
    attempt = 0;

    let progressed = false;
    let ended = false;
    try {
      for await (const message of parseSseStream(res, signal)) {
        if (message.type === "control") {
          if (message.event === SSE_CONTROL.end) ended = true;
          if (message.event === SSE_CONTROL.end || message.event === SSE_CONTROL.overflow) break;
          continue;
        }
        const envelope = message.envelope;
        if (envelope.seq <= cursor) continue; // a resume overlap, not new history
        cursor = envelope.seq;
        progressed = true;
        yield envelope;
      }
    } catch (e) {
      if (stopped()) return;
      if (isFatal(e)) throw e;
      // A mid-stream transport failure is exactly what `?since=` exists for.
    }

    if (ended || stopped()) return;
    empty = progressed ? 0 : empty + 1;
    if (empty > MAX_EMPTY_RECONNECTS) {
      throw new OmniError(
        "internal",
        `event stream for run ${id} ended ${String(empty)} times without delivering an envelope`,
        { detail: { since: cursor } },
      );
    }
    await delay(backoff(empty), signal);
  }
}

/** Errors that reopening cannot fix. Replaying them from the same cursor loops forever. */
function isFatal(e: unknown): boolean {
  return (
    isMalformedFrame(e) ||
    OmniError.is(e, "worker_not_found") ||
    OmniError.is(e, "worker_closed") ||
    OmniError.is(e, "unauthorized") ||
    OmniError.is(e, "forbidden") ||
    OmniError.is(e, "bad_request")
  );
}

function backoff(attempt: number): number {
  return RECONNECT_BACKOFF_MS[Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)] ?? 800;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
