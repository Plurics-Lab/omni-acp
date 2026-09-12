import { describe, expect, it } from "vitest";
import {
  OmniError,
  reduceTurn,
  type CredentialBinding,
  type EventEnvelope,
  type RestartResult,
  type RuntimeDescriptor,
  type SessionStrategy,
  type WorkerCredentialBinding,
  type WorkerHandle,
  type WorkerState,
  type WorkerStatePayload,
} from "@omni-acp/protocol";
import { fakeRuntime, nullLogger } from "@omni-acp/testkit";
import { createSessionStrategy } from "../../src/worker/session-open.js";
import { flush, harness, OWNER, TEXT, type Harness } from "./support/harness.js";
import { asScripted, resumableAgent, type ResumableAgent } from "./support/resumable-agent.js";

/**
 * `Worker.restart` and `Worker.setCredential` (docs/M3-WP1-CREDENTIALS.md §worker.restart,
 * §worker.setCredential), END TO END through the real `Worker` over a fake supervisor, a scripted
 * resumable agent and a fake clock.
 *
 * The whole feature is a claim about M1's reclaim + wake path with exactly TWO exceptions, so the
 * cases below are written as those two exceptions plus the things a restart must NOT do:
 *
 *  - the LEASE is kept (a hibernate releases it; a restart is a gap the holder asked for);
 *  - the HOME is kept (E7: the agent's session files are in it);
 *  - `generation` advances by exactly one, and the SESSION POINTER survives;
 *  - a forced restart terminates the live turn with `error.code: "restarted"` and NO synthesized
 *    `idle` — which is asserted through `reduceTurn` over the real envelopes, because the
 *    projection is what every consumer actually reads.
 *
 * Owned by M3-WP1.
 */

const stateOf = (e: EventEnvelope): WorkerStatePayload => e.payload as WorkerStatePayload;

const DESCRIPTOR: RuntimeDescriptor = fakeRuntime({
  prefer: {
    resume: { spellings: ["session/resume", "session/load"], onFailure: "fail" },
    close: { spellings: ["session/close"], onFailure: "fail" },
  },
});

/** A descriptor whose agent advertises NO resume spelling at all. */
const NO_RESUME: RuntimeDescriptor = fakeRuntime({
  prefer: { close: { spellings: ["session/close"], onFailure: "fail" } },
});

const strategyFor = (h: Harness, descriptor = DESCRIPTOR): SessionStrategy =>
  createSessionStrategy({ descriptor, clock: h.clock, logger: nullLogger() });

/**
 * A `WorkerCredentialBinding` double that records every `relink` and answers the reload mode the
 * case is about.
 *
 * It is the SEAM, so the double is the whole credential layer as far as `worker.ts` is concerned:
 * the file is `daemon/src/credentials/*`'s to move, and what the worker owns is the DECISION about
 * whether a new process is needed — which is the descriptor's measured `reload` and nothing else.
 */
function fakeBinding(o: {
  reload: "file" | "restart";
  initial?: Partial<CredentialBinding>;
}): WorkerCredentialBinding & { readonly relinked: readonly string[] } {
  const relinked: string[] = [];
  let current: CredentialBinding = {
    name: "default",
    method: "files",
    fingerprint: "aaaaaaaaaaaa",
    home: "/data/homes/w_1",
    env: { FAKE_HOME: "/data/homes/w_1" },
    ...o.initial,
  };
  return {
    reload: o.reload,
    current: () => current,
    relink: (name: string) => {
      relinked.push(name);
      current = { ...current, name, fingerprint: `bbbbbbbbbbb${String(relinked.length)}` };
      return Promise.resolve(current);
    },
    get relinked(): readonly string[] {
      return relinked;
    },
  };
}

interface Rig {
  readonly h: Harness;
  readonly worker: WorkerHandle;
  readonly agents: readonly ResumableAgent[];
  next(): ResumableAgent;
  readonly states: readonly [WorkerState, WorkerState | null][];
}

