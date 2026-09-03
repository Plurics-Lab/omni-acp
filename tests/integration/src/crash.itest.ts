import { describe, it } from "vitest";

/**
 * The crash rule (CONTRACTS.md §7.3): a dead agent never produces a fabricated `idle`.
 * `prompt()` still cannot hang, because a turn is terminal on `idle` OR on
 * `worker_state{closed}` — and `stopReason` stays null rather than becoming a lie. WP-6 owns this.
 */
describe("agent crash mid-turn", () => {
  it.todo("settles prompt() rather than hanging");
  it.todo(
    "appends omni.error with a non-empty stderrTail, then worker_state{closed, agent_crashed}",
  );
  it.todo("appends NO state_update{idle}");
  it.todo("reclaims the process tree");
});
