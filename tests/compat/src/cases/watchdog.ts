import type { DaemonConfig } from "@omni-acp/protocol";
import { assert, type CompatCase, type CompatContext } from "./support.js";

/**
 * Compat cases for the idle watchdog's dual budget and `strandedToolCalls`.
 *
 * Every case declares what it `requires`, so an agent that cannot do it is SKIPPED with a printed
 * source and a reason rather than silently passed — and the suite refuses to assert an
 * `unverified` descriptor row at all.
 *
 * Both cases below require `watchdog`, which nothing declares in `provides:` yet: the daemon does
 * not wire `DaemonDeps.watchdog` until M2-WP-J's join, so until then they are `capability` skips
 * with a printed reason, which is §18.3's honest answer and not a silent pass. When the wiring
 * lands, the two agents' YAML gains `watchdog` in `provides:` and these run unchanged — that is
 * §18.1's whole rule ("adding an agent is a YAML edit with ZERO code changes"), applied to a
 * capability instead of an agent.
 *
 * Owned by M2-A-WP-W.
 */

/**
 * The gate that stops a vacuous pass.
 *
 * Both cases are about something NOT happening (a turn that is cancelled, a turn that is not), and
 * a daemon with no watchdog satisfies the second one by doing nothing at all. `WorkerSnapshot.
 * watchdog` is `null` for a worker with no watchdog and for a disabled one, and non-null with the
 * RESOLVED budgets otherwise (§5.8.4), so it is the one wire-visible fact that says the feature is
 * actually present.
 */
function assertWired(snapshot: { watchdog?: unknown }, budgets: Record<string, number>): void {
  const watchdog = snapshot.watchdog;
  assert(
    watchdog !== null && watchdog !== undefined,
    "WorkerSnapshot.watchdog is null: this daemon wired no idle watchdog, so the case would " +
      "pass by doing nothing (DaemonDeps.watchdog is M2-WP-J's wiring)",
  );
  const view = watchdog as Record<string, unknown>;
  for (const [key, value] of Object.entries(budgets)) {
    assert(
      view[key] === value,
      `WorkerSnapshot.watchdog.${key} is ${String(view[key])}, not the configured ${String(value)}`,
    );
  }
}

const withWatchdog =
  (watchdog: Record<string, number>) =>
  (base: DaemonConfig): DaemonConfig => ({
    ...base,
    watchdog: { ...(base.watchdog ?? {}), ...watchdog } as DaemonConfig["watchdog"],
  });

export function watchdogCases(): readonly CompatCase[] {
  return [
    {
      /**
       * §27.2. A 30-second shell command under a case-scoped `watchdog.toolMs`, so the TOOL budget
       * is the one that fires — and F36's consequence is what is asserted afterwards: neither
       * real agent sends a terminal `tool_call_update` for the call it was running, so the turn
       * ends `partial` with exactly one `strandedToolCalls` entry and the aggregator never blocks
       * waiting for a status that is never coming.
       */
      id: "watchdog-cancel",
      requires: ["watchdog", "tools", "cancel"],
      async run(ctx: CompatContext) {
        // `cancelTimeoutMs` MUST exceed `turn.cancelGraceMs` or the config does not load (§21.5),
        // and it is deliberately far larger than the tool budget here: the assertion is that the
        // TURN was cancelled, not that the worker was closed.
        await ctx.withDaemonConfig(
          withWatchdog({ silentMs: 300_000, toolMs: 8_000, cancelTimeoutMs: 60_000 }),
        );
        // A DEDICATED worker, created AFTER the overlay (M2-WP-J). `ctx.worker()` is the shared
        // one, and `withDaemonConfig` restarts the daemon — which closes it. Re-attaching would
        // hand this case a CLOSED worker whose budgets are the ones it was created under, so the
        // assertion below would be about the previous configuration or about nothing at all.
        const worker = await ctx.harness.A.createAgent(ctx.agentId, { cwd: ctx.cwd });
        assertWired(worker.snapshot, { toolMs: 8_000, silentMs: 300_000 });

        const started = Date.now();
        const result = await worker
          .prompt(
            "Run a shell command that sleeps for 30 seconds and then prints WOKE. " +
              "Use the terminal. Do not do anything else.",
          )
          .finally(() => {
            // The dedicated worker and the overlay are BOTH this case's to give back: a leaked
            // 8-second tool budget would cancel the next case's turn.
            void worker.close().catch(() => {});
          });
        const elapsed = Date.now() - started;

        // The aggregate SETTLED. That is the half of ruling M2-R8 a hang would violate, and it is
        // asserted first because a test that hangs reports nothing at all.
        assert(elapsed < 120_000, `the turn took ${String(elapsed)}ms, which is not a settle`);
        assert(
          result.stopReason === "cancelled" || result.error !== null,
          `stopReason is ${String(result.stopReason)} and error is ${String(result.error?.code)}: ` +
            "the watchdog's cancel did not end this turn",
        );

        // F36, on both agents: the call the agent was running is left non-terminal for ever.
        assert(
          result.strandedToolCalls.length === 1,
          `strandedToolCalls is ${JSON.stringify(result.strandedToolCalls)}, not exactly one call`,
        );
        const stranded = result.strandedToolCalls[0] ?? "";
        const call = result.toolCalls.find((c) => c.toolCallId === stranded);
        assert(call !== undefined, `stranded id ${stranded} names no tool call`);
        assert(
          call.status !== "completed" && call.status !== "failed",
          `stranded call reports a terminal status ${String(call.status)}`,
        );
        // NEVER synthesized (M2-R8): we do not put a status on the wire that no agent sent.
        assert(
          !result.failedToolCalls.includes(stranded),
          "a stranded call was reported as failed, which is a status no agent sent",
        );
        assert(
          result.verdict === "partial" || result.verdict === "failed",
          `verdict is ${result.verdict}: a turn holding a stranded call is not ok`,
        );
        await ctx.withDaemonConfig(null);
      },
    },

    {
      /**
       * F25's half of the anchor argument, end to end. `session_info_update` lands 5-22 ms AFTER
       * `session/prompt` resolves on claude-acp (7/7) and codex emits `threadStatus:{idle}` just
       * BEFORE its response — so a `silentMs` short enough to expire between the two must NOT
       * cancel the turn, because the window is anchored on the last envelope appended.
       */
      id: "watchdog-late-update",
      requires: ["watchdog"],
      async run(ctx: CompatContext) {
        await ctx.withDaemonConfig(
          withWatchdog({ silentMs: 3_000, toolMs: 300_000, cancelTimeoutMs: 60_000 }),
        );
        // Dedicated, for the reason `watchdog-cancel` above states.
        const worker = await ctx.harness.A.createAgent(ctx.agentId, { cwd: ctx.cwd });
        assertWired(worker.snapshot, { silentMs: 3_000 });

        const result = await worker.prompt(ctx.prompts.plain);

        assert(
          result.stopReason !== "cancelled",
          "a turn that finished normally was cancelled: the quiet window is anchored on the " +
            "prompt RESPONSE rather than on the last envelope appended (F25)",
        );
        assert(result.error === null, `the turn carries an error: ${String(result.error)}`);
        assert(
          result.strandedToolCalls.length === 0,
          `a completed plain turn stranded ${JSON.stringify(result.strandedToolCalls)}`,
        );
        // And the worker is still usable: nothing escalated into a close.
        const state = worker.snapshot.state;
        assert(state !== "closed", `the worker is ${state} after a turn that was never stalled`);
        await worker.close().catch(() => {});
        await ctx.withDaemonConfig(null);
      },
    },
  ];
}
