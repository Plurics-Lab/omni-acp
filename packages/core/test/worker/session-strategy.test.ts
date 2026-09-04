import { describe, expect, it } from "vitest";
import {
  OmniError,
  type AcpLinkLike,
  type AgentCapabilitiesSnapshot,
  type RuntimeDescriptor,
  type SessionId,
  type SessionReopenOptions,
} from "@omni-acp/protocol";
import { fakeClock, fakeRuntime, nullLogger, type FakeClock } from "@omni-acp/testkit";
import { openAcpLink } from "../../src/acp/link.js";
import { createSessionStrategy } from "../../src/worker/session-open.js";
import { attemptResume } from "../../src/worker/resume.js";
import { resolveResumeMethod, resumeSpellings } from "../../src/worker/handshake.js";
import {
  BOTH_SPELLINGS,
  LOAD_ONLY,
  NOT_RESUMABLE,
  RESUME_ONLY,
  resumableAgent,
  type ResumableAgent,
  type ResumableAgentOptions,
} from "./support/resumable-agent.js";

/**
 * SEAM 2 (M1-PLAN §1.2) on its own, with no `Worker` and no process: `createSessionStrategy` is
 * `open` + `reopen` + `close` over an `AcpLinkLike`, and every §15.5 row is reachable from here.
 *
 * The end-to-end half — the state transitions, the single flight, `maxWakeFailures` — is
 * `hibernate-wake.test.ts`. This file is about what goes on the WIRE and what comes back.
 */

const SESSION = "sess_resumable" as SessionId;

/** claude-acp's own resume preference order (F18): the v2 name first, the v1 one second. */
const descriptorWith = (over: Partial<RuntimeDescriptor> = {}): RuntimeDescriptor =>
  fakeRuntime({
    prefer: {
      resume: { spellings: ["session/resume", "session/load"], onFailure: "fail" },
      close: { spellings: ["session/close"], onFailure: "fail" },
    },
    ...over,
  });

interface Rig {
  readonly agent: ResumableAgent;
  readonly link: AcpLinkLike;
  readonly clock: FakeClock;
  /** Every `replayWindow()` open, and whether it was closed. */
  readonly windows: { opened: number; closed: number };
  /** `session/update` payloads that arrived while a window was OPEN, in order. */
  readonly inWindow: Record<string, unknown>[];
  /** …and the ones that did not. */
  readonly outOfWindow: Record<string, unknown>[];
  reopenOptions(over?: Partial<SessionReopenOptions>): SessionReopenOptions;
  close(): void;
}

function rig(opts: ResumableAgentOptions = {}, descriptor = descriptorWith()): Rig {
  const agent = resumableAgent(opts);
  const clock = fakeClock();
  const windows = { opened: 0, closed: 0 };
  const inWindow: Record<string, unknown>[] = [];
  const outOfWindow: Record<string, unknown>[] = [];
  let depth = 0;

  const acp = openAcpLink(
    agent.stream,
    {
      onSessionUpdate: (n) => {
        // This is `worker.ts`'s one line (`#onSessionUpdate`), reproduced: the WINDOW decides,
        // and nothing downstream carries window state.
        (depth > 0 ? inWindow : outOfWindow).push(n.update);
      },
      onPermissionRequest: () =>
        Promise.resolve({ outcome: { outcome: "selected", optionId: "x" } }),
      onClosed: () => {},
    },
    { logger: nullLogger() },
  );

  const link: AcpLinkLike = {
    request: <T>(method: string, params: unknown): Promise<T> => acp.request<T>(method, params),
    notify: (method: string, params: unknown): void => {
      void acp.notify(method, params);
    },
    get closed(): boolean {
      return false;
    },
  };

  return {
    agent,
    link,
    clock,
    windows,
    inWindow,
    outOfWindow,
    reopenOptions(over = {}) {
      return {
        cwd: "/tmp/omni-acp-test",
        descriptor,
        mcpServers: [],
        budgetMs: 90_000,
        sessionId: SESSION,
        capabilities: null,
        controls: {
          // A REFCOUNT, exactly as `worker.ts` implements it, so a nested open cannot close a
          // window somebody else still holds — and an idempotent closer, so a strategy that
          // closes twice cannot drop the count below zero.
          replayWindow: () => {
            windows.opened += 1;
            depth += 1;
            let done = false;
            return () => {
              if (done) return;
              done = true;
              windows.closed += 1;
              depth -= 1;
            };
          },
        },
        ...over,
      };
    },
    close() {
      acp.close();
      agent.die();
    },
  };
}

