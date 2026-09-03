import { defineConfig } from "vitest/config";

/**
 * Tier-3: real processes, real ndJSON, real loopback HTTP. The SDK example agent costs ~5 s per
 * turn (5 x 1 000 ms of simulated latency), so the budget is generous and a single retry absorbs
 * runner jitter without hiding a real failure (M0-PLAN.md §4).
 */
export default defineConfig({
  test: {
    name: "integration",
    include: ["src/**/*.itest.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    retry: 1,
    passWithNoTests: true,
  },
});
