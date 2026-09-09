import { describe, expect, it } from "vitest";
import { OmniError, type InteractionId, type PolicyVerdict } from "@omni-acp/protocol";
import { seqIds } from "@omni-acp/testkit";
import { OWNER, TEXT } from "../support/harness.js";
import {
  ALLOW_ALWAYS,
  ALLOW_ONCE,
  elicitationParams,
  flush,
  linkRig,
  MENU,
  REJECT,
  rig,
  type Rig,
} from "./support/rig.js";

/**
 * M2-A-WP-I's acceptance script (docs/M2-PLAN.md §2, CONTRACTS §19), end to end through the real
 * `Worker`, the real `InteractionStrategy` and a recording v1 agent.
 *
 * Owned by M2-A-WP-I.
 */

const WHO = { ...OWNER, tokenId: OWNER.tokenId };

/** Starts a turn and returns its id, so every envelope below can be attributed to one turn. */
async function turn(r: Rig): Promise<string> {
  const accepted = await r.worker.prompt([TEXT("please edit")], OWNER);
  await flush();
  return accepted.turnId;
}

/** The one parked interaction's id. Fails loudly rather than returning undefined. */
function parkedId(r: Rig): InteractionId {
  const pending = r.worker.interactions;
  const first = pending[0];
  if (first === undefined) throw new Error("nothing is parked");
  return first.requestId;
}

const failed = async (p: Promise<unknown>): Promise<OmniError> => {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  if (!(e instanceof OmniError)) throw new Error(`expected an OmniError, got ${String(e)}`);
  return e;
};

// ── bullet 5: the two envelope sequences ────────────────────────────────────