const strategyFor = (
  r: Rig,
  descriptor = descriptorWith(),
): ReturnType<typeof createSessionStrategy> =>
  createSessionStrategy({ descriptor, clock: r.clock, logger: nullLogger() });

const failure = async (p: Promise<unknown>): Promise<OmniError> => {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  if (!(e instanceof OmniError)) throw new Error(`expected an OmniError, got ${String(e)}`);
  return e;
};

// ── the preference order (F18, WP-C acceptance 10) ──────────────────────────

describe("resumeSpellings — the descriptor's ORDER, the agent's VETO (F18)", () => {
  const descriptor = descriptorWith();

  it("keeps the descriptor's order when the agent advertises both, as claude-acp does", () => {
    expect(resumeSpellings(descriptor, BOTH_SPELLINGS)).toEqual(["session/resume", "session/load"]);
    expect(resolveResumeMethod(descriptor, BOTH_SPELLINGS)).toBe("session/resume");
  });

  it("drops the spelling the agent did not advertise", () => {
    expect(resumeSpellings(descriptor, LOAD_ONLY)).toEqual(["session/load"]);
    expect(resumeSpellings(descriptor, RESUME_ONLY)).toEqual(["session/resume"]);
  });

  it("resolves to null when the agent advertises neither — M1-R15's refusal-to-hibernate state", () => {
    expect(resumeSpellings(descriptor, NOT_RESUMABLE)).toEqual([]);
    expect(resolveResumeMethod(descriptor, NOT_RESUMABLE)).toBeNull();
    expect(resolveResumeMethod(descriptor, {})).toBeNull();
  });

  it("`sessionCapabilities.resume` is an OBJECT capability: `{}` is yes, `null` is no", () => {
    expect(resumeSpellings(descriptor, { sessionCapabilities: { resume: {} } })).toEqual([
      "session/resume",
    ]);
    expect(resumeSpellings(descriptor, { sessionCapabilities: { resume: null } })).toEqual([]);
    // `loadSession` is v1's own BOOLEAN flag, so here `=== true` is exactly right.
    expect(resumeSpellings(descriptor, { loadSession: "yes" })).toEqual([]);
  });

  it("honours a descriptor that reverses the order", () => {
    const reversed = descriptorWith({
      prefer: { resume: { spellings: ["session/load", "session/resume"], onFailure: "fail" } },
    });
    expect(resumeSpellings(reversed, BOTH_SPELLINGS)).toEqual(["session/load", "session/resume"]);
  });

  it("DROPS a spelling M1 has no params shape for, rather than sending it blind", () => {
    const exotic = descriptorWith({
      prefer: {
        resume: {
          spellings: ["session/rehydrate", "session/load", "session/load"],
          onFailure: "fail",
        },
      },
    });
    expect(resumeSpellings(exotic, BOTH_SPELLINGS)).toEqual(["session/load"]);
  });
});

// ── open() ──────────────────────────────────────────────────────────────────

