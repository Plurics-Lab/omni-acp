import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "client",
    include: ["test/**/*.test.ts"],
    testTimeout: 5_000,
    passWithNoTests: true,
  },
});
