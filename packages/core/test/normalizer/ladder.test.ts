import { describe, expect, it } from "vitest";
import { createNormalizer } from "@omni-acp/core";
import { fakeClock, fakeRuntime } from "@omni-acp/testkit";
import type {
  CloseOutAction,
  EventInput,
  Normalizer,
  TurnId,
  TurnInput,
  TurnOutput,
} from "@omni-acp/protocol";
import { claudeAcpDescriptor } from "./support/claude-acp.js";

/**
 * CONTRACTS.md §13.2's FORCED ladder, driven with a fake clock and no process at all.
 *
 * That is the property the whole design rests on: `CloseOutAction` is the ONLY side effect the
 * reducer requests, so every rung, every deadline and every ordering decision is testable as
 * arithmetic. A ladder that could only be tested through a real Worker would be a ladder whose
 * timing nobody could pin down.
 *
 * The SETTLE ladder — the per-turn quiet window — is unchanged from M0 and is tested in
 * `turn-lifecycle.test.ts`, which M1 did not touch. §13.1's ruling (M1-R4) is that these are TWO
 * ladders: `closeStdin()` never appears at turn end, and it appears here.
 */

const QUIET = 250;
const HARD = 5_000;
const DRAIN = 2_000;
const CANCEL = 10_000;
const T0 = Date.UTC(2026, 0, 1);
const TURN = `t_${"0".repeat(25)}1` as TurnId;

interface Recorded {
  readonly at: number;
  readonly action: CloseOutAction | null;
  readonly emit: readonly string[];
  readonly settled: TurnOutput["settled"];
  readonly state: TurnOutput["state"];
}

/**
 * The Worker's four lines (§13.2), with the clock and the timer in the test's hands:
 *
 *   const out = norm.step(input);
 *   log.appendAll(out.emit);
 *   rescheduleTick(out.scheduleTickAt);
 *   perform(out.action);
 */
function driver(o: { descriptor?: ReturnType<typeof fakeRuntime> } = {}): {
  norm: Normalizer;
  steps: Recorded[];
  step(input: TurnInput): TurnOutput;
  /** Deliver the tick the reducer last asked for, at exactly the time it asked for. */
  tick(): TurnOutput | null;
  /** Deliver every tick the reducer asks for, until it stops asking or `settled` arrives. */
  runToSettled(limit?: number): void;
  readonly clock: ReturnType<typeof fakeClock>;
} {
  const clock = fakeClock(T0);
  const norm = createNormalizer({
    quietMs: QUIET,
    hardMs: HARD,
    drainGraceMs: DRAIN,
    cancelGraceMs: CANCEL,
    descriptor: o.descriptor ?? claudeAcpDescriptor(),
  });
  const steps: Recorded[] = [];
  let pendingTick: number | null = null;

  const tag = (e: EventInput): string => {
    if (e.kind !== "acp.session_update") return e.kind;
    const p = e.payload as { sessionUpdate: string; state?: string; stopReason?: string | null };
    if (p.sessionUpdate !== "state_update") return `update:${p.sessionUpdate}`;
    return p.state === "idle" ? `idle(${String(p.stopReason)})` : String(p.state);
  };

  const step = (input: TurnInput): TurnOutput => {
    const out = norm.step(input);
    pendingTick = out.scheduleTickAt;
    steps.push({
      at: input.at,
      action: out.action,
      emit: out.emit.map(tag),
      settled: out.settled,
      state: out.state,
    });
    return out;
  };

  return {
    norm,
    steps,
    step,
    clock,
    tick(): TurnOutput | null {
      if (pendingTick === null) return null;
      const at = Math.max(pendingTick, clock.now());
      clock.set(at);
      return step({ type: "tick", at });
    },
    runToSettled(limit = 12): void {
      for (let i = 0; i < limit; i++) {
        if (steps[steps.length - 1]?.settled != null) return;
        if (this.tick() === null) return;
      }
    },
  };
}

/** A live turn that has NOT been answered — the state every ladder trigger finds it in. */
function liveTurn(d: ReturnType<typeof driver>): void {
  d.step({ type: "prompt_sent", turnId: TURN, at: T0 });
}

