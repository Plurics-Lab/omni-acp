import { describe, expect, it } from "vitest";
import {
  OmniError,
  type EventEnvelope,
  type RuntimeDescriptor,
  type SessionStrategy,
  type WorkerHandle,
  type WorkerSnapshot,
  type WorkerState,
  type WorkerStatePayload,
} from "@omni-acp/protocol";
import { fakeRuntime, nullLogger } from "@omni-acp/testkit";
import { createSessionStrategy } from "../../src/worker/session-open.js";
import { flush, harness, OWNER, TEXT, type Harness } from "./support/harness.js";
import {
  asScripted,
  NOT_RESUMABLE,
  resumableAgent,
  type ResumableAgent,
  type ResumableAgentOptions,
} from "./support/resumable-agent.js";

/**
 * §15.1's state table, §15.2's ordering and §15.3's wake ladder, END TO END through the real
 * `Worker` — the Land-written half — with a fake supervisor and a scripted agent.
 *
 * No real agent is needed for any of it: every row of §15.5's outcome table is one scripted
 * answer to `session/resume`, which is the whole point of putting the four-state classifier
 * behind a pure function.
 */

const stateOf = (e: EventEnvelope): WorkerStatePayload => e.payload as WorkerStatePayload;

const DESCRIPTOR: RuntimeDescriptor = fakeRuntime({
  prefer: {
    resume: { spellings: ["session/resume", "session/load"], onFailure: "fail" },
    close: { spellings: ["session/close"], onFailure: "fail" },
  },
});

const strategyFor = (h: Harness, descriptor = DESCRIPTOR): SessionStrategy =>
  createSessionStrategy({ descriptor, clock: h.clock, logger: nullLogger() });

interface Rig {
  readonly h: Harness;
  readonly worker: WorkerHandle;
  readonly agents: readonly ResumableAgent[];
  /** Enqueues the agent the NEXT spawn (i.e. the next wake) will be wired to. */
  next(opts?: ResumableAgentOptions): ResumableAgent;
  readonly states: readonly [WorkerState, WorkerState | null][];
}

/**
 * A worker created against a resumable agent, with the strategy injected — i.e. the M1 shape.
 *
 * The invariant checker is installed BEFORE the first transition this rig performs, so §15.1's
 * five invariants are asserted after every state change rather than only at the end.
 */
async function rig(o?: {
  agent?: ResumableAgentOptions;
  descriptor?: RuntimeDescriptor;
  limits?: Partial<
    Parameters<Harness["deps"]>[0] extends undefined ? never : Record<string, number>
  >;
  maxWakeFailures?: number;
}): Promise<Rig> {
  const h = harness();
  const descriptor = o?.descriptor ?? DESCRIPTOR;
  const agents: ResumableAgent[] = [];
  const next = (opts: ResumableAgentOptions = { onResume: { kind: "ok" } }): ResumableAgent => {
    const agent = resumableAgent(opts);
    agents.push(agent);
    h.supervisor.enqueue(asScripted(agent));
    return agent;
  };
  next(o?.agent ?? { onResume: { kind: "ok" } });

  const worker = await h.create({
    overrides: {
      session: strategyFor(h, descriptor),
      runtime: descriptor,
      limits: {
        ...h.deps().limits,
        ...(o?.maxWakeFailures === undefined ? {} : { maxWakeFailures: o.maxWakeFailures }),
      },
    },
  });

  const states: [WorkerState, WorkerState | null][] = [];
  worker.onStateChange((s, prev) => {
    states.push([s, prev]);
    assertInvariants(h, worker);
  });
  assertInvariants(h, worker);

  return { h, worker, agents, next, states };
}

/** §15.1's five invariants, asserted after EVERY transition. */
function assertInvariants(h: Harness, w: WorkerHandle): void {
  const snap: WorkerSnapshot = w.snapshot();

  // 1. A hibernated worker has no process, HAS a session pointer, and HAS a resolved spelling.
  //    Any one of the three missing makes it a worker that can never wake.
  if (snap.state === "hibernated") {
    expect(snap.process, "invariant 1: process").toBeNull();
    expect(snap.sessionId, "invariant 1: sessionId").not.toBeNull();
    expect(snap.capabilities?.resume.method, "invariant 1: resume.method").not.toBeNull();
  }

  // 2. `crashed` is MONOTONE. Tracked across calls on the module-level map below.
  const previouslyCrashed = crashedSoFar.get(w) ?? false;
  if (previouslyCrashed) expect(snap.crashed, "invariant 2: crashed is monotone").toBe(true);
  crashedSoFar.set(w, snap.crashed);

  // 3. `hibernatedAt !== null` <=> `state === "hibernated"`.
  expect(snap.hibernatedAt !== null, "invariant 3").toBe(snap.state === "hibernated");

  // 4. A hibernated worker holds ZERO `maxWorkers` slots. The registry's `maxHibernated` half is
  //    WP-E's; what a Worker can prove is that it owns no live process, which is the fact the
  //    slot accounting is derived from.
  if (snap.state === "hibernated") {
    expect(h.supervisor.live.size, "invariant 4: holds no process slot").toBe(0);
  }

  // 5. The log's `previous` chain is a valid path: every envelope's `previous` is the state the
  //    envelope before it announced.
  const chain = h.log.all.filter((e) => e.kind === "omni.worker_state").map(stateOf);
  let seen: WorkerState | null = null;
  for (const p of chain) {
    expect(p.previous, "invariant 5: the previous chain is a path").toBe(seen);
    seen = p.state;
  }
}

