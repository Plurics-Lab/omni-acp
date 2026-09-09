import { OmniError } from "@omni-acp/protocol";
import type { PolicyPreset, ResolvedPolicy, PolicySelection } from "@omni-acp/protocol";

/**
 * D4's four named presets, as DATA.
 *
 * `readonly` never allows `edit` / `delete` / `execute` — a property test over 10 000 generated
 * subjects, not four examples.
 *
 * **The hazard, documented here because it is not obvious and cannot be fixed by a rule.** F40:
 * a read-only `ls -A` ran with NO permission request at all while `python3 -c …` in the same cwd
 * raised one, and the split is invisible in the frame. So `readonly` is not "cannot exfiltrate":
 * a `kind:"read"` tool call that the agent never asks permission for reads whatever it likes.
 * `alertOnUnpoliced` is the answer we actually have — a listed kind that never reached the engine
 * becomes `TurnWarning{code:"unpoliced_tool_call"}` — and `readonly-contained` is the test that
 * pins it.
 *
 * Owned by M2-B-WP-P.
 */
export const BUILTIN_POLICIES: Readonly<
  Record<"readonly" | "src-edit" | "full" | "deny-all", PolicyPreset>
> = Object.freeze({}) as never;

/**
 * `presets ⊕ inline`, inline LAST-WINS, with `extends` resolved and a cycle a LOAD error.
 *
 * `PolicySnapshot.sources` names every layer in order, so an operator reading a snapshot can see
 * which document produced a verdict without re-deriving the merge.
 *
 * Owned by M2-B-WP-P.
 */
export function resolvePolicySelection(
  _sel: PolicySelection | undefined,
  _available: Readonly<Record<string, PolicyPreset>>,
  _fallback: string,
): ResolvedPolicy {
  throw new OmniError("internal", "unimplemented: M2-B-WP-P");
}
