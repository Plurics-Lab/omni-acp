import type { CreateAgentOptions, InteractionRequestHandle, Worker } from "@omni-acp/client";
import type { EventEnvelope, InteractionPayload } from "@omni-acp/protocol";
import { until } from "../harness.js";
import { allEnvelopes, assert, asRecord, type CompatCase, type CompatContext } from "./support.js";

/**
 * Compat cases for `elicitation/create`, the park lifecycle and `requires_action` (§27.2).
 *
 * All three require `elicitation`, so an agent that does not declare it in `provides:` is a
 * printed `capability` skip with a source and never a silent pass — which is the whole value of
 * the taxonomy here, because the two real agents disagree about exactly this: claude-acp elicits
 * and codex-acp never does, and codex's own README is the skip's source (§27.1, §11.9).
 *
 * `interaction-park-timeout` exists to DISCOVER what a real agent does with a long park, not to
 * confirm it — §11.9's first risk, and the first M2 experiment to run. Both corpus elicitations
 * were answered in about a millisecond, so nobody knows whether claude-acp times an unanswered
 * `elicitation/create` out on its own, or what it does with an answer that arrives late. Our park
 * timer fires first BY CONSTRUCTION (`parkTimeoutMs` default 600 s, this case's 5 s), and if the
 * agent gave up first our answer lands on a dead JSON-RPC id — which `settleAll` already
 * tolerates, because the promise it awaits is the one WE hold. Whatever the run observes about
 * the agent's own behaviour belongs in M2-PLAN §5's real-agent record rather than being smoothed
 * over here.
 *
 * Owned by M2-A-WP-I.
 */

/**
 * `CreateAgentOptions.onUnresolved` is narrowed to `"deny"` in `client/src/server.ts`, which is
 * M2-WP-J's file; the WIRE has accepted all three since the Land step
 * (`CreateWorkerRequest.onUnresolved`, §5.8.6). The widening is recorded in the merge notes, and
 * the cast lives here and nowhere else so there is exactly one place to delete.
 */
function parkOptions(ctx: CompatContext): CreateAgentOptions {
  return { cwd: ctx.cwd, onUnresolved: "park" } as unknown as CreateAgentOptions;
}

const interactionsIn = (envelopes: readonly EventEnvelope[]): InteractionPayload[] =>
  envelopes.filter((e) => e.kind === "acp.interaction").map((e) => e.payload as InteractionPayload);

/**
 * The first parked interaction, as a HANDLE.
 *
 * Subscribed BEFORE the prompt on purpose: `on("interaction")` fires for a `pending` envelope on
 * the worker's tail (§5.8.10), and a listener attached afterwards would race the very park it is
 * there to catch.
 */
function firstPark(worker: Worker): { handle: Promise<InteractionRequestHandle>; off: () => void } {
  let settle!: (r: InteractionRequestHandle) => void;
  const handle = new Promise<InteractionRequestHandle>((resolve) => (settle = resolve));
  const off = worker.on("interaction", (r) => settle(r));
  return { handle, off };
}

