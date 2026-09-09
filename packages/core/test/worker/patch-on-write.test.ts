import { describe, expect, it } from "vitest";
import type { TurnId } from "@omni-acp/protocol";
import { fakeDiffProvider, scriptedAgent, type FakeDiffProvider } from "@omni-acp/testkit";
import { createNormalizer } from "../../src/normalizer/normalizer.js";
import { flush, harness, OWNER, TEXT } from "./support/harness.js";

/**
 * §25.4's `on_write`, from the WORKER's side (review finding V12).
 *
 * `diff.mode:"on_write"` is the documented DEFAULT and behaved identically to `"always"`:
 * `cfg.mode` was read in exactly one place — `begin`'s `=== "off"` — so every turn on a git
 * worker paid two `git add -A` + `write-tree` pairs whether or not it wrote anything, and
 * §11.9's stated mitigation for that cost saved nothing. The provider decides what to do with
 * the observation; this file is about the observation itself.
 *
 * It is folded off the NORMALIZED envelopes, so it reads the same v2 `kind` and
 * `content[].type` the reducer does and needs no per-agent branch — and it is deliberately
 * GENEROUS, because F38 records claude-acp under-reporting a two-file read as one `kind:"read"`
 * call: a false positive costs one `git write-tree`, a false negative would cost a patch.
 *
 * Owned by M2-B (review round 2).
 */

async function turnWith(
  emit: (agent: ReturnType<typeof scriptedAgent>) => Promise<void>,
): Promise<{ diff: FakeDiffProvider; turnId: TurnId }> {
  const h = harness();
  const diff = fakeDiffProvider({ text: "diff --git a/a b/a\n", quality: "exact" });
  const agent = scriptedAgent();
  h.supervisor.enqueue(agent);
  const worker = await h.create({
    overrides: {
      diff,
      normalizer: createNormalizer({ quietMs: 250, hardMs: 5_000, cwd: "/tmp/omni-acp-test" }),
    },
  });
  const accepted = await worker.prompt([TEXT("go")], OWNER);
  await flush();
  await emit(agent);
  agent.resolvePrompt("end_turn");
  await flush(20);
  h.clock.advance(300);
  await flush(20);
  return { diff, turnId: accepted.turnId };
}

describe("the worker reports whether the turn WROTE (§25.4, review finding V12)", () => {
  it("false for a turn with no tool call at all", async () => {
    const { diff } = await turnWith(async () => {});
    expect(diff.ended).toHaveLength(1);
    expect(diff.wroteFiles).toEqual([false]);
  });

  it("false for a READ — the kind that F40 says runs unpoliced and touches nothing", async () => {
    const { diff } = await turnWith(async (agent) => {
      await agent.emitToolCall({
        sessionUpdate: "tool_call",
        toolCallId: "call_read",
        title: "Read a.txt",
        kind: "read",
        status: "completed",
      });
    });
    expect(diff.wroteFiles).toEqual([false]);
  });

  it("true for an EDIT tool call", async () => {
    const { diff } = await turnWith(async (agent) => {
      await agent.emitToolCall({
        sessionUpdate: "tool_call",
        toolCallId: "call_edit",
        title: "Write a.txt",
        kind: "edit",
        status: "completed",
      });
    });
    expect(diff.wroteFiles).toEqual([true]);
  });

  it("true for a DIFF content block, whatever the kind says", async () => {
    // The same block `reduceTurn` folds into `TurnResult.changes`, so "the turn reported changes"
    // and "the turn wrote" agree by construction.
    const { diff } = await turnWith(async (agent) => {
      await agent.emitDiff("call_other", "/tmp/omni-acp-test/a.txt", "hi\n", "hi\nbye\n");
    });
    expect(diff.wroteFiles).toEqual([true]);
  });

  it("is per TURN: a writing turn does not make the next one look like one", async () => {
    const h = harness();
    const diff = fakeDiffProvider({ text: "diff --git a/a b/a\n", quality: "exact" });
    const agent = scriptedAgent();
    h.supervisor.enqueue(agent);
    const worker = await h.create({
      overrides: {
        diff,
        normalizer: createNormalizer({ quietMs: 250, hardMs: 5_000, cwd: "/tmp/omni-acp-test" }),
      },
    });

    await worker.prompt([TEXT("one")], OWNER);
    await flush();
    await agent.emitToolCall({
      sessionUpdate: "tool_call",
      toolCallId: "call_edit",
      title: "Write a.txt",
      kind: "edit",
      status: "completed",
    });
    agent.resolvePrompt("end_turn");
    await flush(20);
    h.clock.advance(300);
    await flush(20);

    await worker.prompt([TEXT("two")], OWNER);
    await flush();
    agent.resolvePrompt("end_turn");
    await flush(20);
    h.clock.advance(300);
    await flush(20);

    expect(diff.wroteFiles).toEqual([true, false]);
  });
});
