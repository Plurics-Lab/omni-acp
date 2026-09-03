import { describe, expect, it } from "vitest";
import { createBaselineResponder } from "@omni-acp/core";
import type {
  EventEnvelope,
  InteractionPayload,
  PermissionOption,
  PolicyDecisionPayload,
} from "@omni-acp/protocol";
import { scriptedAgent } from "@omni-acp/testkit";
import { flush, harness, OWNER, TEXT } from "./support/harness.js";

const option = (optionId: string, kind: string): PermissionOption =>
  ({ optionId, kind, name: optionId }) as PermissionOption;

const ALLOW = option("allow", "allow_once");
const REJECT = option("reject", "reject_once");

const payloadOf = <T>(e: EventEnvelope | undefined): T => (e as EventEnvelope).payload as T;

/**
 * F1, made mechanical. The M0 acceptance fixture issues `session/request_permission` mid-turn and
 * awaits it forever, so an unanswered request is not a degraded turn — it is a turn that never
 * ends. §7.4 fixes both the answer and the two envelopes that record it.
 */
describe("permission handling (WP-4 acceptance 7, §7.4)", () => {
  it("auto-denies, answers the agent, and appends interaction + policy_decision", async () => {
    const h = harness();
    const agent = scriptedAgent();
    h.supervisor.enqueue(agent);
    const w = await h.create();

    const accepted = await w.prompt([TEXT("please edit")], OWNER);
    await flush();
    const answer = await agent.requestPermission([ALLOW, REJECT]);
    // The agent got a real answer, which is the only reason its turn can now finish.
    expect(answer).toBe("reject");

    const interaction = h.log.all.find((e) => e.kind === "acp.interaction");
    const decision = h.log.all.find((e) => e.kind === "omni.policy_decision");
    expect(interaction).toBeDefined();
    expect(decision).toBeDefined();

    const ip = payloadOf<InteractionPayload>(interaction);
    expect(ip.method).toBe("session/request_permission");
    expect(ip.status).toBe("answered");
    expect(ip.answer).toEqual({ optionId: "reject", by: "baseline" });
    // The request is kept verbatim for audit — including the options menu as offered.
    expect((ip.request as Record<string, unknown>)["toolCall"]).toMatchObject({
      toolCallId: "call_1",
    });

    const dp = payloadOf<PolicyDecisionPayload>(decision);
    expect(dp).toMatchObject({
      decision: "deny",
      rule: "m0:auto-deny",
      optionId: "reject",
      title: "scripted permission 1",
    });
    expect(dp.offered).toEqual([ALLOW, REJECT]);
    // One requestId, both envelopes: this is what lets `reduceTurn` fold ONE kind (review R9).
    expect(ip.requestId).toBe(dp.requestId);
    expect(interaction?.turnId).toBe(accepted.turnId);
    expect(decision?.turnId).toBe(accepted.turnId);

    agent.resolvePrompt("end_turn");
    await flush();
    h.clock.advance(250);
    await flush();

    const result = w.turn(accepted.turnId).result;
    expect(result?.interactions).toEqual([
      {
        requestId: dp.requestId,
        title: "scripted permission 1",
        decision: "deny",
        optionId: "reject",
        rule: "m0:auto-deny",
        at: decision?.ts,
      },
    ]);
  });

  it("replies -32603 and records status:'failed' when nothing acceptable is offered (rule 4)", async () => {
    const h = harness();
    const agent = scriptedAgent();
    h.supervisor.enqueue(agent);
    const w = await h.create();

    await w.prompt([TEXT("hi")], OWNER);
    await flush();
    const answer = await agent.requestPermission([option("allow_always", "allow_always")]);
    expect(answer).toEqual({ error: -32603 });

    const ip = payloadOf<InteractionPayload>(h.log.all.find((e) => e.kind === "acp.interaction"));
    expect(ip.status).toBe("failed");
    expect(ip.answer).toEqual({ optionId: null, by: "baseline" });
    const dp = payloadOf<PolicyDecisionPayload>(
      h.log.all.find((e) => e.kind === "omni.policy_decision"),
    );
    expect(dp.decision).toBe("error");
    expect(dp.optionId).toBeNull();

    // Rule 5 in situ: the turn was NOT cancelled, so the agent can still finish it.
    agent.resolvePrompt("end_turn");
    await flush();
    h.clock.advance(250);
    await flush();
    expect(w.snapshot().state).toBe("ready");
  });

  it("the allow branch is reachable when wired, and picks allow_once (never allow_always)", async () => {
    // M0 wires "deny" only; this proves the other branch is implemented rather than aspirational.
    const h = harness();
    const agent = scriptedAgent();
    h.supervisor.enqueue(agent);
    const w = await h.create({
      overrides: { responder: createBaselineResponder("allow", h.clock) },
    });

    await w.prompt([TEXT("hi")], OWNER);
    await flush();
    const answer = await agent.requestPermission([
      option("allow_always", "allow_always"),
      ALLOW,
      REJECT,
    ]);
    expect(answer).toBe("allow");

    const dp = payloadOf<PolicyDecisionPayload>(
      h.log.all.find((e) => e.kind === "omni.policy_decision"),
    );
    expect(dp).toMatchObject({ decision: "allow", rule: "m0:auto-allow", optionId: "allow" });
  });

  it("answers a permission that arrives with no turn in flight, with turnId null", async () => {
    const h = harness();
    const agent = scriptedAgent();
    h.supervisor.enqueue(agent);
    await h.create();

    const answer = await agent.requestPermission([ALLOW, REJECT]);
    expect(answer).toBe("reject");
    expect(h.log.all.find((e) => e.kind === "omni.policy_decision")?.turnId).toBeNull();
  });
});
