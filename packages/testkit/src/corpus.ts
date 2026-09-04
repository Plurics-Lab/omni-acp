import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OmniError } from "@omni-acp/protocol";

/**
 * The claude-acp corpus loader — `docs/research/transcripts/claude-acp-0.73.0/*.jsonl`, 11
 * processes, 407 lines, the M1 ground truth (CONTRACTS.md §5.7).
 *
 * `dir:"meta"` lines are dropped: they are the recorder's own annotations (`process_spawn`,
 * `scenario`, `permission_decision`, …) and not wire traffic.
 *
 * The repository root is resolved FROM THIS PACKAGE, never from `process.cwd()`, so the golden
 * suite runs identically from any directory — and through `fileURLToPath`, never
 * `new URL(...).pathname`, which yields `/C:/…` on Windows.
 *
 * Owned by M1-WP-B.
 */
export interface TranscriptLine {
  dir: "client->agent" | "agent->client" | "stderr" | "meta";
  tMs: number;
  msg?: unknown;
  raw?: string;
}

/** `<repo>/docs/research/transcripts/claude-acp-0.73.0`, from `dist/corpus.js` or `src`. */
export function transcriptDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/corpus.js  ->  packages/testkit  ->  packages  ->  <repo root>
  return join(here, "..", "..", "..", "docs", "research", "transcripts", "claude-acp-0.73.0");
}

/** The 11 scenario names, without the `.jsonl` suffix, in lexical (= scenario) order. */
export function transcriptNames(): readonly string[] {
  return readdirSync(transcriptDir())
    .filter((f) => f.endsWith(".jsonl"))
    .sort()
    .map((f) => f.slice(0, -".jsonl".length));
}

/**
 * One transcript, `meta` lines dropped, in wire order.
 *
 * A malformed line FAILS rather than being skipped: this corpus is checked into the repository
 * and is the ground truth for every golden in M1, so a line that will not parse means the file
 * changed under us — which is exactly the event a silent `continue` would hide.
 */
export function loadTranscript(name: string): readonly TranscriptLine[] {
  const file = join(transcriptDir(), `${name}.jsonl`);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    throw new OmniError("internal", `no such transcript: ${name}`, {
      detail: { file, error: String(e) },
    });
  }
  const out: TranscriptLine[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || line.trim() === "") continue;
    let parsed: TranscriptLine;
    try {
      parsed = JSON.parse(line) as TranscriptLine;
    } catch (e) {
      throw new OmniError("internal", `transcript ${name} line ${String(i + 1)} is not JSON`, {
        detail: { error: String(e) },
      });
    }
    if (parsed.dir === "meta") continue;
    out.push(parsed);
  }
  return out;
}

interface SessionUpdateMessage {
  method?: unknown;
  params?: { update?: unknown };
}

/**
 * Every `agent->client` `session/update` param, in wire order. 216 across the 11 files.
 *
 * The UPDATE, not the notification: `params` is always `{sessionId, update}` on this agent, and
 * the map's subject is the `update` object.
 */
export function transcriptUpdates(name: string): readonly Record<string, unknown>[] {
  return loadTranscript(name).flatMap((line) => {
    if (line.dir !== "agent->client") return [];
    const msg = line.msg as SessionUpdateMessage | undefined;
    if (msg?.method !== "session/update") return [];
    const update = msg.params?.update;
    return typeof update === "object" && update !== null
      ? [update as Record<string, unknown>]
      : [];
  });
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
    const msg = line.msg as { method?: unknown; id?: unknown; params?: unknown } | undefined;
    if (msg?.method !== method || msg.id === undefined) return [];
    const params = msg.params;
    return typeof params === "object" && params !== null
      ? [params as Record<string, unknown>]
      : [];
  });
}

/** The agent's answer to the client request with this id — the `initialize` / `session/new` body. */
export function transcriptResult(name: string, id: number): unknown {
  for (const line of loadTranscript(name)) {
    if (line.dir !== "agent->client") continue;
    const msg = line.msg as { id?: unknown; result?: unknown } | undefined;
    if (msg?.id === id && msg.result !== undefined) return msg.result;
  }
  return undefined;
}

/** The agent's JSON-RPC error for the client request with this id, or `undefined`. */
export function transcriptError(name: string, id: number): unknown {
  for (const line of loadTranscript(name)) {
    if (line.dir !== "agent->client") continue;
    const msg = line.msg as { id?: unknown; error?: unknown } | undefined;
    if (msg?.id === id && msg.error !== undefined) return msg.error;
  }
  return undefined;
}
