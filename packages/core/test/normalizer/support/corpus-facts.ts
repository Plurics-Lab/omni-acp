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

/**
 * The M1 GROUND TRUTH: the eleven claude-acp scenarios CONTRACTS.md §12.7(b) states its eight
 * properties over, named rather than globbed.
 *
 * The corpus DIRECTORY grew for M2 — `11-permission-allow-with-updates` through
 * `17-resource-link-in-and-outside-cwd` were recorded for the interaction, config-option,
 * watchdog and prompt-containment work packages — and the M1 conformance suite must not silently
 * change what it asserts when it does. §12.7(b)'s counts (216 updates, 86 chunks, the kind
 * distribution) are statements about THESE eleven files; a `readdir` here would have quietly
 * restated them about whatever the directory happens to hold, which is the opposite of a golden.
 *
 * `transcriptNames()` still reports the whole directory, and `corpus.test.ts` asserts BOTH
 * numbers, so a transcript that is added and then never used by anybody is still visible.
 */
export const M1_TRANSCRIPTS: readonly string[] = [
  "01-plain-answer",
  "02-tool-read",
  "03-tool-write-allowed",
  "04-tool-write-denied",
  "05-plan",
  "05b-plan-natural-phrasing",
  "06-cancel-mid-turn",
  "07-session-load",
  "08-set-model-extension",
  "09-permission-bad-option-id",
  "10-tool-edit-existing",
];

/** Every recorded update across the M1 corpus, tagged with the scenario it came from. */
export function allTranscriptUpdates(): readonly {
  readonly name: string;
  readonly index: number;
  readonly update: Record<string, unknown>;
}[] {
  return M1_TRANSCRIPTS.flatMap((name) =>
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
