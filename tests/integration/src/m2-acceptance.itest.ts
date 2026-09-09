import { describe, it } from "vitest";

/**
 * M2's acceptance script (docs/M2-PLAN.md §4), for the parts a FIXTURE agent can prove
 * deterministically. The real-agent half runs from `tests/compat/src/runner.ts` against
 * `claude-acp` and `codex-acp`, twice in a row, and is recorded in M2-PLAN §5.
 *
 * Owned by M2-WP-J.
 */

describe("M2-WP-J — the join: diff provider, wiring, compat, CLI", () => {
  it.todo(
    "reduceTurn locally and GET /turns/{id} return DEEP-EQUAL TurnResults INCLUDING patch on every M2 integration test — D7 re-proven, not assumed",
  );
  it.todo(
    "create-daemon.ts flips six defaults (interactions, watchdog, policy, diff, webhooks, runs); with all six ABSENT the whole M1 suite passes unedited",
  );
  it.todo(
    "boot order is persistence -> worker adopt -> run recover -> delivery requeue -> dispatcher.start -> listen, and stop() is interactions.settleAll -> dispatcher.drain(bounded) -> workers -> socket, both asserted by a recording order test",
  );
  it.todo(
    'runtime/known.ts gains the session_info_update row (F25) and the `unverified` entries for elicitation.url, elicitation/complete, action:"cancel", multi-question forms, parkTimeoutAction, configOptionIdField and codex\'s cmd-matching rules (F38); the compat suite REFUSES to assert an unverified row, with a printed reason',
  );
  it.todo(
    "the full compat matrix runs: hermetic agents.ci.yaml green on three OSes with ZERO unsourced skips, and OMNI_COMPAT_REAL=1 green against claude-acp and codex-acp with every skip carrying a source and a >=10-character reason",
  );
  it.todo(
    "§4's acceptance script is green against the real agents TWICE IN A ROW, and its transcript is recorded in M2-PLAN §5",
  );
  it.todo(
    "omni-acp interactions <wid>, interactions answer <wid> <reqId> --allow|--deny|--value q=v, config <wid> <id> <value>, runs, deliveries [--redeliver <id>] exist and are parse -> one call -> print (D15); omni-acp workers prints requires_action and the pending count",
  );
  it.todo(
    "exports-are-stable.itest.ts records the new surface; client-has-no-daemon-import, dependency-direction and sdk-version-pinned still pass",
  );
});
