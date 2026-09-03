import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  reduceTurn,
  turnStatus,
  type EventEnvelope,
  type TurnId,
  type TurnResult,
  type TurnState,
} from "@omni-acp/protocol";

/**
 * The golden corpus. Each case is a RECORDED transcript (`*.envelopes.json`) plus a
 * hand-written expectation (`*.expected.json`): the expectations were written from
 * CONTRACTS.md, not captured from the implementation, which is the only thing that makes a
 * golden test worth having.
 *
 * `reduceTurn` is the one aggregator the daemon (H11) and the client SDK (`prompt()`) share,
 * so every row here is simultaneously an assertion about both (DESIGN §5.5, D7).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, "transcripts");

interface Expected {
  readonly turnId: TurnId;
  readonly result: TurnResult;
  readonly status: {
    readonly state: TurnState;
    readonly startSeq: number | null;
    readonly endSeq: number | null;
    readonly stopReason: string | null;
  };
}

const names = readdirSync(DIR)
  .filter((f) => f.endsWith(".envelopes.json"))
  .map((f) => f.slice(0, -".envelopes.json".length))
  .sort();

const load = (name: string): { envelopes: EventEnvelope[]; expected: Expected } => ({
  envelopes: JSON.parse(
    readFileSync(join(DIR, `${name}.envelopes.json`), "utf8"),
  ) as EventEnvelope[],
  expected: JSON.parse(readFileSync(join(DIR, `${name}.expected.json`), "utf8")) as Expected,
});

describe("reduceTurn golden transcripts", () => {
  it("has a corpus big enough to be worth the name", () => {
    expect(names.length).toBeGreaterThanOrEqual(8);
  });

  for (const name of names) {
    describe(name, () => {
      const { envelopes, expected } = load(name);

      it("reduces to the recorded TurnResult", () => {
        expect(reduceTurn(expected.turnId, envelopes)).toStrictEqual(expected.result);
      });

      it("reports the recorded TurnStatus, whose result is the same aggregate", () => {
        const status = turnStatus(expected.turnId, envelopes);
        expect({
          state: status.state,
          startSeq: status.startSeq,
          endSeq: status.endSeq,
          stopReason: status.stopReason,
        }).toStrictEqual(expected.status);
        // D7: one implementation, so polling and streaming cannot disagree.
        expect(status.result).toStrictEqual(
          expected.status.state === "unknown" ? null : expected.result,
        );
        expect(status.turnId).toBe(expected.turnId);
      });

      it("is pure: same envelopes twice, deep-equal results, inputs untouched", () => {
        const before = structuredClone(envelopes);
        const first = reduceTurn(expected.turnId, envelopes);
        const second = reduceTurn(expected.turnId, envelopes);
        expect(second).toStrictEqual(first);
        expect(envelopes).toStrictEqual(before);
      });

      it("folds in seq order however the array is ordered", () => {
        const reversed = [...envelopes].reverse();
        expect(reduceTurn(expected.turnId, reversed)).toStrictEqual(expected.result);
        expect(turnStatus(expected.turnId, reversed).state).toBe(expected.status.state);
      });

      it("never reads `messageId` (F3): adding one to every chunk changes nothing", () => {
        const withIds = structuredClone(envelopes).map((e) => {
          if (e.kind !== "acp.session_update") return e;
          const p = e.payload as unknown as Record<string, unknown>;
          if (
            typeof p["sessionUpdate"] !== "string" ||
            !`${p["sessionUpdate"]}`.endsWith("_chunk")
          ) {
            return e;
          }
          return { ...e, payload: { ...p, messageId: "msg-1" } } as EventEnvelope;
        });
        expect(reduceTurn(expected.turnId, withIds)).toStrictEqual(expected.result);
      });
    });
  }
});

describe("the corpus covers every acceptance clause", () => {
  it("names the transcript for each one", () => {
    // If a case is renamed or dropped, this fails loudly instead of silently thinning cover.
    expect(names).toEqual([
      "cancelled",
      "crash-mid-turn",
      "diff-changes",
      "happy-turn",
      "interleaved-turns",
      "no-message-id",
      "permission-deny",
      "prompt-error",
      "running-partial",
      "tool-call-upsert",
      "unknown-turn",
      "usage-last-wins",
    ]);
  });

  it("text is concatenated in seq order and excludes thoughts", () => {
    const { envelopes, expected } = load("no-message-id");
    expect(reduceTurn(expected.turnId, envelopes).text).toBe("one two three");
  });

  it("a tool call is upserted by toolCallId, keeping the LAST status", () => {
    const { envelopes, expected } = load("tool-call-upsert");
    const calls = reduceTurn(expected.turnId, envelopes).toolCalls;
    expect(calls.map((c) => c.toolCallId)).toEqual(["call_a", "call_b"]);
    expect(calls[0]?.status).toBe("completed");
    expect(calls[0]?.title).toBe("First, renamed");
  });

  it('`changes` come from ToolCallContent{type:"diff"} with `oldText ?? null` (F5)', () => {
    const { envelopes, expected } = load("diff-changes");
    expect(reduceTurn(expected.turnId, envelopes).changes).toStrictEqual([
      { path: "/repo/a.ts", oldText: "old2", newText: "new2" },
      { path: "/repo/b.ts", oldText: null, newText: "created" },
    ]);
  });

  it("`usage` is the LAST usage_update and never idle.usage (F4)", () => {
    const { envelopes, expected } = load("usage-last-wins");
    const result = reduceTurn(expected.turnId, envelopes);
    expect(result.usage).toStrictEqual({
      used: 42,
      size: 200,
      cost: { amount: 0.12, currency: "USD" },
    });
    const idle = envelopes.at(-1);
    expect((idle?.payload as Record<string, unknown>)["usage"]).toBeDefined(); // it IS there
  });

  it("`interactions` come from omni.policy_decision alone, with `at` from the envelope ts", () => {
    const { envelopes, expected } = load("permission-deny");
    const result = reduceTurn(expected.turnId, envelopes);
    const decision = envelopes.find((e) => e.kind === "omni.policy_decision");
    expect(result.interactions).toHaveLength(1);
    expect(result.interactions[0]?.at).toBe(decision?.ts);
    expect(result.interactions[0]?.rule).toBe("m0:auto-deny");
    // Two acp.interaction envelopes are present and contribute nothing (review R9).
    expect(envelopes.filter((e) => e.kind === "acp.interaction")).toHaveLength(2);
  });

  it("`patch` is null in every case (D8)", () => {
    for (const name of names) {
      const { envelopes, expected } = load(name);
      expect(reduceTurn(expected.turnId, envelopes).patch).toBeNull();
    }
  });

  it("a turn ended by worker_state{closed} has stopReason null and a non-null error", () => {
    const { envelopes, expected } = load("crash-mid-turn");
    const result = reduceTurn(expected.turnId, envelopes);
    expect(result.stopReason).toBeNull();
    expect(result.error).not.toBeNull();
    expect(turnStatus(expected.turnId, envelopes).state).toBe("failed");
    // §7.3: no fabricated idle exists to be found.
    const idle = envelopes.some(
      (e) =>
        e.kind === "acp.session_update" &&
        (e.payload as unknown as Record<string, unknown>)["state"] === "idle",
    );
    expect(idle).toBe(false);
  });

  it("a turn id never seen is `unknown` with a null result", () => {
    const { envelopes, expected } = load("unknown-turn");
    const status = turnStatus(expected.turnId, envelopes);
    expect(status.state).toBe("unknown");
    expect(status.result).toBeNull();
    expect(status.startSeq).toBeNull();
    expect(status.endSeq).toBeNull();
  });
});
