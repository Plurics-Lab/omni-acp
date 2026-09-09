import { InteractionConfig } from "@omni-acp/protocol";
import type { InteractionStrategy, WorkerId } from "@omni-acp/protocol";
import {
  fakeClock,
  nullLogger,
  runInteractionConformance,
  seqIds,
  type FakeClock,
} from "@omni-acp/testkit";
import { createBaselineResponder } from "../../../src/index.js";
import { baselineInteractions } from "../../../src/worker/interaction/baseline.js";
import { createInteractionStrategy } from "../../../src/worker/interaction/strategy.js";

/**
 * WP-I acceptance 1, first half: `runInteractionConformance` passes for BOTH strategies.
 *
 * That pairing is the whole of M2-PLAN §1.3's seam A. `InteractionStrategy` supersedes
 * `PermissionResponder` by WRAPPING it, so every M1 behaviour is preserved by construction — and
 * this is where the claim is executed rather than asserted. The real strategy is run in all three
 * `onUnresolved` arms, because the suite's rows are about what the envelopes SAY and a park only
 * changes WHEN they appear.
 *
 * Owned by M2-A-WP-I.
 */

const WORKER = "w_00000000000000000000000001" as WorkerId;

const clockFor = (): FakeClock => fakeClock();

/** One clock per suite, so `close()`'s "no timer survives" row is about that suite's timers. */
const baselineClock = clockFor();
runInteractionConformance(
  "baselineInteractions (M1's responder, wrapped)",
  (): InteractionStrategy =>
    baselineInteractions(createBaselineResponder("deny", baselineClock), baselineClock),
  baselineClock,
);

for (const onUnresolved of ["deny", "fail", "park"] as const) {
  const clock = clockFor();
  runInteractionConformance(
    `createInteractionStrategy (onUnresolved: ${onUnresolved})`,
    (): InteractionStrategy =>
      createInteractionStrategy({
        workerId: WORKER,
        clock,
        ids: seqIds(),
        logger: nullLogger(),
        config: InteractionConfig.parse({}),
        onUnresolved,
        // A park with no deadline is the harshest case for `settleAll`: nothing but the teardown
        // can end it, which is exactly what §19.8 is about.
        parkTimeoutMs: 0,
        parkTimeoutAction: "deny",
        responder: createBaselineResponder("deny", clock),
        // The daemon wiring's `log`, minimal: `InteractionAnswerResult.seq` is copied off an
        // envelope the log stamped (§8.2), and the suite's `answer` rows reach that path.
        log: {
          head: 1 as never,
          read: () => [{ seq: 1 } as never],
        },
      }),
    clock,
  );
}
