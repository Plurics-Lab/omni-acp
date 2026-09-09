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
 * F28 is also why not declaring is SAFE: with `clientCapabilities: {}` and the byte-identical
 * prompt there was no request and no tool call at all — the model asked in prose and ended the
 * turn. Declaring a mode we cannot service is the failure that hangs; declining to declare one is
 * a degradation the agent handles by itself.
 *
 * Owned by M2-A-WP-I.
 */
export function clientCapabilitiesFor(o: {
  onUnresolved: "park" | "deny" | "fail";
  config: ResolvedInteractionConfig;
}): Readonly<Record<string, unknown>> {
  // `deny` and `fail` answer without a human, so there is nobody for a form to reach. Declaring
  // it anyway would make the agent ask questions our own configuration guarantees we decline.
  if (o.onUnresolved !== "park") return Object.freeze({});

  const elicitation: Record<string, unknown> = { form: {} };
  // The `url` key exists in exactly one place in this repository, and this is it. It is gated on
  // a config flag that defaults false and is documented as staying false until a real url handler
  // sits behind it — `elicitation/complete` has never been observed on either agent, and a mode
  // we declare but cannot service is how a turn hangs forever (§19.2, §11.9).
  if (o.config.declareUrlElicitation) elicitation["url"] = {};

  return Object.freeze({ elicitation: Object.freeze(elicitation) });
}
