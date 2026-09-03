import { defineConfig } from "vitest/config";

/**
 * `reporters` includes junit so that CI's `if: failure()` artifact step has a file to collect:
 * its glob names the `vitest-report/` directory, and before this the step silently uploaded
 * nothing on every red run — worst of all on windows-latest, the failure class the three-OS
 * matrix exists to catch and nobody can reproduce locally (review R2, M0-PLAN §1.3 item 6).
 */

export default defineConfig({
  test: {
    name: "core",
    include: ["test/**/*.test.ts"],
    testTimeout: 5_000,
    passWithNoTests: true,
    reporters: ["default", ["junit", { outputFile: "vitest-report/junit.xml" }]],
  },
});
