import { OmniError } from "@omni-acp/protocol";

/**
 * The claude-acp corpus loader — `docs/research/transcripts/claude-acp-0.73.0/*.jsonl`, 11
 * processes, 407 lines, the M1 ground truth (CONTRACTS.md §5.7).
 *
 * `dir:"meta"` lines are dropped. The repository root is resolved FROM THIS PACKAGE, never from
 * `process.cwd()`, so the golden suite runs identically from any directory.
 *
 * Owned by M1-WP-B.
 */
export interface TranscriptLine {
  dir: "client->agent" | "agent->client" | "stderr" | "meta";
  tMs: number;
  msg?: unknown;
  raw?: string;
}

export function loadTranscript(_name: string): readonly TranscriptLine[] {
  throw new OmniError("internal", "unimplemented: M1-WP-B");
}

export function transcriptNames(): readonly string[] {
  throw new OmniError("internal", "unimplemented: M1-WP-B");
}

/** Every `agent->client` `session/update` param, in wire order. 216 across the 11 files. */
export function transcriptUpdates(_name: string): readonly Record<string, unknown>[] {
  throw new OmniError("internal", "unimplemented: M1-WP-B");
}
