import {
  type AcpLinkLike,
  type ResumeMethod,
  type SessionId,
  type SessionReopenOptions,
} from "@omni-acp/protocol";

/**
 * The resume CALL — the descriptor's preferred spelling, the replay window, and the raw material
 * `classifyResume` then judges (CONTRACTS.md §15.3).
 *
 * The window is opened by the WORKER and closed in a `finally`: F16 measured it exact and
 * uninterleaved (`session/load` request at 943.8 ms, replay updates at 1491.9 / 1492.5 ms,
 * response at 1493.1 ms, first NON-replay update at 1495.3 ms), so "everything between the
 * request and its response is replay" is literally correct for this agent. Closing it anywhere
 * but a `finally` leaves a rejected resume marking the NEXT turn's updates as replay.
 *
 * Owned by M1-WP-C.
 */
export async function attemptResume(
  link: AcpLinkLike,
  method: ResumeMethod,
  sessionId: SessionId,
  o: SessionReopenOptions,
): Promise<unknown> {
  // Opened on the SYNCHRONOUS prefix of this async function — an async body runs up to its first
  // `await` during the call itself — so the flag is set before `link.request` writes a byte, and
  // no replay notification can arrive ahead of it.
  const closeWindow = o.controls.replayWindow();
  try {
    // `return await`, not `return`: without the await the `finally` runs before the response
    // arrives, and the window would close over an empty interval. This is the load-bearing line
    // of the whole replay contract, and the `finally` around it is the other half — a REJECTED
    // resume that left the window open would mark the NEXT live turn's updates as replay, and a
    // consumer filtering `replay: true` would then silently drop a real turn.
    return await link.request<unknown>(method, resumeParams(method, sessionId, o));
  } finally {
    closeWindow();
  }
}

/**
 * `{sessionId, cwd, mcpServers}` — the same three the v1 schema gives `session/load`, and the
 * ones `session/resume` accepts too (corpus `07`, F18).
 *
 * `replayFrom` is sent ONLY when the agent's own `sessionCapabilities.resume` advertised the
 * parameter. F18 records claude-acp accepting `replayFrom: {type:"start"}` and IGNORING it;
 * sending a parameter that is ignored buys nothing and costs us the ability to tell an agent
 * that honours it from one that does not.
 */
function resumeParams(
  method: ResumeMethod,
  sessionId: SessionId,
  o: SessionReopenOptions,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    sessionId,
    cwd: o.cwd,
    mcpServers: [...o.mcpServers],
  };
  if (o.capabilities?.resume.replayFrom === true && method === "session/resume") {
    base["replayFrom"] = { type: "start" };
  }
  return base;
}
