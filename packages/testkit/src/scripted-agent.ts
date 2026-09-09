import { agent as acpAgent } from "@agentclientprotocol/sdk";
import {
  ACP_V1_VERSION,
  AcpRequestError,
  OmniError,
  type AcpStream,
  type AgentCapabilities,
  type PermissionOption,
  type RequestPermissionResponse,
  type StopReason,
  type V1PromptResponse,
} from "@omni-acp/protocol";
import { memoryStreamPair } from "./memory-stream.js";

/** A scriptable ACP v1 agent built on the SDK's public acp.agent() builder. */
export interface ScriptedAgent {
  /** Hand this to FakeAgentProcess. */
  readonly stream: AcpStream;
  readonly sessionIds: readonly string[];
  emitChunk(text: string): Promise<void>;
  emitThought(text: string): Promise<void>;
  emitToolCall(u: Record<string, unknown>): Promise<void>;
  emitDiff(
    toolCallId: string,
    path: string,
    oldText: string | null,
    newText: string,
  ): Promise<void>;
  emitUsage(used: number, size: number): Promise<void>;
  /** Issues session/request_permission and resolves with the option the client chose. */
  requestPermission(options: readonly PermissionOption[]): Promise<string | { error: number }>;
  /**
   * The GENERIC agent→client request (M2-PLAN §1.1's "+1 generic client-request hook", review
   * R13): send ANY agent-to-client method and receive the client's answer.
   *
   * `requestPermission` above is the one shape M0 needed hard-coded; M2 has a second
   * (`elicitation/create`) and D10 says they are ONE lifecycle, so the fixture gets one verb for
   * both rather than a second special case. `params` reaches the wire untouched — that is the
   * whole point for elicitation, where a schema parse would strip the
   * `_meta._askUserQuestionCustomAnswer` marker and the flat scope (F29, F30).
   *
   * Resolves with the client's result, or `{error: code}` for a JSON-RPC error — `-32800` when
   * the client cancelled — so a fixture asserts on the ANSWER without a try/catch per call.
   */
  request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<{ result: unknown } | { error: number }>;
  resolvePrompt(stopReason: StopReason): void;
  /** Emit an update `ms` after the prompt response has already returned (the L5 case). */
  emitAfterPromptResolves(ms: number, text: string): void;
  hang(): void;
  die(): void;
  setCapabilities(caps: Record<string, unknown>): void;
}

/**
 * Method names as plain `string`s on purpose: it selects the SDK's untyped `notify`/`request`
 * overload, so a fixture can emit an update shape the generated v1 union does not model — which
 * is most of what a test double is for. The literal spellings are still checked by the real
 * client on the other end of the pair.
 */
const SESSION_UPDATE: string = "session/update";
const REQUEST_PERMISSION: string = "session/request_permission";

/** JSON-RPC "request cancelled" (LSP's -32800). M0's responder never produces this (D4 rule 5). */
const CANCELLED = -32800;

