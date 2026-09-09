import { OmniError } from "@omni-acp/protocol";
import type { DiffProvider } from "@omni-acp/protocol";

/**
 * A `DiffProvider` with no git and no process, so M2-A-WP-W can consume the INTERFACE without
 * ever touching M2-WP-J's implementation — which is what makes those two packages independent.
 *
 * It can be told to hang, to fail, and to return an over-size patch, because those are the three
 * shapes `TurnResult.patch` has to stay honest about: a hung provider still yields `idle` with
 * `patch: null` and a `patch_timeout` warning.
 *
 * Owned by M2-A-WP-W.
 */
export function fakeDiffProvider(_o?: {
  text?: string | null;
  hangMs?: number;
  fail?: boolean;
}): DiffProvider {
  throw new OmniError("internal", "unimplemented: M2-A-WP-W");
}