describe("§13.2 CLOSE_OUT — the forced ladder, rungs 1 to 5 in order", () => {
  it("drives quiet -> close_stdin -> drain -> cancel -> terminate, at the documented deadlines", () => {
    const d = driver();
    liveTurn(d);

    const opened = d.step({ type: "close_requested", at: T0 + 100 });
    // Rung 1 is a WAIT, not an action: the last chunk has to be allowed to land first.
    expect(opened.action).toBeNull();
    expect(opened.state).toBe("closing");
    expect(opened.scheduleTickAt).toBe(T0 + 100 + QUIET);

    // Rung 2 — EOF on stdin. This is the ONLY ladder that may close it (§6.5, M1-R4).
    const rung2 = d.tick();
    expect(rung2?.action).toBe("close_stdin");

    // Rung 3 — drain, with its own grace.
    const rung3 = d.tick();
    expect(rung3?.action).toBe("drain");
    expect(rung3?.scheduleTickAt).toBe(T0 + 100 + QUIET + DRAIN);

    // Rung 4 — `session/cancel`, then its own grace.
    const rung4 = d.tick();
    expect(rung4?.action).toBe("cancel");
    expect(rung4?.scheduleTickAt).toBe(T0 + 100 + QUIET + DRAIN + CANCEL);

    // Rung 5 — the ladder is finished, and says so.
    const rung5 = d.tick();
    expect(rung5?.settled).toBe("cancelled");
    expect(rung5?.scheduleTickAt).toBeNull();

    expect(d.steps.map((s) => s.action)).toEqual([
      null, // prompt_sent
      null, // close_requested: rung 1 is a wait
      "close_stdin",
      "drain",
      "cancel",
      null, // rung 5 reports `settled`; §6.5's escalation is the caller's, see terminate()'s note
    ]);
  });

  it("a `usage_update` arriving mid-rung is ordered BEFORE `idle` — the corpus `06` shape", () => {
    // Corpus finding 14, which is what forces rungs 1 and 4 into this order: a `usage_update`
    // arrived 53 ms AFTER our `session/cancel` and ~4 ms before the prompt response. A ladder
    // that emitted `idle` at the response boundary would order that update after an event that
    // belongs to the turn.
    const d = driver();
    liveTurn(d);
    d.step({ type: "close_requested", at: T0 + 100 });

    const emitted: string[] = [];
    const record = (out: TurnOutput | null): void => {
      for (const e of out?.emit ?? []) {
        const p = e.payload as { sessionUpdate?: string; state?: string };
        emitted.push(p.sessionUpdate === "state_update" ? String(p.state) : String(p.sessionUpdate));
      }
    };

    record(d.tick()); // rung 2
    record(d.tick()); // rung 3
    // The agent is still talking during the drain, exactly as scenario 06 records.
    record(
      d.step({
        type: "agent_update",
        at: T0 + 500,
        update: { sessionUpdate: "usage_update", used: 42, size: 200 },
      }),
    );
    // …and answers 4 ms later, which the ladder must carry into `idle`.
    d.step({ type: "prompt_result", stopReason: "cancelled", at: T0 + 504 });
    record(d.tick()); // rung 4
    record(d.tick()); // rung 5

    expect(emitted).toEqual(["usage_update", "idle"]);
    expect(emitted.indexOf("usage_update")).toBeLessThan(emitted.indexOf("idle"));
  });

  it("FORWARDS everything during the drain rung", () => {
    const d = driver();
    liveTurn(d);
    d.step({ type: "close_requested", at: T0 });
    d.tick(); // rung 2
    d.tick(); // rung 3 — draining
    const out = d.step({
      type: "agent_update",
      at: T0 + 400,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "m1",
        content: { type: "text", text: "the tail" },
      },
    });
    expect(out.emit).toHaveLength(1);
    expect(out.emit[0]?.payloadVersion).toBe(2);
  });

  it("rung 1's quiet window MOVES with the agent, and is capped by hardMs", () => {
    const d = driver();
    liveTurn(d);
    const opened = d.step({ type: "close_requested", at: T0 });
    expect(opened.scheduleTickAt).toBe(T0 + QUIET);

    const chunk = (at: number): TurnOutput =>
      d.step({
        type: "agent_update",
        at,
        update: { sessionUpdate: "usage_update", used: 1, size: 2 },
      });
    expect(chunk(T0 + 200).scheduleTickAt).toBe(T0 + 200 + QUIET);
    expect(chunk(T0 + 400).scheduleTickAt).toBe(T0 + 400 + QUIET);
    // §13.3: a hung agent cannot hold `DELETE /v1/workers/{wid}` open.
    expect(chunk(T0 + HARD - 10).scheduleTickAt).toBe(T0 + HARD);
    expect(chunk(T0 + HARD + 5_000).scheduleTickAt).toBe(T0 + HARD);
  });

  it("`drained` SHORT-CIRCUITS to terminate: nothing more can arrive", () => {
    const d = driver();
    liveTurn(d);
    d.step({ type: "close_requested", at: T0 });
    d.tick(); // rung 2 — close_stdin
    d.tick(); // rung 3 — drain
    const out = d.step({ type: "drained", at: T0 + 300 });
    expect(out.settled).toBe("drained");
    expect(out.scheduleTickAt).toBeNull();
    // Rung 4's `session/cancel` is never sent: the process's stdout has already ended.
    expect(d.steps.map((s) => s.action)).not.toContain("cancel");
  });

  it("`drained` OUTSIDE the ladder is inert and does not disturb an armed timer", () => {
    // The Worker feeds it unconditionally from `stdoutEnded`. M0's exit-grace path owns that
    // case, and a reducer that answered `scheduleTickAt: null` here would disarm a settle.
    const d = driver();
    liveTurn(d);
    d.step({ type: "prompt_result", stopReason: "end_turn", at: T0 });
    const out = d.step({ type: "drained", at: T0 + 10 });
    expect(out.emit).toEqual([]);
    expect(out.settled).toBeNull();
    expect(out.scheduleTickAt).toBe(T0 + QUIET);
  });

  it("is IDEMPOTENT: a second close_requested does not reopen a rung already spent", () => {
    const d = driver();
    liveTurn(d);
    d.step({ type: "close_requested", at: T0 });
    d.tick(); // rung 2
    d.tick(); // rung 3
    const again = d.step({ type: "close_requested", at: T0 + 300 });
    expect(again.action).toBeNull();
    expect(again.scheduleTickAt).toBe(T0 + QUIET + DRAIN);
    // DELETE, hibernate, daemon shutdown and the cancel escalation can all fire at once.
    d.tick(); // still rung 4, not rung 2 again
    expect(d.steps.at(-1)?.action).toBe("cancel");
  });

  it("does NOT run when there is no live turn: a DELETE of an idle worker keeps M0's path", () => {
    // Every rung protects output that is still coming. With no turn open there is none, and
    // running the ladder anyway would add quiet+drain+cancel to every `DELETE` — which §13.3 is
    // explicitly trying to prevent — and would let the leader exit on stdin EOF before §6.5's
    // ladder could reclaim its process GROUP (§6.7's zombie).
    const d = driver();
    const out = d.step({ type: "close_requested", at: T0 });
    expect(out.action).toBeNull();
    expect(out.scheduleTickAt).toBeNull();
    expect(out.settled).toBeNull();
    expect(out.emit).toEqual([]);
  });
});