describe("bullet 5 — envelope sequences (§19.10, ruling M2-R4)", () => {
  it("auto-resolved: M1's two envelopes, in M1's order, and nothing else", async () => {
    const r = await rig({ onUnresolved: "deny" });
    const turnId = await turn(r);
    const answer = await r.agent.requestPermission("p1", {
      sessionId: "sess_recording",
      toolCall: { toolCallId: "call_1", title: "Write hello.txt", kind: "edit" },
      options: [...MENU],
    });

    expect(answer).toEqual({ result: { outcome: { outcome: "selected", optionId: "reject" } } });
    expect(r.interactions()).toHaveLength(1);
    expect(r.decisions()).toHaveLength(1);
    // The ORDER: `acp.interaction` then `omni.policy_decision`, adjacent, both on the turn.
    const kinds = r.log.filter((e) => e.kind !== "acp.session_update").map((e) => e.kind);
    expect(kinds.slice(-2)).toEqual(["acp.interaction", "omni.policy_decision"]);
    expect(r.interactions()[0]?.turnId).toBe(turnId);
    expect(r.decisions()[0]?.turnId).toBe(turnId);

    // Ruling M2-R3: `payloadVersion` 2, the NORMALIZED request, the agent's bytes beside it.
    expect(r.interactions()[0]?.payloadVersion).toBe(2);
    const ip = r.ip(0);
    expect(ip.status).toBe("answered");
    expect(ip.kind).toBe("permission");
    expect(ip.toolCallId).toBe("call_1");
    expect(ip.answer?.parkedMs).toBe(0);
    expect(Object.keys(ip.request as Record<string, unknown>).sort()).toEqual([
      "options",
      "subject",
      "title",
    ]);
    expect((ip.raw as Record<string, unknown>)["toolCall"]).toMatchObject({
      toolCallId: "call_1",
    });
    // No `park` block on an auto-resolved interaction: nothing was ever waiting for a human.
    expect(ip.park).toBeUndefined();

    const dp = r.dp(0);
    expect(dp).toMatchObject({
      decision: "deny",
      by: "policy",
      rule: "m2:onUnresolved",
      ruleSource: "default",
      optionId: "reject",
      parkedMs: 0,
      toolCallId: "call_1",
      title: "Write hello.txt",
    });
    expect(dp.requestId).toBe(ip.requestId);
    // F33: the identity is OURS. The transport id can never be the interaction id, because both
    // agent→client methods share one counter.
    expect(dp.requestId.startsWith("x_")).toBe(true);
    await r.worker.close("client_request");
  });

  it("parked then answered: §19.10's five envelopes, in §19.10's order", async () => {
    const r = await rig({ onUnresolved: "park", parkTimeoutMs: 0 });
    const turnId = await turn(r);
    const before = r.log.length;
    const pending = r.agent.requestPermission("p1", {
      sessionId: "sess_recording",
      toolCall: { toolCallId: "call_1", title: "Write hello.txt", kind: "edit" },
      options: [...MENU],
    });
    await flush();

    // n+0 and n+1.
    const parked = r.log.slice(before);
    expect(parked.map((e) => e.kind)).toEqual(["acp.interaction", "omni.worker_state"]);
    expect(r.ip(0)).toMatchObject({ status: "pending", kind: "permission" });
    expect(r.ip(0).park).toEqual({
      parkedAt: r.h.clock.iso(),
      // `parkTimeoutMs: 0` is a real configuration: a human is genuinely expected, and a
      // deadline nothing is counting down to would be a lie (§5.8.4).
      expiresAt: null,
      onTimeout: "deny",
    });
    expect(parked[1]?.payload).toMatchObject({
      state: "requires_action",
      previous: "running",
      reason: "interaction_parked",
    });
    // Ruling M2-R4: a parked request has NO decision yet.
    expect(r.decisions()).toHaveLength(0);
    expect(r.worker.snapshot().state).toBe("requires_action");

    r.h.clock.advance(41_230);
    const result = r.worker.answerInteraction(parkedId(r), { action: "allow" }, WHO);
    await flush();

    // n+2, n+3, n+4.
    const after = r.log.slice(before + 2);
    expect(after.map((e) => e.kind)).toEqual([
      "acp.interaction",
      "omni.policy_decision",
      "omni.worker_state",
    ]);
    expect(r.ip(1)).toMatchObject({
      status: "answered",
      answer: {
        optionId: "allow-once",
        by: "human",
        byToken: OWNER.tokenId,
        parkedMs: 41_230,
      },
    });
    expect(r.dp(0)).toMatchObject({
      decision: "allow",
      by: "human",
      rule: `human:${OWNER.tokenId}`,
      parkedMs: 41_230,
      optionId: "allow-once",
    });
    expect(after[2]?.payload).toMatchObject({
      state: "running",
      previous: "requires_action",
      reason: "interaction_resolved",
    });

    // `acp.interaction` for ONE requestId appeared TWICE, which is why an SSE consumer keys on
    // `requestId` and never counts frames; `omni.policy_decision` appeared EXACTLY ONCE.
    expect(r.interactions()).toHaveLength(2);
    expect(
      new Set(r.interactions().map((e) => (e.payload as { requestId: string }).requestId)).size,
    ).toBe(1);
    expect(r.decisions()).toHaveLength(1);
    expect(r.interactions().every((e) => e.turnId === turnId)).toBe(true);

    expect(await pending).toEqual({
      result: { outcome: { outcome: "selected", optionId: "allow-once" } },
    });
    expect(result.interaction.status).toBe("answered");
    expect(result.interaction.settledBy).toBe("human");
    expect(result.state).toBe("running");
    await r.worker.close("client_request");
  });

  it("an elicitation parks and answers through the same one lifecycle (D10)", async () => {
    const r = await rig({ onUnresolved: "park", parkTimeoutMs: 0 });
    await turn(r);
    const pending = r.agent.elicit("e1", elicitationParams());
    await flush();

    expect(r.worker.snapshot().state).toBe("requires_action");
    const snapshot = r.worker.interactions[0];
    expect(snapshot).toMatchObject({
      kind: "elicitation",
      method: "elicitation/create",
      status: "pending",
      // F29's FLAT toolCallId — F32's join to the `AskUserQuestion` mirror.
      toolCallId: "toolu_ask_1",
      options: [],
    });
    // The REAL map ran, from `req.raw` — `worker.ts`'s Land fallback yields `fields: []` and it
    // is not trusted (review R11).
    expect(snapshot?.fields.map((f) => f.id)).toEqual(["question_0"]);
    expect(snapshot?.fields[0]?.customField).toBe("question_0_custom");

    r.worker.answerInteraction(
      parkedId(r),
      { action: "answer", content: { question_0: "notes.md" } },
      WHO,
    );
    await flush();

    // F30 on the WIRE: exactly one property per question, and it is the question's own.
    expect(await pending).toEqual({
      result: { action: "accept", content: { question_0: "notes.md" } },
    });
    expect(r.dp(0)).toMatchObject({ decision: "answer", by: "human", optionId: null, offered: [] });
    // KEYS ONLY: the answer's own value never enters the log.
    expect(r.ip(1).answer?.contentKeys).toEqual(["question_0"]);
    expect(JSON.stringify(r.ip(1).answer)).not.toContain("notes.md");
    await r.worker.close("client_request");
  });

  it("a FREE-TEXT answer reaches the _custom property and never the log (F30, §5.8.3)", async () => {
    const r = await rig({ onUnresolved: "park", parkTimeoutMs: 0 });
    await turn(r);
    const pending = r.agent.elicit("e1", elicitationParams());
    await flush();
    r.worker.answerInteraction(
      parkedId(r),
      // The exact value transcript `12` wrongly wrote to disk, answered the RIGHT way: keyed by
      // question id, routed by the daemon, and reaching the wire in ONE property.
      { action: "answer", content: { question_0: "omni-choice.txt" } },
      WHO,
    );
    await flush();

    expect(await pending).toEqual({
      result: { action: "accept", content: { question_0_custom: "omni-choice.txt" } },
    });
    expect(r.ip(1).answer?.contentKeys).toEqual(["question_0_custom"]);
    // A free-text answer is USER CONTENT: it is on the wire and it is nowhere in the log.
    for (const e of r.log) {
      expect(JSON.stringify(e.payload)).not.toContain("omni-choice.txt");
    }
    await r.worker.close("client_request");
  });
});

