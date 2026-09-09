import { describe, expect, it } from "vitest";
import { baselineInteractions, createBaselineResponder } from "@omni-acp/core";
import type {
  EventEnvelope,
  InteractionPayload,
  InteractionStrategy,
  PermissionOption,
  PolicyDecisionPayload,
} from "@omni-acp/protocol";
import { scriptedAgent } from "@omni-acp/testkit";
import { flush, harness, OWNER, TEXT, type Harness } from "./support/harness.js";

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
        // M2 widens `InteractionRecord` (§5.8.5). Every added field has an M1 reading that is the
        // TRUTH rather than a guess, which is exactly why this row can be written out in full: an
        // M1 daemon knew one kind, answered inline through the baseline responder, and parked
        // nothing — so `kind`, `method`, `by` and `parkedMs` are what they are here, forever.
        kind: "permission",
        method: "session/request_permission",
        title: "scripted permission 1",
        decision: "deny",
        by: "baseline",
        parkedMs: 0,
        // F32's join: the same interaction is ALSO a `tool_call` in the stream. `toolCalls` keeps
        // the tool call, `interactions` keeps the decision, neither duplicates the other.
        toolCallId: "call_1",
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

/**
 * The SAME cases, with `baselineInteractions(responder, clock)` INJECTED.
 *
 * M2-PLAN §1.3's seam A says `InteractionStrategy` supersedes `PermissionResponder` by WRAPPING
 * it, so every M1 behaviour is preserved by construction rather than by care. The block above is
 * the un-wrapped path — `worker.ts`'s `#baselinePermission`, still frozen, still
 * `payloadVersion: 1` — and it runs unedited. This block is the wrapper, and the only differences
 * between them are ruling M2-R3's `payloadVersion` flip and §19.10's additive fields:
 *
 *   payloadVersion 1 -> 2 · request: <verbatim v1> -> <mapped {title,subject,options}> + raw
 *   answer: {optionId, by} -> {optionId, by, parkedMs: 0}
 *   + kind, + toolCallId · decision: + kind, + method, + by, + ruleSource, + parkedMs
 *
 * Nothing else moved, and `core/test/worker/interaction/golden-shape.test.ts` asserts that
 * against the checked-in M2 goldens key by key (WP-I acceptance 1).
 */
