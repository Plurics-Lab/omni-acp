import { describe, it } from "vitest";

/**
 * D4's ceiling, at the boundary a client actually meets: `403 policy_exceeds_ceiling` at CREATE,
 * and a runtime clamp that is never silent.
 *
 * Owned by M2-B-WP-P.
 */

describe("policy ceiling (M2-B, §20.5)", () => {
  it.todo(
    "a policy exceeding the token's ceiling is 403 at create, with body.policy.{ceiling, offending}",
  );
  it.todo(
    "a case the static check provably cannot catch is CLAMPED at runtime, and the clamp appears on the decision and as a TurnWarning",
  );
});
