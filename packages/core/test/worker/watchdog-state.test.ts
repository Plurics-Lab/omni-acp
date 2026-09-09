import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type {
  DaemonId,
  EventEnvelope,
  ResolvedWatchdogConfig,
  Seq,
  SessionId,
  TurnId,
  WatchdogSignal,
  WatchdogState,
  WatchdogVerdict,
  WorkerId,
} from "@omni-acp/protocol";
import { loadTranscript } from "@omni-acp/testkit";
import { initialWatchdogState, watchdogStep } from "@omni-acp/core";

/**
 * `watchdogStep` — PURE, table-driven, 100 % branch coverage, and there is NO `setTimeout` in the
 * file under test. Every row here is a corpus lesson rather than an invented case.
 *
 * Owned by M2-A-WP-W.
 */

const WORKER = "w_00000000000000000000000001" as WorkerId;
const DAEMON = "d_00000000000000000000000001" as DaemonId;
const TURN = "t_00000000000000000000000001" as TurnId;

const CFG: ResolvedWatchdogConfig = {
  enabled: true,
  silentMs: 300_000,
  toolMs: 1_800_000,
  cancelTimeoutMs: 60_000,
  action: "cancel",
};

const cfg = (o: Partial<ResolvedWatchdogConfig> = {}): ResolvedWatchdogConfig => ({ ...CFG, ...o });

let seq = 0;
function envelope(payload: Record<string, unknown>, o?: { replay?: true }): EventEnvelope {
  seq += 1;
  return {
    seq: seq as Seq,
    ts: new Date(seq).toISOString(),
    daemonId: DAEMON,
    workerId: WORKER,
    sessionId: "s_1" as SessionId,
    turnId: TURN,
    payloadVersion: 2,
    kind: "acp.session_update",
    payload: payload as never,
    ...(o?.replay === true ? { replay: true as const } : {}),
  };
}

/** A non-`acp.session_update` envelope: still activity, still never a tool call. */
function stateEnvelope(): EventEnvelope {
  seq += 1;
  return {
    seq: seq as Seq,
    ts: new Date(seq).toISOString(),
    daemonId: DAEMON,
    workerId: WORKER,
    sessionId: null,
    turnId: TURN,
    payloadVersion: 2,
    kind: "omni.worker_state",
    payload: { state: "running", previous: "ready", reason: "prompt" },
  };
}

const chunk = (text: string): Record<string, unknown> => ({
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text },
});

const open = (id: string, status: string | null = "pending"): Record<string, unknown> => ({
  sessionUpdate: "tool_call",
  toolCallId: id,
  ...(status === null ? {} : { status }),
  title: "Terminal",
  kind: "execute",
});

const update = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  sessionUpdate: "tool_call_update",
  toolCallId: id,
  ...extra,
});

/** Drive a whole signal list, returning the last verdict and the state it left behind. */
function drive(
  signals: readonly WatchdogSignal[],
  config: ResolvedWatchdogConfig = CFG,
  from: WatchdogState = initialWatchdogState(),
): { state: WatchdogState; verdict: WatchdogVerdict } {
  let state = from;
  // The disarmed reading, which is what an EMPTY signal list means; every real row below starts
  // with `turn_start`.
  let verdict: WatchdogVerdict = {
    deadlineAt: null,
    budget: null,
    phase: "idle",
    openToolCalls: [...state.open],
  };
  for (const sig of signals) {
    const out = watchdogStep(state, sig, config);
    state = out.state;
    verdict = out.verdict;
  }
  return { state, verdict };
}

const start = (at: number): WatchdogSignal => ({ kind: "turn_start", at });
const env = (
  at: number,
  payload: Record<string, unknown>,
  o?: { replay?: true },
): WatchdogSignal => ({
  kind: "envelope",
  at,
  envelope: envelope(payload, o),
});

