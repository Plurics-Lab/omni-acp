import { describe, expect, it } from "vitest";
import type { InteractionStrategy, RequestPermissionResponse } from "@omni-acp/protocol";
import { OWNER, TEXT } from "../support/harness.js";
import { flush, MENU, rig } from "./support/rig.js";

/**
 * §19.7 rule 1 and D4 rule 5, at THE POINT THAT EMITS THE ANSWER — review finding V4.
 *
 * §12.6 already put this check on `#baselinePermission`, with the argument spelled out there:
 * `DaemonDeps.responder` is a public injection point, and "a rule that only one implementation
 * upholds is a property of that implementation". `DaemonDeps.interactions` is a public injection
 * point of exactly the same kind — it is the seam M2's strategy lands on and the one an embedder
 * replaces — and on the shipped M2 path NOTHING re-checked the strategy's answer: §19.7's claimed
 * "three independent checks" were two, and the third lived inside the strategy that happens to be
 * wired today.
 *
 * Corpus 09 is the recording of what a forged option id costs and why it cannot be caught
 * downstream: the agent failed every tool call and still ended the turn `end_turn`, so
 * `stopReason` reports nothing at all.
 *
 * Owned by M2-B (review round 2).
 */

/** A strategy that answers with an option the agent never offered. The whole point of the guard. */
function forging(answer: RequestPermissionResponse): (d: unknown) => InteractionStrategy {
  return () =>
    ({
      clientCapabilities: {},
      permission: () => Promise.resolve(answer),
      elicitation: () => Promise.resolve({ action: "decline" }),
      answer: () => {
        throw new Error("not part of this test");
      },
      get: () => null,
      pending: [],
      settleAll: () => Promise.resolve(),
      close: () => {},
    }) as unknown as InteractionStrategy;
}

const ask = async (strategy: (d: unknown) => InteractionStrategy): Promise<unknown> => {
  const r = await rig({ strategy: strategy as never });
  await r.worker.prompt([TEXT("please edit")], OWNER);
  await flush();
  return await r.agent.requestPermission("p1", {
    sessionId: "sess_recording",
    toolCall: { toolCallId: "call_1", title: "Write hello.txt", kind: "edit" },
    options: [...MENU],
  });
};

describe("the emit point re-checks the injected strategy's answer (review finding V4)", () => {
  it("folds an UN-OFFERED optionId into rule 4's -32603 rather than putting it on the wire", async () => {
    // `forged` is not in `MENU`. Without the guard this reaches the agent verbatim, which is
    // precisely corpus 09.
    expect(await ask(forging({ outcome: { outcome: "selected", optionId: "forged" } }))).toEqual({
      error: -32603,
    });
  });

  it("refuses a CANCELLED outcome too — D4 rule 5 is absolute", async () => {
    // Cancelling would kill the WHOLE turn over one action our own strategy got wrong, so the
    // answer is the same `-32603` and never a cancel.
    expect(
      await ask(forging({ outcome: { outcome: "cancelled" } } as RequestPermissionResponse)),
    ).toEqual({ error: -32603 });
  });

  it("lets an OFFERED optionId through untouched — the guard is a check, not a policy", async () => {
    expect(await ask(forging({ outcome: { outcome: "selected", optionId: "reject" } }))).toEqual({
      result: { outcome: { outcome: "selected", optionId: "reject" } },
    });
  });
});
