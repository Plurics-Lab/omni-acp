import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { reduceTurn, turnStatus, type EventEnvelope } from "@omni-acp/protocol";
import { emitScenario, GOLDEN_TURN, goldenNames } from "./support/emit.js";

/**
 * CONTRACTS.md §12.7(c) — the GENERATED envelope goldens, and §12.7(b)(8): "`reduceTurn` over the
 * mapped stream reproduces, per scenario, the outcome the corpus README records".
 *
 * Two halves, and the split is the whole design of this tier:
 *
 *   the `.envelopes.json` are GENERATED, by the checked-in generator in `support/emit.ts`, and
 *   re-generated on every run and compared byte for byte — that is `corpus:emit --check`, run by
 *   the ordinary test command rather than by a script in a frozen manifest;
 *
 *   the `.expected.json` are HAND-WRITTEN, from the recorded wire and the research README.
 *   Generating them would make the tier tautological: a wrong map would produce a wrong
 *   expectation and the test would agree with it.
 *
 * Re-generating on purpose: `OMNI_CORPUS_EMIT=1 pnpm test`. That writes the envelope files and
 * leaves the expectations alone, which is the only direction this may ever run in.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, "golden");
const EMIT = process.env["OMNI_CORPUS_EMIT"] === "1";

/**
 * The hand-written expectation. It is deliberately NOT a whole `TurnResult` dump: what §12.7(b)(8)
 * asks to be reproduced is the OUTCOME — the stop reason, the tool calls and their final statuses,
 * the changes — and those are the facts a person can write down from the transcript and check.
 */
interface Expected {
  readonly scenario: string;
  readonly note: string;
  readonly stopReason: string | null;
  readonly verdict: "ok" | "partial" | "failed";
  readonly state: "running" | "completed" | "failed" | "unknown";
  /** `sessionUpdate` -> count, over the MAPPED stream. The v1 kinds must all be gone. */
  readonly kinds: Readonly<Record<string, number>>;
  /** Tool call ids in stream order, with the status each one ENDED on. */
  readonly toolCalls: readonly {
    readonly id: string;
    readonly kind: string | null;
    readonly status: string | null;
  }[];
  readonly changes: readonly {
    readonly path: string;
    readonly operation: string;
    readonly oldText: string | null;
    readonly newText: string;
    readonly fragment: boolean;
  }[];
  readonly failedToolCalls: readonly string[];
  readonly deniedToolCalls: readonly string[];
  /** Substrings the agent's answer must contain, from the transcript. */
  readonly textIncludes: readonly string[];
  readonly replayEnvelopes: number;
  readonly vendorPatchIncludes: readonly string[];
}

/** The one canonical form both sides of the `--check` are compared in. */
const canonical = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

function generated(name: string): EventEnvelope[] {
  const file = join(DIR, `${name}.envelopes.json`);
  const envelopes = emitScenario(name);
  if (EMIT) {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(file, canonical(envelopes));
  }
  expect(existsSync(file) ? "present" : `MISSING ${file}`).toBe("present");

  // `--check`: the checked-in file must be identical to what the generator produces now.
  //
  // Compared through ONE canonical serialization rather than byte for byte, because the
  // repository's formatter owns the checked-in file's whitespace — prettier collapses a short
  // array onto one line and `JSON.stringify` does not, and a check that failed on that would
  // fail on every `pnpm format` instead of on a map change. Every byte that carries MEANING is
  // still compared: a changed key, value, order or count shows up here as a reviewable diff
  // rather than as a silently-updated fixture.
  expect(canonical(JSON.parse(readFileSync(file, "utf8")))).toBe(canonical(envelopes));
  return envelopes;
}

function expectation(name: string): Expected {
  return JSON.parse(readFileSync(join(DIR, `${name}.expected.json`), "utf8")) as Expected;
}

