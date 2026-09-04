import { configPathOf, loadCompatConfig, selectAgents } from "./config.js";
import { runCompatSuite } from "./runner.js";

/**
 * The config-driven compat suite (CONTRACTS.md §18, M1-PLAN §4).
 *
 * DESIGN §11's M1 criterion made mechanical: the IDENTICAL SDK script runs against every
 * configured agent — today `claude-acp` only, tomorrow a YAML edit. An agent that is not
 * configured on this machine is SKIPPED WITH A PRINTED REASON, never silently passed.
 *
 * The whole body is three lines on purpose. Everything selectable is an environment variable and
 * everything configurable is YAML; a suite that branched here would be a suite where "adding an
 * agent is a YAML edit" was true only for the agents somebody had already thought of.
 *
 *   OMNI_COMPAT_CONFIG   which agents file (default `agents.ci.yaml`, the hermetic one)
 *   OMNI_COMPAT_AGENTS   a comma-separated allow-list
 *   OMNI_COMPAT_REAL=1   enables entries that need a login or the network
 *   OMNI_COMPAT_REQUIRE=1  FAILS an empty selection, so a mis-set variable cannot pass
 *   OMNI_COMPAT_REPORT   where the report goes. The default is inside `vitest-report/`, which is
 *                        the directory CI's failure-artifact step already collects; a CHILD run
 *                        (the "adding an agent is a YAML edit" proof) redirects it so it does not
 *                        clobber its parent's.
 *
 * Owned by M1-WP-F.
 */
runCompatSuite(selectAgents(loadCompatConfig(configPathOf(process.env)), process.env), {
  reportPath: process.env["OMNI_COMPAT_REPORT"] ?? "vitest-report/compat-report.json",
});