const crashedSoFar = new WeakMap<WorkerHandle, boolean>();

const failure = async (p: Promise<unknown>): Promise<OmniError> => {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  if (!(e instanceof OmniError)) throw new Error(`expected an OmniError, got ${String(e)}`);
  return e;
};

const transitions = (h: Harness): string[] =>
  h.log.all
    .filter((e) => e.kind === "omni.worker_state")
    .map(stateOf)
    .map((p) => `${String(p.previous)}->${p.state}:${p.reason}`);

// ── §15.2: hibernate, and the order that IS the correctness argument ────────

describe("hibernate (§15.2, M1-PLAN WP-C acceptance 4)", () => {
  it("NEVER sends session/close — the pointer is the entire value being preserved", async () => {
    const r = await rig();
    const agent = r.agents[0]!;
    expect(agent.methods).toEqual(["initialize", "session/new"]);

    const snap = await r.worker.hibernate("client_request");

    // Asserted on the WIRE, by an agent that records every method it was asked for. The agent
    // ADVERTISES `sessionCapabilities.close` and would have answered it — which is exactly the
    // case that matters, because claude-acp's `close` is real and destructive.
    expect(agent.methods).toEqual(["initialize", "session/new"]);
    expect(snap.capabilities?.supportsSessionClose).toBe(true);
    expect(snap.state).toBe("hibernated");
  });

  it("releases the lease, reclaims the tree, and keeps the record and the pointer", async () => {
    const r = await rig();
    const before = r.worker.snapshot();
    expect(before.process).not.toBeNull();

    const snap = await r.worker.hibernate("client_request");

    // DESIGN §3.2: 进程回收、lease 释放、记录与 session 指针保留.
    expect(r.h.supervisor.live.size).toBe(0);
    expect(r.h.lease.hibernateReleases).toBe(1);
    expect(snap.sessionId).toBe(before.sessionId);
    expect(snap.capabilities).toEqual(before.capabilities);
    expect(snap.process).toBeNull();
    expect(snap.hibernatedAt).not.toBeNull();
    expect(snap.generation).toBe(1);
  });

  it("appends EXACTLY ONE worker_state{hibernated, hibernate}", async () => {
    const r = await rig();
    await r.worker.hibernate("idle_timeout");
    expect(transitions(r.h)).toEqual([
      "null->starting:created",
      "starting->ready:handshake_ok",
      "ready->hibernated:hibernate",
    ]);
  });

  it("is idempotent: a second call answers with the snapshot, and reclaims nothing twice", async () => {
    const r = await rig();
    const first = await r.worker.hibernate("client_request");
    const second = await r.worker.hibernate("client_request");
    expect(second.state).toBe("hibernated");
    expect(second.hibernatedAt).toBe(first.hibernatedAt);
    expect(r.h.lease.hibernateReleases).toBe(1);
    expect(transitions(r.h).filter((t) => t.endsWith(":hibernate"))).toHaveLength(1);
  });

  it("concurrent callers share ONE transition", async () => {
    const r = await rig();
    const all = await Promise.all([
      r.worker.hibernate("client_request"),
      r.worker.hibernate("client_request"),
      r.worker.hibernate("idle_timeout"),
    ]);
    expect(all.every((s) => s.state === "hibernated")).toBe(true);
    expect(r.h.lease.hibernateReleases).toBe(1);
    expect(transitions(r.h).filter((t) => t.endsWith(":hibernate"))).toHaveLength(1);
  });

  it("REFUSES on an agent with no resume spelling — M1-R15's `whenNotResumable: keep`", async () => {
    const r = await rig({ agent: { capabilities: NOT_RESUMABLE } });
    expect(r.worker.snapshot().capabilities?.resume.method).toBeNull();

    const e = await failure(r.worker.hibernate("idle_timeout"));
    expect(e.code).toBe("not_resumable");
    expect(e.message).toContain("advertises no resume spelling");

    // The process is KEPT. Hibernating a worker you can never wake is a one-way door that turns
    // a healthy worker into a guaranteed 422 on a timer; memory is the cheaper loss.
    expect(r.worker.snapshot().state).toBe("ready");
    expect(r.h.supervisor.live.size).toBe(1);
    expect(r.h.lease.hibernateReleases).toBe(0);
    // §15.1's `ready -> ready` row emits NO envelope, because nothing happened.
    expect(transitions(r.h)).toEqual(["null->starting:created", "starting->ready:handshake_ok"]);
  });

  it("REFUSES when no SessionStrategy is wired — nothing could reopen the session", async () => {
    // M0's shape exactly: no strategy, so `runHandshake` ran and nothing can `reopen`.
    const h = harness();
    h.supervisor.enqueue(asScripted(resumableAgent()));
    const w = await h.create();
    const e = await failure(w.hibernate("idle_timeout"));
    expect(e.code).toBe("not_resumable");
    expect(e.message).toContain("no SessionStrategy");
    expect(w.snapshot().state).toBe("ready");
  });

  it("refuses mid-turn: a running worker is `worker_busy`, never hibernated under a live prompt", async () => {
    const r = await rig();
    await r.worker.prompt([TEXT("hello")], OWNER);
    expect(r.worker.snapshot().state).toBe("running");

    const e = await failure(r.worker.hibernate("idle_timeout"));
    expect(e.code).toBe("worker_busy");
    expect(e.status).toBe(409);
    expect(r.h.supervisor.live.size).toBe(1);
  });

  it("a prompt arriving INSIDE the hibernate window already sees busy (§15.2's #hibernating)", async () => {
    const r = await rig();
    const hibernating = r.worker.hibernate("client_request");
    // No await between: this is the window between "we decided to reclaim" and "the state says
    // hibernated", and a synchronous flag is the only thing that closes it.
    const e = await failure(r.worker.prompt([TEXT("racing")], OWNER));
    expect(["worker_busy", "worker_closed"]).toContain(e.code);
    await hibernating;
  });

  it("a closed worker cannot hibernate", async () => {
    const r = await rig();
    await r.worker.close("client_request");
    const e = await failure(r.worker.hibernate("idle_timeout"));
    expect(e.code).toBe("worker_closed");
    expect(e.status).toBe(410);
  });
});

