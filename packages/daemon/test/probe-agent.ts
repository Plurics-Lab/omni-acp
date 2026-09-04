import { ACP_V1_VERSION, type AcpStream } from "@omni-acp/protocol";
import { memoryStreamPair, type ScriptedAgent } from "@omni-acp/testkit";

/**
 * A fixture agent that answers the probe battery, for the DAEMON side of WP-E.
 *
 * Written against the RAW message stream rather than the SDK's `acp.agent()` builder, for a
 * structural reason: `@omni-acp/daemon`'s manifest does not depend on `@agentclientprotocol/sdk`
 * and manifests are frozen for M1 (§3.2 pins the SDK to `protocol`, `core` and `testkit`). The
 * `AcpStream` a `memoryStreamPair` hands back carries decoded JSON-RPC OBJECTS, not bytes, so a
 * responder over it is a `for await` loop and a `switch` — and it is arguably the better fixture
 * here anyway, because the shapes it returns are the corpus's own bytes with nothing in between.
 *
 * Every answer is the shape recorded in
 * `docs/research/transcripts/claude-acp-0.73.0/08-set-model-extension.jsonl`, including the
 * `-32601` message's embedded quotes — the classifier must not read it, and a fixture that
 * cleaned it up would stop proving that.
 */
export interface ProbeFixtureAgent {
  readonly stream: AcpStream;
  /** Every client→agent method this fixture saw, in wire order. */
  readonly seen: readonly string[];
  die(): void;
}

/** Wire one into `fakeSupervisor.enqueue`, which consumes `.stream` and `.die()`. */
export function asScriptedAgent(a: ProbeFixtureAgent): ScriptedAgent {
  return a as unknown as ScriptedAgent;
}

interface Request {
  readonly jsonrpc: "2.0";
  readonly id?: number | string;
  readonly method?: string;
  readonly params?: unknown;
}

const AGENT_INFO = {
  name: "@agentclientprotocol/claude-agent-acp",
  title: "Claude Agent",
  version: "0.73.0",
};

/** Verbatim corpus 08: embedded quotes in the message, the method name in `data`. */
const notFound = (method: string) => ({
  code: -32601,
  message: `"Method not found": ${method}`,
  data: { method },
});

/** zod's own `-32602` payload — the shape that teaches the probe a parameter's real name (F17). */
const missingParam = (field: string) => ({
  code: -32602,
  message: "Invalid params",
  data: {
    _errors: [],
    [field]: { _errors: ["Invalid input: expected string, received undefined"] },
  },
});

export function probeFixtureAgent(o?: { hangOn?: string }): ProbeFixtureAgent {
  const [clientSide, agentSide] = memoryStreamPair();
  const seen: string[] = [];
  let dead = false;

  const writer = (agentSide.writable as WritableStream<unknown>).getWriter();
  const reader = (agentSide.readable as ReadableStream<unknown>).getReader();

  /** What the fixture answers, by method. `undefined` ⇒ this agent has never heard of it. */
  const answer = (method: string): { result: unknown } | { error: unknown } | undefined => {
    switch (method) {
      case "initialize":
        return {
          result: {
            protocolVersion: ACP_V1_VERSION,
            agentCapabilities: { loadSession: true, sessionCapabilities: { close: {}, list: {} } },
            agentInfo: AGENT_INFO,
            authMethods: [],
          },
        };
      case "session/new":
        return { result: { sessionId: "sess-probe-1" } };
      // `-32601` on 0.73.0 (corpus 08, ids 3 and 5).
      case "session/set_model":
      case "session/set_options":
      case "session/load":
        return { error: notFound(method) };
      // Implemented; the probe withholds the value-bearing parameter, so the agent names it.
      case "session/set_mode":
        return { error: missingParam("modeId") };
      // THE row §17.4 exists for (F17, corpus 08 id 7).
      case "session/set_config_option":
        return { error: missingParam("configId") };
      case "session/resume":
        return { error: missingParam("cwd") };
      case "session/list":
        return { result: { sessions: [] } };
      case "session/close":
        return { result: {} };
      default:
        return undefined;
    }
  };

  void (async () => {
    for (;;) {
      let next: ReadableStreamReadResult<unknown>;
      try {
        next = await reader.read();
      } catch {
        return;
      }
      if (next.done === true) return;
      const message = next.value as Request;
      const method = message.method;
      if (typeof method !== "string" || message.id === undefined) continue;
      seen.push(method);
      // A method the fixture never answers: the wire goes quiet, which is what a wedged agent
      // actually does and the only way to reach the probe's deadline path.
      if (o?.hangOn === method) continue;

      const body = answer(method) ?? { error: notFound(method) };
      try {
        await writer.write({ jsonrpc: "2.0", id: message.id, ...body });
      } catch {
        return;
      }
    }
  })();

  return {
    stream: clientSide,
    seen,
    die(): void {
      if (dead) return;
      dead = true;
      void writer.close().catch(() => {});
      void reader.cancel().catch(() => {});
    },
  };
}