export function elicitationCases(): readonly CompatCase[] {
  return [
    {
      /**
       * F28 reproduced live: a `park` worker gets a real `elicitation/create` and reaches
       * `requires_action`; a `deny` CONTROL worker gets none and still ends `end_turn`.
       *
       * The declaration is asserted on OUR OWN outbound `initialize` bytes —
       * `AgentCapabilitiesSnapshot.clientCapabilities`, recorded as sent — because `initialize`'s
       * `agentCapabilities` never mentions elicitation either way, so our own declaration is the
       * only record of why an agent asked in prose.
       */
      id: "elicitation-gated",
      requires: ["elicitation"],
      async run(ctx) {
        const control = await ctx.harness.A.createAgent(ctx.agentId, { cwd: ctx.cwd });
        const asked = await ctx.harness.A.createAgent(ctx.agentId, parkOptions(ctx));
        const park = firstPark(asked);
        try {
          assert(
            JSON.stringify(control.snapshot.capabilities?.clientCapabilities ?? {}) === "{}",
            "a deny worker declared something: D10 gates elicitation on onUnresolved:'park'",
          );
          const declared = asRecord(asked.snapshot.capabilities?.clientCapabilities);
          assert(
            JSON.stringify(declared["elicitation"] ?? null) === '{"form":{}}',
            `a park worker must declare {elicitation:{form:{}}}, got ${JSON.stringify(declared)}`,
          );
          assert(
            !JSON.stringify(declared).includes("url"),
            "`url` was declared: there is no browser here and elicitation/complete is unobserved",
          );

          // The CONTROL: the identical prompt with nothing declared. F28 says the agent asks in
          // prose and ends the turn — no request and no tool call at all.
          const plain = await control.prompt(ctx.prompts.remember);
          assert(plain.verdict === "ok", `the control turn is ${plain.verdict}, not ok`);
          assert(
            interactionsIn(await allEnvelopes(ctx, control.id)).every(
              (p) => p.method !== "elicitation/create",
            ),
            "an elicitation/create arrived on a worker that declared nothing (F28's control)",
          );

          // The PARK worker. `prompt()` returns the TURN, so it is not awaited until the park has
          // been answered — a park is exactly the case where a turn outlives its request.
          const turn = asked.prompt(ctx.prompts.remember);
          const handle = await park.handle;
          await until(() => asked.state === "requires_action", 120_000, 100);
          assert(
            asked.interactions.length > 0,
            "requires_action with an empty pending set (§19.5)",
          );
          assert(
            handle.method === "elicitation/create",
            `the parked interaction is ${handle.method}`,
          );
          assert(handle.settled === false, "a parked interaction is not settled");

          // D10's ONE verb for both arms, so a caller need not know which arrived.
          await handle.deny();
          const result = await turn;
          assert(result.verdict !== "failed", `the answered turn is ${result.verdict}`);
          await until(() => asked.state !== "requires_action", 60_000, 100);
        } finally {
          park.off();
          await asked.close().catch(() => {});
          await control.close().catch(() => {});
        }
      },
    },

    {
      /**
       * F30's regression, live: answering `question_0` with a `oneOf[].const` sends THAT value,
       * and the paired `_custom` property is ABSENT from the wire — asserted on the recorded
       * frames rather than on the SDK's own view, because our recorder filled both and the agent
       * used the custom one, creating `omni-choice.txt` instead of the selected `notes.md`.
       */
      id: "elicitation-answer",
      requires: ["elicitation"],
      async run(ctx) {
        const worker = await ctx.harness.A.createAgent(ctx.agentId, parkOptions(ctx));
        const park = firstPark(worker);
        try {
          const turn = worker.prompt(ctx.prompts.remember);
          const handle = await park.handle;
          const field = handle.fields[0];
          assert(field !== undefined, "the mapped form has no answerable question");
          const choice = field.options[0];
          assert(choice !== undefined, "the question offered no `oneOf` const to choose (F30)");

          // Keyed by QUESTION id. The SDK never sends both halves of a group, and the daemon
          // re-checks — three independent checks, which is what D4 rule 1 costs.
          await handle.answer({ [field.id]: choice.value });
          const result = await turn;
          assert(result.verdict !== "failed", `the answered turn is ${result.verdict}`);

          const settled = interactionsIn(await allEnvelopes(ctx, worker.id)).filter(
            (p) => p.status !== "pending",
          );
          assert(settled.length === 1, `expected one settlement, saw ${String(settled.length)}`);
          const keys = settled[0]?.answer?.contentKeys ?? [];
          // EXACTLY ONE property per question reached the wire, and it is the question's OWN
          // because the value is one of the schema's own consts.
          assert(
            JSON.stringify(keys) === JSON.stringify([field.id]),
            `the wire carried ${JSON.stringify(keys)}, not ${JSON.stringify([field.id])}`,
          );
          assert(
            !keys.includes(`${field.id}_custom`),
            "the paired _custom property reached the wire: this is the omni-choice.txt bug",
          );
          // A free-text answer is user content: KEYS ONLY ever enter the log (§5.8.3).
          assert(
            !JSON.stringify(settled[0]?.answer).includes(choice.value),
            "the answer's VALUE entered the log; only its keys may",
          );
        } finally {
          park.off();
          await worker.close().catch(() => {});
        }
      },
    },

    {
      /**
       * `parkTimeoutMs: 5000` with nobody answering ⇒ `status:"expired"`, and the turn still
       * completes because a real answer went out (§19.8).
       */
      id: "interaction-park-timeout",
      requires: ["elicitation"],
      async run(ctx) {
        await ctx.withDaemonConfig((base) => ({
          ...base,
          interaction: {
            ...(base.interaction ?? {}),
            parkTimeoutMs: 5_000,
            parkTimeoutAction: "deny",
          },
        }));
        const worker = await ctx.harness.A.createAgent(ctx.agentId, parkOptions(ctx));
        const park = firstPark(worker);
        try {
          const turn = worker.prompt(ctx.prompts.remember);
          const handle = await park.handle;
          // The deadline is PUBLISHED. A park that expires must say when; a park that never does
          // reads `null` rather than a deadline nothing is counting down to (§5.8.4).
          assert(handle.expiresAt !== null, "parkTimeoutMs: 5000 published no expiresAt");

          // Nobody answers. Our own timer is the only thing that can end this.
          await until(() => worker.interactions.length === 0, 120_000, 100);
          const result = await turn;

          const settled = interactionsIn(await allEnvelopes(ctx, worker.id)).filter(
            (p) => p.status !== "pending",
          );
          assert(settled.length === 1, `expected one settlement, saw ${String(settled.length)}`);
          assert(
            settled[0]?.status === "expired",
            `the settlement is ${String(settled[0]?.status)}, not expired`,
          );
          assert(
            settled[0]?.answer?.by === "timeout",
            `the settlement was by ${String(settled[0]?.answer?.by)}, not the timer`,
          );
          assert(
            result.verdict === "ok" || result.verdict === "partial",
            `the turn is ${result.verdict}: a real answer went out, so it must complete`,
          );
        } finally {
          park.off();
          await worker.close().catch(() => {});
          await ctx.withDaemonConfig(null);
        }
      },
    },
  ];
}
