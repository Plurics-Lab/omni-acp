import { describe, expect, it } from "vitest";
import { createMemoryEventLog, createNormalizer } from "@omni-acp/core";
import { fakeClock, seqIds } from "@omni-acp/testkit";
import {
  turnStatus,
  type EventEnvelope,
  type EventLog,
  type Normalizer,
  type Seq,
  type TurnId,
  type TurnInput,
  type TurnOutput,
} from "@omni-acp/protocol";

const T0 = Date.UTC(2026, 0, 1);
const TURN = `t_${"0".repeat(25)}1` as TurnId;

/**
 * The Worker's ENTIRE coupling to WP-3, copied from CONTRACTS.md §7.6:
 *
 *   const out = this.norm.step(input);
 *   this.log.appendAll(out.emit);      // seq assigned here, synchronously, in array order
 *   this.rescheduleTick(out.scheduleTickAt);
 *
 * The tick is delivered by hand here, which is the point: the reducer never owns a timer, so a
 * turn's whole lifecycle is expressible as arithmetic in a synchronous test.
 */
function harness(o: { quietMs?: number; hardMs?: number } = {}): {
  log: EventLog;
  norm: Normalizer;
  drive: (input: TurnInput) => TurnOutput;
  seqOf: (predicate: (e: EventEnvelope) => boolean) => Seq | null;
} {
  const ids = seqIds();
  const log = createMemoryEventLog({
    workerId: ids.worker(),
    daemonId: ids.daemon(),
    clock: fakeClock(),
    maxEvents: 1_000,
    subscriberQueueSize: 64,
  });
  const norm = createNormalizer({ quietMs: o.quietMs ?? 250, hardMs: o.hardMs ?? 5_000 });
  return {
    log,
    norm,
    drive(input: TurnInput): TurnOutput {
      const out = norm.step(input);
      log.appendAll(out.emit);
      return out;
    },
    seqOf(predicate): Seq | null {
      return log.read(0).find(predicate)?.seq ?? null;
    },
  };
}

const isState = (state: string) => (e: EventEnvelope) =>
  e.kind === "acp.session_update" &&
  (e.payload as { sessionUpdate?: string; state?: string }).sessionUpdate === "state_update" &&
  (e.payload as { state?: string }).state === state;

const textChunk = (text: string): TurnInput => ({
  type: "agent_update",
  at: T0,
  update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
});

describe("normalizer + event log: the seq ordering the whole design rests on", () => {
  it("puts state_update{running} below every update of the turn, and idle above them all", () => {
    const h = harness();
    h.drive({ type: "prompt_sent", turnId: TURN, at: T0 });
    const accepted = h.log.head; // == PromptAccepted.seq

    h.drive({ ...textChunk("Hello"), at: T0 + 10 });
    h.drive({ ...textChunk(", world"), at: T0 + 20 });
    h.drive({ type: "prompt_result", stopReason: "end_turn", at: T0 + 30 });
    // chatty.mjs: one more chunk 400 ms AFTER the response.
    h.drive({ ...textChunk("!"), at: T0 + 430 });
    h.drive({ type: "tick", at: T0 + 680 });

    const running = h.seqOf(isState("running"));
    const idle = h.seqOf(isState("idle"));
    expect(running).toBe(1);
    expect(running).toBe(accepted);
    expect(idle).toBe(h.log.head);

    // The agent's own updates, selected by KIND rather than by `payloadVersion`. M1-R10 flips
    // `payloadVersion` to 2 for every kind the map lands on a v2 arm — which `agent_message_chunk`
    // now is, with `messageId` synthesized (§12.4) — so the M0 proxy "payloadVersion === 1 means
    // the agent sent it" is exactly what the flip retires. This asks the question the assertion
    // was always about: every update that is not one of OUR two synthesized state changes.
    const updates = h.log
      .read(0)
      .filter(
        (e) =>
          e.kind === "acp.session_update" &&
          (e.payload as { sessionUpdate?: string }).sessionUpdate !== "state_update",
      )
      .map((e) => e.seq);
    expect(updates).toHaveLength(3);
    for (const seq of updates) {
      expect(seq).toBeGreaterThan(running ?? 0);
      expect(seq).toBeLessThan(idle ?? 0);
    }
  });

  it("makes `PromptAccepted.seq - 1` a cursor that sees the entire turn", () => {
    const h = harness();
    h.drive({ type: "prompt_sent", turnId: TURN, at: T0 });
    const accepted = h.log.head;

    const seen: Seq[] = [];
    const sub = h.log.subscribe(accepted - 1, (e) => seen.push(e.seq));
    h.drive({ ...textChunk("hi"), at: T0 + 1 });
    h.drive({ type: "prompt_result", stopReason: "end_turn", at: T0 + 2 });
    h.drive({ type: "tick", at: T0 + 252 });

    expect(seen[0]).toBe(accepted);
    expect(seen).toEqual([1, 2, 3]);
    sub.close();
    h.log.close();
  });

  it("folds into a completed TurnStatus that agrees with the stream", () => {
    const h = harness();
    h.drive({ type: "prompt_sent", turnId: TURN, at: T0 });
    h.drive({ ...textChunk("I'll skip the configuration update."), at: T0 + 1 });
    h.drive({ type: "prompt_result", stopReason: "end_turn", at: T0 + 2 });
    h.drive({ type: "tick", at: T0 + 252 });

    const status = turnStatus(TURN, h.log.read(0));
    expect(status.state).toBe("completed");
    expect(status.stopReason).toBe("end_turn");
    expect(status.startSeq).toBe(1);
    expect(status.endSeq).toBe(h.log.head);
    expect(status.result?.text).toBe("I'll skip the configuration update.");
    expect(status.result?.error).toBeNull();
  });
});

