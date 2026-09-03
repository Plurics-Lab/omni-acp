import { OmniError, type Normalizer } from "@omni-acp/protocol";

/**
 * The M0 normalization slice, and nothing more (CONTRACTS.md §7.1): it synthesizes exactly two
 * events — `state_update{running}` before the prompt bytes reach stdin, and
 * `state_update{idle, stopReason}` after the prompt response AND the quiet window. Every other
 * `session/update` is forwarded verbatim with `payloadVersion: 1`.
 *
 * Two rules that look like omissions and are not:
 *  - A dead agent NEVER produces a fabricated `idle` (§7.3). On `process_gone` this emits
 *    `omni.error` only; the Worker appends the `closed` state. `stopReason` stays null rather
 *    than becoming a lie that flows into every downstream consumer.
 *  - `step()` is pure. It returns `EventInput[]` with no `seq`, no `ts`, no ids — the type makes
 *    stamping one a compile error, because `EventLog.append()` is the only assigner (§7.6).
 */
export function createNormalizer(o: { quietMs: number; hardMs: number }): Normalizer {
  throw new OmniError("internal", "unimplemented: WP-3 (normalizer.createNormalizer)");
}