// ── §15.3 / §15.5: the wake ladder and its four outcomes ────────────────────

describe("wake — §15.5's outcome table on a scripted agent (acceptance 5)", () => {
  it("landed => ready, 200, generation +1, pointer kept, wakeFailures reset", async () => {
    const r = await rig();
    await r.worker.hibernate("client_request");
    r.next({ onResume: { kind: "ok" } });

    const snap = await r.worker.wake(OWNER);

    expect(snap.state).toBe("ready");
    expect(snap.resume?.outcome).toBe("landed");
    expect(snap.resume?.method).toBe("session/resume");
    expect(snap.sessionId).toBe("sess_resumable");
    expect(snap.generation).toBe(2);
    expect(snap.wakeCount).toBe(1);
    expect(snap.wakeFailures).toBe(0);
    expect(snap.hibernatedAt).toBeNull();
    expect(r.h.supervisor.live.size).toBe(1);
    expect(transitions(r.h)).toEqual([
      "null->starting:created",
      "starting->ready:handshake_ok",
      "ready->hibernated:hibernate",
      "hibernated->starting:wake",
      "starting->ready:resumed",
    ]);
    // The `resumed` envelope always carries the report (§15.1's `+resume` column).
    const resumed = r.h.log.all
      .filter((e) => e.kind === "omni.worker_state")
      .map(stateOf)
      .at(-1);
    expect(resumed?.resume?.outcome).toBe("landed");
  });

  it("unknown => ready, 200, and the pointer SURVIVES (F15's cwd mismatch, M1-R6)", async () => {
    const quirky = fakeRuntime({
      prefer: DESCRIPTOR.prefer,
      quirks: { ...DESCRIPTOR.quirks, resumeRequiresSameCwd: true },
    });
    const r = await rig({ descriptor: quirky });
    await r.worker.hibernate("client_request");
    r.next({
      onResume: {
        kind: "error",
        code: -32002,
        message: "Resource not found: sess_resumable",
        data: { uri: "sess_resumable" },
      },
    });

    const snap = await r.worker.wake(OWNER);

    expect(snap.state).toBe("ready");
    expect(snap.resume?.outcome).toBe("unknown");
    expect(snap.resume?.hint).toBe("cwd_mismatch");
    expect(snap.sessionId).toBe("sess_resumable");
    expect(transitions(r.h).at(-1)).toBe("starting->ready:resumed");
  });

  it("rejected_transient => back to `hibernated`, 502, pointer KEPT, wakeFailures +1", async () => {
    const r = await rig();
    await r.worker.hibernate("client_request");
    r.next({ onResume: { kind: "error", code: -32000, message: "Rate limit exceeded" } });

    const e = await failure(r.worker.wake(OWNER));

    expect(e.code).toBe("agent_error");
    expect(e.status).toBe(502);
    expect(e.resume?.outcome).toBe("rejected_transient");

    const snap = r.worker.snapshot();
    expect(snap.state).toBe("hibernated");
    expect(snap.sessionId).toBe("sess_resumable");
    expect(snap.wakeFailures).toBe(1);
    expect(r.h.supervisor.live.size).toBe(0);
    expect(transitions(r.h).at(-1)).toBe("starting->hibernated:wake_retry");
  });

  it("rejected_permanent => closed(not_resumable), 422, pointer CLEARED", async () => {
    const r = await rig();
    await r.worker.hibernate("client_request");
    r.next({
      onResume: { kind: "error", code: -32002, message: "session not found: sess_resumable" },
    });

    const e = await failure(r.worker.wake(OWNER));

    expect(e.code).toBe("not_resumable");
    expect(e.status).toBe(422);
    expect(e.resume?.outcome).toBe("rejected_permanent");
    expect(e.resume?.rule).toBe("rule2:session-not-found");
    // Ruling M1-R7: there is no `new_session` fallback in M1. A context-free session that LOOKS
    // resumed is undetectable from the outside, so the answer is a 422 and a closed worker.
    const snap = r.worker.snapshot();
    expect(snap.state).toBe("closed");
    expect(snap.closeReason).toBe("not_resumable");
    expect(snap.sessionId).toBeNull();
    expect(transitions(r.h).at(-1)).toBe("starting->closed:not_resumable");
  });

  it("a woken process that advertises nothing still TRIES the remembered spelling, then 422s", async () => {
    const r = await rig();
    await r.worker.hibernate("client_request");
    const agent = r.next({ capabilities: NOT_RESUMABLE });

    const e = await failure(r.worker.wake(OWNER));

    // §15.1's invariant 1 guarantees a hibernated worker HAS a resolved spelling, so the wake
    // path never sees `capability_absent`: a warm `initialize` that says less than the cold one
    // did must not turn a resumable worker into a 422 on the strength of an advertisement.
    // What ends it is the agent answering -32601 to the spelling that used to work.
    expect(agent.methods).toEqual(["initialize", "session/resume"]);
    expect(e.code).toBe("not_resumable");
    expect(e.status).toBe(422);
    expect(e.resume?.hint).toBe("method_not_found");
    expect(e.resume?.rule).toBe("rule3:method-not-found");
    expect(r.worker.snapshot().state).toBe("closed");
    expect(r.worker.snapshot().sessionId).toBeNull();
  });

  it("a spawn failure => back to `hibernated`, 502, and the pointer is kept (§15.5)", async () => {
    const r = await rig();
    await r.worker.hibernate("client_request");
    r.h.supervisor.enqueue({ failWith: new Error("npx: command not found") });

    const e = await failure(r.worker.wake(OWNER));
    expect(e.code).toBe("agent_error");
    const snap = r.worker.snapshot();
    expect(snap.state).toBe("hibernated");
    expect(snap.sessionId).toBe("sess_resumable");
    expect(snap.wakeFailures).toBe(1);
  });

  it("wake on a `ready` worker is a no-op: it asked for a live process and there is one", async () => {
    const r = await rig();
    const snap = await r.worker.wake(OWNER);
    expect(snap.state).toBe("ready");
    expect(snap.wakeCount).toBe(0);
    expect(r.h.supervisor.spawnCalls).toHaveLength(1);
  });

  it("wake on a `closed` worker is 410, not a spawn", async () => {
    const r = await rig();
    await r.worker.close("client_request");
    const e = await failure(r.worker.wake(OWNER));
    expect(e.code).toBe("worker_closed");
    expect(e.status).toBe(410);
    expect(r.h.supervisor.spawnCalls).toHaveLength(1);
  });

  it("asserts the lease FIRST, exactly as prompt() and cancel() do (F22, seam 3)", async () => {
    const r = await rig();
    await r.worker.hibernate("client_request");
    r.next();
    const before = r.h.lease.asserted.length;
    await r.worker.wake(OWNER);
    expect(r.h.lease.asserted.length).toBeGreaterThan(before);
    expect(r.h.lease.asserted.at(-1)).toBe(OWNER);
  });
});

