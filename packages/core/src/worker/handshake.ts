import {
  ACP_V1_VERSION,
  OmniError,
  type AgentCapabilitiesSnapshot,
  type Clock,
  type PromptCapabilities,
  type SessionId,
  type TimerHandle,
} from "@omni-acp/protocol";
import type { AcpLink } from "../acp/link.js";

export interface HandshakeResult {
  readonly capabilities: AgentCapabilitiesSnapshot;
  readonly sessionId: SessionId;
}

function record(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/**
 * One budget for the WHOLE handshake, not one per request.
 *
 * `initialize` and `session/new` are two round trips against the same cold process; charging
 * each of them the full `timeoutMs` would make the worst case twice the number an operator
 * configured, and `POST /v1/workers` holds an HTTP request open for exactly this window (D17).
 */
function budget(o: { timeoutMs: number; clock: Clock; signal?: AbortSignal }): {
  race<T>(p: Promise<T>): Promise<T>;
  dispose(): void;
} {
  let timer: TimerHandle | null = null;
  let onAbort: (() => void) | null = null;
  let settled = false;

  const failure = new Promise<never>((_resolve, reject) => {
    const fail = (e: OmniError): void => {
      if (settled) return;
      settled = true;
      reject(e);
    };

    if (o.signal?.aborted === true) {
      fail(new OmniError("agent_timeout", "handshake aborted before it started"));
      return;
    }

    timer = o.clock.setTimer(o.timeoutMs, () => {
      fail(
        new OmniError("agent_timeout", `handshake exceeded ${String(o.timeoutMs)}ms`, {
          detail: { timeoutMs: o.timeoutMs },
        }),
      );
    });

    if (o.signal !== undefined) {
      onAbort = (): void => {
        fail(new OmniError("agent_timeout", "handshake aborted"));
      };
      o.signal.addEventListener("abort", onAbort, { once: true });
    }
  });

  // The loser of every race is this promise, and an unobserved rejection is a process-level
  // warning (and a crash under --unhandled-rejections=strict). One permanent sink, here.
  failure.catch(() => {});

  return {
    race<T>(p: Promise<T>): Promise<T> {
      return Promise.race([p, failure]);
    },
    dispose(): void {
      settled = true;
      timer?.cancel();
      timer = null;
      if (onAbort !== null && o.signal !== undefined) {
        o.signal.removeEventListener("abort", onAbort);
        onAbort = null;
      }
    },
  };
}

/**
 * `initialize{protocolVersion: 1, clientCapabilities: {}}` then
 * `session/new{cwd, mcpServers: []}` — always the empty array in M0; MCP presets are M2
 * (DESIGN §8).
 *
 * `clientCapabilities: {}` is D3, and it is a decision rather than an omission: the spec makes
 * an agent responsible for not calling `fs/*` or `terminal/*` it was not offered, every runtime
 * surveyed works under `{}`, and a headless daemon has no editor buffer for those methods to
 * expose in the first place.
 *
 * Internal to WP-4; not part of CONTRACTS.md §5. The budget lives here; the tree reclamation on
 * every failure edge belongs to `createWorker`, which is the only caller.
 */
export async function runHandshake(
  link: AcpLink,
  o: { cwd: string; timeoutMs: number; clock: Clock; signal?: AbortSignal },
): Promise<HandshakeResult> {
  const window = budget(o);
  try {
    const initRaw = await window.race(
      link.request<unknown>("initialize", {
        protocolVersion: ACP_V1_VERSION,
        clientCapabilities: {},
      }),
    );

    const init = record(initRaw);
    if (init === null) {
      throw new OmniError("agent_error", "initialize returned a non-object response");
    }

    // M0 negotiates 1 and only 1 (CONTRACTS.md §1). An agent answering with anything else has
    // not agreed to speak the dialect the Normalizer is written against, and pretending
    // otherwise would put un-mappable frames into the canonical log.
    const negotiated = init["protocolVersion"];
    if (negotiated !== ACP_V1_VERSION) {
      throw new OmniError(
        "agent_error",
        `agent negotiated ACP protocol version ${String(negotiated)}; M0 speaks ${String(ACP_V1_VERSION)}`,
        { detail: { negotiated } },
      );
    }

    const raw = record(init["agentCapabilities"]) ?? {};
    const sessionCaps = record(raw["sessionCapabilities"]);
    const capabilities: AgentCapabilitiesSnapshot = {
      protocolVersion: 1,
      // Verbatim, never reshaped: the M1 quirk table and the compat suite both read the real
      // thing, and a rebuilt object would have silently dropped whatever they need.
      raw,
      loadSession: raw["loadSession"] === true,
      promptCapabilities: (record(raw["promptCapabilities"]) as PromptCapabilities | null) ?? null,
      // `SessionCapabilities.close` is an OBJECT capability: present-and-non-null means yes,
      // `{}` included. `=== true` would read every advertising agent as not advertising.
      supportsSessionClose:
        sessionCaps !== null && sessionCaps["close"] !== undefined && sessionCaps["close"] !== null,
    };

    const newRaw = await window.race(
      link.request<unknown>("session/new", { cwd: o.cwd, mcpServers: [] }),
    );

    const created = record(newRaw);
    const sessionId = created === null ? undefined : created["sessionId"];
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new OmniError("agent_error", "session/new returned no sessionId");
    }

    return { capabilities, sessionId };
  } catch (e) {
    // `agent_error` is the fallback rather than `internal`: everything reachable here came back
    // from — or died with — the agent process, and §2.1 H5 maps that to 502. `OmniError.from`
    // still routes an `acp.RequestError` to `agent_error` WITH its `acp` body, and an
    // abort/timeout to `agent_timeout` (504), which is the 502/504 split H5 asks for.
    throw OmniError.from(e, "agent_error");
  } finally {
    window.dispose();
  }
}
