import { agent as acpAgent } from "@agentclientprotocol/sdk";
import { ACP_V1_VERSION, AcpRequestError, type AcpStream } from "@omni-acp/protocol";
import { memoryStreamPair } from "@omni-acp/testkit";

/**
 * A fixture agent that answers the PROBE BATTERY the way claude-acp 0.73.0 did.
 *
 * `scriptedAgent()` (testkit, frozen) models a TURN — prompts, chunks, permissions — and has no
 * way to register `session/set_config_option` or to answer one method `-32601` and another
 * `-32602`. That is the whole subject of §17.4, so this fixture lives beside the probe's own
 * suite rather than as an edit to a frozen file.
 *
 * Every canned answer below is the byte shape recorded in
 * `docs/research/transcripts/claude-acp-0.73.0/08-set-model-extension.jsonl`, including the
 * `-32601` message's embedded quotes — the classifier must not read it, and a fixture that
 * cleaned it up would stop proving that.
 *
 * Every handler is registered through the SDK's UNTYPED three-argument `onRequest` with an
 * identity parser: the two-argument overload validates against the generated v1 schema, which
 * would answer `session/set_config_option{optionId}` with the SDK's own `-32602` rather than the
 * `data.configId._errors` shape F17 is about — the fixture would then be testing the SDK.
 */
export interface ProbeFixtureOptions {
  /** Methods answered `-32601`. Default: the two corpus 08 found missing. */
  readonly notImplemented?: readonly string[];
  /** `session/new` returns no sessionId — the battery-skipped path. */
  readonly sessionNewReturnsNothing?: boolean;
  /** Answer `initialize` with this protocol version. Default 1. */
  readonly protocolVersion?: number;
  /** Never answer this method — the blown-deadline path. */
  readonly hangOn?: string;
  /** Issue a `session/request_permission` as soon as `session/new` is answered. */
  readonly requestsPermission?: boolean;
  /** Emit N unprompted `available_commands_update`s, as the real agent does mid-battery. */
  readonly chatter?: number;
}

export interface ProbeFixtureAgent {
  readonly stream: AcpStream;
  /** Every client→agent method this fixture saw, in wire order. */
  readonly seen: readonly string[];
  /** Settles with how the client answered a permission request — or refused to. */
  readonly permissionOutcome: Promise<{ answered: true } | { refusedWith: number }>;
  die(): void;
}

const AGENT_INFO = {
  name: "@agentclientprotocol/claude-agent-acp",
  title: "Claude Agent",
  version: "0.73.0",
};

const SESSION_ID = "c5beb00a-f261-4e48-9705-a5a8f96116da";

/** Verbatim corpus 08: embedded quotes in the message, the method name in `data`. */
function methodNotFound(method: string): AcpRequestError {
  return new AcpRequestError(-32601, `"Method not found": ${method}`, { method });
}

/** zod's own `-32602` payload, which is what teaches the probe a parameter's real name (F17). */
function missingParam(field: string): AcpRequestError {
  return new AcpRequestError(-32602, "Invalid params", {
    _errors: [],
    [field]: { _errors: ["Invalid input: expected string, received undefined"] },
  });
}

/** Identity: the fixture must see exactly the bytes the probe sent (CONTRACTS.md §7.5's rule). */
const verbatim = (params: unknown): Record<string, unknown> =>
  (params ?? {}) as Record<string, unknown>;

