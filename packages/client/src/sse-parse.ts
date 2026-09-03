import {
  OmniError,
  SSE_CONTROL,
  eventEnvelopeSchema,
  type EventEnvelope,
} from "@omni-acp/protocol";

export type SseMessage =
  | { readonly type: "envelope"; readonly envelope: EventEnvelope }
  | { readonly type: "control"; readonly event: string; readonly data: unknown };

/**
 * The marker that separates "the connection broke" from "the other end is not speaking our
 * protocol". The first is what `?since=` resume exists for; the second cannot be fixed by
 * reconnecting, and a reader that retried it would spin quietly for as long as the daemon stayed
 * wrong — the worst available failure mode for a transport.
 */
const MALFORMED = "sse_malformed_frame";

export function isMalformedFrame(e: unknown): boolean {
  return e instanceof OmniError && e.detail?.["reason"] === MALFORMED;
}

const CONTROL_EVENTS = new Set<string>(Object.values(SSE_CONTROL));

interface Frame {
  id: string | undefined;
  event: string | undefined;
  data: string[];
}

/**
 * One `field: value` block, per the SSE grammar: a leading `:` is a comment, one optional space
 * is stripped from the value, and repeated `data:` lines join with "\n". A block with no fields
 * at all (a heartbeat, `: hb`) produces nothing.
 */
function parseBlock(block: string): Frame | null {
  const frame: Frame = { id: undefined, event: undefined, data: [] };
  let sawField = false;

  for (const line of block.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "id") {
      frame.id = value;
      sawField = true;
    } else if (field === "event") {
      frame.event = value;
      sawField = true;
    } else if (field === "data") {
      frame.data.push(value);
      sawField = true;
    }
    // `retry:` and any unknown field are ignored, which is what the SSE spec requires of a
    // client and what keeps a future daemon-side field from breaking this one.
  }

  return sawField ? frame : null;
}

function toMessage(frame: Frame): SseMessage | null {
  const text = frame.data.join("\n");

  if (frame.event !== undefined && CONTROL_EVENTS.has(frame.event)) {
    // Out-of-band control frames carry no `id:` and are NOT envelopes (CONTRACTS.md §8.4, D24).
    return { type: "control", event: frame.event, data: safeJson(text, frame.event) };
  }

  if (text.trim() === "") return null;

  const parsed = eventEnvelopeSchema.safeParse(safeJson(text, frame.event ?? "envelope"));
  if (!parsed.success) {
    throw new OmniError("internal", "SSE frame is not a valid EventEnvelope", {
      cause: parsed.error,
      detail: { reason: MALFORMED, event: frame.event, id: frame.id },
    });
  }
  return { type: "envelope", envelope: parsed.data };
}

function safeJson(text: string, event: string): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new OmniError("internal", `SSE frame "${event}" carried data that is not JSON`, {
      cause: e,
      detail: { reason: MALFORMED, event },
    });
  }
}

/**
 * An incremental SSE frame parser over the response body.
 *
 * It has to distinguish the two frame families the daemon emits: envelopes (which carry `id:`
 * and advance the client's resume cursor) and out-of-band control frames (which carry no `id:`
 * and must not) — CONTRACTS.md §8.4.
 *
 * The reader is cancelled in `finally`, so a consumer that `break`s out of the `for await` —
 * which is exactly what `prompt()` does the moment its turn goes terminal — closes the HTTP
 * response and therefore the daemon-side `Subscription`. A leaked subscription per reconnect is
 * the classic SSE memory leak.
 */
export function parseSseStream(res: Response, signal?: AbortSignal): AsyncIterable<SseMessage> {
  return { [Symbol.asyncIterator]: () => iterate(res, signal) };
}

async function* iterate(res: Response, signal?: AbortSignal): AsyncGenerator<SseMessage> {
  const body = res.body;
  if (body === null) {
    throw new OmniError("internal", "the event stream response has no body");
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();

  // Read through a call, never as a property: `AbortSignal.aborted` is declared `readonly`, so
  // TypeScript narrows it once and then believes the narrowing across the whole loop — which is
  // exactly wrong for the one property in the language that is expected to flip under you.
  const stopped = (): boolean => signal?.aborted === true;

  const onAbort = (): void => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    if (stopped()) return;

    let buffer = "";
    for (;;) {
      const chunk = await reader.read().catch(() => ({ done: true, value: undefined }) as const);
      if (chunk.done) break;

      // Normalize over the ACCUMULATED buffer, not the chunk: a `\r\n` split across a chunk
      // boundary would otherwise survive and its frame terminator would never match.
      buffer = (buffer + decoder.decode(chunk.value, { stream: true })).replace(/\r\n/g, "\n");

      for (;;) {
        const at = buffer.indexOf("\n\n");
        if (at === -1) break;
        const block = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        const frame = parseBlock(block);
        if (frame === null) continue;
        const message = toMessage(frame);
        if (message !== null) yield message;
      }

      if (stopped()) return;
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await reader.cancel().catch(() => {});
  }
}
