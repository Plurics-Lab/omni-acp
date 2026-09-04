import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Absolute path to the ACP SDK's own example agent — the Tier-3 acceptance fixture.
 *
 * Derived from the SDK's MAIN ENTRY, because the SDK's `exports` map publishes neither
 * `./package.json` nor `./dist/examples/*` (CONTRACTS.md F8): `require.resolve` of an
 * unexported subpath throws ERR_PACKAGE_PATH_NOT_EXPORTED. And never via `new URL(...).pathname`,
 * which yields `/C:/...` on Windows.
 *
 * Launch it as `process.execPath <this path>` — never through `npx`, which is a `.cmd` shim on
 * Windows (CONTRACTS.md §6.3).
 *
 * Real, not a stub: the scaffold's own smoke test proves the fixture resolves and handshakes on
 * this machine before any work package starts.
 */
export function sdkExampleAgentPath(): string {
  const require = createRequire(import.meta.url);
  const mainEntry = require.resolve("@agentclientprotocol/sdk");
  return join(dirname(mainEntry), "examples", "agent.js");
}

export type FixtureAgentName =
  | "echo"
  | "crash"
  | "slow"
  | "chatty"
  | "orphan"
  | "noisy"
  /**
   * M1's four, covering the corpus gaps the research README enumerates (CONTRACTS.md §5.7,
   * §18.3). The NAMES are landed here so every consumer compiles against the final union; the
   * `.mjs` files themselves are M1-WP-B's, which is also what makes `fixture-agents.test.ts`
   * (WP-B's) the test that proves each one launches.
   */
  | "plan"
  | "thought"
  | "mode"
  | "hybrid";

/**
 * Absolute path to one of the repository's own fixture agents (`fixtures/agents/*.mjs`).
 * Resolved from this module's URL through `fileURLToPath`, so it is correct on Windows and
 * survives being called from `dist`.
 */
export function fixtureAgentPath(name: FixtureAgentName): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/paths.js -> <package root>/fixtures/agents/<name>.mjs
  return join(here, "..", "fixtures", "agents", `${name}.mjs`);
}
