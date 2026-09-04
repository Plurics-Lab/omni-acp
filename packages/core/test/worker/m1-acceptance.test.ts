import { describe, expect, it } from "vitest";
import {
  OmniError,
  type EventEnvelope,
  type RuntimeDescriptor,
  type WorkerStatePayload,
} from "@omni-acp/protocol";
import { fakeRuntime, nullLogger, seqIds } from "@omni-acp/testkit";
import { createHibernateTimer } from "../../src/worker/hibernate.js";
import { createRehydratedWorker } from "../../src/worker/rehydrated.js";
import {
  classifyResume,
  createDeferredPromotion,
  PERMANENT_TEXT,
} from "../../src/worker/resume-classify.js";
import { createSessionStrategy } from "../../src/worker/session-open.js";
import { resolveResumeMethod } from "../../src/worker/handshake.js";
import { createPlatformOps } from "../../src/process/platform.js";
import { createSupervisor } from "../../src/process/supervisor.js";
import { arrayLog } from "./support/array-log.js";
import {
  recordingLogger,
  realClock,
  recordingUtility,
  supervisorConfig,
} from "../process/support.js";
import {
  DAEMON_ID,
  DESCRIPTOR,
  harness,
  LIMITS,
  OWNER,
  WORKER_ID,
  type Harness,
} from "./support/harness.js";
import {
  asScripted,
  BOTH_SPELLINGS,
  NOT_RESUMABLE,
  resumableAgent,
} from "./support/resumable-agent.js";

/**
 * M1-WP-C's acceptance bullets (M1-PLAN §2, WP-C), one test each.
 *
 * This is the LEDGER, not the depth: each bullet is asserted here in its headline form and
 * proven in detail in the file named beside it. A bullet that cannot be satisfied literally is
 * still here, saying which half is provable and which half belongs to another work package —
 * a silently missing row would be indistinguishable from a bullet nobody read.
 */

const RUNTIME: RuntimeDescriptor = fakeRuntime({
  prefer: {
    resume: { spellings: ["session/resume", "session/load"], onFailure: "fail" },
    close: { spellings: ["session/close"], onFailure: "fail" },
  },
});

const stateOf = (e: EventEnvelope): WorkerStatePayload => e.payload as WorkerStatePayload;

const failure = async (p: Promise<unknown>): Promise<OmniError> => {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  if (!(e instanceof OmniError)) throw new Error(`expected an OmniError, got ${String(e)}`);
  return e;
};

async function ready(h: Harness, opts = { onResume: { kind: "ok" as const } }) {
  h.supervisor.enqueue(asScripted(resumableAgent(opts)));
  return await h.create({
    overrides: {
      session: createSessionStrategy({ descriptor: RUNTIME, clock: h.clock, logger: nullLogger() }),
      runtime: RUNTIME,
    },
  });
}

