import {
  OmniError,
  type AcpLinkLike,
  type ClientRef,
  type SessionOpenResult,
  type SessionReopenOptions,
  type SessionStrategy,
} from "@omni-acp/protocol";

/**
 * `hibernated -> ready`: spawn → `initialize` → the descriptor's preferred resume spelling →
 * `classifyResume` → `landed` / `rejected_permanent` / `rejected_transient` / `unknown` (§15.5).
 *
 * Idempotent and SINGLE-FLIGHT — concurrent callers share ONE attempt, because five racing
 * prompts must not become five `npx` cold starts. `maxWakeFailures` consecutive TRANSIENT
 * failures abandon the pointer (`wake_failed`), which is what stops a worker whose agent binary
 * was uninstalled from paying a 7 s spawn on every prompt forever.
 *
 * The `link` parameter is first and is not optional: `SessionStrategy.reopen(link, o)` is the one
 * call this function exists to make, and a signature that could not name a link could not make it
 * (review R13). It is the narrow `AcpLinkLike`, which is all a strategy may touch (§5.1).
 *
 * Owned by M1-WP-C.
 */
export function performWake(
  _link: AcpLinkLike,
  _strategy: SessionStrategy,
  _who: ClientRef,
  _o: SessionReopenOptions,
): Promise<SessionOpenResult> {
  throw new OmniError("internal", "unimplemented: M1-WP-C");
}
