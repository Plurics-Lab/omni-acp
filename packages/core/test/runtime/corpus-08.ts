import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Corpus `08-set-model-extension.jsonl`, read straight off disk.
 *
 * NOT through testkit's `loadTranscript()`: that loader is M1-WP-B's and is a throwing stub in
 * this tree, and the whole point of the §17.4 verdict table is that it is checked against the
 * BYTES the agent actually put on the wire. Reading the file here keeps this suite green while
 * WP-B is still in flight and keeps the classifier's ground truth one hop from the recording.
 *
 * The path is resolved from THIS MODULE's URL, never from `process.cwd()`, so the suite runs
 * identically from any directory (and from `dist`, which vitest does not use but the rule is
 * cheap to keep).
 */
const CORPUS_08 = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "docs",
  "research",
  "transcripts",
  "claude-acp-0.73.0",
  "08-set-model-extension.jsonl",
);

export interface CorpusLine {
  readonly dir: string;
  readonly tMs: number;
  readonly msg?: unknown;
  readonly raw?: string;
}

export function corpus08(): readonly CorpusLine[] {
  return readFileSync(CORPUS_08, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as CorpusLine);
}

/** The client→agent request whose JSON-RPC id is `id`, and the agent's answer to it. */
export function exchange(id: number): { request: Record<string, unknown>; response: unknown } {
  const lines = corpus08();
  let request: Record<string, unknown> | null = null;
  let response: unknown;
  for (const line of lines) {
    // `stderr` lines carry `raw` and a null `msg`; `meta` lines carry a recorder note.
    const msg = line.msg as Record<string, unknown> | null | undefined;
    if (msg === null || msg === undefined || msg["id"] !== id) continue;
    if (line.dir === "client->agent") request = msg;
    if (line.dir === "agent->client") response = msg;
  }
  if (request === null || response === undefined) {
    throw new Error(`corpus 08 has no complete exchange for id ${String(id)}`);
  }
  return { request, response };
}