describe("§13.3 — what the ladder must NOT do", () => {
  it("never fabricates a stopReason: a turn the agent never answered gets NO idle", () => {
    // §7.3 is unchanged and still binding. Emitting `idle{stopReason:null}` here would make the
    // turn terminal one envelope EARLIER than `omni.worker_state{closed}` — before the
    // `omni.error` the close appends — so a cancel escalation would report a turn that
    // "completed" with no error instead of one that timed out.
    const d = driver();
    liveTurn(d);
    d.step({ type: "close_requested", at: T0 });
    d.runToSettled();
    const emitted = d.steps.flatMap((s) => s.emit);
    expect(emitted.filter((t) => t.startsWith("idle"))).toEqual([]);
    expect(d.steps.at(-1)?.settled).toBe("cancelled");
  });

  it("carries the REAL stopReason when the response landed mid-ladder", () => {
    const d = driver();
    liveTurn(d);
    d.step({ type: "close_requested", at: T0 });
    d.tick(); // rung 2
    d.step({ type: "prompt_result", stopReason: "cancelled", at: T0 + 300 });
    d.runToSettled();
    expect(d.steps.flatMap((s) => s.emit)).toContain("idle(cancelled)");
  });

  it("settles the turn normally when rung 1's window closes over an ANSWERED turn", () => {
    const d = driver();
    liveTurn(d);
    d.step({ type: "prompt_result", stopReason: "end_turn", at: T0 });
    // The close arrives inside the quiet window: the turn's own settle still happens, at the
    // ladder's rung 1, and `settled` stays null because the LADDER is not finished.
    d.step({ type: "close_requested", at: T0 + 10 });
    const rung1 = d.tick();
    expect(rung1?.emit.map((e) => (e.payload as { state?: string }).state)).toEqual(["idle"]);
    expect(rung1?.settled).toBeNull();
    expect(rung1?.action).toBe("close_stdin");
  });

  it("a crash mid-ladder still produces no idle, and does not disarm the ladder", () => {
    const d = driver();
    liveTurn(d);
    d.step({ type: "close_requested", at: T0 });
    d.tick(); // rung 2
    const gone = d.step({
      type: "process_gone",
      error: { code: "agent_error", message: "agent exited" },
      stderrTail: "boom",
      at: T0 + 300,
    });
    expect(gone.emit.map((e) => e.kind)).toEqual(["omni.error"]);
    expect(gone.settled).toBe("gone");
    // The ladder's own deadline survives, so the Worker's timer is not cancelled under it.
    expect(gone.scheduleTickAt).not.toBeNull();
  });
});