// ── the single flight and the failure cap (acceptance 6) ────────────────────

describe("wake — single flight and maxWakeFailures (acceptance 6)", () => {
  it("five racing callers share ONE attempt, i.e. ONE npx cold start", async () => {
    const r = await rig();
    await r.worker.hibernate("client_request");
    r.next({ onResume: { kind: "ok" } });
    const spawnsBefore = r.h.supervisor.spawnCalls.length;

    const results = await Promise.all([
      r.worker.wake(OWNER),
      r.worker.wake(OWNER),
      r.worker.wake(OWNER),
      r.worker.wake(OWNER),
      r.worker.wake(OWNER),
    ]);

    expect(r.h.supervisor.spawnCalls.length - spawnsBefore).toBe(1);
    expect(results.every((s) => s.state === "ready")).toBe(true);
    expect(new Set(results.map((s) => s.generation))).toEqual(new Set([2]));
    expect(r.worker.snapshot().wakeCount).toBe(1);
    // ONE `wake` and ONE `resumed` envelope, not five of each.
    expect(transitions(r.h).filter((t) => t.endsWith(":wake"))).toHaveLength(1);
    expect(transitions(r.h).filter((t) => t.endsWith(":resumed"))).toHaveLength(1);
  });

  it("five racing FAILURES also share one attempt, and count as ONE failure", async () => {
    const r = await rig();
    await r.worker.hibernate("client_request");
    r.next({ onResume: { kind: "error", code: -32000, message: "rate limit exceeded" } });

    const errors = await Promise.all(
      Array.from({ length: 5 }, () => failure(r.worker.wake(OWNER))),
    );
    expect(errors.every((e) => e.code === "agent_error")).toBe(true);
    expect(r.worker.snapshot().wakeFailures).toBe(1);
  });

  it("maxWakeFailures is enforced, and the (N+1)th prompt is 410 rather than another spawn", async () => {
    const r = await rig({ maxWakeFailures: 3 });
    await r.worker.hibernate("client_request");

    const transient = (): ResumableAgent =>
      r.next({ onResume: { kind: "error", code: -32000, message: "rate limit exceeded" } });

    // Failures 1 and 2 keep the pointer and go back to `hibernated`.
    for (const expected of [1, 2]) {
      transient();
      const e = await failure(r.worker.wake(OWNER));
      expect(e.code).toBe("agent_error");
      expect(r.worker.snapshot().state).toBe("hibernated");
      expect(r.worker.snapshot().wakeFailures).toBe(expected);
    }

    // The third ABANDONS the pointer: `wake_failed`, 422, and the worker closes. This is what
    // stops a worker whose agent binary was uninstalled from paying a 7 s spawn forever.
    transient();
    const fatal = await failure(r.worker.wake(OWNER));
    expect(fatal.code).toBe("not_resumable");
    expect(fatal.status).toBe(422);
    expect(fatal.message).toContain("3 consecutive failed wakes");
    expect(r.worker.snapshot().state).toBe("closed");
    expect(r.worker.snapshot().sessionId).toBeNull();
    expect(transitions(r.h).at(-1)).toBe("starting->closed:wake_failed");

    // The (N+1)th PROMPT is 410 and spawns nothing: the worker is closed, not sleeping.
    const spawns = r.h.supervisor.spawnCalls.length;
    const after = await failure(r.worker.prompt([TEXT("still there?")], OWNER));
    expect(after.code).toBe("worker_closed");
    expect(after.status).toBe(410);
    expect(r.h.supervisor.spawnCalls.length).toBe(spawns);
  });

  it("a successful wake RESETS the consecutive-failure counter", async () => {
    const r = await rig({ maxWakeFailures: 3 });
    await r.worker.hibernate("client_request");

    r.next({ onResume: { kind: "error", code: -32000, message: "rate limit exceeded" } });
    await failure(r.worker.wake(OWNER));
    expect(r.worker.snapshot().wakeFailures).toBe(1);

    r.next({ onResume: { kind: "ok" } });
    const snap = await r.worker.wake(OWNER);
    expect(snap.wakeFailures).toBe(0);
    expect(snap.wakeCount).toBe(2);
    expect(snap.generation).toBe(2);
  });

  it("a prompt on a `hibernated` worker AUTO-WAKES (§15.3's first box)", async () => {
    const r = await rig();
    await r.worker.hibernate("client_request");
    const agent = r.next({ onResume: { kind: "ok" } });

    const accepted = await r.worker.prompt([TEXT("what did I ask before?")], OWNER);
    expect(accepted.turnId).toBeTruthy();
    expect(r.worker.snapshot().state).toBe("running");
    // `prompt()` resolves once the request is ON THE WIRE (D17); one flush is what the fixture
    // on the other end needs to have read it.
    await flush();
    expect(agent.methods).toEqual(["initialize", "session/resume", "session/prompt"]);
    expect(r.worker.snapshot().generation).toBe(2);
  });
});