const kindsOf = (envelopes: readonly EventEnvelope[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const e of envelopes) {
    if (e.kind !== "acp.session_update") continue;
    const p = e.payload as unknown as { sessionUpdate: string; state?: string };
    const key =
      p.sessionUpdate === "state_update" ? `state_update:${String(p.state)}` : p.sessionUpdate;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
};

describe("corpus envelope goldens (§12.7(c))", () => {
  it("generates one file per named scenario, and the set is fixed", () => {
    expect(goldenNames()).toEqual([
      "01-plain-answer",
      "02-tool-read",
      "03-tool-write-allowed",
      "04-tool-write-denied",
      "06-cancel-mid-turn",
      "07-session-load",
      "09-permission-bad-option-id",
      "10-tool-edit-existing",
    ]);
  });

  for (const name of goldenNames()) {
    describe(name, () => {
      it("`--check`: the checked-in envelopes are byte-identical to a fresh generation", () => {
        expect(generated(name).length).toBeGreaterThan(0);
      });

      it("is DETERMINISTIC: two generations of the same scenario are identical", () => {
        expect(JSON.stringify(emitScenario(name))).toBe(JSON.stringify(emitScenario(name)));
      });

      it("reproduces the hand-written outcome (§12.7(b)(8))", () => {
        const envelopes = generated(name);
        const expected = expectation(name);
        const result = reduceTurn(GOLDEN_TURN, envelopes);

        expect(kindsOf(envelopes)).toEqual(expected.kinds);
        expect(result.stopReason).toBe(expected.stopReason);
        expect(result.verdict).toBe(expected.verdict);
        expect(turnStatus(GOLDEN_TURN, envelopes).state).toBe(expected.state);
        expect(
          result.toolCalls.map((c) => ({ id: c.toolCallId, kind: c.kind, status: c.status })),
        ).toEqual(expected.toolCalls);
        expect(result.changes).toEqual(expected.changes);
        expect(result.failedToolCalls).toEqual(expected.failedToolCalls);
        expect(result.deniedToolCalls).toEqual(expected.deniedToolCalls);
        for (const fragment of expected.textIncludes) expect(result.text).toContain(fragment);
        expect(envelopes.filter((e) => e.replay === true)).toHaveLength(expected.replayEnvelopes);
        for (const fragment of expected.vendorPatchIncludes) {
          expect(result.vendorPatch?.text ?? "").toContain(fragment);
        }
        if (expected.vendorPatchIncludes.length === 0) expect(result.vendorPatch).toBeNull();
        // D8 / ruling M1-R11, in every case without exception.
        expect(result.patch).toBeNull();
      });

      it("no v1-only kind survives, and every mapped update is payloadVersion 2", () => {
        const envelopes = generated(name);
        const kinds = Object.keys(kindsOf(envelopes));
        expect(kinds).not.toContain("tool_call");
        expect(kinds).not.toContain("plan");
        expect(kinds).not.toContain("current_mode_update");
        const v1 = envelopes.filter(
          (e) => e.kind === "acp.session_update" && e.payloadVersion !== 2,
        );
        expect(v1).toEqual([]);
      });
    });
  }
});

// ── §12.8's named cases ──────────────────────────────────────────────────────

describe("§12.8 `01-plain`", () => {
  const envelopes = generated("01-plain-answer");

  it("orders state_update{running} < every agent update < idle", () => {
    const running = envelopes.find(
      (e) =>
        e.kind === "acp.session_update" &&
        (e.payload as unknown as { state?: string }).state === "running",
    );
    const idle = envelopes.find(
      (e) =>
        e.kind === "acp.session_update" &&
        (e.payload as unknown as { state?: string }).state === "idle",
    );
    expect(running?.seq).toBe(1);
    expect(idle?.seq).toBe(envelopes.length);
    for (const e of envelopes.slice(1, -1)) {
      expect(e.seq).toBeGreaterThan(running?.seq ?? 0);
      expect(e.seq).toBeLessThan(idle?.seq ?? 0);
    }
  });

  it("`idle.usage` carries the prompt-response `Usage` (F21)", () => {
    const idle = envelopes.at(-1)?.payload as unknown as { usage?: unknown };
    expect(idle.usage).toEqual({
      inputTokens: 2,
      outputTokens: 5,
      cachedReadTokens: 10_038,
      cachedWriteTokens: 7_006,
      totalTokens: 17_051,
    });
    expect(reduceTurn(GOLDEN_TURN, envelopes).tokens).toEqual({
      inputTokens: 2,
      outputTokens: 5,
      cachedReadTokens: 10_038,
      cachedWriteTokens: 7_006,
      totalTokens: 17_051,
    });
  });
});

describe("§12.8 `02-read`", () => {
  const envelopes = generated("02-tool-read");

  it("`tool_call` became `tool_call_update` on the stream", () => {
    const first = envelopes.find(
      (e) =>
        e.kind === "acp.session_update" &&
        (e.payload as unknown as { toolCallId?: string }).toolCallId !== undefined,
    );
    expect((first?.payload as unknown as { sessionUpdate: string }).sessionUpdate).toBe(
      "tool_call_update",
    );
  });

  it('`reduceTurn` merges 1+3 updates into ONE call with `kind:"read"` PRESERVED', () => {
    // Corpus finding 3: the later updates each carry an arbitrary SUBSET of keys, and some carry
    // only `{toolCallId, sessionUpdate, _meta}`. An omitted field means UNCHANGED; treating it
    // as cleared loses `kind` before the call completes.
    const updates = envelopes.filter(
      (e) =>
        e.kind === "acp.session_update" &&
        (e.payload as unknown as { toolCallId?: string }).toolCallId !== undefined,
    );
    expect(updates).toHaveLength(4);
    expect(
      updates.filter((e) => (e.payload as unknown as { kind?: string }).kind === undefined).length,
    ).toBeGreaterThan(0);

    const calls = reduceTurn(GOLDEN_TURN, envelopes).toolCalls;
    expect(calls).toHaveLength(1);
    expect(calls[0]?.kind).toBe("read");
    expect(calls[0]?.status).toBe("completed");
  });
});

describe("§12.8 `03-write-allowed`", () => {
  const envelopes = generated("03-tool-write-allowed");
  const result = reduceTurn(GOLDEN_TURN, envelopes);

  it("the permission was mapped to `{title, subject:{type:'tool_call'}}` before the responder saw it", () => {
    const interaction = envelopes.find((e) => e.kind === "omni.policy_decision");
    expect(interaction).toBeDefined();
    // The mapped `title` is what the policy record carries, and it came from
    // `_meta.permission.title` (§12.6's first precedence rung).
    expect(result.interactions[0]?.title).toBe("Write hello.txt");
    expect(result.interactions[0]?.decision).toBe("allow");
    expect(result.interactions[0]?.optionId).toBe("allow-once");
  });

  it('`changes[0].operation === "add"`', () => {
    expect(result.changes[0]?.operation).toBe("add");
    expect(result.changes[0]?.path).toBe("/tmp/acp-ws-wa-VxS6ru/hello.txt");
  });

  it("`vendorPatch` is a valid git CREATION patch, and `patch` is null", () => {
    expect(result.vendorPatch?.format).toBe("git_patch");
    expect(result.vendorPatch?.text).toContain("new file mode 100644");
    expect(result.vendorPatch?.text).toContain("--- /dev/null");
    expect(result.patch).toBeNull();
  });
});

describe("§12.8 `04-write-denied`", () => {
  const envelopes = generated("04-tool-write-denied");
  const result = reduceTurn(GOLDEN_TURN, envelopes);

  it("ends `end_turn` AND reports `verdict: partial` — corpus finding 7", () => {
    // "Deny is invisible in `stopReason`". The turn ended exactly as a successful one would.
    expect(result.stopReason).toBe("end_turn");
    expect(result.verdict).toBe("partial");
  });

  it("`deniedToolCalls` is non-empty, from OUR policy decision and not from the agent's prose", () => {
    expect(result.deniedToolCalls).toEqual(["toolu_01LGdKmGmcWVh9Mvy7x2rvpa"]);
    // The agent's own English is in `rawOutput` and was never read.
    expect(JSON.stringify(result.toolCalls)).toContain("User refused permission");
    // Three warnings, three DIFFERENT sources, none of them prose: our own policy decision, the
    // schema'd status enum, and the descriptor's rate-limit pointer — the recorded run really
    // was at utilization 0.78, status `allowed_warning`, which is advisory (§13.4).
    expect(result.warnings.map((w) => `${w.code}/${w.source}`).sort()).toEqual([
      "rate_limit/usage_meta",
      "tool_denied/policy",
      "tool_failed/tool_status",
    ]);
    expect(result.warnings.find((w) => w.code === "rate_limit")?.message).toBe(
      "rate-limit status allowed_warning",
    );
  });

  it("`changes` is EMPTY: the denied call's final update replaced its content with the failure", () => {
    // A happy consequence §12.5 asks for an assertion on: the diff is gone by the end of the
    // turn, and the fold reads the FINAL content, so nothing claims a file was written.
    expect(result.changes).toEqual([]);
  });
});

describe("§12.8 `06-cancel`", () => {
  const envelopes = generated("06-cancel-mid-turn");

  it("the `usage_update` that arrived after `session/cancel` has a LOWER seq than `idle`", () => {
    // Corpus finding 14, and the reason rungs 1 and 4 are ordered as they are: that update
    // arrived 53 ms after our cancel and ~4 ms before the prompt response. A normalizer that
    // emitted `idle` at the response boundary would order it after an event of this turn.
    const usage = envelopes.filter(
      (e) =>
        e.kind === "acp.session_update" &&
        (e.payload as unknown as { sessionUpdate: string }).sessionUpdate === "usage_update",
    );
    const idle = envelopes.find(
      (e) =>
        e.kind === "acp.session_update" &&
        (e.payload as unknown as { state?: string }).state === "idle",
    );
    expect(usage.length).toBeGreaterThan(0);
    expect(usage.at(-1)?.seq).toBeLessThan(idle?.seq ?? 0);
    expect(reduceTurn(GOLDEN_TURN, envelopes).stopReason).toBe("cancelled");
  });
});

describe("§12.8 `07-load-replay`", () => {
  const envelopes = generated("07-session-load");

  it("EXACTLY the two updates between the request and the response carry `replay: true`", () => {
    const replayed = envelopes.filter((e) => e.replay === true);
    expect(replayed).toHaveLength(2);
    expect(
      replayed.map((e) => (e.payload as unknown as { sessionUpdate: string }).sessionUpdate),
    ).toEqual(["user_message_chunk", "agent_message_chunk"]);
  });

  it("the `available_commands_update` 2 ms after the response does NOT", () => {
    const first = envelopes.find(
      (e) =>
        e.kind === "acp.session_update" &&
        (e.payload as unknown as { sessionUpdate: string }).sessionUpdate ===
          "available_commands_update",
    );
    expect(first?.replay).toBeUndefined();
  });

  it("`reduceTurn` SKIPS replay envelopes: the replayed history is not this turn's text", () => {
    // Ruling M1-R5: marked, stored, streamed — and not folded. The replayed user message asked
    // for PONG in a PREVIOUS turn, and this turn's answer is about that question.
    const result = reduceTurn(GOLDEN_TURN, envelopes);
    expect(result.text).not.toContain("Reply with exactly the word PONG");
    expect(result.text).toContain("You asked me to reply");
    // …and every consumer can still see them, because they are in the log.
    expect(envelopes.some((e) => e.replay === true)).toBe(true);
  });
});

describe("§12.8 `09-bad-option-id`", () => {
  const envelopes = generated("09-permission-bad-option-id");
  const result = reduceTurn(GOLDEN_TURN, envelopes);

  it('reproduces the recorded `status: "failed"` on every tool call, with `end_turn`', () => {
    // The recorded cost of violating D4 rule 1. Our responder never produces an unoffered id
    // (`permission.test.ts` asserts that structurally); this is the OTHER half — what the agent
    // does when someone's does, and why `stopReason` cannot be the detector.
    expect(result.stopReason).toBe("end_turn");
    expect(result.toolCalls.map((c) => c.status)).toEqual(["failed", "failed"]);
    expect(result.verdict).toBe("partial");
  });
});

describe("§12.8 `10-edit`", () => {
  const envelopes = generated("10-tool-edit-existing");
  const result = reduceTurn(GOLDEN_TURN, envelopes);

  it("`content` WIDENING does not double-count: exactly one FileChange, `fragment: true`", () => {
    // F19: the pair widens between updates (`"mode = slow"` → then `"mode = slow\\nretries = 3"`).
    // `ToolCallUpdate.content` REPLACES the collection, so the fold reads the final content and
    // sees the widened pair once — and `fragment` says a consumer must not write it to the file.
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toEqual({
      path: "/tmp/acp-ws-edit-96xAuv/config.txt",
      operation: "modify",
      oldText: "mode = slow\nretries = 3",
      newText: "mode = fast\nretries = 3",
      fragment: true,
    });
  });

  it("`vendorPatch` applies, and it is the only place a patch appears", () => {
    expect(result.vendorPatch?.text).toContain("@@ -1,2 +1,2 @@");
    expect(result.patch).toBeNull();
  });
});
