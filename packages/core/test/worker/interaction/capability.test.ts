import { describe, expect, it } from "vitest";
import { InteractionConfig, type RuntimeDescriptor, type SessionId } from "@omni-acp/protocol";
import { fakeClock, fakeRuntime, nullLogger } from "@omni-acp/testkit";
import { openAcpLink } from "../../../src/acp/link.js";
import { clientCapabilitiesFor } from "../../../src/worker/interaction/capability.js";
import { createSessionStrategy } from "../../../src/worker/session-open.js";
import { recordingAgent, type RecordingAgent } from "./support/recording-agent.js";

/**
 * WP-I acceptance 2, in two halves.
 *
 * The pure half is `clientCapabilitiesFor`: `{elicitation:{form:{}}}` iff `onUnresolved === "park"`,
 * `{}` otherwise, and no `url` key under any resolved default configuration.
 *
 * The half that matters is F42's. `clientCapabilities: {}` was hard-coded in TWO files —
 * `handshake.ts` (create) and `session-open.ts`'s WAKE path — so a `park` worker that hibernated
 * and woke would silently stop declaring elicitation, F28 says the agent then asks in PROSE
 * instead, and the park never happens again. The regression test below was written FIRST and
 * FAILED against the Land commit's literal `clientCapabilities: {}` on the reopen path; landing
 * the fix before writing it would have left it passing on arrival and proved nothing.
 */

const CONFIG = InteractionConfig.parse({});
const SESSION = "sess_recording" as SessionId;

const DESCRIPTOR: RuntimeDescriptor = fakeRuntime({
  prefer: {
    resume: { spellings: ["session/resume", "session/load"], onFailure: "fail" },
    close: { spellings: ["session/close"], onFailure: "fail" },
  },
});

describe("clientCapabilitiesFor — D10's gate as a pure function (§19.2, §5.8.9)", () => {
  it('declares {elicitation:{form:{}}} iff onUnresolved === "park"', () => {
    expect(clientCapabilitiesFor({ onUnresolved: "park", config: CONFIG })).toEqual({
      elicitation: { form: {} },
    });
    expect(clientCapabilitiesFor({ onUnresolved: "deny", config: CONFIG })).toEqual({});
    expect(clientCapabilitiesFor({ onUnresolved: "fail", config: CONFIG })).toEqual({});
  });

  it("never declares `url` under any resolved default configuration", () => {
    // §11.9: `url`-mode elicitation and `elicitation/complete` are schema-only on BOTH real
    // agents, and declaring a mode we cannot service is how a turn hangs. The flag exists so the
    // decision is visible; it defaults false and stays false until a real url handler lands.
    expect(CONFIG.declareUrlElicitation).toBe(false);
    for (const onUnresolved of ["park", "deny", "fail"] as const) {
      const declared = clientCapabilitiesFor({ onUnresolved, config: CONFIG });
      expect(JSON.stringify(declared)).not.toContain("url");
    }
  });

  it("declares `url` ONLY when interaction.declareUrlElicitation is set, and only under park", () => {
    const config = InteractionConfig.parse({ declareUrlElicitation: true });
    expect(clientCapabilitiesFor({ onUnresolved: "park", config })).toEqual({
      elicitation: { form: {}, url: {} },
    });
    expect(clientCapabilitiesFor({ onUnresolved: "deny", config })).toEqual({});
  });

  it("is pure: two calls with the same input are deep-equal and neither mutates the other", () => {
    const a = clientCapabilitiesFor({ onUnresolved: "park", config: CONFIG });
    const b = clientCapabilitiesFor({ onUnresolved: "park", config: CONFIG });
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    // Frozen, so a caller cannot hand a mutated copy to the second of the two call sites F42 is
    // about and make them disagree after the fact.
    expect(Object.isFrozen(a)).toBe(true);
  });
});

/**
 * F42, end to end on the wire: `open` and `reopen` must send the SAME declaration.
 *
 * The assertion is on our own outbound `initialize` params — the bytes, not the intent — because
 * F28's whole finding is that the AGENT branches on them and `initialize`'s `agentCapabilities`
 * says nothing about elicitation either way. Our declaration is the only record of why an agent
 * asked in prose (§19.2).
 */
