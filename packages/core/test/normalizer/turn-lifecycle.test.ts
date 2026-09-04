import { describe, expect, it } from "vitest";
import { createNormalizer } from "@omni-acp/core";
import {
  OmniError,
  type EventInput,
  type Normalizer,
  type OmniErrorBody,
  type TurnId,
  type TurnInput,
  type TurnOutput,
} from "@omni-acp/protocol";

const QUIET = 250;
const HARD = 5_000;
const T0 = Date.UTC(2026, 0, 1); // any fixed epoch; the reducer only ever does arithmetic

const TURN_A = `t_${"0".repeat(25)}1` as TurnId;
const TURN_B = `t_${"0".repeat(25)}2` as TurnId;

const make = (o: { quietMs?: number; hardMs?: number } = {}): Normalizer =>
  createNormalizer({ quietMs: o.quietMs ?? QUIET, hardMs: o.hardMs ?? HARD });

const CRASH: OmniErrorBody = { code: "agent_error", message: "agent exited" };
const RPC_ERROR: OmniErrorBody = {
  code: "agent_error",
  message: "prompt failed",
  acp: { code: -32000, message: "prompt failed" },
};

const promptSent = (turnId: TurnId, at: number): TurnInput => ({ type: "prompt_sent", turnId, at });
const agentUpdate = (
  at: number,
  update: unknown = { sessionUpdate: "agent_message_chunk" },
): TurnInput => ({
  type: "agent_update",
  update,
  at,
});
const promptResult = (at: number, stopReason = "end_turn"): TurnInput => ({
  type: "prompt_result",
  stopReason,
  at,
});
const promptError = (at: number): TurnInput => ({ type: "prompt_error", error: RPC_ERROR, at });
const processGone = (at: number): TurnInput => ({
  type: "process_gone",
  error: CRASH,
  stderrTail: "Error: boom",
  at,
});
const tick = (at: number): TurnInput => ({ type: "tick", at });

/**
 * A compact projection of one emitted event, so a 19-row table asserts what actually differs
 * between cells instead of restating the envelope shape 19 times. Every field it collapses is
 * asserted in full by the dedicated cases below.
 */
function tag(e: EventInput): string {
  if (e.kind === "omni.error") return `error(${e.payload.code})`;
  if (e.kind !== "acp.session_update") return e.kind;
  const p = e.payload as { sessionUpdate: string; state?: string; stopReason?: string | null };
  if (e.payloadVersion === 1) return "passthrough";
  if (p.sessionUpdate !== "state_update") return `v2:${p.sessionUpdate}`;
  return p.state === "idle" ? `idle(${String(p.stopReason)})` : `${String(p.state)}`;
}

const tags = (out: TurnOutput): string[] => out.emit.map(tag);

/** The three carried states, each reached the only way the Worker can reach it. */
const at = {
  idle: (): Normalizer => make(),
  running: (): Normalizer => {
    const n = make();
    n.step(promptSent(TURN_A, T0));
    return n;
  },
  settling: (): Normalizer => {
    const n = make();
    n.step(promptSent(TURN_A, T0));
    n.step(promptResult(T0));
    return n;
  },
};

interface Row {
  readonly from: keyof typeof at;
  readonly what: string;
  readonly input: TurnInput;
  readonly emit: readonly string[];
  readonly scheduleTickAt: number | null;
  readonly state: TurnOutput["state"];
  readonly turnId: TurnId | null;
  readonly settled: TurnOutput["settled"];
}