describe("normalizer + event log: a turn that ends badly", () => {
  it("reports a crashed agent as failed with a NULL stopReason, never a fabricated one", () => {
    const h = harness();
    h.drive({ type: "prompt_sent", turnId: TURN, at: T0 });
    h.drive({ ...textChunk("partial"), at: T0 + 1 });
    h.drive({
      type: "process_gone",
      error: { code: "agent_error", message: "agent exited (code 3)" },
      stderrTail: "Segmentation fault",
      at: T0 + 2,
    });
    // What the Worker appends next, and the ONLY thing that makes the turn terminal (§7.3).
    h.log.append({
      kind: "omni.worker_state",
      payloadVersion: 2,
      turnId: null,
      payload: {
        state: "closed",
        previous: "running",
        reason: "agent_crashed",
        exit: { code: 3, signal: null },
        leaderExited: true,
        treeGone: true,
      },
    });

    expect(h.log.read(0).some((e) => isState("idle")(e))).toBe(false);

    const status = turnStatus(TURN, h.log.read(0));
    expect(status.state).toBe("failed");
    expect(status.stopReason).toBeNull();
    expect(status.result?.error).toEqual({
      code: "agent_error",
      message: "agent exited (code 3)",
    });
    expect(status.result?.text).toBe("partial");
  });

  it("reports a JSON-RPC prompt error as failed, terminal, and still idle-ended", () => {
    const h = harness();
    h.drive({ type: "prompt_sent", turnId: TURN, at: T0 });
    h.drive({
      type: "prompt_error",
      error: {
        code: "agent_error",
        message: "context length exceeded",
        acp: { code: -32000, message: "context length exceeded", data: { tokens: 200_000 } },
      },
      at: T0 + 1,
    });

    const status = turnStatus(TURN, h.log.read(0));
    expect(status.state).toBe("failed");
    expect(status.stopReason).toBeNull();
    expect(status.endSeq).toBe(h.log.head);
    expect(status.result?.error?.acp).toEqual({
      code: -32000,
      message: "context length exceeded",
      data: { tokens: 200_000 },
    });
  });

  it("keeps a turn `running` for as long as the agent is alive and silent", () => {
    const h = harness();
    h.drive({ type: "prompt_sent", turnId: TURN, at: T0 });
    h.drive({ type: "prompt_result", stopReason: "end_turn", at: T0 + 1 });
    // The quiet window has not expired: the turn is NOT terminal yet.
    expect(turnStatus(TURN, h.log.read(0)).state).toBe("running");
    h.drive({ type: "tick", at: T0 + 251 });
    expect(turnStatus(TURN, h.log.read(0)).state).toBe("completed");
  });
});
