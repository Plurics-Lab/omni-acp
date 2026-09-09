import { OmniError } from "@omni-acp/protocol";
import type { ConfigOptionView, RuntimeDescriptor } from "@omni-acp/protocol";

/**
 * The agent's `configOptions` array → an addressable view, with `raw` kept BY IDENTITY (§7.5).
 *
 * The argument is the WHOLE result body (`{configOptions: [...]}`) rather than the array, because
 * `null` and `[]` are different answers: `null` means the method returned no list at all, which
 * is `SetConfigResponse.stale: true` and "keep the previous list", while `[]` means the agent
 * really does offer nothing now. Merging a guess would resurrect the two entries F34's four→two
 * shrink dropped.
 *
 * The entry's own key is `id` — MEASURED on both agents, not assumed: claude-acp transcript `15`
 * and codex-acp transcript `07` both spell it `id`. `configId` is the REQUEST parameter and lives
 * in `Quirks.configIdField` (F34); review R3 records that there is only that one quirk and that a
 * second one for the entry key would have described a variable nobody has ever observed varying.
 *
 * F35 is why identity matters here and not merely as a principle: codex spells its model id two
 * ways — `models.availableModels[].modelId: "gpt-5.6-sol[low]"` against
 * `configOptions[model].currentValue: "gpt-5.6-sol"` — so anything that normalized `currentValue`
 * would make a snapshot fail to match itself.
 *
 * PURE and TOTAL: a body it cannot read is `null`, never a throw.
 *
 * Owned by M2-A-WP-C.
 */
export function viewConfigOptions(
  _result: unknown,
  _d: RuntimeDescriptor,
): readonly ConfigOptionView[] | null {
  throw new OmniError("internal", "unimplemented: M2-A-WP-C");
}

/**
 * The membership delta between two catalogues, for `SetConfigResponse.{removed, added}`.
 *
 * PURE, and it is the ONLY thing `POST …/config` says about the shrink: F34's `model → haiku`
 * dropped `effort` because Haiku exposes no effort levels, and a client that re-rendered a
 * control for it would be rendering one the agent will now refuse. Order is the catalogue's, so
 * two calls with the same lists produce deep-equal responses.
 *
 * The wire call itself is NOT here: review R12 moved it into `Worker.setConfig` (M2-PLAN §1.2
 * hunk 6), which is the only place that holds the lease gate, the `worker_busy` gate, the
 * auto-wake and the previous list — leaving this file the pure half that M2-A-WP-C unit-tests
 * against transcripts `15` and `07` with no link at all.
 *
 * Owned by M2-A-WP-C.
 */
export function configOptionsDelta(
  _previous: readonly ConfigOptionView[] | null,
  _next: readonly ConfigOptionView[] | null,
): { readonly removed: readonly string[]; readonly added: readonly string[] } {
  throw new OmniError("internal", "unimplemented: M2-A-WP-C");
}
