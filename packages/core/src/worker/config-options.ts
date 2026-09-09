import { OmniError } from "@omni-acp/protocol";
import type {
  AcpLinkLike,
  ConfigOptionView,
  Normalizer,
  RuntimeDescriptor,
  SessionId,
  SetConfigResponse,
} from "@omni-acp/protocol";

/**
 * `session/set_config_option`, through `Normalizer.mapRequest` — so this file names NEITHER
 * spelling.
 *
 * F34: the request parameter is `configId` while the catalogue entry's own key is `id`, and
 * `optionId` is a `-32602` on claude-acp. Which word reaches the wire is descriptor DATA
 * (`configOptionIdField`), and a `-32602` on the first spelling falls through to the next, which
 * is `mapRequest`'s existing job (§17.3).
 *
 * The result REPLACES `WorkerSnapshot.configOptions` wholesale, from the METHOD's own body and
 * never from the event stream: neither real agent emits a `config_option_update` for a set (F34,
 * F35), so a daemon that waited for one would wait forever, and a daemon that merged a guess
 * would invent a catalogue. When the method returns no list, `stale: true` and the previous list
 * is KEPT — F34's four→two shrink is real, and a merge would resurrect the two it dropped.
 *
 * Owned by M2-A-WP-C.
 */
export function setConfigOption(
  _link: AcpLinkLike,
  _n: Normalizer,
  _o: { sessionId: SessionId; configId: string; value: unknown },
): Promise<SetConfigResponse> {
  throw new OmniError("internal", "unimplemented: M2-A-WP-C");
}

/**
 * The agent's `configOptions` array → an addressable view, with `raw` kept BY IDENTITY (§7.5).
 *
 * F35 is why identity matters here and not merely as a principle: codex spells its model id two
 * ways — `models.availableModels[].modelId: "gpt-5.6-sol[low]"` against
 * `configOptions[model].currentValue: "gpt-5.6-sol"` — so anything that normalized `currentValue`
 * would make a snapshot fail to match itself.
 *
 * Owned by M2-A-WP-C.
 */
export function viewConfigOptions(
  _result: unknown,
  _d: RuntimeDescriptor,
): readonly ConfigOptionView[] | null {
  throw new OmniError("internal", "unimplemented: M2-A-WP-C");
}
