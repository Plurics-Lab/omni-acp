import { describe, it } from "vitest";

/**
 * `session/set_config_option` and the live catalogue (§22).
 *
 * Owned by M2-A-WP-C.
 */

describe("setConfigOption / viewConfigOptions (H24)", () => {
  it.todo(
    'goes through Normalizer.mapRequest("session/set_config_option", ...), so configId vs optionId is descriptor DATA and this file names neither spelling; a -32602 on the first spelling falls through to the next (F34)',
  );
  it.todo(
    "WorkerSnapshot.configOptions is REPLACED WHOLESALE from the method result: a golden over claude 15 asserts the list shrinks 4 -> 2 with no phantom `effort` surviving; a golden over codex 07 asserts all five survive; AgentCapabilitiesSnapshot.configOptions is UNCHANGED by the call",
  );
  it.todo(
    'ZERO agent-emitted config_option_update is consumed: a stream carrying none still sees the new value, and a planted spurious one is ignored; the route\'s own synthesized envelope carries _meta["omni/source"]:"set_config_option"',
  );
  it.todo(
    "SetConfigResponse.stale is true when the method returned no list, and the previous list is KEPT, never merged with a guess; removed/added name the membership delta",
  );
  it.todo(
    "viewConfigOptions lifts `id` through the descriptor's quirk and keeps `raw` BY IDENTITY: codex's two model spellings are both preserved untouched (F35)",
  );
  it.todo(
    "after a wake, configOptions is re-seeded from reopen's result, because a resumed session may report a different catalogue",
  );
});