describe("§13.4 — the fourth signal: a COMPLETE stderr line", () => {
  const fatal = () =>
    fakeRuntime({
      errorRules: [
        { id: "fatalStderr:oom", messageMatches: "^FATAL: ", classify: "agent_error" },
      ],
    });

  it("promotes a matching line to `omni.error` and carries a warning onto `idle`", () => {
    const d = driver({ descriptor: fatal() });
    liveTurn(d);
    const out = d.step({ type: "stderr_line", line: "FATAL: out of memory", at: T0 + 10 });
    expect(out.emit).toHaveLength(1);
    expect(out.emit[0]?.kind).toBe("omni.error");
    expect((out.emit[0]?.payload as { code: string }).code).toBe("agent_error");

    d.step({ type: "prompt_result", stopReason: "end_turn", at: T0 + 20 });
    const settled = d.tick();
    const idle = settled?.emit[0]?.payload as { _meta?: Record<string, unknown> };
    expect(idle._meta?.["omni/warnings"]).toEqual([
      { code: "fatal_stderr", message: "stderr matched fatalStderr:oom", source: "stderr" },
    ]);
  });

  it("promotes it BEFORE `idle`, which is the ordering §13.4 requires", () => {
    const d = driver({ descriptor: fatal() });
    liveTurn(d);
    const order: string[] = [];
    order.push(
      ...d
        .step({ type: "stderr_line", line: "FATAL: out of memory", at: T0 + 10 })
        .emit.map((e) => e.kind),
    );
    d.step({ type: "prompt_result", stopReason: "end_turn", at: T0 + 20 });
    order.push(...(d.tick()?.emit.map((e) => e.kind) ?? []));
    expect(order).toEqual(["omni.error", "acp.session_update"]);
  });

  it("a line the descriptor did not name does NOTHING — and does not disarm the settle", () => {
    const d = driver({ descriptor: fatal() });
    liveTurn(d);
    d.step({ type: "prompt_result", stopReason: "end_turn", at: T0 });
    const out = d.step({ type: "stderr_line", line: "warning: deprecated flag", at: T0 + 10 });
    expect(out.emit).toEqual([]);
    expect(out.scheduleTickAt).toBe(T0 + QUIET);
  });

  it("does nothing at all for a descriptor with no `fatalStderr` rule — stderr is the weakest signal", () => {
    const d = driver({ descriptor: fakeRuntime() });
    liveTurn(d);
    expect(
      d.step({ type: "stderr_line", line: "FATAL: out of memory", at: T0 + 10 }).emit,
    ).toEqual([]);
  });

  it("de-duplicates: an agent that writes the same fatal line in a loop still warns ONCE", () => {
    const d = driver({ descriptor: fatal() });
    liveTurn(d);
    for (let i = 0; i < 5; i++) {
      d.step({ type: "stderr_line", line: "FATAL: out of memory", at: T0 + i });
    }
    d.step({ type: "prompt_result", stopReason: "end_turn", at: T0 + 20 });
    const idle = d.tick()?.emit[0]?.payload as { _meta?: { "omni/warnings"?: unknown[] } };
    expect(idle._meta?.["omni/warnings"]).toHaveLength(1);
  });
});