describe("the same handling through baselineInteractions (M2-PLAN §1.3 seam A)", () => {
  /**
   * The harness's lifecycle double, with `MappedPermissionRequest.raw` filled in.
   *
   * `support/lifecycle-normalizer.ts` predates review R11's `raw` field and belongs to M1-WP-C, so
   * these cases supply what the REAL `createNormalizer` already supplies
   * (`normalizer/map/permission.ts`: `raw: record(r["raw"]) ?? r`). Without it every
   * `acp.interaction.raw` below would be `undefined` and §7.5's audit — "the agent's bytes,
   * untouched" — would be asserted against a hole. The block ABOVE does not need it: `worker.ts`'s
   * frozen `#baselinePermission` puts the verbatim request in `request` and reads no `raw` at all.
   */
  const withRaw = (h: ReturnType<typeof harness>): { normalizer: Harness["normalizer"] } => {
    const base = h.normalizer;
    return {
      normalizer: {
        ...base,
        mapPermissionRequest: (req: unknown) => ({
          ...base.mapPermissionRequest(req),
          raw: typeof req === "object" && req !== null ? (req as Record<string, unknown>) : {},
        }),
      },
    };
  };

  const wrapped = (
    h: ReturnType<typeof harness>,
    mode: "allow" | "deny" = "deny",
  ): { interactions: InteractionStrategy; normalizer: Harness["normalizer"] } => ({
    interactions: baselineInteractions(createBaselineResponder(mode, h.clock), h.clock),
    ...withRaw(h),
  });

  it("auto-denies, answers the agent, and appends the SAME two envelopes in the SAME order", async () => {
    const h = harness();
    const agent = scriptedAgent();
    h.supervisor.enqueue(agent);
    const w = await h.create({ overrides: wrapped(h) });

    const accepted = await w.prompt([TEXT("please edit")], OWNER);
    await flush();
    expect(await agent.requestPermission([ALLOW, REJECT])).toBe("reject");

    const interaction = h.log.all.find((e) => e.kind === "acp.interaction");
    const decision = h.log.all.find((e) => e.kind === "omni.policy_decision");
    expect(h.log.all.indexOf(decision as EventEnvelope)).toBe(
      h.log.all.indexOf(interaction as EventEnvelope) + 1,
    );

    const ip = payloadOf<InteractionPayload>(interaction);
    expect(interaction?.payloadVersion).toBe(2);
    expect(ip.method).toBe("session/request_permission");
    expect(ip.kind).toBe("permission");
    expect(ip.status).toBe("answered");
    expect(ip.answer).toEqual({ optionId: "reject", by: "baseline", parkedMs: 0 });
    expect(ip.toolCallId).toBe("call_1");
    // The mapped view, and the agent's bytes beside it — M2-R3's whole ruling in two assertions.
    expect(ip.request).toEqual({
      title: "scripted permission 1",
      subject: {
        type: "tool_call",
        toolCall: { toolCallId: "call_1", title: "scripted permission 1" },
      },
      options: [ALLOW, REJECT],
    });
    expect((ip.raw as Record<string, unknown>)["toolCall"]).toMatchObject({ toolCallId: "call_1" });

    const dp = payloadOf<PolicyDecisionPayload>(decision);
    expect(dp).toMatchObject({
      kind: "permission",
      method: "session/request_permission",
      decision: "deny",
      by: "baseline",
      ruleSource: "baseline",
      rule: "m0:auto-deny",
      optionId: "reject",
      parkedMs: 0,
      title: "scripted permission 1",
    });
    expect(dp.offered).toEqual([ALLOW, REJECT]);
    expect(ip.requestId).toBe(dp.requestId);
    // M1's synthesized spelling is KEPT: the wrapper mints nothing (WP-I acceptance 1).
    expect(dp.requestId).toMatch(/^perm_\d+_\d+$/);
    expect(interaction?.turnId).toBe(accepted.turnId);
    expect(decision?.turnId).toBe(accepted.turnId);

    agent.resolvePrompt("end_turn");
    await flush();
    h.clock.advance(250);
    await flush();
    // The turn projection is UNCHANGED — the same row the un-wrapped path produces above.
    expect(w.turn(accepted.turnId).result?.interactions).toEqual([
      {
        requestId: dp.requestId,
        kind: "permission",
        method: "session/request_permission",
        title: "scripted permission 1",
        decision: "deny",
        by: "baseline",
        parkedMs: 0,
        toolCallId: "call_1",
        optionId: "reject",
        rule: "m0:auto-deny",
        at: decision?.ts,
      },
    ]);
    await w.close("client_request");
  });

  it("replies -32603 and records status:'failed' when nothing acceptable is offered (rule 4)", async () => {
    const h = harness();
    const agent = scriptedAgent();
    h.supervisor.enqueue(agent);
    const w = await h.create({ overrides: wrapped(h) });

    await w.prompt([TEXT("hi")], OWNER);
    await flush();
    expect(await agent.requestPermission([option("allow_always", "allow_always")])).toEqual({
      error: -32603,
    });

    const ip = payloadOf<InteractionPayload>(h.log.all.find((e) => e.kind === "acp.interaction"));
    expect(ip.status).toBe("failed");
    expect(ip.answer).toEqual({ optionId: null, by: "baseline", parkedMs: 0 });
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
    await w.close("client_request");
  });

  it("the allow branch picks allow_once and NEVER allow_always (D4 rules 2 and 3)", async () => {
    const h = harness();
    const agent = scriptedAgent();
    h.supervisor.enqueue(agent);
    const w = await h.create({ overrides: wrapped(h, "allow") });

    await w.prompt([TEXT("hi")], OWNER);
    await flush();
    expect(
      await agent.requestPermission([option("allow_always", "allow_always"), ALLOW, REJECT]),
    ).toBe("allow");

    expect(
      payloadOf<PolicyDecisionPayload>(h.log.all.find((e) => e.kind === "omni.policy_decision")),
    ).toMatchObject({ decision: "allow", rule: "m0:auto-allow", optionId: "allow" });
    await w.close("client_request");
  });

  it("re-checks the responder's answer against the OFFERED menu (D4 rule 1, §12.6)", async () => {
    // `worker.ts`'s forge guard, reproduced in the wrapper: a responder that names an id nobody
    // offered is folded into rule 4's answer — `-32603`, `decision:"error"`, no invented id
    // (rule 1) and no cancel (rule 5). Corpus 09 is the recording of what a violation costs, and
    // its lesson is that it CANNOT be caught downstream.
    const h = harness();
    const agent = scriptedAgent();
    h.supervisor.enqueue(agent);
    const w = await h.create({
      overrides: {
        ...withRaw(h),
        interactions: baselineInteractions(
          {
            decide: (req) => ({
              response: { outcome: { outcome: "selected", optionId: "not-on-the-menu" } },
              record: {
                requestId: "perm_forged" as InteractionPayload["requestId"],
                title: req.title,
                decision: "allow",
                rule: "planted:invented-option",
                optionId: "not-on-the-menu",
                offered: req.options,
                toolCallId: req.toolCallId,
              },
            }),
          },
          h.clock,
        ),
      },
    });

    await w.prompt([TEXT("hi")], OWNER);
    await flush();
    expect(await agent.requestPermission([ALLOW, REJECT])).toEqual({ error: -32603 });

    const ip = payloadOf<InteractionPayload>(h.log.all.find((e) => e.kind === "acp.interaction"));
    expect(ip.status).toBe("failed");
    expect(ip.answer).toEqual({ optionId: null, by: "baseline", parkedMs: 0 });
    const dp = payloadOf<PolicyDecisionPayload>(
      h.log.all.find((e) => e.kind === "omni.policy_decision"),
    );
    expect(dp.decision).toBe("error");
    expect(dp.optionId).toBeNull();
    expect(dp.rule).toBe("planted:invented-option");
    await w.close("client_request");
  });

  it('declares NOTHING — D10 gates elicitation on onUnresolved:"park", and this never parks', async () => {
    const h = harness();
    const strategy = baselineInteractions(createBaselineResponder("deny", h.clock), h.clock);
    expect(strategy.clientCapabilities).toEqual({});
    expect(strategy.pending).toEqual([]);
    expect(strategy.get("x_00000000000000000000000001" as never)).toBeNull();
    // M2-R15: registered always, answers `decline`, never `-32601` — and unreachable in practice
    // precisely because `clientCapabilities` above declares nothing (F28).
    await expect(strategy.elicitation({} as never, {} as never)).resolves.toEqual({
      action: "decline",
    });
    // Nothing is ever held open, so both teardown members are no-ops that never throw.
    await expect(strategy.settleAll("close")).resolves.toBeUndefined();
    expect(() => {
      strategy.close();
    }).not.toThrow();
    expect(() =>
      strategy.answer("x_00000000000000000000000001" as never, { action: "deny" }, {
        tokenId: OWNER.tokenId,
        clientId: OWNER.clientId,
      }),
    ).toThrow(/no interaction/);
  });
});
