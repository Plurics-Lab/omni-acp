import { BUILTIN_POLICIES, createPolicyEngine, resolvePolicySelection } from "@omni-acp/core";
import { OmniError } from "@omni-acp/protocol";
import type {
  AuthContext,
  PolicyEngine,
  PolicyPreset,
  PolicySelection,
  ResolvedDaemonConfig,
} from "@omni-acp/protocol";
import { ceilingFor } from "./ceiling.js";

/**
 * `CreateWorkerRequest.policy` -> a `PolicyEngine`, and the ONE place `403
 * policy_exceeds_ceiling` is raised.
 *
 * It happens at CREATE, before a process exists, because that is where the operator can act on
 * it: a ceiling violation discovered at the first permission request is a ceiling violation
 * discovered after the agent has already been running in the user's repository.
 *
 * Owned by M2-B-WP-P.
 */

export interface ResolvePolicyOptions {
  /**
   * `CreateWorkerRequest.onUnresolved`, so that `PolicyCeiling.park:false` refuses all THREE of
   * §20.5's things. Optional because §5.8.10's signature is `(cfg, auth, sel)`; the create route
   * has the value and passes it, and a caller that has no request omits it.
   */
  readonly onUnresolved?: "park" | "deny" | "fail";
}

/**
 * The presets a request may name: the four D4 ships, plus §20.4's contained variant, plus the
 * operator's own — and an operator may REPLACE a shipped one by declaring the same name, which is
 * what makes them data rather than code.
 */
export function availablePresets(
  cfg: ResolvedDaemonConfig,
): Readonly<Record<string, PolicyPreset>> {
  return { ...BUILTIN_POLICIES, ...cfg.policy.presets };
}

/** The preset names the CLIENT named. The daemon's own fallback is not the client's to be ACL'd on. */
function namedPresets(sel: PolicySelection | undefined): readonly string[] {
  if (sel === undefined) return [];
  if (typeof sel === "string") return [sel];
  if (Array.isArray(sel)) return sel;
  return sel.presets ?? [];
}

export function resolvePolicyForRequest(
  cfg: ResolvedDaemonConfig,
  auth: AuthContext,
  sel: PolicySelection | undefined,
  opts?: ResolvePolicyOptions,
): PolicyEngine {
  const available = availablePresets(cfg);
  const token = cfg.tokens.find((t) => t.id === auth.tokenId);
  const allowed = token?.policyPresets ?? "*";

  for (const name of namedPresets(sel)) {
    // The ACL is checked BEFORE existence on purpose: answering `400 unknown` for a name a token
    // may not use would turn this route into a preset enumerator. With the default `"*"` the
    // ordering is invisible, and an unknown name is still the `400` that names it.
    if (allowed !== "*" && !allowed.includes(name)) {
      throw new OmniError(
        "forbidden",
        `policy preset "${name}" is not in this token's policyPresets`,
      );
    }
  }

  // Throws `bad_request` naming an unknown preset (including one reached through `extends`) and
  // on an `extends` cycle. Both are config LOAD errors by §20.2.
  const resolved = resolvePolicySelection(sel, available, cfg.policy.default);

  const named = ceilingFor(cfg, auth.tokenId);
  const ceiling =
    named ??
    (auth.policyCeiling === null
      ? null
      : { name: `token:${auth.tokenId}`, ceiling: auth.policyCeiling });

  // `createPolicyEngine` runs `assertWithinCeiling`, so an engine that exceeds its ceiling cannot
  // be constructed at all — the 403 comes out of here and the caller never holds a wider engine.
  return createPolicyEngine({
    policy: resolved,
    ceiling: ceiling === null ? null : ceiling.ceiling,
    id: resolved.id,
    ...(ceiling === null ? {} : { ceilingName: ceiling.name }),
    ...(opts?.onUnresolved === undefined ? {} : { onUnresolved: opts.onUnresolved }),
  });
}