// ── the replay window, end to end (acceptance 3) ─────────────────────────────

describe("the replay window, through the Worker (D6, F16, acceptance 3)", () => {
  const REPLAY = [
    { sessionUpdate: "user_message_chunk", content: { type: "text", text: "PING" } },
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "PONG" } },
  ];

  it("marks EXACTLY the updates between the resume request and its response", async () => {
    const r = await rig();
    await r.worker.hibernate("client_request");
    const agent = r.next({ onResume: { kind: "ok" }, replay: REPLAY });
    await r.worker.wake(OWNER);

    const updates = r.h.log.all.filter((e) => e.kind === "acp.session_update");
    expect(updates).toHaveLength(2);
    expect(updates.every((e) => e.replay === true)).toBe(true);

    // Live traffic after the response is NOT marked (F16: the first non-replay update lands
    // 2 ms after the response, and the window closed on the response).
    await agent.update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "live" },
    });
    await flush();
    const after = r.h.log.all.filter((e) => e.kind === "acp.session_update").at(-1);
    expect(after?.replay).toBeUndefined();
  });

  it("a REJECTED resume leaves the NEXT turn's updates unmarked (the `finally`)", async () => {
    const r = await rig();
    await r.worker.hibernate("client_request");
    // The resume replays history and THEN fails — the worst case for a leaked window, because
    // the failure path is the one that skips a naive cleanup.
    r.next({
      onResume: { kind: "error", code: -32000, message: "rate limit exceeded" },
      replay: REPLAY,
    });
    await failure(r.worker.wake(OWNER));
    expect(r.worker.snapshot().state).toBe("hibernated");

    // A later wake succeeds, and its LIVE turn must not be marked as replay.
    const agent = r.next({ onResume: { kind: "ok" } });
    await r.worker.wake(OWNER);
    await r.worker.prompt([TEXT("a live turn")], OWNER);
    await agent.update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "live" },
    });
    await flush();

    const live = r.h.log.all
      .filter((e) => e.kind === "acp.session_update")
      .filter((e) => e.replay !== true);
    expect(live.length).toBeGreaterThan(0);
    const payloads = live.map((e) => JSON.stringify(e.payload));
    expect(payloads.some((p) => p.includes("live"))).toBe(true);
    // And the replayed pair from the FAILED wake is still marked, because it really was replay.
    expect(r.h.log.all.filter((e) => e.replay === true)).toHaveLength(2);
  });

  it("counts the replayed updates onto `ResumeReport.replayedEvents` (F16)", async () => {
    const r = await rig();
    await r.worker.hibernate("client_request");
    r.next({ onResume: { kind: "ok" }, replay: REPLAY });
    await r.worker.wake(OWNER);

    // No `replayMeter` is injected anywhere in this rig: the number reaches the strategy through
    // `controls.replayCounts()`, which is the production path. Before that wiring the field was
    // structurally pinned to 0 and could not tell a replay of two from a replay of none.
    expect(r.worker.snapshot().resume?.replayedEvents).toBe(2);
    // Not measured, and therefore reported as 0 rather than guessed: the drop happens in the
    // Normalizer under ruling M1-R5's `resume.replay: "drop_duplicates"`, which M1 does not ship.
    expect(r.worker.snapshot().resume?.replayDropped).toBe(0);
  });

  it("reports THIS wake's replay, not the running total — a second wake starts from zero", async () => {
    const r = await rig();
    await r.worker.hibernate("client_request");
    r.next({ onResume: { kind: "ok" }, replay: REPLAY });
    await r.worker.wake(OWNER);
    expect(r.worker.snapshot().resume?.replayedEvents).toBe(2);

    // A second hibernate/wake cycle that replays ONE update. The Worker's counter is cumulative
    // for the worker's whole life, so a report that forgot to subtract its baseline would say 3.
    await r.worker.hibernate("client_request");
    r.next({
      onResume: { kind: "ok" },
      replay: [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ONE" } }],
    });
    await r.worker.wake(OWNER);
    expect(r.worker.snapshot().resume?.replayedEvents).toBe(1);
    // …and the log still holds all three, which is what makes 1 the right answer rather than a
    // counter somebody reset.
    expect(r.h.log.all.filter((e) => e.replay === true)).toHaveLength(3);
  });

  it("the flag reaches the reducer on the INPUT, which is the only place it exists (§15.3)", async () => {
    const r = await rig();
    await r.worker.hibernate("client_request");
    r.next({ onResume: { kind: "ok" }, replay: REPLAY });
    await r.worker.wake(OWNER);

    const seen = r.h.normalizer.seen.filter((i) => i.type === "agent_update");
    expect(seen).toHaveLength(2);
    expect(seen.every((i) => (i as { replay?: true }).replay === true)).toBe(true);
  });
});

