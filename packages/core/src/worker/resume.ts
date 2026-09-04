import {
  OmniError,
  type AcpLinkLike,
  type ResumeMethod,
  type SessionId,
  type SessionReopenOptions,
} from "@omni-acp/protocol";

/**
 * The resume CALL — the descriptor's preferred spelling, the replay window, and the raw material
 * `classifyResume` then judges (§15.3).
 *
 * The window is opened by the WORKER and closed in a `finally`: F16 measured it exact and
 * uninterleaved (`session/load` request at 943.8 ms, replay updates at 1491.9 / 1492.5 ms,
 * response at 1493.1 ms, first NON-replay update at 1495.3 ms), so "everything between the
 * request and its response is replay" is literally correct for this agent. Closing it anywhere
 * but a `finally` leaves a rejected resume marking the NEXT turn's updates as replay.
 *
 * Owned by M1-WP-C.
 */
export function attemptResume(
  _link: AcpLinkLike,
  _method: ResumeMethod,
  _sessionId: SessionId,
  _o: SessionReopenOptions,
): Promise<unknown> {
  throw new OmniError("internal", "unimplemented: M1-WP-C");
}
