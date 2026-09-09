import { describe, expect, it } from "vitest";
import { AcpRequestError, OmniError } from "@omni-acp/protocol";
import type {
  EventInput,
  InteractionContext,
  InteractionId,
  InteractionPayload,
  InteractionStrategy,
  MappedElicitationRequest,
  MappedPermissionRequest,
  PermissionOption,
  PolicyDecisionPayload,
  RequestPermissionResponse,
} from "@omni-acp/protocol";
import type { FakeClock } from "./fake-clock.js";

/**
 * The conformance suite EVERY `InteractionStrategy` must pass — `baselineInteractions` included.
 *
 * Running it against the baseline is the point, and it is what makes M2-PLAN §1.3's seam A more
 * than a hope: the wrapper preserves M1 by CONSTRUCTION, and this is where that claim is
 * executed. The companion golden asserts the baseline's envelopes are byte-identical to M1's
 * modulo `payloadVersion` and the additive fields (ruling M2-R3, review R4).
 *
 * The rows it covers, each a fact rather than a taste: the two-envelope order (§7.4); D4 rules
 * 1-6 including the `-32603` on rule 4 and the never-invented option id on rule 1; `settleAll`
 * resolving every held promise before anything else reaches the wire (§19.8); and idempotency of
 * `settleAll` and `close`, because every teardown path calls them blindly.
 *
 * A strategy that PARKS satisfies the same rows: what changes is WHEN the settlement envelopes
 * appear, not what they say, so the suite drives the park to a settlement through
 * `settleAll("close")` — the one verb every strategy has — rather than through a route.
 *
 * Owned by M2-A-WP-I.
 */