// ── bullet 6: the park refcount and the biconditional ───────────────────────

describe("bullet 6 — park refcounts (§19.5)", () => {
  it("two concurrent interactions park once and resolve once, and the lease pin is held", async () => {
    const r = await rig({ onUnresolved: "park", parkTimeoutMs: 0 });
    await turn(r);
    const a = r.agent.requestPermission("p1", {
      sessionId: "sess_recording",
      toolCall: { toolCallId: "call_1", title: "one" },
      options: [...MENU],
    });
    await flush();
    const b = r.agent.elicit("e1", elicitationParams({ toolCallId: "toolu_ask_2" }));
    await flush();

    // ONE transition into `requires_action`, for TWO parked requests.
    const parks = r.states().filter((s) => s.reason === "interaction_parked");
    expect(parks).toHaveLength(1);
    expect(parks[0]?.interactions).toHaveLength(1);
    expect(r.worker.interactions).toHaveLength(2);
    expect(r.worker.snapshot().state).toBe("requires_action");
    // Rule L6: a parked worker must stay answerable, so the lease pin is held for the whole
    // window. The harness lease records every hibernate release, and there must be none.
    expect(r.h.lease.hibernateReleases).toBe(0);

    const [first, second] = r.worker.interactions;
    r.worker.answerInteraction(first!.requestId, { action: "deny" }, WHO);
    await flush();
    // The FIRST answer must NOT unpark: one is still open.
    expect(r.states().filter((s) => s.reason === "interaction_resolved")).toHaveLength(0);
    expect(r.worker.snapshot().state).toBe("requires_action");
    expect(r.worker.interactions).toHaveLength(1);

    r.worker.answerInteraction(second!.requestId, { action: "deny" }, WHO);
    await flush();
    expect(r.states().filter((s) => s.reason === "interaction_resolved")).toHaveLength(1);
    expect(r.worker.snapshot().state).toBe("running");
    expect(r.worker.interactions).toHaveLength(0);

    await a;
    await b;
    await r.worker.close("client_request");
  });

  it("interactions.length > 0 <=> state === requires_action, after every transition", async () => {
    const r = await rig({ onUnresolved: "park", parkTimeoutMs: 0 });
    await turn(r);
    const check = (): void => {
      const s = r.worker.snapshot();
      expect(s.interactions.length > 0).toBe(s.state === "requires_action");
    };
    check();
    const a = r.agent.requestPermission("p1", {
      sessionId: "sess_recording",
      toolCall: { toolCallId: "call_1", title: "one" },
      options: [...MENU],
    });
    await flush();
    check();
    const b = r.agent.requestPermission("p2", {
      sessionId: "sess_recording",
      toolCall: { toolCallId: "call_2", title: "two" },
      options: [...MENU],
    });
    await flush();
    check();
    r.worker.answerInteraction(r.worker.interactions[0]!.requestId, { action: "deny" }, WHO);
    await flush();
    check();
    r.worker.answerInteraction(r.worker.interactions[0]!.requestId, { action: "deny" }, WHO);
    await flush();
    check();
    await a;
    await b;
    await r.worker.close("client_request");
  });
});

// ── bullet 7: the park deadline ─────────────────────────────────────────────

