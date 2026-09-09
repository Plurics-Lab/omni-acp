import { describe, expect, it } from "vitest";
import type { InteractionId, PolicyVerdict, TurnResult } from "@omni-acp/protocol";
import { OWNER, TEXT } from "../support/harness.js";
import { ALLOW_ALWAYS, flush, MENU, rig, type Rig } from "./support/rig.js";

/**
 * M2's three "it is never silent" guarantees, made true (review finding V9).
 *
 *  - §20.5's ceiling clamp reaches the SETTLEMENT even when the clamp is what parked the request.
 *    `createPolicyEngine` returns `clamped:{from:"allow",…}`, `route()` then parks — and every
 *    settlement built afterwards hard-coded `clamped: null`, so the ONE clamp that turns an
 *    auto-allow into a human decision left no trace on `omni.policy_decision` at all.
 *  - M2-R19's `WorkerSnapshot.policyBlinded` was declared in `protocol/src/worker.ts` and never
 *    assigned anywhere in `packages/core/src`. Two of the three announcements that are the PRICE
 *    of allowing `interaction.allowAlways:"human"` were missing.
 *  - §20.6's `alertOnUnpoliced` reaches the TURN, through `idle._meta["omni/policy"]`, so
 *    `unpoliced_tool_call` is produced by the same pure fold the SDK runs (D7).
 *
 * Owned by M2-B (review round 2).
 */

const WHO = { ...OWNER, tokenId: OWNER.tokenId };

/** A verdict that PARKS because a ceiling narrowed an `allow` — §20.5's layer 2, exactly. */
const CLAMPED_PARK: PolicyVerdict = {
  action: "park",
  rule: "p#r1",
  source: "ceiling",
  clamped: { from: "allow", by: "policyCeiling:pathRoots" },
};

async function parked(o?: {
  decide?: () => PolicyVerdict;
  allowAlways?: "never" | "human";
  parkTimeoutMs?: number;
}): Promise<{ r: Rig; id: InteractionId }> {
  const r = await rig({
    onUnresolved: "park",
    parkTimeoutMs: o?.parkTimeoutMs ?? 0,
    ...(o?.decide === undefined ? {} : { decide: o.decide }),
    ...(o?.allowAlways === undefined ? {} : { config: { allowAlways: o.allowAlways } }),
  });
  await r.worker.prompt([TEXT("please edit")], OWNER);
  await flush();
  void r.agent.requestPermission("p1", {
    sessionId: "sess_recording",
    toolCall: { toolCallId: "call_1", title: "Write hello.txt", kind: "edit" },
    options: [...MENU],
  });
  await flush();
  const first = r.worker.interactions[0];
  if (first === undefined) throw new Error("nothing parked");
  return { r, id: first.requestId };
}

describe("the ceiling clamp survives the PARK (review finding V9)", () => {
  it("a HUMAN answer records the clamp that made a human necessary", async () => {
    const { r, id } = await parked({ decide: () => CLAMPED_PARK });
    r.worker.answerInteraction(id, { action: "allow" }, WHO);
    await flush();
    // Before the fix this read `clamped: undefined`: `answerOf` hard-coded `clamped: null`, so
    // the audit could not tell an allow a human chose from an allow a ceiling forced them to
    // choose.
    expect(r.dp(0).clamped).toEqual({ from: "allow", by: "policyCeiling:pathRoots" });
    expect(r.dp(0).by).toBe("human");
    await r.worker.close("client_request");
  });

  it("an EXPIRED park records it too — nobody answering does not change why they were asked", async () => {
    const { r } = await parked({ decide: () => CLAMPED_PARK, parkTimeoutMs: 1_000 });
    r.h.clock.advance(1_001);
    await flush();
    expect(r.dp(0).clamped).toEqual({ from: "allow", by: "policyCeiling:pathRoots" });
    await r.worker.close("client_request");
  });

  it("a TEARDOWN records it too", async () => {
    const { r } = await parked({ decide: () => CLAMPED_PARK });
    await r.strategy.settleAll("shutdown");
    await flush();
    expect(r.dp(0).clamped).toEqual({ from: "allow", by: "policyCeiling:pathRoots" });
    await r.worker.close("client_request");
  });

  it("…and an UNCLAMPED park still records nothing, so the field means what it says", async () => {
    const { r, id } = await parked();
    r.worker.answerInteraction(id, { action: "deny" }, WHO);
    await flush();
    expect(r.dp(0).clamped).toBeUndefined();
    await r.worker.close("client_request");
  });
});

