import { beforeEach, describe, expect, it } from "vitest";
import {
  reduceTurn,
  turnStatus,
  type DaemonId,
  type EventEnvelope,
  type EventInput,
  type TurnId,
  type WorkerId,
} from "@omni-acp/protocol";

const D = `d_${"0".repeat(26)}` as DaemonId;
const W = `w_${"0".repeat(26)}` as WorkerId;
const T = `t_${"0".repeat(26)}` as TurnId;
const OTHER = `t_${"0".repeat(25)}2` as TurnId;

let seq = 0;
function env(body: EventInput, turnId: TurnId | null = T): EventEnvelope {
  seq += 1;
  return {
    ...body,
    seq,
    ts: `2026-09-03T12:00:00.${String(seq).padStart(3, "0")}Z`,
    daemonId: D,
    workerId: W,
    sessionId: "sess",
    turnId,
  } as EventEnvelope;
}

const running = (turnId: TurnId = T) =>
  env(
    {
      kind: "acp.session_update",
      payloadVersion: 2,
      payload: { sessionUpdate: "state_update", state: "running" },
    },
    turnId,
  );
const chunk = (text: string, turnId: TurnId = T) =>
  env(
    {
      kind: "acp.session_update",
      payloadVersion: 1,
      payload: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    },
    turnId,
  );
const idle = (stopReason: string | null, turnId: TurnId = T) =>
  env(
    {
      kind: "acp.session_update",
      payloadVersion: 2,
      payload: {
        sessionUpdate: "state_update",
        state: "idle",
        ...(stopReason === null ? {} : { stopReason }),
      },
    },
    turnId,
  );

beforeEach(() => {
  seq = 0;
});

