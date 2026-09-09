import { OmniError } from "@omni-acp/protocol";
import type { RunStore } from "@omni-acp/protocol";

/**
 * §24.4. Every run whose `bootId` is not ours and whose state is LIVE becomes `abandoned`, with a
 * terminal `run.failed` delivery enqueued.
 *
 * Its worker died with that boot, so the run can never finish; leaving it `running` would make a
 * receiver wait forever for a completion nobody will ever send. The state change and the enqueue
 * are ONE transaction — a planted throw between them must leave NEITHER, or a restart produces a
 * run that says it failed and a webhook that never fires (or the reverse, which is worse).
 *
 * Owned by M2-B-WP-R.
 */
export function recoverRuns(
  _store: RunStore,
  _bootId: string,
  _nowMs: number,
): { abandoned: number } {
  throw new OmniError("internal", "unimplemented: M2-B-WP-R");
}