export function probeFixtureAgent(o: ProbeFixtureOptions = {}): ProbeFixtureAgent {
  const [clientSide, agentSide] = memoryStreamPair();
  const seen: string[] = [];
  const missing = new Set(o.notImplemented ?? ["session/set_model", "session/set_options"]);
  let sessionId: string | null = null;
  let dead = false;

  let settlePermission: (v: { answered: true } | { refusedWith: number }) => void = () => {};
  const permissionOutcome = new Promise<{ answered: true } | { refusedWith: number }>((resolve) => {
    settlePermission = resolve;
  });

  /**
   * Record the call, then either hang forever, refuse with `-32601`, or answer.
   *
   * Hanging is a real agent behaviour and the only way to reach the probe's deadline path; a
   * `Promise` that never settles is exactly what the wire does when an agent wedges.
   */
  const guard = <T>(method: string, answer: () => T): T | Promise<T> => {
    seen.push(method);
    if (o.hangOn === method) return new Promise<T>(() => {});
    if (missing.has(method)) throw methodNotFound(method);
    return answer();
  };

  const app = acpAgent({ name: "probe-fixture" })
    .onRequest("initialize", verbatim, () =>
      guard("initialize", () => ({
        protocolVersion: o.protocolVersion ?? ACP_V1_VERSION,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, embeddedContext: true },
          sessionCapabilities: { close: {}, list: {}, resume: {} },
        },
        agentInfo: AGENT_INFO,
        authMethods: [],
      })),
    )
    .onRequest("session/new", verbatim, () =>
      guard("session/new", () => {
        if (o.sessionNewReturnsNothing === true) return {};
        sessionId = SESSION_ID;
        if (o.requestsPermission === true) void askPermission();
        void chatter();
        return { sessionId, modes: { currentModeId: "default", availableModes: [] } };
      }),
    )
    // `-32601` on 0.73.0 (corpus 08, ids 3-5). Registered rather than left unhandled so the
    // answer carries `data.method`, which is the field §17.3 says detection keys on.
    .onRequest("session/set_model", verbatim, () => guard("session/set_model", () => ({})))
    .onRequest("session/set_options", verbatim, () => guard("session/set_options", () => ({})))
    // Implemented, and it CHANGES the mode when given one — so the probe omits `modeId` and this
    // fixture answers the zod-shaped `-32602` the real agent would.
    .onRequest("session/set_mode", verbatim, (ctx) =>
      guard("session/set_mode", () => {
        if (typeof ctx.params["modeId"] !== "string") throw missingParam("modeId");
        return {};
      }),
    )
    // THE row §17.4 exists for: sent `optionId`, answered naming `configId` (F17, corpus 08 id 7).
    .onRequest("session/set_config_option", verbatim, (ctx) =>
      guard("session/set_config_option", () => {
        if (typeof ctx.params["configId"] !== "string") throw missingParam("configId");
        return { configOptions: [] };
      }),
    )
    .onRequest("session/list", verbatim, () => guard("session/list", () => ({ sessions: [] })))
    .onRequest("session/resume", verbatim, (ctx) =>
      guard("session/resume", () => {
        if (typeof ctx.params["cwd"] !== "string") throw missingParam("cwd");
        return { sessionId };
      }),
    )
    .onRequest("session/load", verbatim, (ctx) =>
      guard("session/load", () => {
        if (typeof ctx.params["cwd"] !== "string") throw missingParam("cwd");
        return { sessionId };
      }),
    )
    .onRequest("session/close", verbatim, () => guard("session/close", () => ({})))
    // A prompt costs tokens against a real agent. The fixture records the call so a test can
    // assert the probe NEVER makes one — that assertion is the ≈0-token claim, made falsifiable.
    .onRequest("session/prompt", verbatim, () =>
      guard("session/prompt", () => ({ stopReason: "end_turn" })),
    );

  // `omni/definitely_unknown_method` is deliberately NOT registered: the SDK's own "no handler"
  // answer is the most faithful model of a method the agent has never heard of.

  const connection = app.connect(agentSide);
  const cx = connection.client;

  const chatter = async (): Promise<void> => {
    for (let i = 0; i < (o.chatter ?? 0); i += 1) {
      if (dead) return;
      await cx
        .notify("session/update", {
          sessionId,
          update: { sessionUpdate: "available_commands_update", availableCommands: [] },
        })
        .catch(() => {});
    }
  };

  const askPermission = async (): Promise<void> => {
    try {
      await cx.request("session/request_permission", {
        sessionId,
        toolCall: { toolCallId: "call_1", title: "write a file" },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
        ],
      });
      settlePermission({ answered: true });
    } catch (e) {
      settlePermission({ refusedWith: e instanceof AcpRequestError ? e.code : 0 });
    }
  };

  return {
    stream: clientSide,
    seen,
    permissionOutcome,
    die(): void {
      if (dead) return;
      dead = true;
      connection.close(new Error("probe fixture died"));
    },
  };
}