describe("SessionStrategy.open — create", () => {
  it("sends initialize then session/new, and resolves resume.method from the descriptor", async () => {
    const r = rig();
    const opened = await strategyFor(r).open(r.link, {
      cwd: "/tmp/omni-acp-test",
      descriptor: descriptorWith(),
      mcpServers: [],
      budgetMs: 60_000,
    });
    expect(r.agent.methods).toEqual(["initialize", "session/new"]);
    expect(opened.sessionId).toBe(SESSION);
    expect(opened.capabilities.resume.method).toBe("session/resume");
    // A CREATE has no resume verdict: D2's four states describe a resume, and inventing a
    // `landed` here would make `snapshot().resume` lie about what happened.
    expect(opened.resume).toBeNull();
    r.close();
  });

  it("captures modes and configOptions off `session/new`'s body (corpus 07)", async () => {
    const r = rig({
      newSessionBody: {
        modes: { currentModeId: "default", availableModes: [{ id: "default" }] },
        configOptions: [{ id: "model", currentValue: "opus" }],
      },
    });
    const opened = await strategyFor(r).open(r.link, {
      cwd: "/tmp",
      descriptor: descriptorWith(),
      mcpServers: [],
      budgetMs: 60_000,
    });
    expect(opened.capabilities.modes).toEqual({
      currentModeId: "default",
      availableModes: [{ id: "default" }],
    });
    expect(opened.capabilities.configOptions).toEqual([{ id: "model", currentValue: "opus" }]);
    r.close();
  });

  it("keeps `agentCapabilities` VERBATIM — the quirk table and the compat suite read the real thing", async () => {
    const raw = { ...BOTH_SPELLINGS, _meta: { claudeCode: { promptQueueing: true } } };
    const r = rig({ capabilities: raw });
    const opened = await strategyFor(r).open(r.link, {
      cwd: "/tmp",
      descriptor: descriptorWith(),
      mcpServers: [],
      budgetMs: 60_000,
    });
    expect(opened.capabilities.raw).toEqual(raw);
    expect(opened.capabilities.supportsSessionClose).toBe(true);
    expect(opened.capabilities.supportsSessionList).toBe(true);
    r.close();
  });

  it("the negotiated version check is DESCRIPTOR-driven, not a hard-coded 1 (acceptance 10)", async () => {
    const two = rig({ protocolVersion: 2 });
    const v1 = await failure(
      strategyFor(two).open(two.link, {
        cwd: "/tmp",
        descriptor: descriptorWith(),
        mcpServers: [],
        budgetMs: 60_000,
      }),
    );
    expect(v1.code).toBe("agent_error");
    expect(v1.message).toContain("version 2");
    two.close();

    // The SAME agent under a v2 descriptor is accepted, with no code change.
    const v2Descriptor = descriptorWith({ protocolVersion: 2 });
    const ok = rig({ protocolVersion: 2 }, v2Descriptor);
    const opened = await createSessionStrategy({
      descriptor: v2Descriptor,
      clock: ok.clock,
      logger: nullLogger(),
    }).open(ok.link, {
      cwd: "/tmp",
      descriptor: v2Descriptor,
      mcpServers: [],
      budgetMs: 60_000,
    });
    expect(opened.capabilities.protocolVersion).toBe(2);
    ok.close();
  });
});

// ── reopen(): §15.5's rows, one at a time ───────────────────────────────────

