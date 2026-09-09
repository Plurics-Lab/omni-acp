import { describe, it } from "vitest";

/**
 * `resolvePolicyForRequest` — the ONE place `403 policy_exceeds_ceiling` is raised, and it is
 * raised at CREATE so the operator sees it where they can act on it.
 *
 * Owned by M2-B-WP-P.
 */

describe("resolvePolicyForRequest (§20.5)", () => {
  it.todo(
    "a preset name, a list of names and an inline document all resolve, merged preset (+) inline with inline last-wins",
  );
  it.todo("an unknown preset name is 400 NAMING it; one outside the token's policyPresets is 403");
  it.todo(
    "a merge exceeding the token's policyCeiling is 403 with body.policy.{ceiling, offending}",
  );
});