// ── §15.1's state table ─────────────────────────────────────────────────────

/**
 * §15.1's table, transcribed. Every row is here, INCLUDING the ones this work package cannot
 * drive, because a row that is silently absent is indistinguishable from a row nobody read.
 *
 * `drivenHere` marks the rows a `Worker` plus a fake supervisor can actually produce; the rest
 * name the work package that owns their trigger, and the tests below assert exactly the first
 * set. `notes` records the two rows the FROZEN `worker.ts` cannot produce at all.
 */
const STATE_TABLE: readonly {
  readonly edge: string;
  readonly reason: string;
  readonly drivenHere: boolean;
  readonly owner?: string;
}[] = [
  { edge: "null->starting", reason: "created", drivenHere: true },
  { edge: "starting->ready", reason: "handshake_ok", drivenHere: true },
  { edge: "starting->closed", reason: "handshake_error", drivenHere: true },
  { edge: "ready->running", reason: "prompt", drivenHere: true },
  { edge: "running->ready", reason: "turn_end", drivenHere: true },
  { edge: "ready->hibernated", reason: "hibernate", drivenHere: true },
  { edge: "ready->closed", reason: "idle_timeout", drivenHere: true },
  { edge: "hibernated->starting", reason: "wake", drivenHere: true },
  { edge: "starting->ready", reason: "resumed", drivenHere: true },
  { edge: "starting->hibernated", reason: "wake_retry", drivenHere: true },
  { edge: "starting->closed", reason: "not_resumable", drivenHere: true },
  { edge: "starting->closed", reason: "wake_failed", drivenHere: true },
  { edge: "hibernated->closed", reason: "acl_revoked", drivenHere: true },
  { edge: "ready->closed", reason: "client_request", drivenHere: true },
  { edge: "hibernated->closed", reason: "client_request", drivenHere: true },
  { edge: "running->closed", reason: "agent_crashed", drivenHere: true },
  {
    // §15.1's "ready -> ready, idle timer, no resume method, whenNotResumable: keep" row emits
    // NO envelope at all, so it has no edge to observe: it is asserted as an ABSENCE, in
    // `hibernate-timer.test.ts` and in "REFUSES on an agent with no resume spelling".
    edge: "ready->ready",
    reason: "(none; logged once at info)",
    drivenHere: false,
    owner: "asserted as an absence",
  },
  {
    // §15.1's "process death, resume method present" row, and DESIGN §3.2's 进程崩溃：agent 支持
    // resume → 转 hibernated 并标记 crashed. `#classifyAndClose` branches on exactly the
    // predicate `boot-recovery.ts` applies to an abandoned row, so a crash and a daemon restart
    // converge on the same state instead of a crash losing a session the restart would keep.
    edge: "running->hibernated",
    reason: "agent_crashed",
    drivenHere: true,
  },
  {
    edge: "live->hibernated",
    reason: "daemon_restart",
    drivenHere: false,
    owner: "M1-WP-E (recoverFromPreviousBoot)",
  },
  {
    edge: "live->closed",
    reason: "orphaned",
    drivenHere: false,
    owner: "M1-WP-E (recoverFromPreviousBoot)",
  },
  {
    edge: "any->closed",
    reason: "daemon_shutdown",
    drivenHere: false,
    owner: "M1-WP-E (daemon.stop)",
  },
];

