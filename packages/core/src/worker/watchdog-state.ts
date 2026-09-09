import { OmniError } from "@omni-acp/protocol";
import type {
  ResolvedWatchdogConfig,
  WatchdogSignal,
  WatchdogState,
  WatchdogVerdict,
} from "@omni-acp/protocol";

/**
 * DESIGN §7's dual budget, as a PURE FOLD. No clock, no process, no `setTimeout` in this file —
 * `createWatchdog` supplies the one timer, exactly as `HibernateTimer` is split.
 *
 * The two budgets exist because one number cannot express both facts:
 *
 *  - **Budget A, silent.** Nothing appended at all while a turn runs. The window is anchored on
 *    the LAST ENVELOPE APPENDED and never on the prompt response — F25 makes that 7/7 on
 *    claude-acp (a `session_info_update` lands ~20 ms AFTER the response), and codex emits
 *    `threadStatus:idle` BEFORE its response. Replayed envelopes are NOT activity.
 *  - **Budget B, tool.** At least one tool call is OPEN. `npm install` silent for twenty minutes
 *    is normal, so this is the larger; F36 says an open call can be a PERMANENT condition, which
 *    is why it is a budget and not a suspension.
 *
 * The open set opens on `tool_call`, closes on a TERMINAL `tool_call_update`, and is emptied only
 * by `turn_end`. A SPARSE update carrying no `status` neither opens a closed call nor closes an
 * open one — absent means unchanged, the same rule `reduceTurn` folds by.
 *
 * A park DISARMS both budgets and an unpark RE-BASES from the unpark instant (ruling M2-R21): a
 * twenty-minute park followed by one update must not immediately cancel.
 *
 * Owned by M2-A-WP-W.
 */
export function watchdogStep(
  _s: WatchdogState,
  _sig: WatchdogSignal,
  _cfg: ResolvedWatchdogConfig,
): { state: WatchdogState; verdict: WatchdogVerdict } {
  throw new OmniError("internal", "unimplemented: M2-A-WP-W");
}

/** The disarmed start state: no turn, nothing open, nothing parked. */
export function initialWatchdogState(): WatchdogState {
  throw new OmniError("internal", "unimplemented: M2-A-WP-W");
}