async function rig(o?: {
  descriptor?: RuntimeDescriptor;
  credentials?: WorkerCredentialBinding;
}): Promise<Rig> {
  const h = harness();
  const descriptor = o?.descriptor ?? DESCRIPTOR;
  const agents: ResumableAgent[] = [];
  const next = (): ResumableAgent => {
    const agent = resumableAgent({ onResume: { kind: "ok" } });
    agents.push(agent);
    h.supervisor.enqueue(asScripted(agent));
    return agent;
  };
  next();

  const worker = await h.create({
    overrides: {
      session: strategyFor(h, descriptor),
      runtime: descriptor,
      ...(o?.credentials === undefined ? {} : { credentials: o.credentials }),
    },
  });
  const states: [WorkerState, WorkerState | null][] = [];
  worker.onStateChange((s, prev) => states.push([s, prev]));
  return { h, worker, agents, next, states };
}

const failure = async (p: Promise<unknown>): Promise<OmniError> => {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  if (!(e instanceof OmniError)) throw new Error(`expected an OmniError, got ${String(e)}`);
  return e;
};

const reasons = (h: Harness): string[] =>
  h.log.all.filter((e) => e.kind === "omni.worker_state").map((e) => stateOf(e).reason);

describe("Worker.restart — the happy path, and its two exceptions", () => {
  it("replaces the process, resumes the SAME session, and advances generation by one", async () => {
    const r = await rig();
    r.next();

    const before = r.worker.snapshot();
    expect(before.generation).toBe(1);
    const firstPid = before.process?.pid;

    const result: RestartResult = await r.worker.restart({ reason: "a rotation" }, OWNER);

    expect(result.generation).toBe(2);
    expect(result.terminatedTurn).toBeNull();
    expect(result.resume).toMatchObject({ outcome: "landed" });
    // The SESSION POINTER survives, which is the whole point of `resume` defaulting to true: the
    // conversation is what a restart is trying not to lose.
    expect(result.sessionId).toBe(before.sessionId);

    const after = r.worker.snapshot();
    expect(after.state).toBe("ready");
    expect(after.generation).toBe(2);
    expect(after.sessionId).toBe(before.sessionId);
    expect(after.process?.pid).not.toBe(firstPid);
    expect(result.pid).toBe(after.process?.pid);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);

    // §15.1's table, with M3-WP1's row: `ready → starting(restart) → ready(resumed)`.
    expect(reasons(r.h)).toEqual(["created", "handshake_ok", "restart", "resumed"]);
    expect(r.states.map(([s]) => s)).toEqual(["starting", "ready"]);
  });

  it("KEEPS the lease — the one exception a hibernate does not make", async () => {
    const r = await rig();
    r.next();
    const holder = r.worker.snapshot().lease.holder;
    expect(holder).not.toBeNull();

    await r.worker.restart({}, OWNER);

    /**
     * A hibernate RELEASES the lease (§15.2 step 3) because a holder cannot control a worker with
     * no process and a lease held across a 30-minute sleep silently becomes permanent. A restart
     * is a five-second gap the holder ASKED for; releasing it would hand the worker to whichever
     * peer polled first, in the middle of the rotation the holder is performing.
     *
     * `hibernateReleases` is the counter the harness keeps for exactly this ordering claim, so
     * this is a fact about the call and not about the snapshot.
     */
    expect(r.h.lease.hibernateReleases).toBe(0);
    expect(r.worker.snapshot().lease.holder).toEqual(holder);
    // And it IS lease-gated: a stranger cannot restart somebody else's worker.
    expect(r.h.lease.asserted.length).toBeGreaterThan(0);
  });

  it("KEEPS the home: the spawn spec of the second process is the first's", async () => {
    const binding = fakeBinding({ reload: "file" });
    const r = await rig({ credentials: binding });
    r.next();

    const first = r.h.supervisor.spawnCalls[0];
    await r.worker.restart({}, OWNER);
    const second = r.h.supervisor.spawnCalls[1];

    // E7: the agent's own session files live in the home (claude writes `projects/`, codex writes
    // `thread_history_1.sqlite`), so a restart that rebuilt the home would resume into a directory
    // with no history — which is exactly the failure `resume` is supposed to prevent. The
    // environment is the observable form of the claim, because it is what the process is given.
    expect(second?.env["FAKE_HOME"]).toBe(first?.env["FAKE_HOME"]);
    expect(binding.relinked).toEqual([]);
    expect(r.worker.snapshot().home).toBe("/data/homes/w_1");
  });

  it("resets the timers: the cancel-escalation timer of the abandoned turn does not survive", async () => {
    const r = await rig();
    r.next();
    await r.worker.prompt([TEXT("hello")], OWNER);
    // `cancel()` arms the escalation timer (`turn.cancelGraceMs`), whose callback closes the
    // worker with `cancel_timeout` if the agent ignored `session/cancel`. Left armed across a
    // restart it would fire against a link that no longer exists — and its close would land on the
    // NEW process (§restart: 计时器归零).
    await r.worker.cancel(OWNER);
    const armed = r.h.clock.pendingTimers;
    expect(armed).toBeGreaterThan(0);

    await r.worker.restart({ force: true }, OWNER);
    expect(r.h.clock.pendingTimers).toBeLessThan(armed);
    // Proof rather than inference: advancing past the grace period leaves the worker `ready`.
    r.h.clock.advance(60_000);
    await flush();
    expect(r.worker.snapshot().state).toBe("ready");
  });
});

