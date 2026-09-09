import { describe, it } from "vitest";

/**
 * `watchdogStep` — PURE, table-driven, 100 % branch coverage, and there is NO `setTimeout` in the
 * file under test. Every row here is a corpus lesson rather than an invented case.
 *
 * Owned by M2-A-WP-W.
 */

describe("watchdogStep (DESIGN §7's dual budget)", () => {
  it.todo("is pure and table-tested with 100 % branch coverage, no clock and no process");
  it.todo(
    "anchors the quiet window on the LAST envelope appended: an update 20 ms after prompt_result under silentMs: 10 does NOT trip (F25, 7/7)",
  );
  it.todo("treats a replayed envelope (replay:true) as NOT activity");
  it.todo(
    "opens on tool_call, closes on a TERMINAL tool_call_update, and a SPARSE update with no status neither opens a closed call nor closes an open one",
  );
  it.todo(
    "empties the open set only on turn_end — claude 16 and codex 08 are still armed at the cancel (F36)",
  );
  it.todo("a park disarms BOTH budgets and an unpark RE-BASES from the unpark instant (M2-R21)");
  it.todo(
    "silentMs: 0 / toolMs: 0 disable that budget only; enabled:false disarms both and the snapshot's watchdog is null",
  );
});
