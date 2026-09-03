import { OmniError, type Clock } from "@omni-acp/protocol";

/**
 * The one place `Date.now()` and `setTimeout` are allowed to appear in the daemon. Everything
 * else takes a `Clock`, which is what makes the suites deterministic (CONTRACTS.md §1).
 */
export function systemClock(): Clock {
  throw new OmniError("internal", "unimplemented: WP-5 (daemon.systemClock)");
}