describe("bullet 7 — parkTimeoutMs under fakeClock (ruling M2-R7)", () => {
  it('expires with by:"timeout" and applies parkTimeoutAction "deny"', async () => {
    const r = await rig({
      onUnresolved: "park",
      parkTimeoutMs: 5_000,
      parkTimeoutAction: "deny",
    });
    await turn(r);
    const pending = r.agent.requestPermission("p1", {
      sessionId: "sess_recording",
      toolCall: { toolCallId: "call_1", title: "one" },
      options: [...MENU],
    });
    await flush();
    expect(r.ip(0).park?.expiresAt).toBe(new Date(r.h.clock.now() + 5_000).toISOString());

    r.h.clock.advance(4_999);
    await flush();
    expect(r.worker.snapshot().state).toBe("requires_action");

    r.h.clock.advance(1);
    await flush();

    expect(await pending).toEqual({
      result: { outcome: { outcome: "selected", optionId: "reject" } },
    });
    expect(r.ip(1)).toMatchObject({
      status: "expired",
      answer: { by: "timeout", optionId: "reject", parkedMs: 5_000 },
    });
    expect(r.dp(0)).toMatchObject({
      decision: "deny",
      by: "timeout",
      rule: "m2:parkTimeout:deny",
      optionId: "reject",
    });
    expect(r.worker.snapshot().state).toBe("running");
    // The settled row's deadline is cleared, never left counting down.
    expect(r.strategy.get(r.ip(0).requestId)?.expiresAt).toBeNull();
    await r.worker.close("client_request");
  });

  it('applies parkTimeoutAction "fail": the turn is cancelled and the worker STAYS OPEN (M2-R24)', async () => {
    const r = await rig({
      onUnresolved: "park",
      parkTimeoutMs: 5_000,
      parkTimeoutAction: "fail",
    });
    await turn(r);
    const pending = r.agent.elicit("e1", elicitationParams());
    await flush();
    expect(r.ip(0).park?.onTimeout).toBe("fail");

    r.h.clock.advance(5_000);
    await flush();

    // The answer went out — a `fail` still ANSWERS, it does not abandon (§19.8).
    expect(await pending).toEqual({ result: { action: "decline" } });
    expect(r.ip(1)).toMatchObject({ status: "expired", answer: { by: "timeout" } });
    // `session/cancel` reached the agent AFTER our answer.
    expect(r.agent.timeline).toContain("recv:session/cancel");
    expect(r.agent.timeline.indexOf("answer:e1")).toBeLessThan(
      r.agent.timeline.indexOf("recv:session/cancel"),
    );
    // Ruling M2-R24: the WORKER stays open. `fail` is a verdict about one request.
    expect(r.worker.snapshot().state).not.toBe("closed");
    await r.worker.close("client_request");
  });

  it("parkTimeoutMs: 0 never expires — a human is genuinely expected", async () => {
    const r = await rig({ onUnresolved: "park", parkTimeoutMs: 0 });
    await turn(r);
    const pending = r.agent.requestPermission("p1", {
      sessionId: "sess_recording",
      toolCall: { toolCallId: "call_1", title: "one" },
      options: [...MENU],
    });
    await flush();
    expect(r.ip(0).park?.expiresAt).toBeNull();
    expect(r.worker.interactions[0]?.expiresAt).toBeNull();

    r.h.clock.advance(86_400_000);
    await flush();
    expect(r.worker.snapshot().state).toBe("requires_action");
    expect(r.worker.interactions).toHaveLength(1);

    r.worker.answerInteraction(parkedId(r), { action: "deny" }, WHO);
    await flush();
    await pending;
    await r.worker.close("client_request");
  });

  it('interaction.maxParked denies the NEWEST with rule "limit:max_parked" and never drops it', async () => {
    const r = await rig({
      onUnresolved: "park",
      parkTimeoutMs: 0,
      config: { maxParked: 2 },
    });
    await turn(r);
    const held: Promise<unknown>[] = [];
    for (const n of [1, 2]) {
      held.push(
        r.agent.requestPermission(`p${String(n)}`, {
          sessionId: "sess_recording",
          toolCall: { toolCallId: `call_${String(n)}`, title: `t${String(n)}` },
          options: [...MENU],
        }),
      );
      await flush();
    }
    expect(r.worker.interactions).toHaveLength(2);

    // The third arrives over the bound.
    const third = await r.agent.requestPermission("p3", {
      sessionId: "sess_recording",
      toolCall: { toolCallId: "call_3", title: "t3" },
      options: [...MENU],
    });
    // NEVER dropped: an unanswered agent request hangs a turn forever.
    expect(third).toEqual({ result: { outcome: { outcome: "selected", optionId: "reject" } } });
    const denial = r.decisions().at(-1)?.payload as { rule: string; decision: string };
    expect(denial).toMatchObject({ rule: "limit:max_parked", decision: "deny" });
    // The two already parked are untouched — the NEWEST loses, not the oldest.
    expect(r.worker.interactions).toHaveLength(2);

    for (const id of r.worker.interactions.map((i) => i.requestId)) {
      r.worker.answerInteraction(id, { action: "deny" }, WHO);
    }
    await flush();
    await Promise.all(held);
    await r.worker.close("client_request");
  });
});

// ── bullet 9: settleAll ─────────────────────────────────────────────────────