describe("SessionStrategy.reopen — §15.5's outcome table", () => {
  it("landed: the id comes back unchanged, and the resume body's modes are captured (F18)", async () => {
    const r = rig({
      onResume: {
        kind: "ok",
        modes: { currentModeId: "plan" },
        configOptions: [{ id: "model" }],
      },
    });
    const result = await strategyFor(r).reopen(r.link, r.reopenOptions());

    expect(r.agent.methods).toEqual(["initialize", "session/resume"]);
    expect(result.sessionId).toBe(SESSION);
    expect(result.resume?.outcome).toBe("landed");
    expect(result.resume?.rule).toBe("rule7:landed");
    expect(result.resume?.method).toBe("session/resume");
    // Finding 9: the resume body is the `session/new` body, contrary to the v1 schema — so the
    // catalogue `current_mode_update -> config_option_update` needs is read off it too.
    expect(result.capabilities.modes).toEqual({ currentModeId: "plan" });
    expect(result.capabilities.configOptions).toEqual([{ id: "model" }]);
    expect(result.capabilities.resume.method).toBe("session/resume");
    r.close();
  });

  it("landed: a v1 NULL body is the schema's own answer and still lands", async () => {
    const r = rig({ onResume: { kind: "ok", nullBody: true } });
    const result = await strategyFor(r).reopen(r.link, r.reopenOptions());
    expect(result.resume?.outcome).toBe("landed");
    expect(result.sessionId).toBe(SESSION);
    r.close();
  });

  it("sends {sessionId, cwd, mcpServers} — the three the v1 schema gives session/load", async () => {
    const r = rig({ onResume: { kind: "ok" } });
    await strategyFor(r).reopen(r.link, r.reopenOptions({ cwd: "/tmp/ws" }));
    expect(r.agent.lastResumeParams).toEqual({
      sessionId: SESSION,
      cwd: "/tmp/ws",
      mcpServers: [],
    });
    r.close();
  });

  it("rejected_permanent: 422 not_resumable, carrying the report AND the agent's error verbatim", async () => {
    const r = rig({
      onResume: { kind: "error", code: -32002, message: `session not found: ${SESSION}` },
    });
    const e = await failure(strategyFor(r).reopen(r.link, r.reopenOptions()));
    expect(e.code).toBe("not_resumable");
    expect(e.status).toBe(422);
    expect(e.resume?.outcome).toBe("rejected_permanent");
    expect(e.resume?.rule).toBe("rule2:session-not-found");
    // "Every 422 carries the agent's JSON-RPC error verbatim in `acp` where there was one AND
    // the full ResumeReport in body.resume" (§15.5).
    expect(e.acp?.code).toBe(-32002);
    expect(e.toBody().resume?.hint).toBe("not_found");
    r.close();
  });

  it("rejected_permanent: a DIFFERENT session id is rule 5, and the new pointer is reported", async () => {
    const r = rig({ onResume: { kind: "ok", sessionId: "sess_brand_new" } });
    const e = await failure(strategyFor(r).reopen(r.link, r.reopenOptions()));
    expect(e.code).toBe("not_resumable");
    expect(e.resume?.outcome).toBe("rejected_permanent");
    expect(e.resume?.hint).toBe("silently_created");
    expect(e.resume?.landedOn).toBe("sess_brand_new");
    expect(e.resume?.historyLost).toBe(true);
    r.close();
  });

  it("rejected_transient: 502 agent_error, and the pointer is KEPT", async () => {
    const r = rig({
      onResume: { kind: "error", code: -32000, message: "Rate limit exceeded, retry in 60s" },
    });
    const e = await failure(strategyFor(r).reopen(r.link, r.reopenOptions()));
    expect(e.code).toBe("agent_error");
    expect(e.status).toBe(502);
    expect(e.resume?.outcome).toBe("rejected_transient");
    expect(e.resume?.landedOn).toBe(SESSION);
    expect(e.resume?.historyLost).toBe(false);
    r.close();
  });

  it("unknown + ANSWERED (F15's cwd mismatch): 200/ready with the pointer kept (§15.5)", async () => {
    const r = rig({
      onResume: {
        kind: "error",
        code: -32002,
        message: `Resource not found: ${SESSION}`,
        data: { uri: SESSION },
      },
    });
    const quirky = descriptorWith({
      quirks: { ...descriptorWith().quirks, resumeRequiresSameCwd: true },
    });
    const result = await createSessionStrategy({
      descriptor: quirky,
      clock: r.clock,
      logger: nullLogger(),
    }).reopen(r.link, r.reopenOptions({ descriptor: quirky }));

    // §15.5: "resume ⇒ unknown or landed ⇒ ready". The DIAGNOSIS is the hint, and the pointer
    // survives — which is the whole of ruling M1-R6.
    expect(result.resume?.outcome).toBe("unknown");
    expect(result.resume?.hint).toBe("cwd_mismatch");
    expect(result.sessionId).toBe(SESSION);
    r.close();
  });

  it("unknown + NO ANSWER (a dead transport) is a 502 that keeps the pointer", async () => {
    const r = rig({ onResume: { kind: "hang" } });
    const pending = failure(strategyFor(r).reopen(r.link, r.reopenOptions()));
    // Let `initialize` land and the resume request go out, so the death happens INSIDE the
    // resume rather than during the handshake that precedes it.
    await flushMicrotasks();
    // The transport dies mid-request: the SDK rejects with no JSON-RPC code, which §7.3 says we
    // must not classify from.
    r.close();
    const e = await pending;
    expect(e.code).toBe("agent_error");
    expect(e.resume?.outcome).toBe("unknown");
    expect(e.resume?.hint).toBe("transport");
    expect(e.resume?.landedOn).toBe(SESSION);
  });

  it("unknown + a SPENT BUDGET is a 504, on ONE budget for the whole wake", async () => {
    const r = rig({ onResume: { kind: "hang" } });
    const pending = failure(strategyFor(r).reopen(r.link, r.reopenOptions({ budgetMs: 5_000 })));
    // Let `initialize` and the resume request cross the stream before the clock moves.
    await flushMicrotasks();
    r.clock.advance(4_999);
    await flushMicrotasks();
    r.clock.advance(1);
    const e = await pending;
    expect(e.code).toBe("agent_timeout");
    expect(e.status).toBe(504);
    expect(e.resume?.outcome).toBe("unknown");
    expect(e.resume?.hint).toBe("timeout");
    expect(e.resume?.landedOn).toBe(SESSION);
    r.close();
  });

  it("no spelling at all: 422, and NOTHING is sent after initialize (§15.3 step 5)", async () => {
    const r = rig({ capabilities: NOT_RESUMABLE });
    const e = await failure(strategyFor(r).reopen(r.link, r.reopenOptions()));
    expect(e.code).toBe("not_resumable");
    expect(e.resume?.outcome).toBe("rejected_permanent");
    expect(e.resume?.hint).toBe("capability_absent");
    expect(e.resume?.rule).toBe("pre0:capability-absent");
    expect(r.agent.methods).toEqual(["initialize"]);
    r.close();
  });
});

