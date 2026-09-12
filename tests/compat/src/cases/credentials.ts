import { assert, type CompatCase } from "./support.js";

/**
 * M3-WP1's compat case: `restart-resumes` (docs/M3-WP1-CREDENTIALS.md §worker.restart).
 *
 * ONE case, and it is the one claim that cannot be tested any other way: that replacing a real
 * agent's PROCESS and resuming its session gives you back a worker that still remembers the
 * conversation. A fixture can prove the state machine (`core/test/worker/restart.test.ts` does) and
 * a fixture can prove the wiring (`tests/integration/src/credentials.itest.ts` does); only a real
 * agent can prove that its own resume survives a process replacement, because only a real agent
 * decides what its resume actually restores.
 *
 * `requires: ["resume"]` is what makes this HONEST on an agent that cannot resume: §18.3's
 * `capability` skip, sourced from the PROBE's own `resumeMethod`, printed in `compat-report.json`
 * with its reason. It is never a silent pass, and it is never a failure for a runtime that never
 * claimed the capability.
 *
 * The CREDENTIAL half of M3-WP1 is deliberately NOT here, and that is a decision rather than an
 * omission: storing a credential in a compat run means copying this machine's own login into a
 * temp data dir, and a suite that did that on every run would multiply the number of places a real
 * subscription token exists on disk for no new evidence — the store's modes, links and fingerprints
 * are filesystem facts that `daemon/test/credentials/*` asserts exactly, on both agents' real
 * descriptors. What a real agent adds is the resume, and that is what this case takes.
 *
 * Owned by M3-WP1.
 */
export function credentialCases(): readonly CompatCase[] {
  return [
    {
      id: "restart-resumes",
      requires: ["resume"],
      async run(ctx) {
        // A DEDICATED worker: the shared one has other cases' turns in its history, and what this
        // asserts is that a specific fact crosses the restart.
        const worker = await ctx.harness.A.createAgent(ctx.agentId, { cwd: ctx.cwd });
        try {
          // Step 1: put something in the conversation that only the conversation can answer.
          const planted = await worker.prompt(ctx.prompts.remember);
          assert(planted.stopReason !== null, "the planting turn never settled");

          const before = worker.snapshot;
          const pidBefore = before.process?.pid ?? 0;
          assert(pidBefore > 0, "the worker reported no pid before the restart");
          const holderBefore = before.lease.holder;
          assert(holderBefore !== null, "the creator does not hold the lease");
          const generationBefore = before.generation;
          const homeBefore = before.home ?? null;
          const sessionBefore = before.sessionId;

          // Step 2: replace the process.
          const result = await worker.restart({ reason: "compat restart-resumes" });

          assert(
            result.generation === generationBefore + 1,
            `generation went ${String(generationBefore)} -> ${String(result.generation)}, not +1`,
          );
          assert(
            result.pid !== null && result.pid !== pidBefore,
            `the pid did not change: ${String(pidBefore)} -> ${String(result.pid)}`,
          );
          assert(
            result.terminatedTurn === null,
            "an IDLE restart terminated a turn; nothing was running",
          );
          assert(
            result.sessionId === sessionBefore,
            `the session pointer changed: ${String(sessionBefore)} -> ${String(result.sessionId)}`,
          );
          // `{outcome:"fresh"}` would mean the session was ABANDONED, which is what `fresh:true`
          // asks for and what this case must never get by accident.
          const resume = result.resume as { outcome?: string; rule?: number };
          assert(
            resume.outcome === "landed",
            `resume.outcome is ${String(resume.outcome)}, not landed (rule ${String(resume.rule)})`,
          );

          // Step 3: the two exceptions §restart makes to the wake path, on a real agent.
          const after = (await ctx.harness.A.attach(worker.id)).snapshot;
          assert(after.state === "ready", `the worker is ${after.state}, not ready`);
          // The LEASE is the same holder. A hibernate releases it; a restart is a gap the holder
          // asked for, and releasing it would hand the worker to whichever peer polled first.
          assert(
            after.lease.holder?.clientId === holderBefore.clientId &&
              after.lease.holder?.tokenId === holderBefore.tokenId,
            "the restart released the lease",
          );
          // The HOME is the same directory (E7): the agent's own session files are in it, so a
          // restart that rebuilt it would resume into a directory with no history. `null` on a
          // daemon whose worker inherited its environment, which is legal and is not this claim.
          assert(
            (after.home ?? null) === homeBefore,
            `the home changed: ${String(homeBefore)} -> ${String(after.home)}`,
          );

          // Step 4: THE POINT. The new process answers a question about the old conversation.
          const recalled = await worker.prompt(ctx.prompts.recall);
          assert(recalled.stopReason !== null, "the turn after the restart never settled");
          assert(
            recalled.text.length > 0,
            "the turn after the restart produced no text at all, so nothing can be said about " +
              "what the resumed session remembered",
          );
          assert(
            recalled.error === null,
            `the turn after the restart failed: ${JSON.stringify(recalled.error)}`,
          );
        } finally {
          await worker.close().catch(() => {});
        }
      },
    },
  ];
}