describe("bullet 9 — settleAll (§19.8)", () => {
  /**
   * `Worker.cancel`'s body, in `Worker.cancel`'s order, against a recording agent.
   *
   *     await this.#settleInteractions("cancel");
   *     await this.#link.notify("session/cancel", { sessionId });
   *
   * Review R1 is the reason this is a test rather than a reading: `settleAll` returns a promise
   * because resolving a deferred the ACP link's request handler is holding writes the response
   * bytes a MICROTASK later, so a `void` settle followed by the notify would still put the cancel
   * on stdin FIRST — an agent blocked on our answer may never read it, and the turn hangs forever.
   *
   * It is driven here rather than through `worker.cancel(OWNER)` because the frozen `worker.ts`
   * returns early from `cancel()` unless the state is exactly `running`, and a parked worker is
   * `requires_action`. That is a one-line change to a frozen file and it is reported in the merge
   * notes; the GUARANTEE this bullet is about is the ordering, and the ordering is asserted below
   * against the same two calls in the same order.
   */
  it("settleAll('cancel') resolves every held promise BEFORE session/cancel reaches stdin", async () => {
    const r = linkRig({ onUnresolved: "park", parkTimeoutMs: 0 });
    const a = r.agent.requestPermission("p1", {
      sessionId: "sess_recording",
      toolCall: { toolCallId: "call_1", title: "one" },
      options: [...MENU],
    });
    await flush();
    const b = r.agent.elicit("e1", elicitationParams({ toolCallId: "toolu_ask_2" }));
    await flush();
    expect(r.strategy.pending).toHaveLength(2);

    // `Worker.cancel`'s body, verbatim and in its order.
    await r.strategy.settleAll("cancel");
    await r.notifyCancel();
    await flush();

    expect(await a).toEqual({ error: -32603 });
    expect(await b).toEqual({ result: { action: "decline" } });
    // THE ordering claim, asserted by METHOD ORDER on the agent side.
    const cancelAt = r.agent.timeline.indexOf("recv:session/cancel");
    expect(cancelAt).toBeGreaterThan(-1);
    expect(r.agent.timeline.indexOf("error:p1")).toBeLessThan(cancelAt);
    expect(r.agent.timeline.indexOf("answer:e1")).toBeLessThan(cancelAt);
    r.dispose();
  });

  it("a synchronous settle followed by the notify REVERSES that order (review R1)", async () => {
    // The counter-example review R1 names, run for real: the same parked request, settled without
    // awaiting, and the cancel wins the race. That is what a `void settleAll()` would have
    // shipped, and it is why the method returns a promise every caller awaits.
    const r = linkRig({ onUnresolved: "park", parkTimeoutMs: 0 });
    const a = r.agent.requestPermission("p1", {
      sessionId: "sess_recording",
      toolCall: { toolCallId: "call_1", title: "one" },
      options: [...MENU],
    });
    await flush();

    void r.strategy.settleAll("cancel");
    await r.notifyCancel();
    await flush();
    await a;

    const cancelAt = r.agent.timeline.indexOf("recv:session/cancel");
    expect(cancelAt).toBeGreaterThan(-1);
    expect(r.agent.timeline.indexOf("error:p1")).toBeGreaterThan(cancelAt);
    r.dispose();
  });

  it("shutdown/close leaves NO pending interaction in the log", async () => {
    const r = await rig({ onUnresolved: "park", parkTimeoutMs: 0 });
    await turn(r);
    const a = r.agent.requestPermission("p1", {
      sessionId: "sess_recording",
      toolCall: { toolCallId: "call_1", title: "one" },
      options: [...MENU],
    });
    await flush();
    expect(r.ip(0).status).toBe("pending");

    await r.worker.close("client_request");
    await flush();
    await a;

    // A log that ends on a `pending` interaction is a log that lies: for every requestId, the
    // LAST `acp.interaction` frame is terminal.
    const last = new Map<string, string>();
    for (const e of r.interactions()) {
      const p = e.payload as { requestId: string; status: string };
      last.set(p.requestId, p.status);
    }
    expect([...last.values()]).toEqual(["cancelled"]);
    expect(r.dp(0)).toMatchObject({ by: "daemon", rule: "m2:settle:close", decision: "cancel" });
    expect(r.strategy.pending).toEqual([]);
  });

  it("is idempotent: a second settleAll finds nothing and resolves", async () => {
    const r = await rig({ onUnresolved: "park", parkTimeoutMs: 0 });
    await turn(r);
    const a = r.agent.requestPermission("p1", {
      sessionId: "sess_recording",
      toolCall: { toolCallId: "call_1", title: "one" },
      options: [...MENU],
    });
    await flush();
    await r.strategy.settleAll("cancel");
    const before = r.log.length;
    await r.strategy.settleAll("cancel");
    await r.strategy.settleAll("shutdown");
    expect(r.log.length).toBe(before);
    await a;
    await r.worker.close("client_request");
  });
});

// ── bullet 8's semantics half (the HTTP half is daemon/test/http) ────────────