// ── attemptResume: the params, and the window, without an SDK in the way ────

/**
 * A hand-rolled `AcpLinkLike` that records params VERBATIM.
 *
 * The SDK's `agent()` builder parses inbound params against the generated v1 schema and strips
 * every key it does not model — which is correct of it, and is exactly why the params assertions
 * below cannot be made through a fixture agent. `session/resume`'s v1 shape has no `replayFrom`
 * at all, so the fixture would report its absence whether we sent it or not.
 */
function stubLink(answer: (method: string, params: unknown) => Promise<unknown>): {
  link: AcpLinkLike;
  calls: { method: string; params: unknown }[];
} {
  const calls: { method: string; params: unknown }[] = [];
  return {
    calls,
    link: {
      request: <T>(method: string, params: unknown): Promise<T> => {
        calls.push({ method, params });
        return answer(method, params) as Promise<T>;
      },
      notify: () => {},
      closed: false,
    },
  };
}

describe("attemptResume — the params and the window", () => {
  const windowCounter = (): {
    controls: SessionReopenOptions["controls"];
    open: number;
    closed: number;
  } => {
    const state = {
      open: 0,
      closed: 0,
      controls: null as unknown as SessionReopenOptions["controls"],
    };
    state.controls = {
      replayWindow: () => {
        state.open += 1;
        return () => {
          state.closed += 1;
        };
      },
    };
    return state as { controls: SessionReopenOptions["controls"]; open: number; closed: number };
  };

  const options = (over: Partial<SessionReopenOptions> = {}): SessionReopenOptions => ({
    cwd: "/tmp/ws",
    descriptor: descriptorWith(),
    mcpServers: [],
    budgetMs: 1_000,
    sessionId: SESSION,
    capabilities: null,
    controls: { replayWindow: () => () => {} },
    ...over,
  });

  it("sends only the three v1 params when the agent never advertised `replayFrom`", async () => {
    const s = stubLink(() => Promise.resolve({ sessionId: SESSION }));
    await attemptResume(s.link, "session/resume", SESSION, options());
    expect(s.calls).toEqual([
      { method: "session/resume", params: { sessionId: SESSION, cwd: "/tmp/ws", mcpServers: [] } },
    ]);
  });

  it("adds `replayFrom` ONLY for `session/resume` on an agent that advertised it (F18)", async () => {
    const advertised = {
      resume: { method: "session/resume", replayFrom: true, requiresSameCwd: false },
    } as AgentCapabilitiesSnapshot;
    const s = stubLink(() => Promise.resolve({ sessionId: SESSION }));
    await attemptResume(s.link, "session/resume", SESSION, options({ capabilities: advertised }));
    expect(s.calls[0]?.params).toMatchObject({ replayFrom: { type: "start" } });

    // v1's `session/load` has no such parameter, so it is never decorated with one.
    const load = stubLink(() => Promise.resolve({ sessionId: SESSION }));
    await attemptResume(load.link, "session/load", SESSION, options({ capabilities: advertised }));
    expect(load.calls[0]?.params).not.toHaveProperty("replayFrom");
  });

  it("opens the window BEFORE the request bytes and closes it on the response", async () => {
    const w = windowCounter();
    let openDuringRequest = 0;
    const s = stubLink(() => {
      openDuringRequest = w.open - w.closed;
      return Promise.resolve({ sessionId: SESSION });
    });
    await attemptResume(s.link, "session/load", SESSION, options({ controls: w.controls }));
    expect(openDuringRequest).toBe(1);
    expect(w.open).toBe(1);
    expect(w.closed).toBe(1);
  });

  it("closes the window on the REJECTION edge too, and on a SYNCHRONOUS throw", async () => {
    const w = windowCounter();
    const rejecting = stubLink(() => Promise.reject(new Error("boom")));
    await expect(
      attemptResume(rejecting.link, "session/load", SESSION, options({ controls: w.controls })),
    ).rejects.toThrow("boom");
    expect(w.closed).toBe(1);

    const throwing: AcpLinkLike = {
      request: () => {
        throw new Error("the transport is gone");
      },
      notify: () => {},
      closed: true,
    };
    await expect(
      attemptResume(throwing, "session/load", SESSION, options({ controls: w.controls })),
    ).rejects.toThrow("the transport is gone");
    expect(w.closed).toBe(2);
    expect(w.open).toBe(2);
  });
});