describe("Worker.restart — a live turn", () => {
  it("is `409 worker_busy` without force, and the turn is untouched", async () => {
    const r = await rig();
    r.next();
    const accepted = await r.worker.prompt([TEXT("hello")], OWNER);

    const e = await failure(r.worker.restart({}, OWNER));
    expect(e.code).toBe("worker_busy");
    expect(e.status).toBe(409);
    expect(e.message).toContain("force:true");

    // Nothing happened: the turn is still live, the process is the first one, and the log carries
    // no `restart` envelope. A refusal that had already reclaimed the process would be a
    // half-applied operation wearing an error code.
    expect(r.worker.snapshot().state).toBe("running");
    expect(r.worker.snapshot().currentTurnId).toBe(accepted.turnId);
    expect(reasons(r.h)).toEqual(["created", "handshake_ok", "prompt"]);
    expect(r.h.supervisor.spawnCalls.length).toBe(1);
  });

  it("with force, terminates the turn with `restarted` and NO synthesized idle", async () => {
    const r = await rig();
    r.next();
    const accepted = await r.worker.prompt([TEXT("what is 2+2")], OWNER);
    // Some real output first, so the projection has something to have lost.
    await r.agents[0]?.update({
      sessionUpdate: "agent_message_chunk",
      content: TEXT("thinking"),
      messageId: "m1",
    });
    await flush();

    const result = await r.worker.restart({ force: true, reason: "credential rotation" }, OWNER);
    expect(result.terminatedTurn).toBe(accepted.turnId);
    expect(result.generation).toBe(2);

    /**
     * THE PROJECTION IS THE ASSERTION.
     *
     * `reduceTurn` is the one fold both the SDK and `GET /turns/{id}` run (DESIGN §5.5), so what
     * it says about this turn is what every consumer says. §restart requires three things of it
     * and all three are here:
     *
     *  - `stopReason: null` — the agent did not finish, and `end_turn` would claim it did;
     *  - `error.code: "restarted"` — the cause, in the field a caller reads;
     *  - NO `state_update{idle}` anywhere in the log for this turn. A fabricated idle is §7.3's
     *    own prohibition (a dead agent never produces one) and it would tell every reducer,
     *    every SSE subscriber and every `?since=` reader that the turn ended normally.
     */
    const envelopes = r.h.log.all;
    const turn = reduceTurn(accepted.turnId, envelopes);
    expect(turn.stopReason).toBeNull();
    expect(turn.error?.code).toBe("restarted");
    expect(turn.error?.message).toContain("credential rotation");
    expect(turn.verdict).toBe("failed");

    const idles = envelopes.filter(
      (e) =>
        e.kind === "acp.session_update" &&
        (e.payload as unknown as Record<string, unknown>)["sessionUpdate"] === "state_update" &&
        (e.payload as unknown as Record<string, unknown>)["state"] === "idle",
    );
    expect(idles).toEqual([]);

    // The text the agent DID produce is still in the projection: a terminated turn is not an
    // erased one, and the log is authoritative about what happened.
    expect(turn.text).toBe("thinking");

    // The terminal envelope is the restart itself, carried on the terminated turn's id so the
    // fold can find it.
    const terminal = envelopes.filter((e) => e.kind === "omni.worker_state").at(-2);
    expect(stateOf(terminal as EventEnvelope)).toMatchObject({
      state: "starting",
      previous: "running",
      reason: "restart",
    });
    expect((terminal as EventEnvelope).turnId).toBe(accepted.turnId);

    // And the worker takes prompts again afterwards, on the NEW process.
    expect(r.worker.snapshot().state).toBe("ready");
  });

  it("strands the in-flight tool calls rather than inventing a status for them", async () => {
    const r = await rig();
    r.next();
    const accepted = await r.worker.prompt([TEXT("edit a file")], OWNER);
    await r.agents[0]?.update({
      sessionUpdate: "tool_call",
      toolCallId: "call_1",
      title: "Edit",
      kind: "edit",
      status: "pending",
    });
    await flush();

    await r.worker.restart({ force: true }, OWNER);

    // F36's rule, reached by a different road: the tool may well have completed agent-side, so
    // synthesizing `failed` would assert something we do not know. `strandedToolCalls` REPORTS it,
    // and it falls out of the fold for free because the restart envelope makes the turn terminal.
    const turn = reduceTurn(accepted.turnId, r.h.log.all);
    expect(turn.strandedToolCalls).toEqual(["call_1"]);
    expect(turn.toolCalls[0]?.status).toBe("pending");
  });

  it("admits no prompt in the window between the decision and the state (`#restarting`)", async () => {
    const r = await rig();
    r.next();
    // §15.2's `#hibernating` trap, identical: the state still reads `ready` while the process is
    // already being reclaimed, and "busy" is the honest answer for it.
    const restarting = r.worker.restart({}, OWNER);
    const e = await failure(r.worker.prompt([TEXT("sneak in")], OWNER));
    expect(e.code).toBe("worker_busy");
    await restarting;
  });

  it("is SINGLE-FLIGHT: two racing restarts are one new process", async () => {
    const r = await rig();
    r.next();
    const [a, b] = await Promise.all([
      r.worker.restart({ reason: "one" }, OWNER),
      r.worker.restart({ reason: "two" }, OWNER),
    ]);
    expect(a).toEqual(b);
    expect(r.worker.snapshot().generation).toBe(2);
    expect(r.h.supervisor.spawnCalls.length).toBe(2);
  });
});