// ── the full TurnInput x state cross-product ─────────────────────────────────
//
// Six inputs, three states, every cell present. Cells the daemon's `409 worker_busy` makes
// unreachable from the wire are still defined here, because a reducer that throws on one of
// them takes the worker down instead of the request.
const TABLE: readonly Row[] = [
  // ── from idle ──────────────────────────────────────────────────────────────
  {
    from: "idle",
    what: "prompt_sent opens a turn",
    input: promptSent(TURN_B, T0),
    emit: ["running"],
    scheduleTickAt: null,
    state: "running",
    turnId: TURN_B,
    settled: null,
  },
  {
    from: "idle",
    what: "agent_update outside a turn is forwarded with a null turnId",
    input: agentUpdate(T0),
    emit: ["passthrough"],
    scheduleTickAt: null,
    state: "idle",
    turnId: null,
    settled: null,
  },
  {
    from: "idle",
    what: "prompt_result with no live turn has nothing truthful to say",
    input: promptResult(T0),
    emit: [],
    scheduleTickAt: null,
    state: "idle",
    turnId: null,
    settled: null,
  },
  {
    from: "idle",
    what: "prompt_error outside a turn emits the error and no state update",
    input: promptError(T0),
    emit: ["error(agent_error)"],
    scheduleTickAt: null,
    state: "idle",
    turnId: null,
    settled: null,
  },
  {
    from: "idle",
    what: "process_gone outside a turn emits the error and no state update",
    input: processGone(T0),
    emit: ["error(agent_error)"],
    scheduleTickAt: null,
    state: "idle",
    turnId: null,
    settled: null,
  },
  {
    from: "idle",
    what: "a stray tick is inert",
    input: tick(T0),
    emit: [],
    scheduleTickAt: null,
    state: "idle",
    turnId: null,
    settled: null,
  },

  // ── from running ───────────────────────────────────────────────────────────
  {
    from: "running",
    what: "a second prompt_sent starts the new turn and invents no idle for the old one",
    input: promptSent(TURN_B, T0 + 10),
    emit: ["running"],
    scheduleTickAt: null,
    state: "running",
    turnId: TURN_B,
    settled: null,
  },
  {
    from: "running",
    what: "agent_update is forwarded under the live turnId, with no timer",
    input: agentUpdate(T0 + 10),
    emit: ["passthrough"],
    scheduleTickAt: null,
    state: "running",
    turnId: TURN_A,
    settled: null,
  },
  {
    from: "running",
    what: "prompt_result opens the quiet window instead of ending the turn",
    input: promptResult(T0 + 100),
    emit: [],
    scheduleTickAt: T0 + 100 + QUIET,
    state: "settling",
    turnId: TURN_A,
    settled: null,
  },
  {
    from: "running",
    what: "prompt_error ends the turn cleanly: error, then idle with a null stopReason",
    input: promptError(T0 + 100),
    emit: ["error(agent_error)", "idle(null)"],
    scheduleTickAt: null,
    state: "idle",
    turnId: null,
    settled: "error",
  },
  {
    from: "running",
    what: "process_gone emits the error and NO idle (the crash rule)",
    input: processGone(T0 + 100),
    emit: ["error(agent_error)"],
    scheduleTickAt: null,
    state: "idle",
    turnId: null,
    settled: "gone",
  },
  {
    from: "running",
    what: "a tick before any prompt_result is inert",
    input: tick(T0 + 100),
    emit: [],
    scheduleTickAt: null,
    state: "running",
    turnId: TURN_A,
    settled: null,
  },

  // ── from settling (prompt_result at T0; deadline T0+250, hard cutoff T0+5000) ─
  {
    from: "settling",
    what: "a prompt_sent mid-window flushes the known idle, then opens the new turn",
    input: promptSent(TURN_B, T0 + 10),
    emit: ["idle(end_turn)", "running"],
    scheduleTickAt: null,
    state: "running",
    turnId: TURN_B,
    settled: null,
  },
  {
    from: "settling",
    what: "agent_update is forwarded and pushes the deadline out",
    input: agentUpdate(T0 + 100),
    emit: ["passthrough"],
    scheduleTickAt: T0 + 100 + QUIET,
    state: "settling",
    turnId: TURN_A,
    settled: null,
  },
  {
    from: "settling",
    what: "a second prompt_result re-arms the window without moving the hard cap",
    input: promptResult(T0 + 100, "max_tokens"),
    emit: [],
    scheduleTickAt: T0 + 100 + QUIET,
    state: "settling",
    turnId: TURN_A,
    settled: null,
  },
  {
    from: "settling",
    what: "prompt_error mid-window still ends the turn cleanly",
    input: promptError(T0 + 100),
    emit: ["error(agent_error)", "idle(null)"],
    scheduleTickAt: null,
    state: "idle",
    turnId: null,
    settled: "error",
  },
  {
    from: "settling",
    what: "process_gone mid-window emits the error and NO idle",
    input: processGone(T0 + 100),
    emit: ["error(agent_error)"],
    scheduleTickAt: null,
    state: "idle",
    turnId: null,
    settled: "gone",
  },
  {
    from: "settling",
    what: "a tick before the deadline re-arms rather than truncating the answer",
    input: tick(T0 + 100),
    emit: [],
    scheduleTickAt: T0 + QUIET,
    state: "settling",
    turnId: TURN_A,
    settled: null,
  },
  {
    from: "settling",
    what: "a tick at the deadline emits idle with the real stopReason",
    input: tick(T0 + QUIET),
    emit: ["idle(end_turn)"],
    scheduleTickAt: null,
    state: "idle",
    turnId: null,
    settled: "quiet",
  },
];

