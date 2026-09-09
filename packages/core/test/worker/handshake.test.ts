import { describe, expect, it } from "vitest";
import { OmniError, type EventEnvelope, type WorkerStatePayload } from "@omni-acp/protocol";
import { scriptedAgent } from "@omni-acp/testkit";
import { flush, harness, LIMITS } from "./support/harness.js";
import { asScriptedAgent, rawAgent } from "./support/raw-agent.js";

const stateOf = (e: EventEnvelope): WorkerStatePayload => e.payload as WorkerStatePayload;

const failure = async (p: Promise<unknown>): Promise<OmniError> => {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  if (!(e instanceof OmniError)) throw new Error(`expected an OmniError, got ${String(e)}`);
  return e;
};

describe("createWorker — the successful handshake (WP-4 acceptance 1)", () => {
  it("reaches ready and reports the REAL handshake capabilities", async () => {
    const h = harness();
    h.supervisor.enqueue(scriptedAgent());

    const w = await h.create();
    const snap = w.snapshot();

    expect(snap.state).toBe("ready");
    expect(snap.sessionId).toBe("sess_1");
    expect(snap.capabilities).toEqual({
      protocolVersion: 1,
      raw: { loadSession: false },
      // The M0 fixture does not support session/load, and we say so rather than guessing.
      loadSession: false,
      promptCapabilities: null,
      supportsSessionClose: false,
      // M1's fields (§5.1 `AgentCapabilitiesSnapshot`). `resume.method: null` is "no resume
      // spelling has been RESOLVED" — the reading that makes `whenNotResumable:"keep"` refuse to
      // hibernate — and every other field says the handshake learned nothing it did not observe.
      resume: { method: null, replayFrom: false, requiresSameCwd: false },
      supportsSessionList: false,
      configOptions: null,
      modes: null,
      extensions: [],
      // M2 (§5.8.4): D10's gate, recorded AS SENT. `{}` here is D3 and byte-for-byte M1 — this
      // worker was created with no `clientCapabilities` dep, so nothing was declared. F28 is why
      // it is recorded at all: `initialize`'s `agentCapabilities` never mentions elicitation
      // either way, so OUR declaration is the only record of why an agent asked in prose.
      clientCapabilities: {},
    });
    expect(snap.process?.pid).toBeGreaterThan(0);
    expect(snap.closeReason).toBeNull();
    expect(snap.currentTurnId).toBeNull();
    expect(snap.agentId).toBe("test-agent");
    expect(snap.ref).toBe(`${snap.daemonId}:${snap.workerId}`);
  });

  it("passes the agent's advertised capabilities through verbatim, never reshaped", async () => {
    const h = harness();
    const agent = scriptedAgent();
    agent.setCapabilities({
      loadSession: true,
      promptCapabilities: { image: true, embeddedContext: true },
      sessionCapabilities: { close: {}, resume: null },
      vendorExtension: { anything: [1, 2, 3] },
    });
    h.supervisor.enqueue(agent);

    const caps = (await h.create()).snapshot().capabilities;
    expect(caps?.loadSession).toBe(true);
    expect(caps?.promptCapabilities).toEqual({ image: true, embeddedContext: true });
    // An OBJECT capability: `{}` means "supported". `=== true` would read this as unsupported.
    expect(caps?.supportsSessionClose).toBe(true);
    expect(caps?.raw["vendorExtension"]).toEqual({ anything: [1, 2, 3] });
  });

  it("writes seq 1 = worker_state{starting} with a NULL sessionId, then ready with it (§8.2)", async () => {
    const h = harness();
    h.supervisor.enqueue(scriptedAgent());
    await h.create();

    const all = h.log.all;
    expect(all).toHaveLength(2);
    expect(all[0]?.seq).toBe(1);
    expect(all[0]?.kind).toBe("omni.worker_state");
    expect(stateOf(all[0]!)).toMatchObject({
      state: "starting",
      previous: null,
      reason: "created",
    });
    // The pre-handshake prefix is frozen at null and is never back-filled (§8.2 rule 3, R16).
    expect(all[0]?.sessionId).toBeNull();

    expect(stateOf(all[1]!)).toMatchObject({
      state: "ready",
      previous: "starting",
      reason: "handshake_ok",
    });
    expect(all[1]?.sessionId).toBe("sess_1");
    expect(Object.isFrozen(all[0])).toBe(true);
  });

  it("sends initialize{protocolVersion:1, clientCapabilities:{}} and session/new{mcpServers:[]}", async () => {
    const h = harness();
    const agent = rawAgent();
    h.supervisor.enqueue(asScriptedAgent(agent));

    // The payload is asserted by the agent side, not by inspection: the SDK parses `initialize`
    // and `session/new` against the v1 schema before dispatching, so a missing `mcpServers` or a
    // malformed `clientCapabilities` would come back as -32602 and no session would exist.
    await h.create();
    expect(agent.sessionIds).toEqual(["raw_1"]);

    const spec = h.supervisor.spawnCalls[0];
    expect(spec?.command).toBe("/usr/bin/true");
    expect(spec?.args).toEqual(["--acp"]);
    expect(spec?.cwd).toBe("/tmp/omni-acp-test");
    // The COMPLETE environment: inherited, plus the descriptor's own entries.
    expect(spec?.env["OMNI_TEST"]).toBe("1");
    expect(Object.keys(spec?.env ?? {}).length).toBeGreaterThan(1);
    expect(spec?.gracefulMs).toBe(5_000);
    expect(spec?.shutdownSignal).toBe("SIGTERM");
  });

  it("lets a Catalog own SpawnSpec production when one is supplied", async () => {
    const h = harness();
    h.supervisor.enqueue(scriptedAgent());
    await h.create({
      overrides: {
        toSpawnSpec: (d, o) => ({
          command: "catalog-said-so",
          args: [d.id],
          cwd: o.cwd,
          env: { ONLY: "this" },
        }),
      },
    });
    expect(h.supervisor.spawnCalls[0]).toMatchObject({
      command: "catalog-said-so",
      args: ["test-agent"],
      env: { ONLY: "this" },
    });
  });
});