describe("watchdogStep (DESIGN §7's dual budget)", () => {
  it("is pure and table-tested with 100 % branch coverage, no clock and no process", () => {
    // PURITY, asserted rather than asserted-about: the same (state, signal, config) twice gives
    // deep-equal outputs, and NEITHER the input state nor its `open` set is mutated.
    const before = drive([start(1_000), env(1_100, open("a"))]).state;
    const frozen = {
      lastAt: before.lastAt,
      parked: before.parked,
      running: before.running,
      open: [...before.open],
    };
    const sig: WatchdogSignal = env(1_200, update("a", { status: "completed" }));

    const first = watchdogStep(before, sig, CFG);
    const second = watchdogStep(before, sig, CFG);
    expect(second).toStrictEqual(first);
    expect({
      lastAt: before.lastAt,
      parked: before.parked,
      running: before.running,
      open: [...before.open],
    }).toStrictEqual(frozen);

    // No clock and no process: the module under test imports neither, and the deadline is a
    // number the CALLER supplied plus a number the CONFIG supplied. Nothing else could produce
    // it, which is what makes every row below reproducible.
    expect(first.verdict.deadlineAt).toBe(1_200 + CFG.silentMs);
  });

  it("has no setTimeout, no setInterval and no clock in the file under test (§21.1)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "..", "..", "src", "worker", "watchdog-state.ts"), "utf8");
    // Comments are stripped first: the file's prose says "no clock" and "one timer" repeatedly,
    // and a guard that could be satisfied by NOT SAYING SO would be a guard about spelling.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((l) => l.replace(/\/\/.*$/, ""))
      .join("\n");
    for (const forbidden of [
      "setTimeout",
      "setInterval",
      "setImmediate",
      "Date.now",
      "clock",
      "Clock",
      "process.",
      "queueMicrotask",
    ]) {
      expect(code, `watchdog-state.ts must not use ${forbidden}`).not.toContain(forbidden);
    }
    // …and it really is the file the export comes from.
    expect(code).toContain("export function watchdogStep");
  });

  it("arms the SILENT budget from turn_start, before any envelope exists", () => {
    const { verdict } = drive([start(5_000)]);
    expect(verdict).toStrictEqual({
      deadlineAt: 5_000 + CFG.silentMs,
      budget: "silent",
      phase: "silent",
      openToolCalls: [],
    });
  });

  it("is disarmed before a turn starts, and again after turn_end", () => {
    expect(drive([]).verdict.deadlineAt).toBeNull();

    const idle = drive([start(0), env(10, chunk("hi")), { kind: "turn_end", at: 20 }]);
    expect(idle.verdict).toStrictEqual({
      deadlineAt: null,
      budget: null,
      phase: "idle",
      openToolCalls: [],
    });
    expect(idle.state.running).toBe(false);
  });

  it("anchors the quiet window on the LAST envelope appended, never on the prompt response", () => {
    // F25, 7/7 on claude-acp. `session_info_update` lands 5-22 ms AFTER `session/prompt`
    // resolves; codex emits `threadStatus:{idle}` BEFORE its response. A window anchored on the
    // RESPONSE races one agent and truncates the other — so the response is not a signal at all,
    // and `WatchdogSignal` has no arm for it.
    expect(
      new Set(["turn_start", "envelope", "parked", "unparked", "cancel_sent", "turn_end"] as const),
    ).not.toContain("prompt_result");

    const { verdict } = drive([start(0), env(100, chunk("one")), env(140, chunk("two"))]);
    expect(verdict.deadlineAt).toBe(140 + CFG.silentMs);
  });

  it("an update 20 ms after the prompt response re-bases the budget rather than tripping it (F25)", () => {
    // The recorded numbers from claude `16`, to the tenth of a millisecond: the prompt response
    // resolves at 11997.7 and `session_info_update` is appended at 12002.569 — 4.869 ms later.
    const RESPONSE_AT = 11_997.7;
    const LATE_UPDATE_AT = 12_002.569;
    const silent = cfg({ silentMs: 10 });

    const { verdict } = drive(
      [
        start(0),
        env(6_070.721, chunk("working")),
        env(LATE_UPDATE_AT, { sessionUpdate: "session_info_update", title: "Python sleep test" }),
      ],
      silent,
    );

    // Anchored on the LATE UPDATE.
    expect(verdict.deadlineAt).toBe(LATE_UPDATE_AT + 10);
    // And strictly LATER than a response-anchored window would have been — which is the whole
    // finding: a response anchor's deadline (12007.7) precedes the update the agent had still to
    // send, so it would have cancelled a turn that was already over.
    expect(verdict.deadlineAt).toBeGreaterThan(RESPONSE_AT + 10);
    // The update has not yet been outlived: it is in the future relative to its own arrival.
    expect(verdict.deadlineAt).toBeGreaterThan(LATE_UPDATE_AT);
  });

  it("treats a replayed envelope (replay:true) as NOT activity", () => {
    // Ruling M1-R5, D6. Counting a `session/load` replay would let a DEAD turn's budget be held
    // open by history, and would open tool calls that finished in a previous session.
    const base = drive([start(0), env(100, chunk("live"))]);
    const replayed = watchdogStep(base.state, env(9_000, chunk("history"), { replay: true }), CFG);
    expect(replayed.verdict.deadlineAt).toBe(100 + CFG.silentMs);
    expect(replayed.state).toStrictEqual(base.state);

    // Not even a replayed tool_call opens the budget.
    const replayedTool = watchdogStep(base.state, env(9_000, open("ghost"), { replay: true }), CFG);
    expect(replayedTool.verdict.budget).toBe("silent");
    expect(replayedTool.verdict.openToolCalls).toStrictEqual([]);
  });

  it("counts EVERY appended envelope as activity, not only session updates (F41)", () => {
    // A codex host banner arrives as a `messageId`-less `agent_message_chunk` with no `_meta`,
    // and an `omni.worker_state` is not an agent frame at all. §11.9's accepted risk, stated as
    // a rule: a host emitting frames is a host that is alive, which is exactly what the silent
    // budget measures.
    const { verdict } = drive([start(0), { kind: "envelope", at: 700, envelope: stateEnvelope() }]);
    expect(verdict.deadlineAt).toBe(700 + CFG.silentMs);
  });

  it("opens on tool_call and switches to the LARGER tool budget", () => {
    const { verdict } = drive([start(0), env(100, open("a"))]);
    expect(verdict).toStrictEqual({
      deadlineAt: 100 + CFG.toolMs,
      budget: "tool",
      phase: "tool",
      openToolCalls: ["a"],
    });
  });

  it("opens on a tool_call even when it carries no status at all", () => {
    // §21.3: "`tool_call` always (re)opens". v1's `ToolCall.status` is OPTIONAL, so the
    // statusless announcement is legal wire.
    const { verdict } = drive([start(0), env(100, open("a", null))]);
    expect(verdict.budget).toBe("tool");
    expect(verdict.openToolCalls).toStrictEqual(["a"]);
  });

  it("closes on a TERMINAL tool_call_update, and only on completed / failed", () => {
    for (const status of ["completed", "failed"]) {
      const { verdict } = drive([start(0), env(100, open("a")), env(200, update("a", { status }))]);
      expect(verdict.budget, status).toBe("silent");
      expect(verdict.openToolCalls, status).toStrictEqual([]);
      expect(verdict.deadlineAt, status).toBe(200 + CFG.silentMs);
    }
    for (const status of ["pending", "in_progress", "cancelled", "whatever-the-agent-invented"]) {
      const { verdict } = drive([start(0), env(100, open("a")), env(200, update("a", { status }))]);
      expect(verdict.budget, status).toBe("tool");
      expect(verdict.openToolCalls, status).toStrictEqual(["a"]);
    }
  });

  it("a SPARSE update with no status neither opens a closed call nor closes an open one", () => {
    // F23: 8 of the 36 recorded `tool_call_update`s carry only `{toolCallId, sessionUpdate,
    // _meta}`. Absent means unchanged — the same rule `reduceTurn.upsertToolCall` folds by.
    const stillOpen = drive([
      start(0),
      env(100, open("a")),
      env(
        200,
        update("a", { content: [{ type: "content", content: { type: "text", text: "x" } }] }),
      ),
    ]);
    expect(stillOpen.verdict.openToolCalls).toStrictEqual(["a"]);
    expect(stillOpen.verdict.budget).toBe("tool");

    const stillClosed = drive([
      start(0),
      env(100, open("a")),
      env(200, update("a", { status: "completed" })),
      env(300, update("a", { title: "renamed" })),
    ]);
    expect(stillClosed.verdict.openToolCalls).toStrictEqual([]);
    expect(stillClosed.verdict.budget).toBe("silent");
  });

  it("treats a non-string status as absent, exactly as reduceTurn does", () => {
    const { verdict } = drive([
      start(0),
      env(100, open("a")),
      env(200, update("a", { status: null })),
    ]);
    expect(verdict.openToolCalls).toStrictEqual(["a"]);
  });

  it("ignores a tool update with no toolCallId, and a session update of any other kind", () => {
    const { verdict } = drive([
      start(0),
      env(100, { sessionUpdate: "tool_call", title: "no id" }),
      env(200, { sessionUpdate: "tool_call_update", status: "completed" }),
      env(300, { sessionUpdate: "plan", entries: [] }),
    ]);
    expect(verdict.openToolCalls).toStrictEqual([]);
    expect(verdict.budget).toBe("silent");
  });

  it("keeps the tool budget while ANY call is open, and returns to silent only when all are closed", () => {
    const two = drive([start(0), env(100, open("a")), env(150, open("b"))]);
    expect(two.verdict.openToolCalls).toStrictEqual(["a", "b"]);

    const one = watchdogStep(two.state, env(200, update("a", { status: "completed" })), CFG);
    expect(one.verdict.budget).toBe("tool");
    expect(one.verdict.openToolCalls).toStrictEqual(["b"]);

    const none = watchdogStep(one.state, env(250, update("b", { status: "failed" })), CFG);
    expect(none.verdict.budget).toBe("silent");
  });

  it("is idempotent about membership: re-opening an open call and re-closing a closed one change nothing", () => {
    const opened = drive([start(0), env(100, open("a")), env(150, open("a"))]);
    expect(opened.verdict.openToolCalls).toStrictEqual(["a"]);

    const closed = watchdogStep(opened.state, env(200, update("a", { status: "completed" })), CFG);
    const again = watchdogStep(closed.state, env(250, update("a", { status: "failed" })), CFG);
    expect(again.verdict.openToolCalls).toStrictEqual([]);
    expect(again.state.open).toBe(closed.state.open);
  });

  it("empties the open set ONLY on turn_end — claude 16 and codex 08 are still armed at the cancel (F36)", () => {
    // claude `16`: `tool_call{status:"pending"}` at 6070.721, three sparse updates, then a
    // `session/cancel` at 11966.48 and a `usage_update` at 11995.497. No terminal update EVER.
    const claude = drive([
      start(0),
      env(6_070.721, open("toolu_01SSKkXnrSBG3fd7pKyMvHBt")),
      env(6_477.003, update("toolu_01SSKkXnrSBG3fd7pKyMvHBt", { title: "python3 …" })),
      env(
        6_775.238,
        update("toolu_01SSKkXnrSBG3fd7pKyMvHBt", { rawInput: { command: "python3 …" } }),
      ),
      env(6_949.634, update("toolu_01SSKkXnrSBG3fd7pKyMvHBt", { content: [] })),
      env(6_966.288, { sessionUpdate: "usage_update", used: 25_157, size: 1_000_000 }),
      { kind: "cancel_sent", at: 11_966.48 },
    ]);
    expect(claude.state.open).toEqual(new Set(["toolu_01SSKkXnrSBG3fd7pKyMvHBt"]));
    expect(claude.verdict.openToolCalls).toStrictEqual(["toolu_01SSKkXnrSBG3fd7pKyMvHBt"]);

    // codex `08`: one `tool_call{status:"in_progress"}` at 7904.8, cancel at 12910.3, then a
    // `usage_update` and a `session_info_update` — and again no terminal update.
    const codex = drive([
      start(0),
      env(7_904.8, open("exec-cba0d467-b26e-49be-90fc-b48f7be06b0d", "in_progress")),
      { kind: "cancel_sent", at: 12_910.3 },
      env(12_927.1, { sessionUpdate: "usage_update", used: 20_267, size: 258_400 }),
    ]);
    expect(codex.verdict.openToolCalls).toStrictEqual([
      "exec-cba0d467-b26e-49be-90fc-b48f7be06b0d",
    ]);

    // The ONLY thing that empties it.
    const ended = watchdogStep(codex.state, { kind: "turn_end", at: 13_000 }, CFG);
    expect(ended.state.open.size).toBe(0);
  });

  it("a park disarms BOTH budgets and an unpark RE-BASES from the unpark instant (M2-R21)", () => {
    const TWENTY_MINUTES = 20 * 60_000;
    const parked = drive([start(0), env(100, open("a")), { kind: "parked", at: 200 }]);
    expect(parked.verdict).toStrictEqual({
      deadlineAt: null,
      budget: null,
      phase: "paused",
      openToolCalls: ["a"],
    });

    // Twenty minutes of a human thinking, then ONE update. Re-based, not resumed: a budget that
    // was already spent would cancel the very turn the human just unblocked.
    const unparked = watchdogStep(
      parked.state,
      { kind: "unparked", at: 200 + TWENTY_MINUTES },
      CFG,
    );
    expect(unparked.verdict.deadlineAt).toBe(200 + TWENTY_MINUTES + CFG.toolMs);
    const after = watchdogStep(unparked.state, env(200 + TWENTY_MINUTES + 5, chunk("thanks")), CFG);
    expect(after.verdict.deadlineAt).toBeGreaterThan(200 + TWENTY_MINUTES);

    // And with the SILENT budget, the same: a twenty-minute park under the default 300 s budget
    // does not hand back a deadline that is already four times over.
    const silentPark = drive([
      start(0),
      { kind: "parked", at: 10 },
      { kind: "unparked", at: 10 + TWENTY_MINUTES },
    ]);
    expect(silentPark.verdict.deadlineAt).toBe(10 + TWENTY_MINUTES + CFG.silentMs);
  });

  it("the park instant is not an anchor, and a second park is not a second pause", () => {
    const once = drive([start(0), env(100, chunk("x")), { kind: "parked", at: 500 }]);
    const twice = watchdogStep(once.state, { kind: "parked", at: 900 }, CFG);
    expect(twice.state).toBe(once.state);
    // Unparking re-bases from the UNPARK, so the park instants never enter the arithmetic.
    const back = watchdogStep(twice.state, { kind: "unparked", at: 1_000 }, CFG);
    expect(back.verdict.deadlineAt).toBe(1_000 + CFG.silentMs);
  });

  it("a park while the AskUserQuestion tool call is open still stops the TOOL budget (F32)", () => {
    // During a claude-acp elicitation the mirror tool call is OPEN, so without §21.4 the LARGER
    // budget would be the one running against a human — which is worse, not better: it hides the
    // bug for half an hour.
    const { verdict } = drive([
      start(0),
      env(10, open("toolu_ask", "in_progress")),
      { kind: "parked", at: 20 },
    ]);
    expect(verdict.phase).toBe("paused");
    expect(verdict.deadlineAt).toBeNull();
    expect(verdict.openToolCalls).toStrictEqual(["toolu_ask"]);
  });

  it("silentMs: 0 disables the silent budget ONLY", () => {
    const c = cfg({ silentMs: 0 });
    const silent = drive([start(0), env(100, chunk("x"))], c);
    expect(silent.verdict).toStrictEqual({
      deadlineAt: null,
      budget: null,
      phase: "idle",
      openToolCalls: [],
    });
    // The tool budget is untouched.
    const tool = drive([start(0), env(100, open("a"))], c);
    expect(tool.verdict.deadlineAt).toBe(100 + c.toolMs);
    expect(tool.verdict.budget).toBe("tool");
  });

  it("toolMs: 0 disables the tool budget ONLY, and never falls back to the silent one", () => {
    const c = cfg({ toolMs: 0 });
    const tool = drive([start(0), env(100, open("a"))], c);
    expect(tool.verdict.deadlineAt).toBeNull();
    expect(tool.verdict.budget).toBeNull();
    expect(tool.verdict.openToolCalls).toStrictEqual(["a"]);

    const silent = drive([start(0), env(100, chunk("x"))], c);
    expect(silent.verdict.deadlineAt).toBe(100 + c.silentMs);

    // Closing the call brings the silent budget back — "disabled" is a property of the budget,
    // not of the turn.
    const closed = watchdogStep(tool.state, env(200, update("a", { status: "completed" })), c);
    expect(closed.verdict.deadlineAt).toBe(200 + c.silentMs);
  });

  it("`0` means NEVER FIRES, never FIRES NOW", () => {
    const both = cfg({ silentMs: 0, toolMs: 0 });
    expect(drive([start(0)], both).verdict.deadlineAt).toBeNull();
    expect(drive([start(0), env(1, open("a"))], both).verdict.deadlineAt).toBeNull();
  });

  it("enabled:false disarms BOTH budgets in every state", () => {
    const off = cfg({ enabled: false });
    const rows: readonly WatchdogSignal[][] = [
      [start(0)],
      [start(0), env(1, chunk("x"))],
      [start(0), env(1, open("a"))],
      [start(0), { kind: "parked", at: 2 }],
      [start(0), { kind: "cancel_sent", at: 3 }],
      [start(0), { kind: "turn_end", at: 4 }],
    ];
    for (const row of rows) {
      const { verdict } = drive(row, off);
      expect(verdict.deadlineAt).toBeNull();
      expect(verdict.budget).toBeNull();
      expect(verdict.phase).toBe("idle");
    }
    // The FOLD still tracks the open set while disabled, so flipping `enabled` back on (a
    // per-worker override, §5.8.7) does not resume with a wrong budget.
    const { state } = drive([start(0), env(1, open("a"))], off);
    expect(state.open).toEqual(new Set(["a"]));
    expect(watchdogStep(state, env(2, chunk("x")), CFG).verdict.budget).toBe("tool");
  });

  it("cancel_sent moves to the cancelling phase and arms cancelTimeoutMs as the backstop", () => {
    const { verdict } = drive([start(0), env(100, open("a")), { kind: "cancel_sent", at: 5_000 }]);
    expect(verdict).toStrictEqual({
      deadlineAt: 5_000 + CFG.cancelTimeoutMs,
      budget: null,
      phase: "cancelling",
      openToolCalls: ["a"],
    });
  });

  it("a park outranks a cancel that has already gone out", () => {
    // Both disarm; the ORDER of the checks is what makes `paused` the reported phase, and
    // `paused` is the one an operator has to see — it says a human is the thing being waited on.
    const { verdict } = drive([
      start(0),
      { kind: "cancel_sent", at: 100 },
      { kind: "parked", at: 200 },
    ]);
    expect(verdict.phase).toBe("paused");
  });

  it("late envelopes after the cancel do not re-arm a budget, and turn_end clears the cancel", () => {
    // claude `16`: a `usage_update` lands 29 ms after `session/cancel` and the response 31 ms
    // after that. Neither is a reason to give the agent a fresh 300 s.
    const after = drive([
      start(0),
      { kind: "cancel_sent", at: 11_966.48 },
      env(11_995.497, { sessionUpdate: "usage_update", used: 1, size: 2 }),
    ]);
    expect(after.verdict.phase).toBe("cancelling");
    expect(after.verdict.deadlineAt).toBe(11_966.48 + CFG.cancelTimeoutMs);

    const ended = watchdogStep(after.state, { kind: "turn_end", at: 12_100 }, CFG);
    expect(ended.state.cancelSentAt).toBeNull();
    expect(ended.verdict.phase).toBe("idle");

    // …and the NEXT turn is armed normally.
    const next = watchdogStep(ended.state, start(20_000), CFG);
    expect(next.verdict).toStrictEqual({
      deadlineAt: 20_000 + CFG.silentMs,
      budget: "silent",
      phase: "silent",
      openToolCalls: [],
    });
  });

  it("cancelTimeoutMs: 0 leaves the cancelling phase with no deadline at all", () => {
    // `WatchdogConfig.cancelTimeoutMs` is `.positive()`, so this is unreachable through the
    // schema; the fold is total anyway, because "disabled means never fires" must not become
    // "fires at the epoch" for a hand-built config.
    const { verdict } = drive(
      [start(0), { kind: "cancel_sent", at: 100 }],
      cfg({ cancelTimeoutMs: 0 }),
    );
    expect(verdict.phase).toBe("cancelling");
    expect(verdict.deadlineAt).toBeNull();
  });

  it("turn_start clears a previous turn's open set, parked flag and cancel", () => {
    const dirty = drive([
      start(0),
      env(10, open("a")),
      { kind: "parked", at: 20 },
      { kind: "cancel_sent", at: 30 },
    ]);
    const fresh = watchdogStep(dirty.state, start(1_000), CFG);
    expect(fresh.state).toStrictEqual({
      lastAt: 1_000,
      open: new Set<string>(),
      parked: false,
      running: true,
      cancelSentAt: null,
    });
    expect(fresh.verdict.budget).toBe("silent");
  });

  it("signals that arrive outside a turn are recorded but arm nothing", () => {
    const outside = drive([
      { kind: "envelope", at: 10, envelope: stateEnvelope() },
      { kind: "parked", at: 20 },
      { kind: "unparked", at: 30 },
      { kind: "cancel_sent", at: 40 },
      { kind: "turn_end", at: 50 },
    ]);
    expect(outside.verdict.deadlineAt).toBeNull();
    expect(outside.verdict.phase).toBe("idle");
  });

  it("initialWatchdogState is disarmed, empty, and a fresh object every time", () => {
    const a = initialWatchdogState();
    const b = initialWatchdogState();
    expect(a).toStrictEqual({
      lastAt: 0,
      open: new Set<string>(),
      parked: false,
      running: false,
      cancelSentAt: null,
    });
    expect(a).not.toBe(b);
    expect(watchdogStep(a, { kind: "turn_end", at: 0 }, CFG).verdict.deadlineAt).toBeNull();
  });
});