describe("normalizer: TurnInput x state cross-product", () => {
  for (const row of TABLE) {
    it(`${row.from}: ${row.what}`, () => {
      const out = at[row.from]().step(row.input);
      expect(tags(out)).toEqual(row.emit);
      expect(out.scheduleTickAt).toBe(row.scheduleTickAt);
      expect(out.state).toBe(row.state);
      expect(out.turnId).toBe(row.turnId);
      expect(out.settled).toBe(row.settled);
    });
  }

  it("covers every input type from every state", () => {
    const cells = new Set(TABLE.map((r) => `${r.from}:${r.input.type}`));
    for (const from of ["idle", "running", "settling"] as const) {
      for (const type of [
        "prompt_sent",
        "agent_update",
        "prompt_result",
        "prompt_error",
        "process_gone",
        "tick",
      ] as const) {
        expect(cells.has(`${from}:${type}`), `${from}:${type}`).toBe(true);
      }
    }
  });
});

describe("normalizer: the two synthesized events (CONTRACTS.md §7.1)", () => {
  it("emits exactly one running state_update, in the SDK's v2 shape, with payloadVersion 2", () => {
    const out = make().step(promptSent(TURN_A, T0));
    expect(out.emit).toHaveLength(1);
    const [e] = out.emit;
    expect(e).toEqual({
      kind: "acp.session_update",
      payloadVersion: 2,
      turnId: TURN_A,
      payload: { sessionUpdate: "state_update", state: "running" },
    });
    // The type forbids stamping envelope metadata; assert the runtime object agrees, because
    // this is the property `PromptAccepted.seq - 1` depends on (§7.6).
    expect(Object.keys(e ?? {}).sort()).toEqual(["kind", "payload", "payloadVersion", "turnId"]);
  });

  it("emits idle with the stopReason the agent actually returned", () => {
    const n = make();
    n.step(promptSent(TURN_A, T0));
    n.step(promptResult(T0, "max_turn_requests"));
    const out = n.step(tick(T0 + QUIET));
    expect(out.emit).toEqual([
      {
        kind: "acp.session_update",
        payloadVersion: 2,
        turnId: TURN_A,
        payload: {
          sessionUpdate: "state_update",
          state: "idle",
          stopReason: "max_turn_requests",
        },
      },
    ]);
  });
});

