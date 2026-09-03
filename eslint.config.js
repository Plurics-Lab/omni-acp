import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

/**
 * Deliberately small. `tsc --strict` already carries the load that a type-aware
 * lint config would duplicate; eslint here only catches the things the compiler
 * does not look at. Scaffold-owned (M0-PLAN.md §1.1) — a rule change is a
 * renegotiation, not a commit.
 */
export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "packages/protocol/schema/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // Stubs carry signature-complete, deliberately unused parameters.
      "@typescript-eslint/no-unused-vars": "off",
      "no-unused-vars": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    files: ["**/fixtures/**/*.mjs"],
    languageOptions: { globals: { ...globals.node } },
  },
);