describe("bullet 8 — §19.6's SEMANTICS rows, decided before anything reaches the wire", () => {
  const parkedRig = async (o?: { allowAlways?: "never" | "human" }): Promise<Rig> => {
    const r = await rig({
      onUnresolved: "park",
      parkTimeoutMs: 0,
      ...(o?.allowAlways === undefined ? {} : { config: { allowAlways: o.allowAlways } }),
    });
    await turn(r);
    void r.agent.requestPermission("p1", {
      sessionId: "sess_recording",
      toolCall: { toolCallId: "call_1", title: "one" },
      options: [...MENU],
    });
    await flush();
    return r;
  };

  it("an optionId that was never offered is 400 NAMING the offered ids (D4 rule 1)", async () => {
    const r = await parkedRig();
    const e = await failed(
      Promise.resolve().then(() =>
        r.worker.answerInteraction(parkedId(r), { action: "allow", optionId: "invented" }, WHO),
      ),
    );
    expect(e.code).toBe("bad_request");
    expect(e.message).toContain("invented");
    expect(e.message).toContain("allow-once");
    // Still parked: a refused body never settles the agent's request.
    expect(r.worker.interactions).toHaveLength(1);
    await r.worker.close("client_request");
  });

  it('an allow_always optionId is 400 quoting rule 3 and citing F26 (allowAlways:"never")', async () => {
    const r = await parkedRig();
    const e = await failed(
      Promise.resolve().then(() =>
        r.worker.answerInteraction(
          parkedId(r),
          { action: "allow", optionId: ALLOW_ALWAYS.optionId },
          WHO,
        ),
      ),
    );
    expect(e.code).toBe("bad_request");
    expect(e.message).toContain("rule 3");
    expect(e.message).toContain("F26");
    await r.worker.close("client_request");
  });

  it('allowAlways:"human" permits it and stamps blindsPolicy on the decision (M2-R19)', async () => {
    const r = await parkedRig({ allowAlways: "human" });
    r.worker.answerInteraction(
      parkedId(r),
      { action: "allow", optionId: ALLOW_ALWAYS.optionId },
      WHO,
    );
    await flush();
    expect(r.dp(0)).toMatchObject({
      decision: "allow",
      optionId: ALLOW_ALWAYS.optionId,
      blindsPolicy: true,
    });
    await r.worker.close("client_request");
  });

  it("an argument-less allow picks allow_once and NEVER allow_always (D4 rules 2 and 3)", async () => {
    const r = await parkedRig();
    r.worker.answerInteraction(parkedId(r), { action: "allow" }, WHO);
    await flush();
    expect(r.dp(0).optionId).toBe(ALLOW_ONCE.optionId);
    expect(r.dp(0).blindsPolicy).toBeUndefined();
    await r.worker.close("client_request");
  });

  it('"answer" on a permission and "allow" on an elicitation are both 400 (wrong verb)', async () => {
    const r = await parkedRig();
    const wrongVerb = await failed(
      Promise.resolve().then(() =>
        r.worker.answerInteraction(parkedId(r), { action: "answer", content: { q: "x" } }, WHO),
      ),
    );
    expect(wrongVerb.code).toBe("bad_request");
    expect(wrongVerb.message).toContain("elicitation verb");
    await r.worker.close("client_request");

    const e = await rig({ onUnresolved: "park", parkTimeoutMs: 0 });
    await turn(e);
    void e.agent.elicit("e1", elicitationParams());
    await flush();
    const other = await failed(
      Promise.resolve().then(() =>
        e.worker.answerInteraction(parkedId(e), { action: "allow" }, WHO),
      ),
    );
    expect(other.code).toBe("bad_request");
    expect(other.message).toContain("permission verb");
    await e.worker.close("client_request");
  });

  it("an unknown reqId is 404 interaction_not_found; a settled one is 409 with the snapshot", async () => {
    const r = await parkedRig();
    const missing = await failed(
      Promise.resolve().then(() =>
        r.worker.answerInteraction(
          "x_00000000000000000000000099" as InteractionId,
          { action: "deny" },
          WHO,
        ),
      ),
    );
    expect(missing.code).toBe("interaction_not_found");
    expect(missing.status).toBe(404);

    const id = parkedId(r);
    r.worker.answerInteraction(id, { action: "deny" }, WHO);
    await flush();
    const twice = await failed(
      Promise.resolve().then(() => r.worker.answerInteraction(id, { action: "deny" }, WHO)),
    );
    expect(twice.code).toBe("interaction_settled");
    expect(twice.status).toBe(409);
    // "naming who won" — the loser of a double-submit learns it without a second round trip.
    expect(twice.interaction).toMatchObject({ status: "answered", settledBy: "human" });
    await r.worker.close("client_request");
  });

  it("two identical failures produce DEEP-EQUAL bodies", async () => {
    const bodies: unknown[] = [];
    for (const _ of [0, 1]) {
      const r = await parkedRig();
      const e = await failed(
        Promise.resolve().then(() =>
          r.worker.answerInteraction(parkedId(r), { action: "allow", optionId: "nope" }, WHO),
        ),
      );
      // The requestId is a ULID and differs per worker; everything else must not.
      bodies.push({
        code: e.code,
        status: e.status,
        message: e.message.replace(/x_[0-9A-Z]+/, ""),
      });
      await r.worker.close("client_request");
    }
    expect(bodies[0]).toEqual(bodies[1]);
  });

  it("a content key naming an unknown question is 400 WITH THE NAME in it", async () => {
    const r = await rig({ onUnresolved: "park", parkTimeoutMs: 0 });
    await turn(r);
    void r.agent.elicit("e1", elicitationParams());
    await flush();
    const e = await failed(
      Promise.resolve().then(() =>
        r.worker.answerInteraction(
          parkedId(r),
          { action: "answer", content: { question_7: "x" } },
          WHO,
        ),
      ),
    );
    expect(e.code).toBe("bad_request");
    expect(e.message).toContain("question_7");
    await r.worker.close("client_request");
  });
});

