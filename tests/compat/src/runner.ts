import { OmniError } from "@omni-acp/protocol";
import type { CompatSelection } from "./config.js";

/**
 * Runs `compatCases()` against every selected agent and writes `compat-report.json`
 * UNCONDITIONALLY — a run that produced no report is a run nobody can argue with (§18.2).
 *
 * Two rules it must not soften:
 *
 *  - a skip carries a source and a reason, and a skip with NO source is a failure;
 *  - `OMNI_COMPAT_REQUIRE=1` fails an EMPTY selection, so "green because it ran nothing" is not
 *    a state this suite can reach silently.
 *
 * Owned by M1-WP-F.
 */
export function runCompatSuite(_selection: CompatSelection, _o: { reportPath: string }): void {
  throw new OmniError("internal", "unimplemented: M1-WP-F");
}
