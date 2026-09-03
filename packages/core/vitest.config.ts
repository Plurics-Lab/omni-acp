import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "core",
    include: ["test/**/*.test.ts"],
    testTimeout: 5_000,
    passWithNoTests: true,
  },
});