describe("normalizer: the quiet window (CONTRACTS.md §7.2)", () => {
  it("emits a chunk arriving 400ms after the response BEFORE idle, and idle at T+650", () => {
    // This is `chatty.mjs` made arithmetic: with the quiet window deleted, `idle` would land at
    // T and the chunk would follow it.
    const n = make();
    n.step(promptSent(TURN_A, T0));
    const opened = n.step(promptResult(T0));
    expect(opened.scheduleTickAt).toBe(T0 + 250);

    // The Worker's timer fires at the deadline it was given; the chunk beats it by 100 ms.
    const chunk = n.step(agentUpdate(T0 + 400));
    expect(tags(chunk)).toEqual(["passthrough"]);
    expect(chunk.scheduleTickAt).toBe(T0 + 650);

    // The timer armed for T+250 still fires: it is early now, and must not settle.
    const early = n.step(tick(T0 + 250));
    expect(early.emit).toEqual([]);
    expect(early.state).toBe("settling");
    expect(early.scheduleTickAt).toBe(T0 + 650);

    const settled = n.step(tick(T0 + 650));
    expect(tags(settled)).toEqual(["idle(end_turn)"]);
    expect(settled.settled).toBe("quiet");
    expect(settled.state).toBe("idle");
  });

  it("quietMs 0 settles on the response itself rather than asking for a tick in the past", () => {
    const n = make({ quietMs: 0 });
    n.step(promptSent(TURN_A, T0));
    const out = n.step(promptResult(T0));
    expect(tags(out)).toEqual(["idle(end_turn)"]);
    expect(out.scheduleTickAt).toBeNull();
    expect(out.settled).toBe("quiet");
  });
});

describe("normalizer: the hard cap (CONTRACTS.md §7.2)", () => {
  it("caps a permanently chatty agent at promptResultAt + hardMs", () => {
    const n = make({ quietMs: 250, hardMs: 1_000 });
    n.step(promptSent(TURN_A, T0));
    n.step(promptResult(T0));

    let deadline = T0 + 250;
    let idleAt: number | null = null;
    // An agent that never shuts up: one update every 100 ms of virtual time, for ten times the
    // hard cap. The Worker's tick always arrives at the deadline the previous step asked for.
    for (let now = T0 + 100; now <= T0 + 10_000 && idleAt === null; now += 100) {
      const update = n.step(agentUpdate(now));
      expect(tags(update)).toEqual(["passthrough"]);
      deadline = update.scheduleTickAt ?? deadline;
      expect(deadline).toBeLessThanOrEqual(T0 + 1_000);
      if (now >= deadline) {
        const out = n.step(tick(now));
        if (out.emit.length > 0) {
          expect(tags(out)).toEqual(["idle(end_turn)"]);
          expect(out.settled).toBe("hard");
          idleAt = now;
        }
      }
    }
    expect(idleAt).not.toBeNull();
    expect(idleAt).toBeLessThanOrEqual(T0 + 1_000);
  });

  it("clamps the very first deadline when quietMs exceeds hardMs", () => {
    const n = make({ quietMs: 5_000, hardMs: 1_000 });
    n.step(promptSent(TURN_A, T0));
    const out = n.step(promptResult(T0));
    expect(out.scheduleTickAt).toBe(T0 + 1_000);
    expect(n.step(tick(T0 + 1_000)).settled).toBe("hard");
  });

  it("never lets a late update push the deadline past the cap", () => {
    const n = make({ quietMs: 250, hardMs: 400 });
    n.step(promptSent(TURN_A, T0));
    n.step(promptResult(T0));
    expect(n.step(agentUpdate(T0 + 300)).scheduleTickAt).toBe(T0 + 400);
    expect(n.step(agentUpdate(T0 + 399)).scheduleTickAt).toBe(T0 + 400);
  });
});

