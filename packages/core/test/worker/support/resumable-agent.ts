import { agent as acpAgent, RequestError } from "@agentclientprotocol/sdk";
import { ACP_V1_VERSION, type AcpStream, type StopReason } from "@omni-acp/protocol";
import { memoryStreamPair, type ScriptedAgent } from "@omni-acp/testkit";

/**
 * An ACP v1 agent that can be RESUMED — the one thing neither `scriptedAgent()` (testkit,
 * frozen for M1) nor this package's `rawAgent()` models.
 *
 * It exists for §15.3's wake path and §15.4's classifier, and it is deliberately more scriptable
 * than either: a wake is `initialize` → one of two spellings → a body or a JSON-RPC error, and
 * every acceptance bullet in M1-PLAN WP-C 5 is one row of that table. It also RECORDS every
 * method it was asked for, which is how "hibernate never sends `session/close`" is asserted as a
 * fact about the wire rather than as a claim about the code.
 *
 * Not a `*.test.ts` file, so vitest does not collect it.
 */

export type ResumeBehaviour =
  | {
      readonly kind: "ok";
      /** Absent ⇒ the requested id, i.e. the resume LANDED. A different one is rule 5. */
      readonly sessionId?: string;
      /** F18: `session/load` and `session/resume` BOTH return the `session/new` body. */
      readonly modes?: Record<string, unknown>;
      readonly configOptions?: readonly unknown[];
      /** `null` ⇒ the v1 schema's own empty body, which rule 7 treats as a landing. */
      readonly nullBody?: boolean;
    }
  | {
      readonly kind: "error";
      readonly code: number;
      readonly message: string;
      readonly data?: unknown;
    }
  /** Never answers. The caller's budget is what ends it — §15.5's `agent_timeout` row. */
  | { readonly kind: "hang" };

export interface ResumableAgentOptions {
  /** Verbatim `agentCapabilities`. Default advertises BOTH spellings, as claude-acp does (F18). */
  readonly capabilities?: Record<string, unknown>;
  readonly protocolVersion?: number;
  /** What `session/new` hands back. */
  readonly sessionId?: string;
  readonly newSessionBody?: Record<string, unknown>;
  readonly onLoad?: ResumeBehaviour;
  readonly onResume?: ResumeBehaviour;
  /**
   * `session/update` notifications emitted INSIDE the resume request, before its response — F16's
   * measured window, reproduced exactly: request, replay, response, and only then live traffic.
   */
  readonly replay?: readonly Record<string, unknown>[];
  /** Answers `session/close`; when false the method is a `-32601` like every unadvertised one. */
  readonly supportsClose?: boolean;
}

export interface ResumableAgent {
  readonly stream: AcpStream;
  /** Every request method this agent was asked for, in wire order. */
  readonly methods: readonly string[];
  readonly sessionIds: readonly string[];
  /** Params of the last `session/load` or `session/resume`. */
  readonly lastResumeParams: Record<string, unknown> | null;
  update(u: Record<string, unknown>): Promise<void>;
  resolvePrompt(stopReason: StopReason): void;
  die(): void;
}

/** claude-acp's own shape (corpus `07`): `loadSession: true` AND `sessionCapabilities.resume`. */
export const BOTH_SPELLINGS: Record<string, unknown> = {
  loadSession: true,
  sessionCapabilities: { close: {}, resume: {}, list: {} },
};

/** An agent that can be hibernated but has only v1's spelling. */
export const LOAD_ONLY: Record<string, unknown> = { loadSession: true };

/** An agent that has only the v2 spelling. */
export const RESUME_ONLY: Record<string, unknown> = { sessionCapabilities: { resume: {} } };

/** M0's fixture shape: no resume spelling at all, so §15.2 refuses to hibernate it (M1-R15). */
export const NOT_RESUMABLE: Record<string, unknown> = { loadSession: false };