describe("§13.4 — the third signal: the descriptor's rate-limit pointer", () => {
  const usage = (rateLimit: Record<string, unknown>): TurnInput => ({
    type: "agent_update",
    at: T0 + 10,
    update: {
      sessionUpdate: "usage_update",
      used: 1,
      size: 2,
      _meta: { "_claude/rateLimit": rateLimit },
    },
  });

  it("an ADVISORY status becomes a `TurnWarning` on `idle`, and the turn is unharmed", () => {
    // The only status ever observed is `allowed_warning` at utilization 0.78.
    const d = driver();
    liveTurn(d);
    const out = d.step(usage({ status: "allowed_warning", utilization: 0.78 }));
    expect(out.emit.map((e) => e.kind)).toEqual(["acp.session_update"]);

    d.step({ type: "prompt_result", stopReason: "end_turn", at: T0 + 20 });
    const idle = d.tick()?.emit[0]?.payload as {
      _meta?: { "omni/warnings"?: { code: string; source: string; detail?: unknown }[] };
    };
    const warnings = idle._meta?.["omni/warnings"] ?? [];
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.code).toBe("rate_limit");
    expect(warnings[0]?.source).toBe("usage_meta");
    expect(warnings[0]?.detail).toEqual({ status: "allowed_warning", utilization: 0.78 });
  });

  it("a plain `allowed` is not a warning at all — 60 usage updates must not become 60 warnings", () => {
    const d = driver();
    liveTurn(d);
    d.step(usage({ status: "allowed", utilization: 0.19 }));
    d.step({ type: "prompt_result", stopReason: "end_turn", at: T0 + 20 });
    const idle = d.tick()?.emit[0]?.payload as { _meta?: unknown };
    expect(idle._meta).toBeUndefined();
  });

  it("an ENUMERATED terminal status becomes `omni.error` BEFORE `idle`", () => {
    // M1 treats exactly four statuses as terminal and everything else as advisory, rather than
    // guessing that an unknown status means failure (§13.4).
    for (const status of ["rejected", "blocked", "exhausted", "over_limit"]) {
      const d = driver();
      liveTurn(d);
      const out = d.step(usage({ status }));
      expect(out.emit.map((e) => e.kind), status).toEqual(["omni.error", "acp.session_update"]);
      expect((out.emit[0]?.payload as { code: string }).code).toBe("agent_error");
    }
  });

  it("an UNKNOWN status is advisory, never terminal", () => {
    const d = driver();
    liveTurn(d);
    const out = d.step(usage({ status: "some_future_status" }));
    expect(out.emit.map((e) => e.kind)).toEqual(["acp.session_update"]);
  });

  it("a descriptor with no rate-limit extension reads nothing, even from the same bytes", () => {
    const d = driver({ descriptor: fakeRuntime() });
    liveTurn(d);
    const out = d.step(usage({ status: "rejected" }));
    expect(out.emit.map((e) => e.kind)).toEqual(["acp.session_update"]);
  });
});

describe("§13.2 SETTLE — `idle` now carries `usage` (F21)", () => {
  it("puts the prompt RESPONSE's v2 Usage block on `idle`", () => {
    const d = driver();
    liveTurn(d);
    d.step({
      type: "prompt_result",
      stopReason: "end_turn",
      at: T0,
      usage: { totalTokens: 17_051, inputTokens: 2, outputTokens: 5, cachedReadTokens: 10_038 },
    });
    const idle = d.tick()?.emit[0]?.payload as { usage?: unknown; stopReason?: unknown };
    expect(idle.usage).toEqual({
      totalTokens: 17_051,
      inputTokens: 2,
      outputTokens: 5,
      cachedReadTokens: 10_038,
    });
    expect(idle.stopReason).toBe("end_turn");
  });

  it("omits `usage` entirely when the response's block is not the v2 shape", () => {
    // A type pun that happens to compile is exactly what §5.1's note warns against: v1's
    // `usage_update` is `{used, size}` and v2's `Usage` is `{totalTokens, …}`.
    const d = driver();
    liveTurn(d);
    d.step({ type: "prompt_result", stopReason: "end_turn", at: T0, usage: { used: 1, size: 2 } });
    const idle = d.tick()?.emit[0]?.payload as Record<string, unknown>;
    expect(idle).not.toHaveProperty("usage");
  });
});

describe("D6 — the replay copy", () => {
  it("marks every envelope emitted for a replayed update, and nothing else", () => {
    const d = driver();
    liveTurn(d);
    const replayed = d.step({
      type: "agent_update",
      at: T0 + 1,
      replay: true,
      update: {
        sessionUpdate: "user_message_chunk",
        messageId: "6b3e-uuid",
        content: { type: "text", text: "what did I ask before?" },
      },
    });
    expect(replayed.emit[0]?.replay).toBe(true);

    const live = d.step({
      type: "agent_update",
      at: T0 + 2,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "m2",
        content: { type: "text", text: "you asked for PONG" },
      },
    });
    expect(live.emit[0]?.replay).toBeUndefined();
  });
});