export function scriptedAgent(opts?: { name?: string }): ScriptedAgent {
  const [clientSide, agentSide] = memoryStreamPair();
  const sessionIds: string[] = [];

  let capabilities: Record<string, unknown> = { loadSession: false };
  let hanging = false;
  let dead = false;
  let pending: ((r: V1PromptResponse) => void) | null = null;
  let queuedStop: StopReason | null = null;
  let resolvedCount = 0;
  let afterPrompt: { ms: number; text: string } | null = null;
  let permissionSeq = 0;

  const app = acpAgent({ name: opts?.name ?? "scripted-agent" })
    .onRequest("initialize", () => ({
      protocolVersion: ACP_V1_VERSION,
      agentCapabilities: capabilities as AgentCapabilities,
    }))
    .onRequest("session/new", () => {
      const sessionId = `sess_${sessionIds.length + 1}`;
      sessionIds.push(sessionId);
      return { sessionId };
    })
    .onRequest(
      "session/prompt",
      () =>
        // Never settles on its own: the script decides when the turn ends, which is what makes
        // the quiet window, cancel escalation and crash-mid-turn cases reachable at all.
        new Promise<V1PromptResponse>((resolve) => {
          if (hanging) return;
          if (queuedStop !== null) {
            // `resolvePrompt()` ran before the request finished crossing the stream. Settling
            // it here is what lets a test be written without sleeping on a delivery race.
            const stopReason = queuedStop;
            queuedStop = null;
            settle(resolve, stopReason);
            return;
          }
          pending = resolve;
        }),
    )
    .onNotification("session/cancel", () => {
      // Deliberately inert: `cancel()` must be observed by the CLIENT sending it, and a fixture
      // that auto-resolved here would hide the escalation path (CONTRACTS.md §6.5).
    });

  const connection = app.connect(agentSide);
  const cx = connection.client;

  const sessionId = (): string => {
    const id = sessionIds.at(-1);
    if (id === undefined) {
      throw new OmniError("internal", "scriptedAgent: no session yet — call session/new first");
    }
    return id;
  };

  const update = async (u: Record<string, unknown>): Promise<void> => {
    if (dead) throw new OmniError("internal", "scriptedAgent: the agent has died");
    await cx.notify(SESSION_UPDATE, { sessionId: sessionId(), update: u });
  };

  const settle = (resolve: (r: V1PromptResponse) => void, stopReason: StopReason): void => {
    resolvedCount += 1;
    // v1's StopReason is a closed union and v2's is open; the fixture speaks v1 on the wire.
    resolve({ stopReason: stopReason as V1PromptResponse["stopReason"] });
    scheduleAfterPrompt();
  };

  const scheduleAfterPrompt = (): void => {
    const job = afterPrompt;
    if (job === null) return;
    afterPrompt = null;
    setTimeout(() => {
      void update({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: job.text },
      }).catch(() => {});
    }, job.ms).unref?.();
  };

  return {
    stream: clientSide,
    sessionIds,

    emitChunk: (text) =>
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } }),
    emitThought: (text) =>
      update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text } }),
    emitToolCall: (u) => update({ sessionUpdate: "tool_call", ...u }),
    emitDiff: (toolCallId, path, oldText, newText) =>
      update({
        sessionUpdate: "tool_call_update",
        toolCallId,
        content: [{ type: "diff", path, oldText, newText }],
      }),
    emitUsage: (used, size) => update({ sessionUpdate: "usage_update", used, size }),

    async requestPermission(options) {
      if (dead) throw new OmniError("internal", "scriptedAgent: the agent has died");
      permissionSeq += 1;
      const toolCallId = `call_${permissionSeq}`;
      try {
        const res = (await cx.request(REQUEST_PERMISSION, {
          sessionId: sessionId(),
          toolCall: { toolCallId, title: `scripted permission ${permissionSeq}` },
          options: [...options],
        })) as RequestPermissionResponse;
        return res.outcome.outcome === "selected" ? res.outcome.optionId : { error: CANCELLED };
      } catch (e) {
        if (e instanceof AcpRequestError) return { error: e.code };
        throw e;
      }
    },

    async request(method, params) {
      if (dead) throw new OmniError("internal", "scriptedAgent: the agent has died");
      try {
        // The same untyped `request` overload `requestPermission` selects: a fixture must be able
        // to send a method the generated v1 union does not model, which is most of what a test
        // double is for.
        return { result: await cx.request(method, params) };
      } catch (e) {
        if (e instanceof AcpRequestError) return { error: e.code };
        throw e;
      }
    },

    resolvePrompt(stopReason) {
      const resolve = pending;
      pending = null;
      if (resolve === null) {
        // The request has not crossed the stream yet; the handler will settle it on arrival.
        queuedStop = stopReason;
        return;
      }
      settle(resolve, stopReason);
    },

    emitAfterPromptResolves(ms, text) {
      afterPrompt = { ms, text };
      // If a prompt has already returned and none is outstanding, "after the response" is now.
      if (resolvedCount > 0 && pending === null && queuedStop === null) scheduleAfterPrompt();
    },

    hang() {
      hanging = true;
      pending = null;
      queuedStop = null;
    },

    die() {
      if (dead) return;
      dead = true;
      pending = null;
      queuedStop = null;
      connection.close(new Error("scripted agent died"));
    },

    setCapabilities(caps) {
      capabilities = caps;
    },
  };
}