export function runInteractionConformance(
  name: string,
  make: () => InteractionStrategy,
  clock: FakeClock,
): void {
  const option = (optionId: string, kind: string): PermissionOption =>
    ({ optionId, kind, name: optionId }) as PermissionOption;

  const ALLOW_ONCE = option("allow-once", "allow_once");
  const ALLOW_ALWAYS = option("allow-with-updates", "allow_always");
  const REJECT = option("reject", "reject_once");
  const UNKNOWN = option("mystery", "some_future_kind");

  interface Rig {
    readonly strategy: InteractionStrategy;
    readonly emitted: readonly EventInput[];
    readonly parked: readonly InteractionId[];
    readonly failures: readonly string[];
    readonly ctx: InteractionContext;
    interactions(): InteractionPayload[];
    decisions(): PolicyDecisionPayload[];
    permission(options: readonly PermissionOption[]): Promise<RequestPermissionResponse | number>;
    elicitation(): Promise<unknown>;
  }

  const permissionRequest = (options: readonly PermissionOption[]): MappedPermissionRequest => {
    const toolCall = { toolCallId: "call_1", title: "Write hello.txt", kind: "edit" };
    return {
      sessionId: "sess_conformance",
      title: "Write hello.txt",
      subject: { type: "tool_call", toolCall },
      options,
      toolCallId: "call_1",
      raw: { sessionId: "sess_conformance", toolCall, options: [...options] },
    };
  };

  /** Transcript `12`'s shape, hand-narrowed — the same one `elicitationScript` puts on the wire. */
  const elicitationRequest = (): MappedElicitationRequest => {
    const raw = {
      mode: "form",
      sessionId: "sess_conformance",
      toolCallId: "toolu_ask_1",
      message: "What should the new file be named?",
      requestedSchema: {
        type: "object",
        properties: {
          question_0: {
            type: "string",
            title: "File name",
            oneOf: [{ const: "notes.md", title: "notes.md", description: "a file" }],
          },
          question_0_custom: {
            type: "string",
            title: "Other",
            _meta: {
              _askUserQuestionCustomAnswer: { questionId: "question_0", isCustomAnswer: true },
            },
          },
        },
      },
    };
    return {
      mode: "form",
      sessionId: "sess_conformance",
      toolCallId: "toolu_ask_1",
      requestId: null,
      message: "What should the new file be named?",
      // The Land-step fallback's honest shape: the strategy re-maps from `raw` (review R11), so a
      // conformance run that handed it a pre-mapped form would test the fixture, not the code.
      fields: [],
      unmodelled: ["question_0", "question_0_custom"],
      raw,
    };
  };

  const rig = (): Rig => {
    const emitted: EventInput[] = [];
    const parked: InteractionId[] = [];
    const failures: string[] = [];
    const strategy = make();
    const ctx: InteractionContext = {
      turnId: null,
      emit: (inputs) => emitted.push(...inputs),
      park: (id) => {
        parked.push(id);
        return () => {
          const at = parked.indexOf(id);
          if (at !== -1) parked.splice(at, 1);
        };
      },
      failTurn: (reason) => failures.push(reason),
    };
    const payloads = <T>(kind: string): T[] =>
      emitted.filter((e) => e.kind === kind).map((e) => e.payload as T);
    return {
      strategy,
      emitted,
      parked,
      failures,
      ctx,
      interactions: () => payloads<InteractionPayload>("acp.interaction"),
      decisions: () => payloads<PolicyDecisionPayload>("omni.policy_decision"),
      permission: async (options) => {
        try {
          return await strategy.permission(permissionRequest(options), ctx);
        } catch (e) {
          if (e instanceof AcpRequestError) return e.code;
          throw e;
        }
      },
      elicitation: () => strategy.elicitation(elicitationRequest(), ctx),
    };
  };

  /**
   * Drives one request to a terminal state, whether the strategy answered it or parked it.
   *
   * The two microtask turns are not decoration: `permission()` runs synchronously up to its first
   * `await`, so a park's `pending` set is not observable in the same tick the call was made — and
   * a suite that checked too early would hang on the very arm it exists to cover.
   */
  const settle = async (r: Rig, live: Promise<unknown>): Promise<unknown> => {
    await Promise.resolve();
    await Promise.resolve();
    if (r.strategy.pending.length > 0) await r.strategy.settleAll("close");
    return await live;
  };

  /** Every terminal status a settlement may carry; `pending` is NOT one (ruling M2-R5). */
  const TERMINAL = ["answered", "failed", "expired", "cancelled"];

  describe(`InteractionStrategy conformance: ${name}`, () => {
    it("declares a client capability object, and never a `url` mode (§19.2)", () => {
      const caps = make().clientCapabilities;
      expect(typeof caps).toBe("object");
      expect(JSON.stringify(caps)).not.toContain('"url"');
    });

    it("emits acp.interaction then omni.policy_decision, in that order, once each (§7.4)", async () => {
      const r = rig();
      await settle(r, r.permission([ALLOW_ONCE, REJECT]));
      const kinds = r.emitted.map((e) => e.kind);
      expect(kinds.at(-2)).toBe("acp.interaction");
      expect(kinds.at(-1)).toBe("omni.policy_decision");
      // Ruling M2-R4: exactly ONE decision per interaction, at settlement.
      expect(r.decisions()).toHaveLength(1);
      const ids = new Set(r.interactions().map((p) => p.requestId));
      expect(ids.size).toBe(1);
      expect(r.decisions()[0]?.requestId).toBe([...ids][0]);
    });

    it("stamps both envelopes on the SAME requestId and carries `offered` verbatim", async () => {
      const r = rig();
      await settle(r, r.permission([ALLOW_ONCE, ALLOW_ALWAYS, REJECT]));
      expect(r.decisions()[0]?.offered).toEqual([ALLOW_ONCE, ALLOW_ALWAYS, REJECT]);
      expect(r.decisions()[0]?.title).toBe("Write hello.txt");
      expect(r.decisions()[0]?.toolCallId).toBe("call_1");
    });

    it("D4 rule 1: every optionId it answers with was OFFERED", async () => {
      const r = rig();
      const offered = [ALLOW_ONCE, ALLOW_ALWAYS, REJECT];
      const answer = await settle(r, r.permission(offered));
      const chosen = r.decisions()[0]?.optionId;
      if (chosen !== null && chosen !== undefined) {
        expect(offered.map((o) => o.optionId)).toContain(chosen);
      }
      if (typeof answer === "object" && answer !== null && "outcome" in answer) {
        const outcome = (answer as RequestPermissionResponse).outcome;
        expect(outcome.outcome).toBe("selected");
        if (outcome.outcome === "selected") {
          expect(offered.map((o) => o.optionId)).toContain(outcome.optionId);
        }
      }
    });

    it("D4 rule 3: it NEVER selects an allow_always, even when that is all there is", async () => {
      const r = rig();
      const answer = await settle(r, r.permission([ALLOW_ALWAYS]));
      // The rule is ABSOLUTE and arm-independent: whether this strategy denies immediately or
      // parks and is then torn down, the one thing it may never do is name the `allow_always`.
      // F26 is the measured cost — one such grant let a second Write complete with no second
      // permission request, and nothing on the wire announced it.
      expect(r.decisions()[0]?.optionId).not.toBe(ALLOW_ALWAYS.optionId);
      expect(r.decisions()[0]?.optionId).toBeNull();
      if (typeof answer === "object" && answer !== null && "outcome" in answer) {
        const outcome = (answer as RequestPermissionResponse).outcome;
        expect(outcome.outcome === "selected" && outcome.optionId).not.toBe(
          ALLOW_ALWAYS.optionId,
        );
      }
      expect(TERMINAL).toContain(r.interactions().at(-1)?.status);
    });

    it("D4 rule 4: an EMPTY menu answers -32603 — never an invented id, never a cancel", async () => {
      const r = rig();
      expect(await settle(r, r.permission([]))).toBe(-32603);
      expect(r.decisions()[0]?.optionId).toBeNull();
      // Rule 5: `outcome:"cancelled"` is not a word this repository can put on the wire.
      expect(JSON.stringify(r.emitted)).not.toContain('"outcome":"cancelled"');
    });

    it("D4 rule 6: an UNKNOWN kind is a non-grant — it can never be selected", async () => {
      const r = rig();
      const answer = await settle(r, r.permission([UNKNOWN]));
      expect(r.decisions()[0]?.optionId).toBeNull();
      if (typeof answer === "object" && answer !== null && "outcome" in answer) {
        const outcome = (answer as RequestPermissionResponse).outcome;
        expect(outcome.outcome === "selected" && outcome.optionId).not.toBe(UNKNOWN.optionId);
      }
    });

    it('D4 rule 5: `outcome:"cancelled"` never reaches the wire', async () => {
      for (const options of [[ALLOW_ONCE, REJECT], [REJECT], [ALLOW_ALWAYS], []]) {
        const r = rig();
        const answer = await settle(r, r.permission(options));
        if (typeof answer === "object" && answer !== null && "outcome" in answer) {
          expect((answer as RequestPermissionResponse).outcome.outcome).toBe("selected");
        }
      }
    });

    it("NEVER rejects with anything but an AcpRequestError (§19.8, F1)", async () => {
      const r = rig();
      const thrown = await settle(
        r,
        r.strategy.permission(permissionRequest([]), r.ctx).then(
          () => null,
          (e: unknown) => e,
        ),
      );
      expect(thrown).toBeInstanceOf(AcpRequestError);
      // A rejected promise here is an agent waiting forever on a JSON-RPC id, so the ONE
      // rejection shape a strategy may produce is the one the link turns into a JSON-RPC error.
      expect(thrown).not.toBeInstanceOf(OmniError);
    });

    it("answers an elicitation with a form action, and never leaves it hanging (D10, M2-R15)", async () => {
      const r = rig();
      const answer = await settle(r, r.elicitation());
      expect(answer).toMatchObject({ action: expect.any(String) as unknown as string });
      expect(["accept", "decline", "cancel"]).toContain(
        (answer as { action: string }).action,
      );
    });

    it("`answer` on an id it never held is interaction_not_found (§19.6, M2-R2)", () => {
      const strategy = make();
      let thrown: unknown;
      try {
        strategy.answer("x_00000000000000000000000099" as InteractionId, { action: "deny" }, {
          tokenId: "tok_conformance" as never,
          clientId: "cli_conformance",
        });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(OmniError);
      expect((thrown as OmniError).code).toBe("interaction_not_found");
      expect((thrown as OmniError).status).toBe(404);
    });

    it("`get` of an unknown id is null, and `pending` starts empty", () => {
      const strategy = make();
      expect(strategy.get("x_00000000000000000000000099" as InteractionId)).toBeNull();
      expect(strategy.pending).toEqual([]);
    });

    it("settleAll leaves NO pending interaction and is idempotent (§19.8)", async () => {
      const r = rig();
      const live = r.permission([ALLOW_ONCE, REJECT]);
      await Promise.resolve();
      await Promise.resolve();
      await r.strategy.settleAll("close");
      await live;
      expect(r.strategy.pending).toEqual([]);
      const before = r.emitted.length;
      await r.strategy.settleAll("close");
      await r.strategy.settleAll("shutdown");
      expect(r.emitted.length).toBe(before);
      // Every requestId's LAST frame is terminal: a log that ends on a `pending` one lies.
      const last = new Map<string, string>();
      for (const p of r.interactions()) last.set(p.requestId, p.status);
      for (const status of last.values()) expect(status).not.toBe("pending");
    });

    it("close() is idempotent, never throws, and leaves no timer behind (review R15)", async () => {
      const r = rig();
      const live = r.permission([ALLOW_ONCE, REJECT]);
      await Promise.resolve();
      await Promise.resolve();
      r.strategy.close();
      r.strategy.close();
      // Commit 7c80f15 is the recording of what one surviving timer costs: a lease's TTL timer
      // kept the whole process alive.
      expect(clock.pendingTimers).toBe(0);
      await settle(r, live);
    });

    it("un-parks everything it parked, so `requires_action` cannot outlive the settlement", async () => {
      const r = rig();
      const live = r.permission([ALLOW_ONCE, REJECT]);
      await settle(r, live);
      expect(r.parked).toEqual([]);
    });

    it("is TOTAL over two requests in flight at once", async () => {
      const r = rig();
      const a = r.strategy.permission(permissionRequest([ALLOW_ONCE, REJECT]), r.ctx);
      const b = r.strategy.elicitation(elicitationRequest(), r.ctx);
      const settled = [
        a.then(
          () => "a",
          () => "a",
        ),
        b.then(
          () => "b",
          () => "b",
        ),
      ];
      await Promise.resolve();
      await Promise.resolve();
      if (r.strategy.pending.length > 0) await r.strategy.settleAll("cancel");
      expect(await Promise.all(settled)).toEqual(["a", "b"]);
      expect(r.strategy.pending).toEqual([]);
      // No cross-talk: every decision names its OWN request, and no id is recorded twice.
      const ids = r.decisions().map((d) => d.requestId);
      expect(new Set(ids).size).toBe(ids.length);
      // The permission always leaves one. The elicitation arm may not — `baselineInteractions`
      // declares no capability, so D10 says the method is unreachable and its `decline` is a
      // courtesy rather than a decision (M2-R15, §1.3 seam A).
      expect(ids.length).toBeGreaterThanOrEqual(1);
      // Every requestId's LAST frame is terminal. A park emits TWO frames for one id (§19.10),
      // which is exactly why a consumer keys on `requestId` and never counts frames.
      const last = new Map<string, string>();
      for (const p of r.interactions()) last.set(p.requestId, p.status);
      for (const status of last.values()) expect(TERMINAL).toContain(status);
    });
  });
}