describe("Worker.restart — the refusals", () => {
  it("is `422 not_resumable` for an agent that cannot resume, BEFORE the process is reclaimed", async () => {
    const r = await rig({ descriptor: NO_RESUME });
    const e = await failure(r.worker.restart({}, OWNER));
    expect(e.code).toBe("not_resumable");
    expect(e.status).toBe(422);
    expect(e.message).toContain("fresh:true");
    // The point of raising it first: an agent that cannot resume would otherwise lose a HEALTHY
    // session to a restart that then could not reopen it.
    expect(r.worker.snapshot().state).toBe("ready");
    expect(r.h.supervisor.live.size).toBe(1);
  });

  it("accepts `fresh:true` for that agent, and opens a NEW session on the wire", async () => {
    const r = await rig({ descriptor: NO_RESUME });
    r.next();

    const result = await r.worker.restart({ fresh: true }, OWNER);
    // `{outcome:"fresh"}` rather than a `ResumeReport`: nothing was resumed, and reporting a
    // four-state verdict for an operation that did not attempt one would be a lie about which
    // path ran.
    expect(result.resume).toEqual({ outcome: "fresh" });
    expect(r.worker.snapshot().state).toBe("ready");
    expect(reasons(r.h)).toEqual(["created", "handshake_ok", "restart", "handshake_ok"]);
    /**
     * THE WIRE IS THE ASSERTION, because the scripted agent mints one session id for every
     * `session/new` and a pointer comparison would therefore prove nothing about which path ran.
     *
     * The second process was asked `initialize` and `session/new` and was NEVER asked to resume —
     * which is what `fresh` means, and why it is opt-in: the conversation is genuinely gone.
     */
    expect(r.agents[1]?.methods).toEqual(["initialize", "session/new"]);
    expect(r.agents[1]?.methods).not.toContain("session/resume");
    expect(r.worker.snapshot().resume).toBeNull();
  });

  it("is `410 worker_closed` on a closed worker", async () => {
    const r = await rig();
    await r.worker.close("client_request");
    const e = await failure(r.worker.restart({}, OWNER));
    expect(e.code).toBe("worker_closed");
    expect(e.status).toBe(410);
  });

  it("leaves the worker HIBERNATED when the new process cannot resume", async () => {
    const h = harness();
    const agents: ResumableAgent[] = [];
    const push = (opts: Parameters<typeof resumableAgent>[0]): void => {
      const agent = resumableAgent(opts);
      agents.push(agent);
      h.supervisor.enqueue(asScripted(agent));
    };
    push({ onResume: { kind: "ok" } });
    const worker = await h.create({
      overrides: { session: strategyFor(h), runtime: DESCRIPTOR },
    });
    // The SECOND process refuses the resume permanently — D2's `rejected_permanent`.
    push({
      onResume: { kind: "error", code: -32602, message: "session not found", data: {} },
      onLoad: { kind: "error", code: -32602, message: "session not found", data: {} },
    });

    const e = await failure(worker.restart({}, OWNER));
    expect(e.code).toBe("not_resumable");
    /**
     * §restart's one deliberate DIFFERENCE from a wake.
     *
     * A failed WAKE with `rejected_permanent` CLOSES the worker (§15.5): the caller asked for a
     * live process, there can never be one, and a row that answers 422 forever is a row an
     * operator has to reap by hand. A failed RESTART leaves it `hibernated` instead — the worker
     * was alive a moment ago, the operator still holds its lease, and the next prompt gets to try
     * the wake path (and close it there if that fails too).
     *
     * The pointer is KEPT, because §15.1 invariant 1 requires a `hibernated` worker to have one;
     * abandoning it here would make the state table false.
     */
    const snapshot = worker.snapshot();
    expect(snapshot.state).toBe("hibernated");
    expect(snapshot.sessionId).not.toBeNull();
    expect(snapshot.hibernatedAt).not.toBeNull();
    expect(snapshot.process).toBeNull();
    expect(snapshot.generation).toBe(1);
  });
});

