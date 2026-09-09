import type { EventEnvelope, PolicyDecisionPayload } from "@omni-acp/protocol";
import { allEnvelopes, assert, type CompatCase, type CompatContext } from "./support.js";

/**
 * Compat cases for the policy rule engine and D4's six hard rules.
 *
 * Every case declares what it `requires`, so an agent that cannot do it is SKIPPED with a printed
 * source and a reason rather than silently passed — and the suite refuses to assert an
 * `unverified` descriptor row at all. codex-acp never asks for permission in any mode, inside or
 * outside the workspace, so its `provides:` omits `permission` and every case here is a printed
 * `capability` skip for it. That disagreement is the value (§27.1).
 *
 * **Both cases create their OWN worker rather than taking `ctx.worker()`.** The shared one is
 * created lazily and then lives through M1's `hibernate-wake` and `restart-survives`, so by the
 * time an M2 case runs it is `closed` — a real failure this file hit on its first run, and the
 * reason every case here that prompts pays for its own process.
 *
 * Owned by M2-B-WP-P.
 */

/** Every `omni.policy_decision` this worker has written, oldest first. */
async function decisionsOf(
  ctx: CompatContext,
  workerId: string,
): Promise<readonly PolicyDecisionPayload[]> {
  return (await allEnvelopes(ctx, workerId))
    .filter((e: EventEnvelope) => e.kind === "omni.policy_decision")
    .map((e) => e.payload as PolicyDecisionPayload);
}

/**
 * D4's rules 1, 3, 4 and 6, over whatever menus this agent actually sent.
 *
 * It is the compat half of `runPolicyConformance`: the unit suite generates 64 menus no agent
 * sends, and this asserts the same invariants over the ones an agent really did send, whatever
 * the daemon's policy decided. Every one of them is invisible in `stopReason` (corpus 09), which
 * is why they are asserted against our OWN `omni.policy_decision` envelopes.
 */
async function assertHardRules(ctx: CompatContext, workerId: string): Promise<void> {
  const decisions = await decisionsOf(ctx, workerId);
  assert(decisions.length > 0, "a write turn recorded no policy decision at all");

  for (const d of decisions) {
    // Rule 1: only ever an id the agent offered. Never invented.
    if (d.optionId !== null) {
      assert(
        d.offered.some((o) => o.optionId === d.optionId),
        `answered with optionId "${d.optionId}", which was never offered`,
      );
    }

    // Rule 3: never a persistent grant, whatever its label said. F27 is the recording of why the
    // label may not be read: one `{optionId:"allow-with-updates", kind:"allow_always"}` arrived
    // under three different English names, one of them embedding a path.
    const chosen = d.offered.find((o) => o.optionId === d.optionId);
    assert(
      chosen === undefined || chosen.kind !== "allow_always",
      `selected "${String(d.optionId)}", whose kind is a persistent grant`,
    );

    // Rule 4's record: an error carries no id, and an id is never recorded as an error.
    assert(
      (d.decision === "error") === (d.optionId === null),
      `decision "${d.decision}" disagrees with optionId ${JSON.stringify(d.optionId)}`,
    );

    // Rule 6: the only kinds ever selected are the two known grants — fail closed.
    assert(
      chosen === undefined || chosen.kind === "allow_once" || chosen.kind === "reject_once",
      `selected an option whose kind "${String(chosen?.kind)}" is not a known grant`,
    );
  }
}

export function permissionCases(): readonly CompatCase[] {
  return [
    {
      id: "permission-hard-rules",
      requires: ["permission"],
      async run(ctx) {
        const worker = await ctx.harness.A.createAgent(ctx.agentId, { cwd: ctx.cwd });
        try {
          await worker.prompt(ctx.prompts.write);
          await assertHardRules(ctx, worker.id);
        } finally {
          await worker.close().catch(() => undefined);
        }
      },
    },

    {
      /**
       * §27.2's `permission-allow` row: allow the edit, assert the file exists AND that
       * `decision:"allow"` names an id drawn from `offered`.
       *
       * It `requires: ["policy"]` on purpose, and no agent declares that today. The reason is
       * recorded rather than worked around: creating a worker under a NAMED policy needs
       * `CreateAgentOptions.policy` on the SDK (`packages/client/src/server.ts`, M2-WP-J's), and
       * the daemon's `AuthContext.assertPolicy` is still the Land stub. Both are one-liners at
       * the join, and until they land this case is a printed `capability` skip for every agent
       * rather than a silent pass — §18.3's rule doing exactly its job.
       */
      id: "permission-allow",
      requires: ["permission", "policy"],
      async run(ctx) {
        const worker = await ctx.harness.A.createAgent(ctx.agentId, { cwd: ctx.cwd });
        try {
          const result = await worker.prompt(ctx.prompts.write);
          assert(result.stopReason === "end_turn", `stopReason is ${String(result.stopReason)}`);
          assert(result.deniedToolCalls.length === 0, "an allowed turn reported a denial");

          await assertHardRules(ctx, worker.id);
          const allowed = (await decisionsOf(ctx, worker.id)).filter((d) => d.decision === "allow");
          assert(allowed.length > 0, "an allowed turn recorded no allow decision");

          const { readdir } = await import("node:fs/promises");
          const entries = await readdir(ctx.cwd);
          assert(entries.length > 0, "an allowed write left the workspace empty");
        } finally {
          await worker.close().catch(() => undefined);
        }
      },
    },
  ];
}