// ── the preference walk (rule 3) ────────────────────────────────────────────

describe("SessionStrategy.reopen — walking the preference order (rule 3)", () => {
  it("a -32601 on the first spelling tries the SECOND, and lands", async () => {
    // F18's exact shape inverted: this process implements `session/load` and not
    // `session/resume`, and the descriptor prefers the one it does not have.
    const r = rig({ onLoad: { kind: "ok" } });
    const result = await strategyFor(r).reopen(r.link, r.reopenOptions());
    expect(r.agent.methods).toEqual(["initialize", "session/resume", "session/load"]);
    expect(result.resume?.outcome).toBe("landed");
    expect(result.resume?.method).toBe("session/load");
    expect(result.capabilities.resume.method).toBe("session/load");
    r.close();
  });

  it("only an EXHAUSTED list is fatal — and then it is a 422 with the honest `unknown` report", async () => {
    const r = rig({});
    const e = await failure(strategyFor(r).reopen(r.link, r.reopenOptions()));
    expect(r.agent.methods).toEqual(["initialize", "session/resume", "session/load"]);
    expect(e.code).toBe("not_resumable");
    // The CLASSIFICATION stays what the agent actually said — the method is missing, not the
    // session — while the ACTION is fatal because there is nothing left to try.
    expect(e.resume?.outcome).toBe("unknown");
    expect(e.resume?.hint).toBe("method_not_found");
    expect(e.resume?.rule).toBe("rule3:method-not-found");
    r.close();
  });

  it("a NON-32601 error stops the walk: a rate limit is not a reason to try another spelling", async () => {
    const r = rig({
      onResume: { kind: "error", code: -32000, message: "quota exceeded" },
      onLoad: { kind: "ok" },
    });
    const e = await failure(strategyFor(r).reopen(r.link, r.reopenOptions()));
    expect(r.agent.methods).toEqual(["initialize", "session/resume"]);
    expect(e.resume?.outcome).toBe("rejected_transient");
    r.close();
  });

  it("falls back to the spelling the PREVIOUS handshake resolved when this one advertises none", async () => {
    // A warm `initialize` that says less than the cold one did must not turn a resumable worker
    // into a 422: §15.1's invariant 1 says a hibernated worker HAS a resolved method.
    const r = rig({ capabilities: NOT_RESUMABLE, onLoad: { kind: "ok" } });
    const remembered = {
      resume: { method: "session/load", replayFrom: false, requiresSameCwd: false },
    } as AgentCapabilitiesSnapshot;
    const result = await strategyFor(r).reopen(
      r.link,
      r.reopenOptions({ capabilities: remembered }),
    );
    expect(r.agent.methods).toEqual(["initialize", "session/load"]);
    expect(result.resume?.outcome).toBe("landed");
    r.close();
  });
});

// ── the replay window (D6, F16) ─────────────────────────────────────────────

