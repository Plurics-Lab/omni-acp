import { OmniError } from "@omni-acp/protocol";
import type { CreateRunRequest, EventEnvelope, RunId, RunSnapshot } from "@omni-acp/protocol";
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

export function createRunsChannel(_transport: Transport): RunsChannel {
  throw new OmniError("internal", "unimplemented: M2-B-WP-R");
}