describe("F42 — the wake path declares what the create path declared", () => {
  const rig = (): { agent: RecordingAgent; link: ReturnType<typeof linkFor>; close(): void } => {
    const agent = recordingAgent({ resumable: true });
    const link = linkFor(agent);
    return { agent, link, close: () => link.dispose() };
  };

  it("sends `elicitation.form` on reopen, not the hard-coded {} F42 recorded", async () => {
    const r = rig();
    const clock = fakeClock();
    const strategy = createSessionStrategy({
      descriptor: DESCRIPTOR,
      clock,
      logger: nullLogger(),
    });
    const clientCapabilities = clientCapabilitiesFor({ onUnresolved: "park", config: CONFIG });

    await strategy.open(r.link.like, {
      cwd: "/tmp/omni-acp-test",
      descriptor: DESCRIPTOR,
      mcpServers: [],
      clientCapabilities,
      budgetMs: 30_000,
    });
    expect(declaredOn(r.agent, 0)).toEqual({ form: {} });

    const result = await strategy.reopen(r.link.like, {
      cwd: "/tmp/omni-acp-test",
      descriptor: DESCRIPTOR,
      mcpServers: [],
      clientCapabilities,
      budgetMs: 30_000,
      sessionId: SESSION,
      capabilities: null,
      controls: { replayWindow: () => () => {} },
    });

    // THE regression. Against the Land commit this was `undefined` — the reopen path's literal
    // `clientCapabilities: {}` — and the park was silently gone for the rest of the worker's life.
    expect(declaredOn(r.agent, 1)).toEqual({ form: {} });
    expect(declaredOn(r.agent, 1)).toEqual(declaredOn(r.agent, 0));

    // §5.8.4: recorded AS SENT, because `initialize`'s `agentCapabilities` never mentions
    // elicitation either way (F28) and without this the gate is unauditable.
    expect(result.capabilities.clientCapabilities).toEqual({ elicitation: { form: {} } });
    r.close();
  });

  it("sends {} on reopen for a deny worker — the gate is per worker, not per daemon", async () => {
    const r = rig();
    const clock = fakeClock();
    const strategy = createSessionStrategy({
      descriptor: DESCRIPTOR,
      clock,
      logger: nullLogger(),
    });
    const clientCapabilities = clientCapabilitiesFor({ onUnresolved: "deny", config: CONFIG });

    await strategy.open(r.link.like, {
      cwd: "/tmp/omni-acp-test",
      descriptor: DESCRIPTOR,
      mcpServers: [],
      clientCapabilities,
      budgetMs: 30_000,
    });
    await strategy.reopen(r.link.like, {
      cwd: "/tmp/omni-acp-test",
      descriptor: DESCRIPTOR,
      mcpServers: [],
      clientCapabilities,
      budgetMs: 30_000,
      sessionId: SESSION,
      capabilities: null,
      controls: { replayWindow: () => () => {} },
    });
    expect(declaredOn(r.agent, 0)).toBeUndefined();
    expect(declaredOn(r.agent, 1)).toBeUndefined();
    r.close();
  });

  it("falls back to {} when no value is threaded — M1's behaviour is the default, not a migration", async () => {
    const r = rig();
    const clock = fakeClock();
    const strategy = createSessionStrategy({
      descriptor: DESCRIPTOR,
      clock,
      logger: nullLogger(),
    });
    await strategy.reopen(r.link.like, {
      cwd: "/tmp/omni-acp-test",
      descriptor: DESCRIPTOR,
      mcpServers: [],
      budgetMs: 30_000,
      sessionId: SESSION,
      capabilities: null,
      controls: { replayWindow: () => () => {} },
    } as Parameters<typeof strategy.reopen>[1]);
    expect(declaredOn(r.agent, 0)).toBeUndefined();
    r.close();
  });
});

/**
 * What WE declared on the n-th `initialize`, as the agent read it.
 *
 * The SDK's own `initialize` schema fills `fs` / `terminal` / `auth` defaults on the agent side —
 * transcript `12`'s recorded params carry exactly those beside `elicitation` — so the assertion is
 * on the ONE key D10's gate owns. `undefined` is "we declared nothing", which is F28's control.
 */
function declaredOn(agent: RecordingAgent, n: number): unknown {
  const caps = agent.initializeCalls.at(n)?.["clientCapabilities"];
  return typeof caps === "object" && caps !== null
    ? (caps as Record<string, unknown>)["elicitation"]
    : undefined;
}

function linkFor(agent: RecordingAgent): {
  like: {
    request<T>(method: string, params: unknown): Promise<T>;
    notify(method: string, params: unknown): void;
    readonly closed: boolean;
  };
  dispose(): void;
} {
  const acp = openAcpLink(
    agent.stream,
    {
      onSessionUpdate: () => {},
      onPermissionRequest: () =>
        Promise.resolve({ outcome: { outcome: "selected" as const, optionId: "x" } }),
      onClosed: () => {},
    },
    { logger: nullLogger() },
  );
  return {
    like: {
      request: <T>(method: string, params: unknown): Promise<T> => acp.request<T>(method, params),
      notify: (method: string, params: unknown): void => {
        void acp.notify(method, params);
      },
      get closed(): boolean {
        return false;
      },
    },
    dispose: () => {
      acp.close();
      agent.die();
    },
  };
}
