import { OmniError } from "@omni-acp/protocol";
import type {
  AuthContext,
  PolicyEngine,
  PolicySelection,
  ResolvedDaemonConfig,
} from "@omni-acp/protocol";

/**
 * `CreateWorkerRequest.policy` → a `PolicyEngine`, and the ONE place `403
 * policy_exceeds_ceiling` is raised.
 *
 * It happens at CREATE, before a process exists, because that is where the operator can act on
 * it: a ceiling violation discovered at the first permission request is a ceiling violation
 * discovered after the agent has already been running in the user's repository.
 *
 * Owned by M2-B-WP-P.
 */
export function resolvePolicyForRequest(
  _cfg: ResolvedDaemonConfig,
  _auth: AuthContext,
  _sel: PolicySelection | undefined,
): PolicyEngine {
  throw new OmniError("internal", "unimplemented: M2-B-WP-P");
}
