import { agent as acpAgent, RequestError } from "@agentclientprotocol/sdk";
import { ACP_V1_VERSION, type AcpStream, type StopReason } from "@omni-acp/protocol";
import { memoryStreamPair } from "@omni-acp/testkit";

/**
 * A v1 agent that RECORDS what crossed the wire and in what ORDER, and that can issue either of
 * D10's two agent→client requests.
 *
 * `scriptedAgent()` (testkit, Land-frozen) already has the generic `request()` hook, but it
 * records neither the params of our outbound `initialize` — which is what WP-I acceptance 2 is
 * about, D10's gate checked on OUR OWN BYTES — nor the interleaving of an answer against
 * `session/cancel`, which is what acceptance 9 is about. Both are properties of the wire, so they
 * are observed on the wire.
 *
 * Not a `*.test.ts` file, so vitest does not collect it.
 */

export interface RecordingAgent {
  readonly stream: AcpStream;
  /** Every event in wire order: `recv:<method>`, `answer:<label>`, `error:<label>`. */
  readonly timeline: readonly string[];
  /** Params of the LAST `initialize` — the create half and, after a wake, the wake half. */
  readonly initializeParams: Record<string, unknown> | null;
  /** Params of every `initialize`, in order, so a wake can be compared with its own create. */
  readonly initializeCalls: readonly Record<string, unknown>[];
  readonly sessionIds: readonly string[];
  /** Issues `elicitation/create` with EXACTLY these params and records the client's answer. */
  elicit(label: string, params: Record<string, unknown>): Promise<Answer>;
  /** Issues `session/request_permission` and records the client's answer. */
  requestPermission(label: string, params: Record<string, unknown>): Promise<Answer>;
  update(u: Record<string, unknown>): Promise<void>;
  resolvePrompt(stopReason: StopReason): void;
  die(): void;
}

export type Answer = { readonly result: unknown } | { readonly error: number };

export interface RecordingAgentOptions {
  readonly capabilities?: Record<string, unknown>;
  readonly sessionId?: string;
  /** Advertise a resume spelling, so the worker may be hibernated and woken (M1-R15). */
  readonly resumable?: boolean;
}

export function recordingAgent(opts: RecordingAgentOptions = {}): RecordingAgent {
  const [clientSide, agentSide] = memoryStreamPair();
  const timeline: string[] = [];
  const initializeCalls: Record<string, unknown>[] = [];
  const sessionIds: string[] = [];
  let pending: ((r: { stopReason: string }) => void) | null = null;
  let queued: StopReason | null = null;
  let dead = false;

  const seeded = opts.sessionId ?? "sess_recording";
  const capabilities =
    opts.capabilities ??
    (opts.resumable === true
      ? { loadSession: true, sessionCapabilities: { resume: {}, close: {} } }
      : { loadSession: false });

  const paramsOf = (ctx: unknown): Record<string, unknown> => {
    const raw = (ctx as { params?: unknown } | null)?.params;
    return typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  };

  const app = acpAgent({ name: "recording-agent" })
    .onRequest("initialize", (ctx: unknown) => {
      timeline.push("recv:initialize");
      initializeCalls.push(paramsOf(ctx));
      return {
        protocolVersion: ACP_V1_VERSION,
        agentCapabilities: capabilities as Record<string, never>,
      };
    })
    .onRequest("session/new", () => {
      timeline.push("recv:session/new");
      sessionIds.push(seeded);
      return { sessionId: seeded };
    })
    .onRequest("session/load", (ctx: unknown) => {
      timeline.push("recv:session/load");
      const p = paramsOf(ctx);
      return { sessionId: typeof p["sessionId"] === "string" ? p["sessionId"] : seeded };
    })
    .onRequest("session/resume", (ctx: unknown) => {
      timeline.push("recv:session/resume");
      const p = paramsOf(ctx);
      return { sessionId: typeof p["sessionId"] === "string" ? p["sessionId"] : seeded };
    })
    .onRequest("session/close", () => {
      timeline.push("recv:session/close");
      throw new RequestError(-32601, '"Method not found": session/close');
    })
    .onRequest(
      "session/prompt",
      () =>
        new Promise<{ stopReason: string }>((resolve) => {
          timeline.push("recv:session/prompt");
          if (queued !== null) {
            const stopReason = queued;
            queued = null;
            resolve({ stopReason });
            return;
          }
          pending = resolve;
        }),
    )
    .onNotification("session/cancel", () => {
      // RECORDED rather than acted on: §19.8's claim is that our answer reaches the agent BEFORE
      // this notification does, and an inert handler that logs the arrival is the only way to
      // observe the order from the side that matters.
      timeline.push("recv:session/cancel");
    });

  const connection = app.connect(agentSide);
  const cx = connection.client;

  const ask = async (
    method: string,
    label: string,
    params: Record<string, unknown>,
  ): Promise<Answer> => {
    if (dead) throw new Error("recordingAgent: the agent has died");
    try {
      const result: unknown = await cx.request(method, params);
      timeline.push(`answer:${label}`);
      return { result };
    } catch (e) {
      const code = e instanceof RequestError ? e.code : 0;
      timeline.push(`error:${label}`);
      return { error: code };
    }
  };

  return {
    stream: clientSide,
    timeline,
    initializeCalls,
    get initializeParams(): Record<string, unknown> | null {
      return initializeCalls.at(-1) ?? null;
    },
    sessionIds,
    elicit: (label, params) => ask("elicitation/create", label, params),
    requestPermission: (label, params) => ask("session/request_permission", label, params),
    async update(u) {
      await cx.notify("session/update", { sessionId: sessionIds.at(-1) ?? seeded, update: u });
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
      pending = null;
      queued = null;
      connection.close(new Error("recording agent died"));
    },
  };
}