describe("SessionStrategy.reopen — the replay window (D6, F16)", () => {
  const REPLAY = [
    { sessionUpdate: "user_message_chunk", content: { type: "text", text: "PING" } },
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "PONG" } },
  ];

  it("marks EXACTLY the updates between the request and its response", async () => {
    const r = rig({ onResume: { kind: "ok" }, replay: REPLAY });
    await strategyFor(r).reopen(r.link, r.reopenOptions());
    expect(r.inWindow).toEqual(REPLAY);
    expect(r.outOfWindow).toEqual([]);

    // The first update AFTER the response is live traffic and is NOT marked — F16's
    // "first non-replay update at 1495.3 ms, after the 1493.1 ms response".
    await r.agent.update({ sessionUpdate: "available_commands_update", availableCommands: [] });
    await flushMicrotasks();
    expect(r.outOfWindow).toHaveLength(1);
    expect(r.inWindow).toEqual(REPLAY);
    r.close();
  });

  it("is closed in a FINALLY: a REJECTED resume leaves the NEXT turn's updates unmarked", async () => {
    const r = rig({
      onResume: { kind: "error", code: -32000, message: "rate limit exceeded" },
      replay: REPLAY,
    });
    await failure(strategyFor(r).reopen(r.link, r.reopenOptions()));
    expect(r.windows.opened).toBeGreaterThan(0);
    // Every window opened was closed. A leaked window would mark a LIVE turn as replay, and a
    // consumer filtering `replay: true` would then silently drop real history.
    expect(r.windows.closed).toBe(r.windows.opened);

    // The agent replayed history and THEN failed — the worst case, because a cleanup on the
    // success path only would leak here. The replay is marked, and the LIVE update after it is
    // not: a leaked window would have swallowed a real turn into `replay: true`.
    await r.agent.update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "live" },
    });
    await flushMicrotasks();
    expect(r.inWindow).toEqual(REPLAY);
    expect(r.outOfWindow).toHaveLength(1);
    r.close();
  });

  it("is closed even when every spelling is walked and the whole wake fails", async () => {
    const r = rig({});
    await failure(strategyFor(r).reopen(r.link, r.reopenOptions()));
    expect(r.windows.opened).toBe(2);
    expect(r.windows.closed).toBe(2);
    r.close();
  });

  it("is closed when the transport dies inside the window", async () => {
    const r = rig({ onResume: { kind: "hang" } });
    const pending = failure(strategyFor(r).reopen(r.link, r.reopenOptions()));
    await flushMicrotasks();
    expect(r.windows.opened - r.windows.closed).toBe(1);
    r.close();
    await pending;
    expect(r.windows.closed).toBe(r.windows.opened);
  });

  it("reports 0 replayed events without a meter, and the meter's count with one", async () => {
    const r = rig({ onResume: { kind: "ok" }, replay: REPLAY });
    const bare = await strategyFor(r).reopen(r.link, r.reopenOptions());
    // Honest zero, not an invented figure: a `SessionStrategy` is handed request/notify/closed
    // and cannot see the Worker's notification routing (see `ReplayMeter`).
    expect(bare.resume?.replayedEvents).toBe(0);
    expect(bare.resume?.replayDropped).toBe(0);
    r.close();

    const metered = rig({ onResume: { kind: "ok" }, replay: REPLAY });
    const result = await createSessionStrategy({
      descriptor: descriptorWith(),
      clock: metered.clock,
      logger: nullLogger(),
      replayMeter: { begin: () => () => ({ events: metered.inWindow.length, dropped: 1 }) },
    }).reopen(metered.link, metered.reopenOptions());
    expect(result.resume?.replayedEvents).toBe(2);
    expect(result.resume?.replayDropped).toBe(1);
    metered.close();
  });
});

// ── close() ─────────────────────────────────────────────────────────────────

describe("SessionStrategy.close", () => {
  it("sends the descriptor's close spelling", async () => {
    const r = rig();
    await strategyFor(r).close(r.link, SESSION);
    expect(r.agent.methods).toEqual(["session/close"]);
    r.close();
  });

  it("NEVER throws, whatever the agent answers", async () => {
    const r = rig({ supportsClose: false });
    await expect(strategyFor(r).close(r.link, SESSION)).resolves.toBeUndefined();
    r.close();
  });

  it("sends nothing when the descriptor names no spelling", async () => {
    const r = rig();
    const none = descriptorWith({ prefer: { close: { spellings: [], onFailure: "warn" } } });
    await createSessionStrategy({
      descriptor: none,
      clock: r.clock,
      logger: nullLogger(),
    }).close(r.link, SESSION);
    expect(r.agent.methods).toEqual([]);
    r.close();
  });
});

/** Lets the SDK's own message pump run without sleeping on wall-clock time. */
async function flushMicrotasks(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
  await new Promise<void>((r) => setImmediate(r));
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}