describe("Worker.setCredential — the descriptor's MEASURED reload decides", () => {
  it('`reload:"file"` is `immediate`, and no process is replaced', async () => {
    const binding = fakeBinding({ reload: "file" });
    const r = await rig({ credentials: binding });

    const applied = await r.worker.setCredential({ credential: "rotated" }, OWNER);

    // MEASURED on claude-acp 0.73.0: the credential file is consulted PER REQUEST — a garbage file
    // written under a live process made the very next `session/prompt` fail in 88 ms with `-32000
    // Authentication required`. So the swap has already taken effect and replacing the process
    // would be a cold start for nothing.
    expect(applied.applied).toBe("immediate");
    expect(applied.credential.name).toBe("rotated");
    expect(applied.previous).toBe("aaaaaaaaaaaa");
    expect(applied.generation).toBe(1);
    expect(binding.relinked).toEqual(["rotated"]);
    expect(r.h.supervisor.spawnCalls.length).toBe(1);
    expect(r.worker.snapshot().credentialStale).toBeUndefined();
  });

  it('`reload:"restart"` on an IDLE worker restarts now, and reports `restarted`', async () => {
    const binding = fakeBinding({ reload: "restart" });
    const r = await rig({ credentials: binding });
    r.next();

    const applied = await r.worker.setCredential({ credential: "rotated" }, OWNER);

    // MEASURED on codex-acp 1.8.0: the process CACHES the credential — a garbage file written
    // under a live process left the next prompt answering `end_turn`, while the same file present
    // from the start makes `session/new` fail. So nothing less than a new process works.
    expect(applied.applied).toBe("restarted");
    expect(applied.generation).toBe(2);
    expect(r.h.supervisor.spawnCalls.length).toBe(2);
    expect(r.worker.snapshot().credentialStale).toBeUndefined();
    expect(reasons(r.h)).toEqual(["created", "handshake_ok", "restart", "resumed"]);
  });

  it('`reload:"restart"` mid-turn is `on-next-start`, and the turn is NOT interrupted', async () => {
    const binding = fakeBinding({ reload: "restart" });
    const r = await rig({ credentials: binding });
    r.next();
    const accepted = await r.worker.prompt([TEXT("a long turn")], OWNER);

    const applied = await r.worker.setCredential({ credential: "rotated" }, OWNER);

    // We do NOT interrupt a turn the caller did not ask to interrupt. `apply:"restart"` is how
    // they ask, and it 409s (below) rather than doing it silently.
    expect(applied.applied).toBe("on-next-start");
    expect(r.worker.snapshot().state).toBe("running");
    expect(r.worker.snapshot().currentTurnId).toBe(accepted.turnId);
    expect(r.h.supervisor.spawnCalls.length).toBe(1);
    // `credentialStale` is what stops `credential.fingerprint` being a lie: the fingerprint says
    // what the worker WILL use, this says that it is not using it yet.
    expect(r.worker.snapshot().credentialStale).toBe(true);
    expect(r.worker.snapshot().credential?.name).toBe("rotated");

    // …and then the promise is kept. The deferred restart fires on the transition into `ready`,
    // which is the first moment a cached-credential agent can be replaced without cutting a turn
    // short.
    r.agents[0]?.resolvePrompt("end_turn");
    await flush();
    // The quiet window has to elapse before the Normalizer calls the turn settled (§7.2), which is
    // what puts the worker back in `ready` — and `ready` is the first moment a cached-credential
    // agent can be replaced without cutting a turn short.
    r.h.clock.advance(300);
    await flush();
    expect(r.worker.snapshot().state).not.toBe("running");
    for (let i = 0; i < 20 && r.h.supervisor.spawnCalls.length < 2; i += 1) await flush();
    expect(r.h.supervisor.spawnCalls.length).toBe(2);
    expect(r.worker.snapshot().state).toBe("ready");
    expect(r.worker.snapshot().credentialStale).toBeUndefined();
    expect(r.worker.snapshot().generation).toBe(2);
  });

  it('`apply:"restart"` mid-turn is 409 and changes NOTHING', async () => {
    const binding = fakeBinding({ reload: "file" });
    const r = await rig({ credentials: binding });
    await r.worker.prompt([TEXT("a long turn")], OWNER);

    const e = await failure(r.worker.setCredential({ credential: "x", apply: "restart" }, OWNER));
    expect(e.code).toBe("worker_busy");
    // The check is BEFORE the link moves: a caller that got a refusal must find its credential
    // unchanged, or the refusal is a half-applied operation wearing an error code.
    expect(binding.relinked).toEqual([]);
    expect(r.worker.snapshot().credential?.name).toBe("default");
  });

  it('`apply:"defer"` moves the link and stops', async () => {
    const binding = fakeBinding({ reload: "restart" });
    const r = await rig({ credentials: binding });

    const applied = await r.worker.setCredential({ credential: "rotated", apply: "defer" }, OWNER);
    expect(applied.applied).toBe("deferred");
    expect(binding.relinked).toEqual(["rotated"]);
    expect(r.h.supervisor.spawnCalls.length).toBe(1);
    // A caching agent that has not been restarted IS stale, and an operator rotating across a
    // fleet on their own schedule needs the snapshot to say so.
    expect(r.worker.snapshot().credentialStale).toBe(true);
  });

  it("swaps the credential as PART of a restart, while no process is running", async () => {
    const binding = fakeBinding({ reload: "restart" });
    const r = await rig({ credentials: binding });
    r.next();

    const result = await r.worker.restart({ credential: "rotated" }, OWNER);
    expect(result.generation).toBe(2);
    expect(binding.relinked).toEqual(["rotated"]);
    // The link moved while NO process was running, which is the only moment a caching agent can
    // be handed a new credential without a window in which the link points at one file and the
    // process holds another.
    expect(r.worker.snapshot().credential?.name).toBe("rotated");
    expect(r.worker.snapshot().credentialStale).toBeUndefined();
  });

  it("appends exactly ONE `omni.credential` envelope, carrying a fingerprint and no secret", async () => {
    const binding = fakeBinding({ reload: "file" });
    const r = await rig({ credentials: binding });
    await r.worker.setCredential({ credential: "rotated" }, OWNER);

    const audit = r.h.log.all.filter((e) => e.kind === "omni.credential");
    expect(audit.length).toBe(1);
    expect(audit[0]?.payload).toEqual({
      op: "set",
      credential: "rotated",
      method: "files",
      fingerprint: "bbbbbbbbbbb1",
      applied: "immediate",
      generation: 1,
      previous: "aaaaaaaaaaaa",
    });
    /**
     * The envelope exists BECAUSE a credential swap is invisible in every other stream: on a
     * `reload:"file"` agent no process restarts and no state changes, so an operator reading the
     * log would see a turn start answering as somebody else with nothing in between saying why
     * (DESIGN §8's 审计 row).
     *
     * And the whole payload is metadata: `toEqual` over it is the leak guard, because a future
     * field would have to be reconciled here rather than silently appearing on the wire.
     */
    expect(JSON.stringify(audit)).not.toContain("FAKE_HOME");
  });

  it("refuses on a closed worker, and refuses with no credential layer wired", async () => {
    const closed = await rig({ credentials: fakeBinding({ reload: "file" }) });
    await closed.worker.close("client_request");
    expect((await failure(closed.worker.setCredential({ credential: "x" }, OWNER))).code).toBe(
      "worker_closed",
    );

    // No binding injected is M2 exactly: there is nowhere to put a credential, and the honest
    // answer is D29's `bad_request` naming the work package rather than a 500.
    const bare = await rig();
    const e = await failure(bare.worker.setCredential({ credential: "x" }, OWNER));
    expect(e.code).toBe("bad_request");
    expect(e.message).toContain("M3-WP1");
  });

  it("reports the credential on the snapshot: name, method and fingerprint, and no more", async () => {
    const r = await rig({ credentials: fakeBinding({ reload: "file" }) });
    const snapshot = r.worker.snapshot();
    expect(snapshot.credential).toEqual({
      name: "default",
      method: "files",
      fingerprint: "aaaaaaaaaaaa",
    });
    expect(snapshot.home).toBe("/data/homes/w_1");
    // A snapshot is served to every client that can see the worker, so the ENV — which holds the
    // secret for a token/apiKey credential — is not on it at all.
    expect(JSON.stringify(snapshot)).not.toContain("FAKE_HOME");
  });

  it("is ABSENT from the snapshot with no layer wired, so an M2 `toEqual` does not grow a key", async () => {
    const r = await rig();
    const snapshot = r.worker.snapshot();
    expect("credential" in snapshot).toBe(false);
    expect("home" in snapshot).toBe(false);
    expect("credentialStale" in snapshot).toBe(false);
  });
});