describe("normalizer: the crash rule (CONTRACTS.md §7.3)", () => {
  it("process_gone emits omni.error with the stderr tail and NEVER an idle", () => {
    for (const from of ["running", "settling"] as const) {
      const out = at[from]().step(processGone(T0 + 100));
      expect(out.emit).toEqual([
        {
          kind: "omni.error",
          payloadVersion: 2,
          turnId: TURN_A,
          payload: {
            code: "agent_error",
            message: "agent exited",
            stderrTail: "Error: boom",
          },
        },
      ]);
      expect(out.settled).toBe("gone");
    }
  });

  it("never emits an idle for a dead agent, whatever arrives afterwards", () => {
    const n = make();
    n.step(promptSent(TURN_A, T0));
    n.step(promptResult(T0));
    const emitted = [
      n.step(processGone(T0 + 10)),
      n.step(tick(T0 + 250)),
      n.step(tick(T0 + 10_000)),
      n.step(agentUpdate(T0 + 10_001)),
    ].flatMap(tags);
    expect(emitted.filter((t) => t.startsWith("idle"))).toEqual([]);
  });

  it("prompt_error emits the error and THEN idle with a null stopReason", () => {
    const out = at.running().step(promptError(T0 + 100));
    expect(out.emit).toEqual([
      {
        kind: "omni.error",
        payloadVersion: 2,
        turnId: TURN_A,
        payload: RPC_ERROR,
      },
      {
        kind: "acp.session_update",
        payloadVersion: 2,
        turnId: TURN_A,
        payload: { sessionUpdate: "state_update", state: "idle", stopReason: null },
      },
    ]);
    // The agent's JSON-RPC error is passed through by identity, never reshaped (§9).
    expect(out.emit[0]?.kind === "omni.error" && out.emit[0].payload).toBe(RPC_ERROR);
  });

  it("leaves state idle and turnId null after every non-agent_update terminal input", () => {
    for (const from of ["running", "settling"] as const) {
      for (const input of [promptError(T0 + 1), processGone(T0 + 1)]) {
        const out = at[from]().step(input);
        expect(out.state, `${from}/${input.type}`).toBe("idle");
        expect(out.turnId, `${from}/${input.type}`).toBeNull();
        expect(out.scheduleTickAt, `${from}/${input.type}`).toBeNull();
      }
    }
    const settled = at.settling().step(tick(T0 + QUIET));
    expect(settled.state).toBe("idle");
    expect(settled.turnId).toBeNull();
    expect(settled.scheduleTickAt).toBeNull();
  });

  it("accepts a new turn after a crash without carrying the dead turn forward", () => {
    const n = make();
    n.step(promptSent(TURN_A, T0));
    n.step(processGone(T0 + 1));
    const out = n.step(promptSent(TURN_B, T0 + 2));
    expect(tags(out)).toEqual(["running"]);
    expect(out.turnId).toBe(TURN_B);
  });
});

/**
 * §7.5 IS SUPERSEDED BY §12 — the two cases below are its M1 successors, and they are the only
 * two tests in this file that M1 changed.
 *
 * M0 forwarded EVERY `session/update` verbatim at `payloadVersion: 1`, and §7.5 said so; §12
 * replaces that with the per-field map and ruling M1-R10 flips `payloadVersion` to 2 wherever the
 * map lands on a known v2 arm. A `tool_call` carrying a real `toolCallId` is therefore now a
 * `tool_call_update` at 2 — which is precisely the flip §7.5 predicted ("when M1 flips them to 2
 * the client's already-written v2 branch takes over with no wire break").
 *
 * What the M0 cases were PROTECTING is not weakened, it is moved to where §12 puts it:
 *
 *   - forwarding BY IDENTITY, `_meta` included, is now §12.3 row 18's guarantee for an
 *     UNRECOGNIZED kind — and it is asserted here by object identity, exactly as before;
 *   - the three v1-only variants are still not half-translated: a payload that cannot produce
 *     its v2 arm comes back as the very object the agent sent, at `payloadVersion: 1`.
 *
 * Every other test in this file — the whole `TurnInput` × state cross-product, the quiet window,
 * the hard cap, the crash rule, the purity check and the config validation — is M0's, unmodified,
 * which is M1-WP-B acceptance bullet 8.
 */
