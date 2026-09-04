/**
 * D2's resume four-state (CONTRACTS.md §5.1 `src/resume.ts`, §15).
 *
 * TYPES ONLY. `classifyResume` (core, M1-WP-C) is the pure, rule-numbered function that produces
 * a `ResumeReport`; nothing here decides anything.
 */

import type { AcpErrorDetail } from "./errors.js";
import type { SessionId } from "./ids.js";

export type ResumeMethod = "session/load" | "session/resume";

/** D2's four states, verbatim. NEVER a boolean, at any layer. */
export const RESUME_OUTCOMES = [
  "landed",
  "rejected_permanent",
  "rejected_transient",
  "unknown",
] as const;
export type ResumeOutcome = (typeof RESUME_OUTCOMES)[number];

/**
 * `hint` is the evidence, so an operator can argue with the classifier instead of guessing, and
 * so a compat run can assert the DIAGNOSIS separately from the ACTION. Two rows may share an
 * `outcome` and differ only here — `cwd_mismatch` and `unclassified` are both `unknown` and both
 * keep the pointer, but only one of them is recoverable by fixing the request (F15, §15.4).
 */
export type ResumeHint =
  | "ok"
  | "cwd_mismatch"
  | "not_found"
  | "silently_created"
  | "refusal_no_activity"
  | "capability_absent"
  | "method_not_found"
  | "transport"
  | "timeout"
  | "rate_limited"
  | "unclassified";

export interface ResumeReport {
  readonly outcome: ResumeOutcome;
  readonly hint: ResumeHint;
  /** Which rule fired, verbatim, e.g. "rule4:unclassified-jsonrpc". Auditable classification. */
  readonly rule: string;
  readonly method: ResumeMethod | null;
  /** The session id we ASKED for. */
  readonly requested: SessionId | null;
  /** The session actually in force AFTER the attempt. `!== requested` is itself the evidence. */
  readonly landedOn: SessionId | null;
  /**
   * true when the AGENT's model context is provably gone. The daemon's own event log still has
   * every envelope — this is D2's "保得住发生过什么，保不住 agent 进程内的模型上下文", made a field.
   */
  readonly historyLost: boolean;
  /** The agent's JSON-RPC error, passed through, never reshaped. */
  readonly acp: AcpErrorDetail | null;
  /** `session/update` notifications observed inside the replay window (F16). */
  readonly replayedEvents: number;
  /** Non-zero only when `resume.replay: "drop_duplicates"` is enabled (ruling M1-R5). */
  readonly replayDropped: number;
  readonly durationMs: number;
  readonly at: string;
}

/**
 * Everything `classifyResume` is allowed to look at — CONTRACTS.md §15.4's table is written
 * against exactly this record, and the classifier is pure over it (no clock, no process, no
 * network). It is declared here rather than in `core` because the compat suite and the testkit
 * both build one, and neither may depend on `core`'s internals (§4).
 */
export interface ResumeAttempt {
  readonly method: ResumeMethod | null;
  readonly requested: SessionId | null;
  /** The session id the agent reported after the attempt, when it reported one at all. */
  readonly returned: SessionId | null;
  /** The agent's JSON-RPC error, or null on a resolved call. */
  readonly acp: AcpErrorDetail | null;
  /** true when the call never produced a JSON-RPC answer (dead transport, abort, timeout). */
  readonly transportFailed: boolean;
  readonly timedOut: boolean;
  /** `session/update` notifications seen inside the replay window (F16). */
  readonly replayedEvents: number;
  readonly replayDropped: number;
  /** false when the handshake advertised no resume spelling at all (§15.5). */
  readonly capabilityAdvertised: boolean;
  readonly requiresSameCwd: boolean;
  readonly cwdChanged: boolean;
  readonly durationMs: number;
  readonly at: string;
}
