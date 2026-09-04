import { loadTranscript, transcriptNames, transcriptUpdates } from "@omni-acp/testkit";

/**
 * The corpus queries the tests need, DERIVED from `loadTranscript`.
 *
 * They live here rather than in `@omni-acp/testkit` because that package's `index.ts` is a frozen
 * `export *` barrel and `exports-are-stable` pins its surface to CONTRACTS.md §5.7's list exactly
 * — `loadTranscript`, `transcriptNames`, `transcriptUpdates`, `wireAgentPath`. Adding a helper to
 * the barrel would be a published-surface change disguised as a test convenience, and every one
 * of these is a handful of lines over a function that IS published.
 */

interface WireMessage {
  readonly method?: unknown;
  readonly id?: unknown;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

/** Every recorded update across every transcript, tagged with the scenario it came from. */
export function allTranscriptUpdates(): readonly {
  readonly name: string;
  readonly index: number;
  readonly update: Record<string, unknown>;
}[] {
  return transcriptNames().flatMap((name) =>
    transcriptUpdates(name).map((update, index) => ({ name, index, update })),
  );
}

/** Every `agent->client` REQUEST (never a notification) whose method is `method`. */
export function transcriptRequests(
  name: string,
  method: string,
): readonly Record<string, unknown>[] {
  return loadTranscript(name).flatMap((line) => {
    if (line.dir !== "agent->client") return [];
    const msg = line.msg as WireMessage | undefined;
    if (msg?.method !== method || msg.id === undefined) return [];
    return typeof msg.params === "object" && msg.params !== null
      ? [msg.params as Record<string, unknown>]
      : [];
  });
}

/** The agent's answer to the client request with this id — the `initialize` / `session/new` body. */
export function transcriptResult(name: string, id: number): unknown {
  for (const line of loadTranscript(name)) {
    if (line.dir !== "agent->client") continue;
    const msg = line.msg as WireMessage | undefined;
    if (msg?.id === id && msg.result !== undefined) return msg.result;
  }
  return undefined;
}

/** The agent's JSON-RPC error for the client request with this id, or `undefined`. */
export function transcriptError(name: string, id: number): unknown {
  for (const line of loadTranscript(name)) {
    if (line.dir !== "agent->client") continue;
    const msg = line.msg as WireMessage | undefined;
    if (msg?.id === id && msg.error !== undefined) return msg.error;
  }
  return undefined;
}