describe("M1-WP-C — hibernate, wake, the resume four-state, orphan reaping", () => {
  // 1 — hibernate-wake.test.ts §"§15.1's state table" and its `assertInvariants`.
  it("§15.1's state table is a table test, and all FIVE invariants hold after every transition", async () => {
    const h = harness();
    const w = await ready(h);
    const path: string[] = [];
    w.onStateChange((s, prev) => path.push(`${String(prev)}->${s}`));

    await w.hibernate("idle_timeout");
    const asleep = w.snapshot();
    // Invariants 1, 3 and 4 in their strongest form.
    expect(asleep.process).toBeNull();
    expect(asleep.sessionId).not.toBeNull();
    expect(asleep.capabilities?.resume.method).not.toBeNull();
    expect(asleep.hibernatedAt).not.toBeNull();
    expect(h.supervisor.live.size).toBe(0);

    h.supervisor.enqueue(asScripted(resumableAgent({ onResume: { kind: "ok" } })));
    const awake = await w.wake(OWNER);
    expect(awake.hibernatedAt).toBeNull();
    expect(awake.crashed).toBe(false);

    expect(path).toEqual(["ready->hibernated", "hibernated->starting", "starting->ready"]);
    // Invariant 5: exactly one envelope per transition, and the `previous` chain is a path.
    const chain = h.log.all.filter((e) => e.kind === "omni.worker_state").map(stateOf);
    expect(chain.map((p) => p.state)).toEqual([
      "starting",
      "ready",
      "hibernated",
      "starting",
      "ready",
    ]);
    let seen: string | null = null;
    for (const p of chain) {
      expect(p.previous).toBe(seen);
      seen = p.state;
    }
  });

  // 2 — resume-classify.test.ts, all 44 cases.
  it('§15.4\'s classifier table is green, INCLUDING the negative lock that PERMANENT_TEXT does not match "Resource not found" (F15), and the property "no network/timeout/auth/quota/5xx error ever yields rejected_permanent"', () => {
    expect(PERMANENT_TEXT.test("Resource not found: sess_1")).toBe(false);
    expect(PERMANENT_TEXT.test("session not found")).toBe(true);

    const attempt = (message: string) =>
      classifyResume({
        method: "session/load",
        requested: "sess_1",
        returned: null,
        acp: { code: -32002, message },
        transportFailed: false,
        timedOut: false,
        replayedEvents: 0,
        replayDropped: 0,
        capabilityAdvertised: true,
        requiresSameCwd: true,
        silentlyCreates: false,
        cwdChanged: false,
        durationMs: 1,
        at: "2026-09-04T00:00:00.000Z",
      });

    // The rows whose violation destroys a live session pointer.
    expect(attempt("Resource not found: sess_1")).toMatchObject({
      outcome: "unknown",
      hint: "cwd_mismatch",
      landedOn: "sess_1",
    });
    for (const transient of [
      "Rate limit exceeded",
      "503 Service Unavailable",
      "ECONNRESET",
      "Unauthorized",
    ]) {
      expect(attempt(transient).outcome).not.toBe("rejected_permanent");
    }
    expect(attempt("session not found").outcome).toBe("rejected_permanent");
  });

  // 3 — hibernate-wake.test.ts §"the replay window", session-strategy.test.ts §"attemptResume".
  it("the replay window marks exactly the updates between request and response and is closed in a finally: a REJECTED resume leaves the next turn's updates unmarked", async () => {
    const h = harness();
    const w = await ready(h);
    await w.hibernate("client_request");

    const replay = [
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "PONG" } },
    ];
    h.supervisor.enqueue(
      asScripted(
        resumableAgent({
          onResume: { kind: "error", code: -32000, message: "rate limit exceeded" },
          replay,
        }),
      ),
    );
    await failure(w.wake(OWNER));
    expect(h.log.all.filter((e) => e.replay === true)).toHaveLength(1);

    // The window closed on the REJECTION, so the next live update is not marked.
    const agent = resumableAgent({ onResume: { kind: "ok" } });
    h.supervisor.enqueue(asScripted(agent));
    await w.wake(OWNER);
    await agent.update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "live" },
    });
    await new Promise<void>((r) => setImmediate(r));
    const last = h.log.all.filter((e) => e.kind === "acp.session_update").at(-1);
    expect(last?.replay).toBeUndefined();
  });

  // 4 — hibernate-wake.test.ts §"hibernate (§15.2…)".
  it('hibernate() never sends session/close, releases the lease, leaves supervisor.live.size === 0, and REFUSES on a non-resumable agent under the default whenNotResumable:"keep"', async () => {
    const h = harness();
    const agent = resumableAgent({ onResume: { kind: "ok" } });
    h.supervisor.enqueue(asScripted(agent));
    const w = await h.create({
      overrides: {
        session: createSessionStrategy({
          descriptor: RUNTIME,
          clock: h.clock,
          logger: nullLogger(),
        }),
        runtime: RUNTIME,
      },
    });
    await w.hibernate("client_request");
    expect(agent.methods).not.toContain("session/close");
    expect(h.lease.hibernateReleases).toBe(1);
    expect(h.supervisor.live.size).toBe(0);

    const stubborn = harness();
    const w2 = await ready(stubborn, { capabilities: NOT_RESUMABLE } as never);
    const e = await failure(w2.hibernate("idle_timeout"));
    expect(e.code).toBe("not_resumable");
    expect(w2.snapshot().state).toBe("ready");
    expect(stubborn.supervisor.live.size).toBe(1);
  });

  // 5 — hibernate-wake.test.ts §"wake — §15.5's outcome table".
  it("wake outcomes landed / rejected_transient / rejected_permanent / unknown each produce §15.5's HTTP code and §15.1's end state on a scripted agent — no real agent needed", async () => {
    const cases = [
      {
        answer: { kind: "ok" as const },
        outcome: "landed",
        state: "ready",
        status: null as number | null,
      },
      {
        answer: { kind: "error" as const, code: -32000, message: "rate limit exceeded" },
        outcome: "rejected_transient",
        state: "hibernated",
        status: 502,
      },
      {
        answer: { kind: "error" as const, code: -32002, message: "session not found" },
        outcome: "rejected_permanent",
        state: "closed",
        status: 422,
      },
      {
        answer: { kind: "error" as const, code: -32099, message: "the agent is confused" },
        outcome: "unknown",
        state: "ready",
        status: null,
      },
    ];

    for (const c of cases) {
      const h = harness();
      const w = await ready(h);
      await w.hibernate("client_request");
      h.supervisor.enqueue(asScripted(resumableAgent({ onResume: c.answer })));

      if (c.status === null) {
        const snap = await w.wake(OWNER);
        expect(snap.resume?.outcome, c.outcome).toBe(c.outcome);
        expect(snap.state).toBe(c.state);
      } else {
        const e = await failure(w.wake(OWNER));
        expect(e.status, c.outcome).toBe(c.status);
        expect(e.resume?.outcome).toBe(c.outcome);
        expect(w.snapshot().state).toBe(c.state);
      }
    }
  });

  // 6 — hibernate-wake.test.ts §"wake — single flight and maxWakeFailures".
  it("concurrent wake() callers share ONE attempt (5 racing callers); maxWakeFailures is enforced and the (N+1)th prompt is 410, not another spawn", async () => {
    const h = harness();
    const w = await ready(h);
    await w.hibernate("client_request");
    h.supervisor.enqueue(asScripted(resumableAgent({ onResume: { kind: "ok" } })));

    const before = h.supervisor.spawnCalls.length;
    await Promise.all(Array.from({ length: 5 }, () => w.wake(OWNER)));
    expect(h.supervisor.spawnCalls.length - before).toBe(1);

    const capped = harness();
    capped.supervisor.enqueue(asScripted(resumableAgent({ onResume: { kind: "ok" } })));
    const w2 = await capped.create({
      overrides: {
        session: createSessionStrategy({
          descriptor: RUNTIME,
          clock: capped.clock,
          logger: nullLogger(),
        }),
        runtime: RUNTIME,
        limits: { ...LIMITS, maxWakeFailures: 2 },
      },
    });
    await w2.hibernate("client_request");
    for (let i = 0; i < 2; i += 1) {
      capped.supervisor.enqueue(
        asScripted(
          resumableAgent({ onResume: { kind: "error", code: -32000, message: "rate limit" } }),
        ),
      );
      await failure(w2.wake(OWNER));
    }
    expect(w2.snapshot().state).toBe("closed");

    const spawns = capped.supervisor.spawnCalls.length;
    const e = await failure(w2.prompt([{ type: "text", text: "hi" }], OWNER));
    expect(e.status).toBe(410);
    expect(capped.supervisor.spawnCalls.length).toBe(spawns);
  });

  // 7 — fingerprint.test.ts and orphan-reap.test.ts.
  it("fingerprint is captured at spawn on Linux and darwin and is null on win32; reapOrphan sends NO signal on a mismatch or a null fingerprint (spy-asserted) and the Windows branch compiles", async () => {
    const utility = recordingUtility();
    const windows = createPlatformOps("win32", { runUtility: utility.fn });
    expect(await windows.fingerprint(process.pid)).toBeNull();

    if (process.platform !== "win32") {
      const posix = createPlatformOps();
      expect(await posix.fingerprint(process.pid)).toMatch(/^(linux|darwin):/);
    }

    const signals: string[] = [];
    const spy = {
      ...createPlatformOps("linux"),
      fingerprint: () => Promise.resolve("linux:1:1"),
      signalTreeByGroup: (groupId: number, sig: string) => {
        signals.push(`${String(groupId)}:${sig}`);
        return Promise.resolve("sigterm" as const);
      },
      isGroupGone: () => Promise.resolve(true),
    };
    const supervisor = createSupervisor({
      config: supervisorConfig({ killConfirmMs: 10 }),
      clock: realClock(),
      logger: recordingLogger(),
      platform: spy,
    });
    const base = {
      pid: 4242,
      groupId: 4242,
      startedAt: "2026-09-04T00:00:00.000Z",
      reaped: false,
      reapSkipped: null,
    };

    expect(await supervisor.reapOrphan({ ...base, fingerprint: null })).toMatchObject({
      reaped: false,
      reapSkipped: "unsupported_platform",
    });
    expect(await supervisor.reapOrphan({ ...base, fingerprint: "linux:9:9" })).toMatchObject({
      reaped: false,
      reapSkipped: "fingerprint_mismatch",
    });
    expect(signals, "no signal on any refusal path").toEqual([]);

    // The Windows branch: compiles, runs on Linux, and answers `unsupported_platform`.
    const winSupervisor = createSupervisor({
      config: supervisorConfig(),
      clock: realClock(),
      logger: recordingLogger(),
      platform: windows,
    });
    expect(
      await winSupervisor.reapOrphan({ ...base, fingerprint: null, groupId: null }),
    ).toMatchObject({ reaped: false, reapSkipped: "unsupported_platform" });
    expect(utility.calls).toEqual([]);
  });

  // 8 — rehydrated.test.ts.
  it("createRehydratedWorker shares the Worker class; close() on a rehydrated hibernated worker returns {leaderExited:true, treeGone:true, sessionClosed:false}", async () => {
    const source = harness();
    const w = await ready(source);
    const snapshot = await w.hibernate("idle_timeout");

    const fresh = harness();
    const log = arrayLog({ workerId: WORKER_ID, daemonId: DAEMON_ID, clock: fresh.clock });
    const rehydrated = createRehydratedWorker(
      {
        snapshot,
        agentId: snapshot.agentId,
        bootId: "boot_previous",
        closeResult: null,
        lastActiveMs: 0,
        closedAtMs: null,
        hibernateIdleMs: null,
      },
      log,
      {
        descriptor: DESCRIPTOR,
        supervisor: fresh.supervisor,
        session: createSessionStrategy({
          descriptor: RUNTIME,
          clock: fresh.clock,
          logger: nullLogger(),
        }),
        lease: fresh.lease,
        clock: fresh.clock,
        ids: seqIds(),
        logger: fresh.logger,
        normalizer: fresh.normalizer,
        responder: fresh.deps().responder,
        limits: LIMITS,
        runtime: RUNTIME,
      },
    );

    expect(rehydrated.snapshot().state).toBe("hibernated");
    expect(await rehydrated.close("client_request")).toMatchObject({
      leaderExited: true,
      treeGone: true,
      sessionClosed: false,
    });
    expect(fresh.supervisor.spawnCalls).toHaveLength(0);
  });

  // 9 — resume-classify.test.ts §"rule 8".
  it("the deferred promotion (rule 8) fires at most once and can never overturn a `landed`", () => {
    const base = {
      method: "session/load" as const,
      requested: "sess_1",
      returned: null,
      transportFailed: false,
      timedOut: false,
      replayedEvents: 0,
      replayDropped: 0,
      capabilityAdvertised: true,
      requiresSameCwd: false,
      silentlyCreates: false,
      cwdChanged: false,
      durationMs: 1,
      at: "2026-09-04T00:00:00.000Z",
    };
    const unknown = classifyResume({
      ...base,
      acp: { code: -32099, message: "the agent is confused" },
    });
    const landed = classifyResume({ ...base, acp: null, returned: "sess_1" });

    const gate = createDeferredPromotion(unknown);
    expect(gate.offer({ stopReason: "refusal", activity: false })?.outcome).toBe(
      "rejected_permanent",
    );
    expect(gate.offer({ stopReason: "refusal", activity: false })).toBeNull();

    const never = createDeferredPromotion(landed);
    expect(never.offer({ stopReason: "refusal", activity: false })).toBeNull();
    expect(never.report.outcome).toBe("landed");
  });

  // 10 — session-strategy.test.ts §"resumeSpellings" and §"SessionStrategy.open".
  it("handshake.ts resolves resume.method from the descriptor's preference order and captures modes/configOptions from session/new AND from a resume body", async () => {
    expect(resolveResumeMethod(RUNTIME, BOTH_SPELLINGS)).toBe("session/resume");
    expect(resolveResumeMethod(RUNTIME, { loadSession: true })).toBe("session/load");
    expect(resolveResumeMethod(RUNTIME, NOT_RESUMABLE)).toBeNull();

    const h = harness();
    h.supervisor.enqueue(
      asScripted(
        resumableAgent({
          newSessionBody: { modes: { currentModeId: "default" }, configOptions: [{ id: "model" }] },
          onResume: { kind: "ok", modes: { currentModeId: "plan" } },
        }),
      ),
    );
    const w = await h.create({
      overrides: {
        session: createSessionStrategy({
          descriptor: RUNTIME,
          clock: h.clock,
          logger: nullLogger(),
        }),
        runtime: RUNTIME,
      },
    });
    // From `session/new`…
    expect(w.snapshot().capabilities?.modes).toEqual({ currentModeId: "default" });
    expect(w.snapshot().capabilities?.configOptions).toEqual([{ id: "model" }]);

    await w.hibernate("client_request");
    h.supervisor.enqueue(
      asScripted(resumableAgent({ onResume: { kind: "ok", modes: { currentModeId: "plan" } } })),
    );
    const awake = await w.wake(OWNER);
    // …and from the RESUME body, which returns the same shape contrary to the v1 schema (F18).
    expect(awake.capabilities?.modes).toEqual({ currentModeId: "plan" });
  });

  // A bullet's companion, not a bullet of its own: the timer that CALLS hibernate().
  it("the idle timer refuses to fire on an unwakeable worker under the default policy (M1-R15)", () => {
    const h = harness();
    let fired = 0;
    const timer = createHibernateTimer({
      clock: h.clock,
      idleMs: 1_000,
      resumable: () => false,
      onFire: () => {
        fired += 1;
      },
    });
    timer.touch();
    h.clock.advance(10_000);
    expect(fired).toBe(0);
  });
});