describe("reduceTurn edge cases", () => {
  it("returns an empty aggregate for an empty log rather than throwing", () => {
    const r = reduceTurn(T, []);
    expect(r.text).toBe("");
    expect(r.toolCalls).toEqual([]);
    expect(r.error).toBeNull();
    expect(r.patch).toBeNull();
    expect("usage" in r).toBe(false);
    expect(turnStatus(T, []).state).toBe("unknown");
  });

  it("ignores a worker close that precedes the turn entirely", () => {
    const before = env(
      {
        kind: "omni.worker_state",
        payloadVersion: 2,
        payload: { state: "closed", previous: "ready", reason: "client_request" },
      },
      null,
    );
    // A different worker's log, replayed into the same client buffer, must not end this turn.
    const envelopes = [before, running(), chunk("still fine"), idle("end_turn")];
    const status = turnStatus(T, envelopes);
    expect(status.state).toBe("completed");
    expect(status.result?.text).toBe("still fine");
    expect(status.result?.error).toBeNull();
  });

  it("stops at the FIRST terminal envelope and ignores everything after it", () => {
    const envelopes = [
      running(),
      chunk("answer"),
      idle("end_turn"),
      chunk(" trailing chatter after idle"),
      env({
        kind: "omni.error",
        payloadVersion: 2,
        payload: { code: "internal", message: "later, unrelated" },
      }),
    ];
    const r = reduceTurn(T, envelopes);
    expect(r.text).toBe("answer");
    expect(r.error).toBeNull();
    expect(turnStatus(T, envelopes).endSeq).toBe(3);
  });

  it("synthesizes an honest error when a close ends the turn and no omni.error was logged", () => {
    const envelopes = [
      running(),
      chunk("half"),
      env(
        {
          kind: "omni.worker_state",
          payloadVersion: 2,
          payload: {
            state: "closed",
            previous: "running",
            reason: "agent_crashed",
            exit: { code: 139, signal: null },
            leaderExited: true,
            treeGone: true,
          },
        },
        null,
      ),
    ];
    const r = reduceTurn(T, envelopes);
    expect(r.stopReason).toBeNull();
    expect(r.error).toStrictEqual({
      code: "agent_error",
      message: "worker closed during turn (agent_crashed)",
    });
    expect(turnStatus(T, envelopes).state).toBe("failed");
  });

  it("maps a requested close to worker_closed and a timeout to agent_timeout", () => {
    for (const [reason, code] of [
      ["client_request", "worker_closed"],
      ["daemon_shutdown", "worker_closed"],
      ["cancel_timeout", "agent_timeout"],
      ["handshake_timeout", "agent_timeout"],
      ["protocol_error", "agent_error"],
    ] as const) {
      const envelopes = [
        running(),
        env(
          {
            kind: "omni.worker_state",
            payloadVersion: 2,
            payload: { state: "closed", previous: "running", reason },
          },
          null,
        ),
      ];
      expect(reduceTurn(T, envelopes).error?.code, reason).toBe(code);
    }
  });

  it("prefers the turn's own omni.error over the synthesized close error", () => {
    const envelopes = [
      running(),
      env({
        kind: "omni.error",
        payloadVersion: 2,
        payload: { code: "agent_error", message: "agent exited mid-turn", stderrTail: "boom\n" },
      }),
      env(
        {
          kind: "omni.worker_state",
          payloadVersion: 2,
          payload: { state: "closed", previous: "running", reason: "agent_crashed" },
        },
        null,
      ),
    ];
    // `stderrTail` stays on the envelope; TurnResult.error is exactly an OmniErrorBody (§9).
    expect(reduceTurn(T, envelopes).error).toStrictEqual({
      code: "agent_error",
      message: "agent exited mid-turn",
    });
  });

  it("keeps two concurrent turns' aggregates disjoint", () => {
    const envelopes = [
      running(T),
      running(OTHER),
      chunk("mine ", T),
      chunk("theirs ", OTHER),
      chunk("only", T),
      idle("end_turn", OTHER),
      idle("max_tokens", T),
    ];
    expect(reduceTurn(T, envelopes).text).toBe("mine only");
    expect(reduceTurn(OTHER, envelopes).text).toBe("theirs ");
    expect(turnStatus(T, envelopes).stopReason).toBe("max_tokens");
    expect(turnStatus(OTHER, envelopes).stopReason).toBe("end_turn");
  });

  it("treats a turn with no terminal envelope as running, with the partial aggregate", () => {
    const envelopes = [running(), chunk("so far")];
    const status = turnStatus(T, envelopes);
    expect(status.state).toBe("running");
    expect(status.endSeq).toBeNull();
    expect(status.result?.text).toBe("so far");
    expect(status.result?.stopReason).toBeNull();
  });

  it("ignores an idle whose stopReason is absent, keeping it null rather than inventing one", () => {
    const envelopes = [running(), idle(null)];
    expect(reduceTurn(T, envelopes).stopReason).toBeNull();
    expect(turnStatus(T, envelopes).state).toBe("completed");
  });

  it("survives payload shapes it has never seen", () => {
    const envelopes = [
      running(),
      env({
        kind: "acp.session_update",
        payloadVersion: 1,
        payload: { sessionUpdate: "plan", entries: [] },
      }),
      env({
        kind: "acp.session_update",
        payloadVersion: 2,
        payload: { sessionUpdate: "_vendor_thing", anything: { deeply: [1, 2] } },
      }),
      env({
        kind: "acp.session_update",
        payloadVersion: 1,
        payload: { sessionUpdate: "agent_message_chunk", content: { type: "image", data: "…" } },
      }),
      env({
        kind: "acp.session_update",
        payloadVersion: 1,
        payload: { sessionUpdate: "tool_call_update", locations: [{ path: 42 }] },
      }),
      env({
        kind: "acp.session_update",
        payloadVersion: 1,
        payload: { sessionUpdate: "usage_update", used: "lots" },
      }),
      idle("end_turn"),
    ];
    const r = reduceTurn(T, envelopes);
    expect(r.text).toBe("");
    expect(r.toolCalls).toEqual([]);
    expect("usage" in r).toBe(false);
    expect(r.stopReason).toBe("end_turn");
  });

  it("keeps a tool call's locations and drops the ones without a path", () => {
    const envelopes = [
      running(),
      env({
        kind: "acp.session_update",
        payloadVersion: 1,
        payload: {
          sessionUpdate: "tool_call",
          toolCallId: "call_1",
          title: "Reading",
          locations: [{ path: "/a", line: 12 }, { path: "/b" }, { line: 3 }, "nope"],
        },
      }),
      idle("end_turn"),
    ];
    expect(reduceTurn(T, envelopes).toolCalls[0]?.locations).toStrictEqual([
      { path: "/a", line: 12 },
      { path: "/b" },
    ]);
  });

  it("records rawInput/rawOutput only once the agent has sent them", () => {
    const first = [
      running(),
      env({
        kind: "acp.session_update",
        payloadVersion: 1,
        payload: { sessionUpdate: "tool_call", toolCallId: "c" },
      }),
      idle("end_turn"),
    ];
    expect("rawInput" in (reduceTurn(T, first).toolCalls[0] ?? {})).toBe(false);

    const second = [
      running(),
      env({
        kind: "acp.session_update",
        payloadVersion: 1,
        payload: { sessionUpdate: "tool_call", toolCallId: "c", rawInput: null },
      }),
      idle("end_turn"),
    ];
    const view = reduceTurn(T, second).toolCalls[0];
    expect("rawInput" in (view ?? {})).toBe(true);
    expect(view?.rawInput).toBeNull();
  });
});