/**
 * WP-4 acceptance 4. Every failure edge must do the SAME three things — reject with an already
 * correct code, leave `omni.error` + `omni.worker_state{closed}` in the log, and reclaim the
 * tree — because `POST /v1/workers` maps the code with one table and must never leave a process
 * behind on a 502 or a 504 (§2.1 H5).
 */
describe("createWorker — every handshake failure edge (WP-4 acceptance 4)", () => {
  const assertReclaimedAndLogged = (
    h: ReturnType<typeof harness>,
    reason: string,
    code: string,
  ): void => {
    expect(h.log.kinds()).toEqual(["omni.worker_state", "omni.error", "omni.worker_state"]);
    const closed = h.log.all[2]!;
    expect(stateOf(closed)).toMatchObject({ state: "closed", previous: "starting", reason });
    expect(stateOf(closed).error?.code).toBe(code);
    expect(h.supervisor.allTreesReclaimed()).toBe(true);
    expect(h.supervisor.live.size).toBe(0);
  };

  it("a JSON-RPC error from initialize => agent_error (502), carrying the agent's `acp` body", async () => {
    const h = harness();
    h.supervisor.enqueue(
      asScriptedAgent(rawAgent({ failInitialize: { code: -32002, message: "auth required" } })),
    );

    const e = await failure(h.create());
    expect(e.code).toBe("agent_error");
    expect(e.status).toBe(502);
    // Passed through verbatim, never reshaped (§9).
    expect(e.acp).toMatchObject({ code: -32002, message: "auth required" });
    assertReclaimedAndLogged(h, "handshake_error", "agent_error");
  });

  it("a JSON-RPC error from session/new => agent_error, and the tree is still reclaimed", async () => {
    const h = harness();
    h.supervisor.enqueue(
      asScriptedAgent(rawAgent({ failNewSession: { code: -32603, message: "no session" } })),
    );

    const e = await failure(h.create());
    expect(e.code).toBe("agent_error");
    expect(e.acp?.code).toBe(-32603);
    assertReclaimedAndLogged(h, "handshake_error", "agent_error");
  });

  it("an agent that negotiates a protocol version other than 1 => agent_error", async () => {
    const h = harness();
    h.supervisor.enqueue(asScriptedAgent(rawAgent({ protocolVersion: 2 })));

    const e = await failure(h.create());
    expect(e.code).toBe("agent_error");
    expect(e.message).toContain("version 2");
    assertReclaimedAndLogged(h, "handshake_error", "agent_error");
  });

  it("the budget expiring => agent_timeout (504), on ONE budget for the whole handshake", async () => {
    const h = harness();
    h.supervisor.enqueue(asScriptedAgent(rawAgent({ hangInitialize: true })));

    const started = h.create();
    const settled = failure(started);
    await flush();

    // Not a millisecond early: the budget is the number an operator configured (D17).
    h.clock.advance(LIMITS.handshakeTimeoutMs - 1);
    await flush();
    expect(h.log.kinds()).toEqual(["omni.worker_state"]);

    h.clock.advance(1);
    const e = await settled;
    expect(e.code).toBe("agent_timeout");
    expect(e.status).toBe(504);
    expect(e.message).toContain("60000ms");
    assertReclaimedAndLogged(h, "handshake_timeout", "agent_timeout");
  });

  it("an abort mid-handshake => agent_timeout, tree reclaimed", async () => {
    const h = harness();
    h.supervisor.enqueue(asScriptedAgent(rawAgent({ hangInitialize: true })));

    const controller = new AbortController();
    const settled = failure(h.create({ signal: controller.signal }));
    await flush();
    controller.abort();

    const e = await settled;
    expect(e.code).toBe("agent_timeout");
    assertReclaimedAndLogged(h, "handshake_timeout", "agent_timeout");
  });

  it("an agent that dies during the handshake fails it rather than hanging on the budget", async () => {
    const h = harness();
    const agent = rawAgent({ hangInitialize: true });
    h.supervisor.enqueue(asScriptedAgent(agent));

    const settled = failure(h.create());
    await flush();
    // The process signals are the authority (§6.7) — the in-memory transport never EOFs on its
    // own, so a worker that waited for the link would sit here for the whole 60 s budget.
    h.process().simulateExit(3, null);

    const e = await settled;
    expect(e.code).toBe("agent_error");
    expect(h.log.kinds()).toEqual(["omni.worker_state", "omni.error", "omni.worker_state"]);
    expect(stateOf(h.log.all[2]!)).toMatchObject({
      state: "closed",
      reason: "agent_crashed",
      exit: { code: 3, signal: null },
    });
    expect(h.supervisor.allTreesReclaimed()).toBe(true);
  });

  it("a spawn failure => agent_error with reason spawn_failed and no process at all", async () => {
    const h = harness();
    h.supervisor.enqueue({ failWith: new Error("spawn /usr/bin/true ENOENT") });

    const e = await failure(h.create());
    expect(e.code).toBe("agent_error");
    expect(e.message).toContain("ENOENT");
    expect(h.log.kinds()).toEqual(["omni.worker_state", "omni.error", "omni.worker_state"]);
    expect(stateOf(h.log.all[2]!)).toMatchObject({
      state: "closed",
      reason: "spawn_failed",
      // Nothing was ever created, so nothing is left running — but this is the one place the
      // claim is about an absent tree rather than a reclaimed one.
      leaderExited: true,
      treeGone: true,
    });
    expect(h.supervisor.live.size).toBe(0);
  });

  it("an already-aborted signal never reaches the agent at all", async () => {
    const h = harness();
    h.supervisor.enqueue(scriptedAgent());
    const controller = new AbortController();
    controller.abort();

    const e = await failure(h.create({ signal: controller.signal }));
    expect(e.code).toBe("agent_timeout");
    expect(h.supervisor.live.size).toBe(0);
  });
});