describe("WorkerSnapshot.policyBlinded is STICKY and is actually set (M2-R19, finding V9)", () => {
  it("flips on the settlement that blinds the engine, and never goes back", async () => {
    const { r, id } = await parked({ allowAlways: "human" });
    expect(r.worker.snapshot().policyBlinded).toBeUndefined();

    r.worker.answerInteraction(id, { action: "allow", optionId: ALLOW_ALWAYS.optionId }, WHO);
    await flush();
    // F26: after ONE `allow_always` the host never asks again for this session and nothing on
    // the wire says so. This flag and the turn's `policy_blinded` warning are how WE say it.
    expect(r.worker.snapshot().policyBlinded).toBe(true);

    // Sticky: a later ordinary interaction does not un-blind anything.
    void r.agent.requestPermission("p2", {
      sessionId: "sess_recording",
      toolCall: { toolCallId: "call_2", title: "again", kind: "edit" },
      options: [...MENU],
    });
    await flush();
    const second = r.worker.interactions[0];
    if (second !== undefined) r.worker.answerInteraction(second.requestId, { action: "deny" }, WHO);
    await flush();
    expect(r.worker.snapshot().policyBlinded).toBe(true);
    await r.worker.close("client_request");
  });

  it("stays ABSENT on a worker that never granted one — an M1 snapshot grows no key", async () => {
    const { r, id } = await parked();
    r.worker.answerInteraction(id, { action: "deny" }, WHO);
    await flush();
    expect(r.worker.snapshot().policyBlinded).toBeUndefined();
    await r.worker.close("client_request");
  });
});

describe("§20.6's watch list reaches the TURN through idle._meta (finding V9)", () => {
  it("produces `unpoliced_tool_call` for a watched kind that never reached the engine", async () => {
    // The worker is handed the resolved list exactly as the registry hands it one.
    const r = await rig({ onUnresolved: "deny", alertOnUnpoliced: ["execute"] });
    const worker = r.worker;
    const accepted = await worker.prompt([TEXT("run it")], OWNER);
    await flush();
    // F40's shape: a read-only `execute` that ran to `completed` with NO permission request.
    await r.agent.update({
      sessionUpdate: "tool_call",
      toolCallId: "call_ls",
      title: "ls -A",
      kind: "execute",
      status: "completed",
    });
    r.agent.resolvePrompt("end_turn");
    await flush();
    r.h.clock.advance(250);
    await flush();

    const result = worker.turn(accepted.turnId).result as TurnResult;
    const warning = result.warnings.find((w) => w.code === "unpoliced_tool_call");
    // Before the fix `alertOnUnpoliced` was a config key nothing ever read: the fold existed,
    // had unit tests, and had no production caller anywhere.
    expect(warning).toBeDefined();
    expect(warning?.detail).toEqual({ toolCallId: "call_ls", kind: "execute" });
    await worker.close("client_request");
  });

  it("stamps NOTHING when nothing is watched, so an M1 idle grows no key", async () => {
    const r = await rig({ onUnresolved: "deny" });
    const accepted = await r.worker.prompt([TEXT("run it")], OWNER);
    await flush();
    await r.agent.update({
      sessionUpdate: "tool_call",
      toolCallId: "call_ls",
      title: "ls -A",
      kind: "execute",
      status: "completed",
    });
    r.agent.resolvePrompt("end_turn");
    await flush();
    r.h.clock.advance(250);
    await flush();
    const result = r.worker.turn(accepted.turnId).result as TurnResult;
    expect(result.warnings.map((w) => w.code)).not.toContain("unpoliced_tool_call");
    await r.worker.close("client_request");
  });
});
