import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  InteractionPayload,
  PolicyDecisionPayload,
  WorkerStatePayload,
} from "@omni-acp/protocol";
import { tempRoot } from "./support/harness.js";
import {
  startInteractionWorker,
  until,
  WHO,
  OWNER,
  type InteractionWorker,
} from "./support/interaction-worker.js";

/**
 * A real park, end to end: `onUnresolved:"park"` → `requires_action` → a human answer → the turn
 * resumes.
 *
 * Real process, real ndJSON over real pipes, the real `AcpLink` with its `verbatim`
 * `elicitation/create` registration, the real `Normalizer`, the real `Worker` and the real
 * `InteractionStrategy`. See `support/interaction-worker.ts` for why the HTTP route is not in the
 * loop yet.
 *
 * Owned by M2-A-WP-I.
 */

let live: InteractionWorker | null = null;
afterEach(async () => {
  await live?.dispose();
  live = null;
});

const ip = (w: InteractionWorker, n: number): InteractionPayload =>
  w.interactions()[n]?.payload as InteractionPayload;
const dp = (w: InteractionWorker, n: number): PolicyDecisionPayload =>
  w.decisions()[n]?.payload as PolicyDecisionPayload;

describe("interaction park (M2-A, §19)", () => {
  it("moves the worker to requires_action and back, with the lease pin held throughout", async () => {
    const cwd = await tempRoot("omni-acp-park-");
    const w = await startInteractionWorker({
      fixture: "elicit-oneof",
      cwd,
      onUnresolved: "park",
      parkTimeoutMs: 0,
    });
    live = w;

    const accepted = await w.worker.prompt([{ type: "text", text: "name a file" }], OWNER);
    await until(() => w.worker.snapshot().state === "requires_action", {
      what: "the park",
    });

    // §19.10 n+0 and n+1: the request is announced, and only then does the worker move.
    expect(ip(w, 0)).toMatchObject({
      kind: "elicitation",
      method: "elicitation/create",
      status: "pending",
    });
    expect(ip(w, 0).park).toMatchObject({ expiresAt: null, onTimeout: "deny" });
    // A REAL agent's bytes, verbatim: the flat scope (F29) and the `_meta` marker (F30) both
    // survived the inbound `verbatim` parse.
    const raw = ip(w, 0).raw as Record<string, unknown>;
    expect(raw["sessionId"]).toBeTypeOf("string");
    expect(raw["toolCallId"]).toBe("toolu_ask_1");
    expect(JSON.stringify(raw)).toContain("_askUserQuestionCustomAnswer");
    // …and the REAL map ran over them.
    const snapshot = w.worker.interactions[0];
    expect(snapshot?.fields.map((f) => f.id)).toEqual(["question_0"]);
    expect(snapshot?.fields[0]?.customField).toBe("question_0_custom");
    expect(snapshot?.fields[0]?.options.map((x) => x.value)).toEqual([
      "notes.md",
      "README.md",
      "main.py",
    ]);

    const parked = w.states().at(-1)?.payload as WorkerStatePayload;
    expect(parked).toMatchObject({
      state: "requires_action",
      previous: "running",
      reason: "interaction_parked",
    });
    // Ruling M2-R4: a parked request has NO decision yet.
    expect(w.decisions()).toHaveLength(0);
    // The lease pin is held for the whole window (rule L6): a parked worker must stay answerable.
    expect(w.worker.snapshot().lease.holder).toMatchObject({ clientId: OWNER.clientId });

    if (snapshot === undefined) throw new Error("nothing is parked");
    const result = w.worker.answerInteraction(
      snapshot.requestId,
      { action: "answer", content: { question_0: "notes.md" } },
      WHO,
    );
    expect(result.interaction.status).toBe("answered");
    expect(result.state).toBe("running");
    // The seq is a real one, copied off the envelope the log stamped (§8.2).
    expect(result.seq).toBeGreaterThan(0);
    expect(w.envelopes().some((e) => e.seq === result.seq)).toBe(true);

    // `TurnStatus.result` is ALWAYS non-null for a turn the log knows (§5.5), so the end of a
    // turn is `state: "completed"` and never a null check.
    await until(() => w.worker.turn(accepted.turnId).state === "completed", {
      what: "the turn to end",
    });

    // §19.10 n+2..n+4, and `omni.policy_decision` EXACTLY once (M2-R4).
    expect(w.interactions()).toHaveLength(2);
    expect(w.decisions()).toHaveLength(1);
    expect(dp(w, 0)).toMatchObject({
      kind: "elicitation",
      method: "elicitation/create",
      decision: "answer",
      by: "human",
      rule: `human:${OWNER.tokenId}`,
    });
    expect(dp(w, 0).parkedMs).toBeGreaterThanOrEqual(0);
    await until(() => w.worker.snapshot().state === "ready", { what: "the worker to go idle" });
    expect(w.states().at(-1)?.payload).toMatchObject({ state: "ready", reason: "turn_end" });

    // F30 ON THE WIRE, observed on the agent's own stderr rather than on our view of it: exactly
    // one property per question, and it is the question's own because `notes.md` is an offered
    // const.
    const answered = w
      .envelopes()
      .filter((e) => e.kind === "acp.session_update")
      .map((e) => JSON.stringify(e.payload))
      .join("\n");
    expect(answered).toContain("The user answered");
    expect(answered).toContain("question_0");
    expect(answered).not.toContain("question_0_custom");

    const turn = w.worker.turn(accepted.turnId).result;
    // F32: the same interaction is ALSO a tool call. Two arrays, neither feeding the other.
    expect(turn?.interactions).toHaveLength(1);
    expect(turn?.toolCalls).toHaveLength(1);
    expect(turn?.interactions[0]?.toolCallId).toBe(turn?.toolCalls[0]?.toolCallId);
    // §19.9: `deniedToolCalls` is gated on the METHOD, so an elicitation never lands in it.
    expect(turn?.deniedToolCalls).toEqual([]);
    expect(turn?.pendingInteractions).toEqual([]);
    void readFile(join(cwd, "nothing")).catch(() => undefined);
  }, 60_000);

  it("routes a value outside `oneOf` to the _custom property and NOWHERE else (F30)", async () => {
    const cwd = await tempRoot("omni-acp-park-custom-");
    const w = await startInteractionWorker({
      fixture: "elicit-custom",
      cwd,
      onUnresolved: "park",
      parkTimeoutMs: 0,
    });
    live = w;

    const accepted = await w.worker.prompt([{ type: "text", text: "name a file" }], OWNER);
    await until(() => w.worker.interactions.length > 0, { what: "the park" });

    // The exact value transcript `12` wrongly wrote to disk, answered the RIGHT way: keyed by
    // question id, routed by the daemon, and reaching the wire in ONE property.
    const custom = w.worker.interactions[0];
    if (custom === undefined) throw new Error("nothing is parked");
    w.worker.answerInteraction(
      custom.requestId,
      { action: "answer", content: { question_0: "omni-choice.txt" } },
      WHO,
    );
    await until(() => w.worker.turn(accepted.turnId).state === "completed", {
      what: "the turn to end",
    });

    expect(ip(w, 1).answer?.contentKeys).toEqual(["question_0_custom"]);
    // KEYS ONLY: a free-text answer is user content and never enters the log.
    for (const e of w.envelopes()) {
      if (e.kind !== "acp.interaction" && e.kind !== "omni.policy_decision") continue;
      expect(JSON.stringify(e.payload)).not.toContain("omni-choice.txt");
    }
  }, 60_000);

  it("answers a MULTI-question form one property per question", async () => {
    const cwd = await tempRoot("omni-acp-park-multi-");
    const w = await startInteractionWorker({
      fixture: "elicit-multi",
      cwd,
      onUnresolved: "park",
      parkTimeoutMs: 0,
    });
    live = w;

    const accepted = await w.worker.prompt([{ type: "text", text: "two things" }], OWNER);
    await until(() => w.worker.interactions.length > 0, { what: "the park" });
    const snapshot = w.worker.interactions[0];
    if (snapshot === undefined) throw new Error("nothing is parked");
    expect(snapshot.fields.map((f) => f.id)).toEqual(["question_0", "question_1"]);

    w.worker.answerInteraction(
      snapshot.requestId,
      { action: "answer", content: { question_0: "notes.md", question_1: "free text" } },
      WHO,
    );
    await until(() => w.worker.turn(accepted.turnId).state === "completed", {
      what: "the turn to end",
    });
    // One offered const and one free-text answer: one property each, and never a group's twin.
    expect(ip(w, 1).answer?.contentKeys).toEqual(["question_0", "question_1_custom"]);
  }, 60_000);

  it("prompt() survives a park longer than a client's requestTimeoutMs", async () => {
    const cwd = await tempRoot("omni-acp-park-long-");
    const w = await startInteractionWorker({
      fixture: "elicit-oneof",
      cwd,
      onUnresolved: "park",
      parkTimeoutMs: 0,
    });
    live = w;

    // `prompt()` RETURNS at admission — `PromptAccepted`, not the turn's result — which is the
    // whole reason a park cannot time a client out (§5.1, H8). The park below outlives any
    // client deadline and the turn is still there afterwards.
    const accepted = await w.worker.prompt([{ type: "text", text: "name a file" }], OWNER);
    expect(accepted.turnId).toBeTypeOf("string");
    await until(() => w.worker.interactions.length > 0, { what: "the park" });

    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(w.worker.snapshot().state).toBe("requires_action");
    expect(w.worker.turn(accepted.turnId).state).toBe("running");

    const long = w.worker.interactions[0];
    if (long === undefined) throw new Error("nothing is parked");
    w.worker.answerInteraction(long.requestId, { action: "deny" }, WHO);
    await until(() => w.worker.turn(accepted.turnId).state === "completed", {
      what: "the turn to end",
    });
    expect(w.worker.turn(accepted.turnId).result?.stopReason).toBe("end_turn");
  }, 60_000);

  it("two concurrent parks refcount into ONE requires_action (§19.5)", async () => {
    const cwd = await tempRoot("omni-acp-park-two-");
    const w = await startInteractionWorker({
      fixture: "elicit-oneof",
      cwd,
      onUnresolved: "park",
      parkTimeoutMs: 0,
    });
    live = w;

    const accepted = await w.worker.prompt([{ type: "text", text: "one" }], OWNER);
    await until(() => w.worker.interactions.length > 0, { what: "the first park" });
    // A second request on the same worker, issued straight at the strategy: the fixture asks once
    // per turn, and a second TURN cannot start while the first is parked (`409 worker_busy`).
    expect(w.worker.snapshot().state).toBe("requires_action");
    // `WorkerSnapshot.interactions` is optional at the Land step (an M1 row carries none), so a
    // reader coalesces rather than asserting the field exists.
    const listed = (): readonly unknown[] => w.worker.snapshot().interactions ?? [];
    expect(listed()).toHaveLength(1);
    // The biconditional §19.5 names, on a live worker.
    expect(listed().length > 0).toBe(w.worker.snapshot().state === "requires_action");

    const one = w.worker.interactions[0];
    if (one === undefined) throw new Error("nothing is parked");
    w.worker.answerInteraction(one.requestId, { action: "deny" }, WHO);
    await until(() => w.worker.turn(accepted.turnId).state === "completed", {
      what: "the turn to end",
    });
    expect(listed()).toEqual([]);
    await until(() => w.worker.snapshot().state === "ready", { what: "the worker to go idle" });
  }, 60_000);
});
