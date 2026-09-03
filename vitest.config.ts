import { defineConfig } from "vitest/config";

/**
 * Root runner. `pnpm test` at the repository root fans out over every workspace
 * package; `pnpm -r test` runs each package's own config directly. Both paths
 * execute the SAME per-package configs, so they cannot disagree.
 *
 * Tests import workspace packages BY NAME, which resolves through each package's
 * `exports` map to its built `dist` — so `pnpm -r build` must run first
 * (CONTRACTS.md §11 D25).
 */
export default defineConfig({
  test: {
    projects: ["packages/*", "tests/*"],
  },
});