export function resumableAgent(opts: ResumableAgentOptions = {}): ResumableAgent {
  const [clientSide, agentSide] = memoryStreamPair();
  const methods: string[] = [];
  const sessionIds: string[] = [];
  let lastResumeParams: Record<string, unknown> | null = null;
  let pending: ((r: { stopReason: string }) => void) | null = null;
  let queued: StopReason | null = null;
  let dead = false;

  const capabilities = opts.capabilities ?? BOTH_SPELLINGS;
  const seeded = opts.sessionId ?? "sess_resumable";

  const answerResume = async (
    method: string,
    ctx: unknown,
    behaviour: ResumeBehaviour | undefined,
  ): Promise<Record<string, unknown> | null> => {
    // The SDK hands a request handler a CONTEXT, not the params — `AgentRequestHandler<P, R> =
    // (context: AgentRequestContext<P>) => …`, whose `params` is the wire object.
    const raw = (ctx as { params?: unknown } | null)?.params;
    const p = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    lastResumeParams = p;
    // An unscripted spelling answers exactly what a runtime that does not implement it answers.
    // F17's shape, verbatim — the message carries embedded quotes and `data.method` carries the
    // fact, which is why the classifier keys on the CODE and never on this text.
    if (behaviour === undefined) {
      throw new RequestError(-32601, `"Method not found": ${method}`, { method });
    }
    // F16: the replay lands strictly BETWEEN the request and its response — and BEFORE the
    // outcome is known, which is why it is emitted here rather than only on the success arm. An
    // agent that replays history and THEN fails is the worst case for a leaked replay window,
    // and it is the case a naive cleanup on the success path would miss.
    for (const u of opts.replay ?? []) {
      await cx.notify("session/update", {
        sessionId: typeof p["sessionId"] === "string" ? p["sessionId"] : seeded,
        update: u,
      });
    }
    if (behaviour.kind === "hang") return new Promise<never>(() => {});
    if (behaviour.kind === "error") {
      throw new RequestError(
        behaviour.code,
        behaviour.message,
        behaviour.data as Record<string, unknown> | undefined,
      );
    }
    if (behaviour.nullBody === true) return null;
    return {
      sessionId:
        behaviour.sessionId ?? (typeof p["sessionId"] === "string" ? p["sessionId"] : seeded),
      ...(behaviour.modes === undefined ? {} : { modes: behaviour.modes }),
      ...(behaviour.configOptions === undefined
        ? {}
        : { configOptions: [...behaviour.configOptions] }),
    };
  };

  const app = acpAgent({ name: "resumable-agent" })
    .onRequest("initialize", () => {
      methods.push("initialize");
      return {
        protocolVersion: opts.protocolVersion ?? ACP_V1_VERSION,
        agentCapabilities: capabilities as Record<string, never>,
      };
    })
    .onRequest("session/new", () => {
      methods.push("session/new");
      sessionIds.push(seeded);
      return { sessionId: seeded, ...(opts.newSessionBody ?? {}) };
    })
    .onRequest("session/load", (params: unknown) => {
      methods.push("session/load");
      return answerResume("session/load", params, opts.onLoad);
    })
    .onRequest("session/resume", (params: unknown) => {
      methods.push("session/resume");
      return answerResume("session/resume", params, opts.onResume);
    })
    .onRequest("session/close", () => {
      methods.push("session/close");
      if (opts.supportsClose === false) {
        throw new RequestError(-32601, '"Method not found": session/close');
      }
      return {};
    })
    .onRequest(
      "session/prompt",
      () =>
        new Promise<{ stopReason: string }>((resolve) => {
          methods.push("session/prompt");
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
      // Inert: the escalation ladder is only reachable if nobody answers.
    });

  const connection = app.connect(agentSide);
  const cx = connection.client;

  return {
    stream: clientSide,
    methods,
    sessionIds,
    get lastResumeParams(): Record<string, unknown> | null {
      return lastResumeParams;
    },
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
      connection.close(new Error("resumable agent died"));
    },
  };
}

/**
 * `fakeSupervisor().enqueue()` takes a `ScriptedAgent` but only ever touches `.stream` and
 * `.die()`, so a `ResumableAgent` is a valid stand-in. The cast is confined to this function,
 * exactly as `raw-agent.ts` confines its own.
 */
export function asScripted(agent: ResumableAgent): ScriptedAgent {
  return agent as unknown as ScriptedAgent;
}
