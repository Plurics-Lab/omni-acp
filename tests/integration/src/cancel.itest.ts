import { describe, it } from "vitest";

/**
 * `session/cancel` is a notification first and a kill only on close or timeout. The second
 * assertion is the one that matters: omni-acp Workers are long-lived across turns, so unlike
 * multica we must NOT close stdin at turn end (CONTRACTS.md §6.5). WP-6 owns this file.
 */
describe("cancel", () => {
  it.todo("returns stopReason 'cancelled' with the process still alive");
  it.todo("accepts a second prompt() after the cancel");
  it.todo("escalates to a tree kill and closes with cancel_timeout when cancelGraceMs elapses");
});
