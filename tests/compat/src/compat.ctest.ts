import { describe, it } from "vitest";

/**
 * The config-driven compat suite (CONTRACTS.md §18, M1-PLAN §4).
 *
 * DESIGN §11's M1 criterion made mechanical: the IDENTICAL SDK script runs against every
 * configured agent — today `claude-acp` only, tomorrow a YAML edit. An agent that is not
 * configured on this machine is SKIPPED WITH A PRINTED REASON, never silently passed.
 *
 * Owned by M1-WP-F.
 */
describe("compat suite", () => {
  it.todo(
    "runCompatSuite is green over agents.ci.yaml (SDK example agent + the eight turn-completing fixtures; crash and orphan excluded) on three OSes",
  );
  it.todo("OMNI_COMPAT_REQUIRE=1 FAILS an empty selection — never green because it ran nothing");
  it.todo(
    "adding an agent is a YAML edit only: a temp config with an appended fixture entry runs the suite UNCHANGED",
  );
  it.todo("no .ts file in the repository contains a real agent's command string");
  it.todo(
    "every skip carries a source (config / capability / precondition) and a reason; a skip with NO source fails",
  );
  it.todo("compat-report.json is written unconditionally and uploaded");
  it.todo(
    "under OMNI_COMPAT_REAL=1, §4's acceptance script is green against claude-acp and the run is recorded in M1-PLAN §5",
  );
});