describe("§15.1's state table (acceptance 1)", () => {
  it("the transcribed table names an owner for every row this package cannot drive", () => {
    for (const row of STATE_TABLE) {
      if (row.drivenHere) continue;
      expect(row.owner, `${row.edge}:${row.reason} has no owner`).toBeTruthy();
    }
    // A cheap regression on the transcription itself: the table has one row per §15.1 line.
    expect(STATE_TABLE).toHaveLength(21);
    expect(STATE_TABLE.filter((r) => r.drivenHere)).toHaveLength(17);
  });

  it("every `drivenHere` row is actually produced, by driving it", async () => {
    const seen = new Set<string>();
    const observe = (h: Harness): void => {
      for (const t of transitions(h)) seen.add(t);
    };

    // created / handshake_ok / prompt / turn_end / hibernate / wake / resumed / client_request
    const happy = await rig();
    await happy.worker.prompt([TEXT("hi")], OWNER);
    happy.agents[0]!.resolvePrompt("end_turn");
    await flush();
    happy.h.clock.advance(300);
    await flush();
    await happy.worker.hibernate("idle_timeout");
    happy.next({ onResume: { kind: "ok" } });
    await happy.worker.wake(OWNER);
    await happy.worker.close("client_request");
    observe(happy.h);

    // handshake_error — §15.1's `starting -> closed` row: the agent answered, and refused.
    const dead = harness();
    dead.supervisor.enqueue(asScripted(resumableAgent({ protocolVersion: 2 })));
    await failure(dead.create({ overrides: { session: strategyFor(dead), runtime: DESCRIPTOR } }));
    observe(dead);

    // wake_retry
    const retry = await rig();
    await retry.worker.hibernate("client_request");
    retry.next({ onResume: { kind: "error", code: -32000, message: "rate limit exceeded" } });
    await failure(retry.worker.wake(OWNER));
    observe(retry.h);

    // not_resumable
    const gone = await rig();
    await gone.worker.hibernate("client_request");
    gone.next({ onResume: { kind: "error", code: -32002, message: "session not found" } });
    await failure(gone.worker.wake(OWNER));
    observe(gone.h);

    // wake_failed
    const capped = await rig({ maxWakeFailures: 1 });
    await capped.worker.hibernate("client_request");
    capped.next({ onResume: { kind: "error", code: -32000, message: "rate limit exceeded" } });
    await failure(capped.worker.wake(OWNER));
    observe(capped.h);

    // idle_timeout (the `whenNotResumable: "close"` opt-in's transition)
    const idle = await rig({ agent: { capabilities: NOT_RESUMABLE } });
    await idle.worker.close("idle_timeout");
    observe(idle.h);

    // acl_revoked and hibernated->closed(client_request)
    const revoked = await rig();
    await revoked.worker.hibernate("client_request");
    await revoked.worker.close("acl_revoked");
    observe(revoked.h);

    const deleted = await rig();
    await deleted.worker.hibernate("client_request");
    await deleted.worker.close("client_request");
    observe(deleted.h);

    // agent_crashed -> CLOSED: the agent advertises no resume spelling, so there is nothing to
    // come back to and the session pointer is worth nothing.
    const crashed = await rig({ agent: { capabilities: NOT_RESUMABLE } });
    await crashed.worker.prompt([TEXT("hi")], OWNER);
    crashed.h.process().simulateExit(9, "SIGKILL");
    await flush();
    observe(crashed.h);

    // agent_crashed -> HIBERNATED: the same death, on an agent that CAN resume (§15.1).
    const crashedResumable = await rig();
    await crashedResumable.worker.prompt([TEXT("hi")], OWNER);
    crashedResumable.h.process().simulateExit(9, "SIGKILL");
    await flush();
    observe(crashedResumable.h);

    const missing = STATE_TABLE.filter((r) => r.drivenHere).filter(
      (r) => !seen.has(`${r.edge}:${r.reason}`),
    );
    expect(missing.map((r) => `${r.edge}:${r.reason}`)).toEqual([]);
  });

  it("drives every row a Worker can reach, and the reasons match the table", async () => {
    // ROW: — -> starting (created), starting -> ready (handshake_ok)
    const r = await rig();
    expect(transitions(r.h)).toEqual(["null->starting:created", "starting->ready:handshake_ok"]);

    // ROW: ready -> running (prompt), running -> ready (turn_end)
    await r.worker.prompt([TEXT("hi")], OWNER);
    r.agents[0]!.resolvePrompt("end_turn");
    await flush();
    r.h.clock.advance(300);
    await flush();
    expect(transitions(r.h).slice(2)).toEqual(["ready->running:prompt", "running->ready:turn_end"]);

    // ROW: ready -> hibernated (hibernate)
    await r.worker.hibernate("idle_timeout");
    expect(transitions(r.h).at(-1)).toBe("ready->hibernated:hibernate");

    // ROW: hibernated -> starting (wake), starting -> ready (resumed)
    r.next({ onResume: { kind: "ok" } });
    await r.worker.wake(OWNER);
    expect(transitions(r.h).slice(-2)).toEqual([
      "hibernated->starting:wake",
      "starting->ready:resumed",
    ]);

    // ROW: any -> closed (client_request)
    await r.worker.close("client_request");
    expect(transitions(r.h).at(-1)).toBe("ready->closed:client_request");
  });

  it("starting -> closed on a handshake failure, with no session pointer to keep", async () => {
    const h = harness();
    h.supervisor.enqueue({ failWith: new Error("no such binary") });
    const w = await failure(
      h.create({ overrides: { session: strategyFor(h), runtime: DESCRIPTOR } }),
    );
    expect(w.code).toBe("agent_error");
    expect(transitions(h)).toEqual(["null->starting:created", "starting->closed:spawn_failed"]);
  });

  it("ready -> closed(idle_timeout) is the `whenNotResumable: close` opt-in's transition", async () => {
    // The TIMER decides (hibernate-timer.test.ts); what the worker owes is the reason existing in
    // the log and the transition being legal.
    const r = await rig({ agent: { capabilities: NOT_RESUMABLE } });
    await r.worker.close("idle_timeout");
    expect(transitions(r.h).at(-1)).toBe("ready->closed:idle_timeout");
  });

  it("hibernated -> closed(acl_revoked) is a real reason, not a reused client_request (M1-R23)", async () => {
    const r = await rig();
    await r.worker.hibernate("client_request");
    const result = await r.worker.close("acl_revoked");
    expect(result.reason).toBe("acl_revoked");
    expect(transitions(r.h).at(-1)).toBe("hibernated->closed:acl_revoked");
  });

  it("`crashed` is monotone across hibernate and wake (invariant 2)", async () => {
    // A crash on an agent that CANNOT resume closes the worker, and `crashed` is observed on the
    // row it writes.
    const gone = await rig({ agent: { capabilities: NOT_RESUMABLE } });
    gone.h.process().simulateExit(9, "SIGKILL");
    await flush();
    const closed = gone.worker.snapshot();
    expect(closed.crashed).toBe(true);
    expect(closed.state).toBe("closed");
    expect(closed.hibernatedAt).toBeNull();

    // The same death on a RESUMABLE agent hibernates instead (§15.1's `running -> hibernated`
    // row), and the flag survives the wake that follows — which is invariant 2 itself, driven
    // here rather than only through `rehydrated.test.ts`'s restore path.
    const r = await rig();
    await r.worker.prompt([TEXT("hi")], OWNER);
    r.h.process().simulateExit(9, "SIGKILL");
    await flush();
    const asleep = r.worker.snapshot();
    expect(asleep.state).toBe("hibernated");
    expect(asleep.crashed).toBe(true);
    expect(asleep.hibernatedAt).not.toBeNull();
    expect(asleep.sessionId).not.toBeNull();

    r.next({ onResume: { kind: "ok" } });
    await r.worker.wake(OWNER);
    const awake = r.worker.snapshot();
    expect(awake.state).toBe("ready");
    // Sticky: it NEVER goes back to false (D2).
    expect(awake.crashed).toBe(true);
  });

  it("`closed` is terminal: hibernate, wake and prompt all refuse afterwards", async () => {
    const r = await rig();
    await r.worker.close("client_request");
    for (const call of [
      () => r.worker.hibernate("idle_timeout"),
      () => r.worker.wake(OWNER),
      () => r.worker.prompt([TEXT("x")], OWNER),
    ]) {
      expect((await failure(call())).code).toBe("worker_closed");
    }
    expect(r.h.log.all.filter((e) => stateOf(e).state === "closed")).toHaveLength(1);
  });
});