describe("the recorded corpus, replayed through the fold", () => {
  /**
   * claude `16` end to end, from the transcript rather than from memory: every `session/update`
   * becomes an `envelope` signal at its own recorded `tMs`, and the prompt RESPONSE is fed as
   * nothing at all, because the watchdog has no arm for it (§21.2).
   */
  const claude16 = loadTranscript("16-cancel-during-tool-call");

  const updates = claude16.flatMap((line) => {
    const msg = line.msg as
      { method?: string; params?: { update?: Record<string, unknown> } } | undefined;
    if (line.dir !== "agent->client" || msg?.method !== "session/update") return [];
    const u = msg.params?.update;
    return u === undefined ? [] : [{ at: line.tMs, update: u }];
  });

  it("keeps the tool budget armed for the whole of claude 16 and strands exactly one call", () => {
    expect(updates.length).toBeGreaterThan(0);

    let state = initialWatchdogState();
    let verdict = watchdogStep(state, start(0), CFG).verdict;
    state = watchdogStep(state, start(0), CFG).state;

    const budgets: string[] = [];
    for (const u of updates) {
      const out = watchdogStep(
        state,
        { kind: "envelope", at: u.at, envelope: envelope(u.update) },
        CFG,
      );
      state = out.state;
      verdict = out.verdict;
      budgets.push(String(verdict.budget));
    }

    // The `tool_call` is update index 1 (the first is `available_commands_update`); from there on
    // the budget is `tool` and never returns to `silent`, because no terminal update is ever sent.
    expect(budgets.filter((b) => b === "tool").length).toBeGreaterThan(0);
    expect(budgets.lastIndexOf("silent")).toBeLessThan(budgets.indexOf("tool"));
    expect(verdict.openToolCalls).toStrictEqual(["toolu_01SSKkXnrSBG3fd7pKyMvHBt"]);

    // The LAST update in the file is the `session_info_update` that lands AFTER the response —
    // F25's whole point — and it is what the window is anchored on.
    const last = updates.at(-1);
    expect(last?.update["sessionUpdate"]).toBe("session_info_update");
    expect(verdict.deadlineAt).toBe((last?.at ?? 0) + CFG.toolMs);
  });

  it("codex 08's session_info_update arrives BEFORE the response, which is the same anchor argument", () => {
    // The codex corpus is a `.log` with a different framing, so it is read here rather than
    // through `loadTranscript` (which is the claude loader, §5.7).
    const here = dirname(fileURLToPath(import.meta.url));
    const log = readFileSync(
      join(
        here,
        "..",
        "..",
        "..",
        "..",
        "docs",
        "research",
        "transcripts",
        "codex-acp-1.8.0",
        "08-cancel-during-shell-tool.log",
      ),
      "utf8",
    );
    const lines = log.split("\n").filter((l) => l.trim() !== "");
    const infoAt = lines.findIndex((l) => l.includes('"threadStatus"'));
    const responseAt = lines.findIndex((l) => l.includes('"stopReason":"cancelled"'));
    expect(infoAt).toBeGreaterThan(-1);
    expect(responseAt).toBeGreaterThan(-1);
    expect(infoAt).toBeLessThan(responseAt);

    // And the tool call it opened is never terminalized.
    expect(log).toContain(
      '"sessionUpdate":"tool_call","toolCallId":"exec-cba0d467-b26e-49be-90fc-b48f7be06b0d","status":"in_progress"',
    );
    expect(log).not.toContain('"status":"completed"');
    expect(log).not.toContain('"status":"failed"');
  });
});
