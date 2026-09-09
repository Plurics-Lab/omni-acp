import { OmniError } from "@omni-acp/protocol";
import type { ResolvedInteractionConfig } from "@omni-acp/protocol";

/**
 * D10's gate, as a PURE function of the request (§5.8.9).
 *
 * `{}` unless `onUnresolved === "park"`; `{elicitation: {form: {}}}` when it is; `url` ONLY when
 * `interaction.declareUrlElicitation`, which defaults false and stays false — there is no browser
 * here and `elicitation/complete` is unobserved on either real agent.
 *
 * It is a function rather than two literals because F42 is precisely that `handshake.ts` and the
 * WAKE path in `session-open.ts` hard-code `{}` in two different files: a `park` worker that
 * hibernates and wakes would silently stop declaring elicitation, F28 says the agent then asks in
 * PROSE instead, and the park never happens again. One producer, threaded through both.
 *
 * Owned by M2-A-WP-I.
 */
export function clientCapabilitiesFor(_o: {
  onUnresolved: "park" | "deny" | "fail";
  config: ResolvedInteractionConfig;
}): Readonly<Record<string, unknown>> {
  throw new OmniError("internal", "unimplemented: M2-A-WP-I");
}
