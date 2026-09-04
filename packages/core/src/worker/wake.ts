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
 * **Where the single flight actually lives.** `Worker.wake()` is Land-written and frozen, and it
 * owns `#wakePromise` (the single flight), the `starting` admission, the replay window and
 * §15.5's failure mapping — it calls `strategy.reopen` directly. What is left for this function
 * is the composable half: the replay window around ONE reopen, and the error normalisation that
 * keeps `ResumeReport` attached to whatever comes out. It is what a caller that is NOT the frozen
 * `Worker` — the compat suite, a future registry-side wake, a test — uses to make the same call
 * the same way, rather than re-deriving the window and the error mapping a second time.
 *
 * Owned by M1-WP-C.
 */
export async function performWake(
  link: AcpLinkLike,
  strategy: SessionStrategy,
  who: ClientRef,
  o: SessionReopenOptions,
): Promise<SessionOpenResult> {
  // D6's window, opened here as well as inside `attemptResume`. The refcount in the Worker makes
  // the nesting free, and it is what keeps this function correct when it is handed a strategy
  // whose `reopen` does something other than one request — a probe, a retry, a second spelling.
  const closeWindow = o.controls.replayWindow();
  try {
    return await strategy.reopen(link, o);
  } catch (e) {
    // `OmniError.from` returns an existing `OmniError` unchanged, so the `resume` report the
    // strategy attached — the whole point of §15.5's "every 422 carries the full ResumeReport" —
    // survives. `who` rides along in `detail`, which is logged and never returned on the wire:
    // an audit trail for "who woke this worker" costs nothing and cannot leak a token.
    const error = OmniError.from(e, "agent_error");
    if (error.detail === undefined) {
      throw new OmniError(error.code, error.message, {
        cause: error,
        detail: { wokenBy: who.clientId ?? who.tokenId },
        ...(error.acp === undefined ? {} : { acp: error.acp }),
        ...(error.resume === undefined ? {} : { resume: error.resume }),
      });
    }
    throw error;
  } finally {
    closeWindow();
  }
}
