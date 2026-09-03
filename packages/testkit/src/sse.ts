import {
  OmniError,
  SSE_CONTROL,
  eventEnvelopeSchema,
  type EventEnvelope,
} from "@omni-acp/protocol";

const CONTROL_EVENTS = new Set<string>(Object.values(SSE_CONTROL));

/**
 * A minimal, spec-shaped SSE parser: blank-line-separated blocks, `field: value` lines, one
 * optional leading space stripped from the value, multiple `data:` lines joined with "\n", and
 * comment lines (`: hb`) ignored. Comment-only blocks — heartbeats — produce no frame.
 */
export function parseSse(text: string): { id?: string; event?: string; data: string }[] {
  const frames: { id?: string; event?: string; data: string }[] = [];
  for (const block of text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n\n")) {
    const frame = parseBlock(block);
    if (frame !== null) frames.push(frame);
  }
  return frames;
}

function parseBlock(block: string): { id?: string; event?: string; data: string } | null {
  let id: string | undefined;
  let event: string | undefined;
  const data: string[] = [];

  for (const line of block.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "id") id = value;
    else if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }

  if (id === undefined && event === undefined && data.length === 0) return null;
  return {
    ...(id === undefined ? {} : { id }),
    ...(event === undefined ? {} : { event }),
    data: data.join("\n"),
  };
}

/**
 * Drains an SSE response into envelopes and out-of-band control frames (CONTRACTS.md §8.4).
 *
 * Stops on the first of: `count` envelopes, `until(envelope)`, an `omni.stream_end` control
 * frame, or end of stream. A timeout is a THROW rather than a short result, because a test that
 * silently accepts "nothing arrived" is a test that passes when the daemon is broken.
 */
export async function collectSse(
  res: Response,
  opts: { until?: (e: EventEnvelope) => boolean; count?: number; timeoutMs?: number },
): Promise<{ envelopes: EventEnvelope[]; control: { event: string; data: unknown }[] }> {
  const envelopes: EventEnvelope[] = [];
  const control: { event: string; data: unknown }[] = [];

  const body = res.body;
  if (body === null) {
    throw new OmniError("internal", "collectSse: the response has no body");
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  const timeoutMs = opts.timeoutMs ?? 5_000;
  let satisfied = false;
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => {});
  }, timeoutMs);

  const consume = (block: string): void => {
    const frame = parseBlock(block);
    if (frame === null) return;
    if (frame.event !== undefined && CONTROL_EVENTS.has(frame.event)) {
      control.push({ event: frame.event, data: safeJson(frame.data) });
      if (frame.event === SSE_CONTROL.end) satisfied = true;
      return;
    }
    const envelope = eventEnvelopeSchema.parse(safeJson(frame.data));
    envelopes.push(envelope);
    if (opts.count !== undefined && envelopes.length >= opts.count) satisfied = true;
    if (opts.until?.(envelope) === true) satisfied = true;
  };

  try {
    let buffer = "";
    while (!satisfied) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      for (;;) {
        const at = buffer.indexOf("\n\n");
        if (at === -1) break;
        const block = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        consume(block);
        // Stop at the frame that satisfied the caller: a whole response often arrives in one
        // chunk, and draining the rest would hand back more than was asked for.
        if (satisfied) break;
      }
    }
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => {});
  }

  if (timedOut && !satisfied) {
    throw new OmniError(
      "internal",
      `collectSse timed out after ${timeoutMs}ms with ${envelopes.length} envelope(s)`,
      { detail: { envelopes: envelopes.length, control: control.length } },
    );
  }
  return { envelopes, control };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new OmniError("internal", "collectSse: a frame's data was not JSON", {
      cause: e,
      detail: { data: text },
    });
  }
}
