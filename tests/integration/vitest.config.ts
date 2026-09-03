import { defineConfig } from "vitest/config";

/**
 * Tier-3: real processes, real ndJSON, real loopback HTTP. The SDK example agent costs ~5 s per
 * turn (5 x 1 000 ms of simulated latency), so the budget is generous and a single retry absorbs
 * runner jitter without hiding a real failure (M0-PLAN.md §4).
 *
 * `reporters` includes junit for the same reason as every package config: CI's `if: failure()`
 * artifact step collects the `vitest-report/` directory and had nothing to collect before
 * (review R2).
 */
export default defineConfig({
  test: {
    name: "integration",
    include: ["src/**/*.itest.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    retry: 1,
    passWithNoTests: true,
    reporters: ["default", ["junit", { outputFile: "vitest-report/junit.xml" }]],
  },
});