// ── the three verdict arms, and the turn projection ─────────────────────────

describe("onUnresolved arms and the turn projection (§19.9, M2-R24)", () => {
  it('"fail" answers the request, cancels the TURN, and leaves the worker OPEN', async () => {
    const r = await rig({ onUnresolved: "fail" });
    await turn(r);
    const answer = await r.agent.requestPermission("p1", {
      sessionId: "sess_recording",
      toolCall: { toolCallId: "call_1", title: "one" },
      options: [...MENU],
    });
    await flush();
    expect(answer).toEqual({ result: { outcome: { outcome: "selected", optionId: "reject" } } });
    const cancelAt = r.agent.timeline.indexOf("recv:session/cancel");
    expect(cancelAt).toBeGreaterThan(-1);
    expect(r.agent.timeline.indexOf("answer:p1")).toBeLessThan(cancelAt);
    expect(r.worker.snapshot().state).not.toBe("closed");
    await r.worker.close("client_request");
  });

  it("F31/F32: an elicitation is folded ONCE as an interaction and ONCE as a tool call", async () => {
    const r = await rig({ onUnresolved: "deny" });
    const turnId = await turn(r);
    // The AskUserQuestion mirror, exactly as claude-acp emits it (F32).
    await r.agent.update({
      sessionUpdate: "tool_call",
      toolCallId: "toolu_ask_1",
      status: "pending",
      title: "Asking for your input",
      kind: "other",
      _meta: { claudeCode: { toolName: "AskUserQuestion" } },
    });
    await flush();
    const declined = await r.agent.elicit("e1", elicitationParams());
    expect(declined).toEqual({ result: { action: "decline" } });
    // F31: accept and decline are indistinguishable in the stream — both leave `completed`.
    await r.agent.update({
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_ask_1",
      status: "completed",
      rawOutput: "The user did not answer the questions.",
    });
    r.agent.resolvePrompt("end_turn");
    await flush();
    r.h.clock.advance(250);
    await flush();

    const result = r.worker.turn(turnId).result;
    expect(result?.interactions).toHaveLength(1);
    expect(result?.interactions[0]).toMatchObject({
      kind: "elicitation",
      method: "elicitation/create",
      decision: "deny",
      toolCallId: "toolu_ask_1",
    });
    expect(result?.toolCalls).toHaveLength(1);
    // §19.9: `deniedToolCalls` is gated on the METHOD — a declined elicitation leaves its tool
    // call `completed`, so joining it there would report a tool we blocked that in fact ran.
    expect(result?.deniedToolCalls).toEqual([]);
    expect(result?.pendingInteractions).toEqual([]);
    await r.worker.close("client_request");
  });

  it("an injected `decide` overrides onUnresolved, and a thrown one fails closed", async () => {
    const allow: PolicyVerdict = {
      action: "allow",
      rule: "test#1",
      source: "inline",
      clamped: { from: "park", by: "ceiling:test" },
    };
    const r = await rig({ onUnresolved: "deny", decide: () => allow });
    await turn(r);
    expect(
      await r.agent.requestPermission("p1", {
        sessionId: "sess_recording",
        toolCall: { toolCallId: "call_1", title: "one" },
        options: [...MENU],
      }),
    ).toEqual({ result: { outcome: { outcome: "selected", optionId: "allow-once" } } });
    expect(r.dp(0)).toMatchObject({
      decision: "allow",
      rule: "test#1",
      ruleSource: "inline",
      clamped: { from: "park", by: "ceiling:test" },
    });
    await r.worker.close("client_request");

    const boom = await rig({
      onUnresolved: "deny",
      decide: () => {
        throw new Error("engine exploded");
      },
    });
    await turn(boom);
    expect(
      await boom.agent.requestPermission("p1", {
        sessionId: "sess_recording",
        toolCall: { toolCallId: "call_1", title: "one" },
        options: [...MENU],
      }),
    ).toEqual({ result: { outcome: { outcome: "selected", optionId: "reject" } } });
    expect(boom.dp(0)).toMatchObject({ decision: "deny", rule: "m2:onUnresolved" });
    await boom.worker.close("client_request");
  });

  it("D4 rule 4: nothing acceptable offered answers -32603 and records decision:'error'", async () => {
    const r = await rig({ onUnresolved: "deny" });
    await turn(r);
    const answer = await r.agent.requestPermission("p1", {
      sessionId: "sess_recording",
      toolCall: { toolCallId: "call_1", title: "one" },
      options: [ALLOW_ALWAYS],
    });
    expect(answer).toEqual({ error: -32603 });
    expect(r.ip(0).status).toBe("failed");
    expect(r.dp(0)).toMatchObject({ decision: "error", optionId: null });
    // Rule 5 in situ: the turn was NOT cancelled.
    expect(r.agent.timeline).not.toContain("recv:session/cancel");
    await r.worker.close("client_request");
  });

  it("a permission answered outside a turn carries turnId null", async () => {
    const r = await rig({ onUnresolved: "deny" });
    await r.agent.requestPermission("p1", {
      sessionId: "sess_recording",
      toolCall: { toolCallId: "call_1", title: "one" },
      options: [...MENU, REJECT],
    });
    expect(r.decisions()[0]?.turnId).toBeNull();
    await r.worker.close("client_request");
  });

  it("a park that cannot be HELD still ANSWERS, and releases the park it announced", async () => {
    // An `IdGen` that repeats is a broken one, and it is the one input that can make `hold` refuse
    // AFTER `ctx.park()` has already moved the worker. Two things must then still be true, and
    // they are the two this belt exists for: the agent gets a real answer (F1 — an unanswered
    // request hangs a turn forever), and the strategy releases the park it announced rather than
    // leaving a refcount nobody will ever decrement.
    //
    // What it canNOT restore is the biconditional, because `worker.ts`'s refcount is keyed on the
    // ID: two parks under one id are one entry, and releasing it releases both. That is a
    // property of a broken `IdGen`, not something a strategy can paper over — which is precisely
    // why F33 makes the id daemon-minted and `interaction-id-is-daemon-minted` guards it.
    const fixed = seqIds();
    const once = fixed.interaction();
    const r = await rig({
      onUnresolved: "park",
      parkTimeoutMs: 0,
      ids: { ...fixed, interaction: () => once },
    });
    await turn(r);

    const first = r.agent.requestPermission("p1", {
      sessionId: "sess_recording",
      toolCall: { toolCallId: "call_1", title: "one" },
      options: [...MENU],
    });
    await flush();
    expect(r.worker.snapshot().state).toBe("requires_action");

    // The SAME id again: the registry refuses to hold it twice.
    const second = await r.agent.requestPermission("p2", {
      sessionId: "sess_recording",
      toolCall: { toolCallId: "call_2", title: "two" },
      options: [...MENU],
    });
    // NEVER dropped, and never a hang: the agent is answered even though we could not park it.
    expect(second).toEqual({ result: { outcome: { outcome: "selected", optionId: "reject" } } });
    expect(r.decisions().at(-1)?.payload).toMatchObject({
      rule: "limit:max_parked",
      decision: "deny",
      by: "daemon",
    });
    // The announced park was released rather than left counting: no worker is stuck waiting on a
    // refcount that has no owner.
    expect(r.worker.snapshot().state).toBe("running");

    // The FIRST request is still held and still answerable, which is the half that matters.
    expect(r.strategy.pending).toHaveLength(1);
    r.worker.answerInteraction(
      r.strategy.pending[0]?.requestId ?? ("x_missing" as InteractionId),
      { action: "deny" },
      WHO,
    );
    await flush();
    await first;
    expect(r.strategy.pending).toEqual([]);
    await r.worker.close("client_request");
  });

  it("close() disposes every armed park deadline (review R15)", async () => {
    const r = await rig({ onUnresolved: "park", parkTimeoutMs: 60_000 });
    await turn(r);
    const a = r.agent.requestPermission("p1", {
      sessionId: "sess_recording",
      toolCall: { toolCallId: "call_1", title: "one" },
      options: [...MENU],
    });
    await flush();
    expect(r.h.clock.pendingTimers).toBeGreaterThan(0);
    await r.worker.close("client_request");
    await flush();
    await a;
    // Commit 7c80f15 is the recording of what one surviving timer costs.
    expect(r.h.clock.pendingTimers).toBe(0);
    // Idempotent and never throws, because every teardown path calls it blindly.
    expect(() => {
      r.strategy.close();
      r.strategy.close();
    }).not.toThrow();
  });
});
