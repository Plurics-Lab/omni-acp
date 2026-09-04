import { OmniError } from "@omni-acp/protocol";

/**
 * The acceptance script of `docs/M1-PLAN.md` §4, as named cases — the IDENTICAL script for every
 * configured agent, which is DESIGN §11's M1 criterion made mechanical.
 *
 * A case declares what it NEEDS (`requires`), so an agent that cannot resume skips the resume
 * cases with `source: "capability"` instead of failing them, and the report says so.
 *
 * Owned by M1-WP-F.
 */
export interface CompatCase {
  readonly id: string;
  /** Capabilities this case needs; missing ones become a `capability` skip, never a failure. */
  readonly requires: readonly string[];
  run(ctx: CompatContext): Promise<void>;
}

export interface CompatContext {
  readonly agentId: string;
  readonly serverUrl: string;
  readonly token: string;
  readonly cwd: string;
}

/**
 * The case list, in the order §4 runs them:
 *
 *  - `tool-turn`            a tool-using turn completes with the same observable `TurnResult` shape
 *  - `sse-reconnect`        an SSE stream dropped mid-turn and reconnected with `?since=` yields a
 *                           union BYTE-IDENTICAL to an uninterrupted observer's, and gap-free
 *  - `hibernate-wake`       a worker forced to `hibernated` by a small `idleTimeoutMs` wakes on the
 *                           next prompt with a `ResumeReport` whose `outcome` is `landed`
 *  - `resume-cwd-mismatch`  F15's unrecorded `-32002` re-observed LIVE, so the claim becomes
 *                           reproducible instead of resting on a README
 *  - `lease-contention`     a second client's `prompt` is `423` with the holder named; its `steal`
 *                           transfers the lease, bumps the epoch, and makes the first client's
 *                           next call `423`
 */
export function compatCases(): readonly CompatCase[] {
  throw new OmniError("internal", "unimplemented: M1-WP-F");
}
