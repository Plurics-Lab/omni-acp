import { agent as acpAgent, RequestError } from "@agentclientprotocol/sdk";
import {
  ACP_V1_VERSION,
  type AcpStream,
  type PermissionOption,
  type StopReason,
} from "@omni-acp/protocol";
import { memoryStreamPair, type ScriptedAgent } from "@omni-acp/testkit";

export interface RawAgent {
  /** Hand this to a fake `AgentProcess`. */
  readonly stream: AcpStream;
  readonly sessionIds: readonly string[];
  /** An arbitrary agent->client request — the only thing `scriptedAgent()` cannot express. */
  request<R = unknown>(method: string, params?: unknown): Promise<R>;
  requestPermission(options: readonly PermissionOption[]): Promise<string | { error: number }>;
  update(u: Record<string, unknown>): Promise<void>;
  resolvePrompt(stopReason: StopReason): void;
  die(): void;
}

export interface RawAgentOptions {
  /** Never answers `initialize`: the handshake-budget and abort paths need this. */
  readonly hangInitialize?: boolean;
  /** Rejects `initialize` with this JSON-RPC error. */
  readonly failInitialize?: { code: number; message: string };
  /** Rejects `session/new` with this JSON-RPC error. */
  readonly failNewSession?: { code: number; message: string };
  /** Rejects `session/prompt` with this JSON-RPC error — the agent is alive, the turn is not. */
  readonly failPrompt?: { code: number; message: string };
  /** What `initialize` reports back as `protocolVersion`. */
  readonly protocolVersion?: number;
  readonly capabilities?: Record<string, unknown>;
  /** ACCEPTS `session/close` and never answers it — the close path's politeness step, stalled. */
  readonly hangSessionClose?: boolean;
}

/**
 * A hand-built ACP v1 agent for the three things testkit's `scriptedAgent()` deliberately does
 * not do: refuse or stall the handshake, answer with a non-1 protocol version, and issue an
 * agent->client request for a method the client never registered (DESIGN §6.2's -32601 rule).
 *
 * Everything else in this package's tests uses `scriptedAgent()`.
 */
export function rawAgent(opts: RawAgentOptions = {}): RawAgent {
  const [clientSide, agentSide] = memoryStreamPair();
  const sessionIds: string[] = [];
  let pending: ((r: { stopReason: string }) => void) | null = null;
  let queued: StopReason | null = null;
  let permissionSeq = 0;
  let dead = false;

  const app = acpAgent({ name: "raw-agent" })
    .onRequest("initialize", () => {
      if (opts.hangInitialize === true) return new Promise<never>(() => {});
      if (opts.failInitialize !== undefined) {
        throw new RequestError(opts.failInitialize.code, opts.failInitialize.message);
      }
      return {
        protocolVersion: opts.protocolVersion ?? ACP_V1_VERSION,
        agentCapabilities: (opts.capabilities ?? { loadSession: false }) as Record<string, never>,
      };
    })
    .onRequest("session/new", () => {
      if (opts.failNewSession !== undefined) {
        throw new RequestError(opts.failNewSession.code, opts.failNewSession.message);
      }
      const sessionId = `raw_${String(sessionIds.length + 1)}`;
      sessionIds.push(sessionId);
      return { sessionId };
    })
    .onRequest(
      "session/prompt",
      () =>
        new Promise<{ stopReason: string }>((resolve, reject) => {
          if (opts.failPrompt !== undefined) {
            reject(new RequestError(opts.failPrompt.code, opts.failPrompt.message));
            return;
          }
          if (queued !== null) {
            const stopReason = queued;
            queued = null;
            resolve({ stopReason });
            return;
          }
          pending = resolve;
        }),
    )
    .onRequest("session/close", () => {
      if (opts.hangSessionClose === true) return new Promise<never>(() => {});
      throw new RequestError(-32601, "session/close is not supported");
    })
    .onNotification("session/cancel", () => {
      // Inert on purpose: the cancel escalation ladder is only reachable if nobody answers.
    });

  const connection = app.connect(agentSide);
  const cx = connection.client;

  const sessionId = (): string => sessionIds.at(-1) ?? "raw_0";

  return {
    stream: clientSide,
    sessionIds,

    request<R = unknown>(method: string, params?: unknown): Promise<R> {
      return cx.request<R>(method, params);
    },

    async requestPermission(options) {
      permissionSeq += 1;
      try {
        const res = (await cx.request("session/request_permission", {
          sessionId: sessionId(),
          toolCall: { toolCallId: `raw_call_${String(permissionSeq)}`, title: "raw permission" },
          options: [...options],
        })) as { outcome: { outcome: string; optionId?: string } };
        return res.outcome.outcome === "selected"
          ? (res.outcome.optionId ?? "")
          : { error: -32800 };
      } catch (e) {
        if (e instanceof RequestError) return { error: e.code };
        throw e;
      }
    },

    async update(u) {
      await cx.notify("session/update", { sessionId: sessionId(), update: u });
    },

    resolvePrompt(stopReason) {
      const resolve = pending;
      pending = null;
      if (resolve === null) {
        queued = stopReason;
        return;
      }
      resolve({ stopReason });
    },

    die() {
      if (dead) return;
      dead = true;
      connection.close(new Error("raw agent died"));
    },
  };
}

/**
 * `fakeSupervisor().enqueue()` takes a `ScriptedAgent`, but only ever touches `.stream` and
 * `.die()` — so a `RawAgent` is a valid stand-in wherever the extra reach is what the test is
 * about. The cast is confined to this one function.
 */
export function asScriptedAgent(raw: RawAgent): ScriptedAgent {
  return raw as unknown as ScriptedAgent;
}
