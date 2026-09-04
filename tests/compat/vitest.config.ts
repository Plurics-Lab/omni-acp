import { defineConfig } from "vitest/config";

/**
 * The compat suite (CONTRACTS.md §18).
 *
 * Two configs, one runner. `agents.ci.yaml` is hermetic — the SDK example agent and the eight
 * turn-completing testkit fixtures (`crash` and `orphan` are excluded: neither completes a turn,
 * and the suite's first assertion is that one does) — and runs everywhere. `agents.local.yaml`
 * names REAL agents and runs only under `OMNI_COMPAT_REAL=1`, because a machine without
 * `claude-acp` logged in must report a printed SKIP rather than a red build.
 *
 * The timeout is the real-agent budget: claude-acp's `initialize` is ~7 s cold and a tool-using
 * turn is minutes, not seconds. `retry: 0` on purpose — a compat run that passes on the second
 * attempt is a compat run that did not pass.
 */
export default defineConfig({
  test: {
    name: "compat",
    include: ["src/**/*.ctest.ts"],
    testTimeout: 300_000,
    hookTimeout: 300_000,
    retry: 0,
    passWithNoTests: true,
    reporters: ["default", ["junit", { outputFile: "vitest-report/junit.xml" }]],
  },
});