describe("normalizer: pass-through by identity (CONTRACTS.md §12.3 row 18)", () => {
  it("forwards an UNRECOGNIZED kind BY IDENTITY, preserving _meta, and stamps payloadVersion 1", () => {
    const meta = { "vendor.io/trace": "abc" };
    const update = {
      sessionUpdate: "vendor.io/telemetry",
      toolCallId: "call-1",
      title: "Read file",
      _meta: meta,
    };
    const n = make();
    n.step(promptSent(TURN_A, T0));
    const [e] = n.step(agentUpdate(T0 + 1, update)).emit;

    expect(e?.kind).toBe("acp.session_update");
    expect(e?.payloadVersion).toBe(1);
    expect(e?.turnId).toBe(TURN_A);
    // Identity, not deep equality: rebuilding the payload is what drops `_meta` and every
    // field this milestone has not enumerated.
    expect(e?.kind === "acp.session_update" && e.payload).toBe(update);
    expect(
      (e?.kind === "acp.session_update" && e.payload) as unknown as typeof update,
    ).toHaveProperty("_meta", meta);
  });

  it("does not half-translate a v1-only kind it cannot land on its v2 arm", () => {
    // `tool_call` without a `toolCallId`, `plan` without `entries`, `current_mode_update`
    // without `currentModeId`: each names a row of §12.3, and each is missing the field its
    // target arm REQUIRES. §12.2's rule — test the target shape before rewriting — makes all
    // three pass through by identity rather than becoming a v2 payload that is not one.
    const n = make();
    n.step(promptSent(TURN_A, T0));
    for (const sessionUpdate of ["tool_call", "plan", "current_mode_update"]) {
      const update = { sessionUpdate, marker: sessionUpdate };
      const [e] = n.step(agentUpdate(T0 + 1, update)).emit;
      expect(e?.payloadVersion).toBe(1);
      expect(e?.kind === "acp.session_update" && e.payload).toBe(update);
    }
  });

  it("DOES map the same three rows once their target arm is satisfiable", () => {
    // The other half of the flip, so the case above cannot be satisfied by a mapper that gave up
    // on these kinds entirely.
    const n = make();
    n.step(promptSent(TURN_A, T0));
    const meta = { "vendor.io/trace": "abc" };
    const [e] = n.step(
      agentUpdate(T0 + 1, { sessionUpdate: "tool_call", toolCallId: "call-1", _meta: meta }),
    ).emit;
    expect(e?.payloadVersion).toBe(2);
    const payload = (e?.kind === "acp.session_update" ? e.payload : {}) as Record<string, unknown>;
    expect(payload["sessionUpdate"]).toBe("tool_call_update");
    // The rename is the WHOLE rewrite: `_meta` survives by identity, and no field is invented.
    expect(payload["_meta"]).toBe(meta);
    expect(Object.keys(payload).sort()).toEqual(["_meta", "sessionUpdate", "toolCallId"]);
  });
});

describe("normalizer: the object itself", () => {
  it("declares the slice it implements", () => {
    const n = make();
    expect(n.sourceProtocolVersion).toBe(1);
    expect(n.slice).toBe("m1-full");
  });

  it("is a pure function of its inputs: two instances, same script, identical outputs", () => {
    const script: TurnInput[] = [
      promptSent(TURN_A, T0),
      agentUpdate(T0 + 1, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hi" },
      }),
      promptResult(T0 + 2),
      agentUpdate(T0 + 3, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "!" },
      }),
      tick(T0 + 253),
      tick(T0 + 300),
      promptSent(TURN_B, T0 + 400),
      processGone(T0 + 500),
    ];
    const a = make();
    const b = make();
    expect(script.map((i) => a.step(i))).toEqual(script.map((i) => b.step(i)));
  });

  it("rejects a nonsense quiet or hard window instead of arming a broken timer", () => {
    expect(() => createNormalizer({ quietMs: -1, hardMs: HARD })).toThrow(OmniError);
    expect(() => createNormalizer({ quietMs: 1.5, hardMs: HARD })).toThrow(/non-negative integer/);
    expect(() => createNormalizer({ quietMs: QUIET, hardMs: 0 })).toThrow(/positive integer/);
  });

  it("throws rather than silently ignoring an input it does not know", () => {
    const n = make();
    expect(() => n.step({ type: "nope", at: T0 } as unknown as TurnInput)).toThrow(OmniError);
  });
});
