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
  | "hybrid"
  /**
   * M2's two stall fixtures (CONTRACTS.md §5.8, the fixture table). `stall-silent` is one update
   * and then silence with nothing open — DESIGN §7's `silentMs` budget; `stall-in-tool` opens a
   * `tool_call{status:"pending"}` and never terminalizes it — F36's tool budget and
   * `TurnResult.strandedToolCalls`. Added by M2-A-WP-W.
   */
  | "stall-silent"
  | "stall-in-tool"
  /**
   * M2-A-WP-I's four elicitation fixtures, all two lines on top of the shared `elicit-support.mjs`
   * that carries transcript `12`'s bytes: `oneOf` + the paired `_custom` property, a free-text
   * custom answer, a multi-question form, and one that never answers so a park can time out.
   */
  | "elicit-oneof"
  | "elicit-custom"
  | "elicit-multi"
  | "elicit-never-answers"
  /**
   * M2-B-WP-P's degenerate menu: the ONLY grant offered is an `allow_always`, which D4 rule 3
   * forbids selecting by any path, so an `allow` verdict has to downgrade rather than take it.
   */
  | "permission-allow-always-only"
  /**
   * M2-WP-J's writer: the only fixture that actually WRITES to its own cwd, and the only way to
   * make a git patch that is not empty. The SDK example agent SIMULATES its edit
   * (`rawOutput: {success:true}`) and never touches the disk, so it can prove a permission was
   * allowed and nothing at all about D8.
   *
   * `PATCH_INIT_GIT=1` makes it create `.git/` mid-turn, which is F39's observed codex-acp
   * behaviour and the only deterministic reproduction of it.
   */
  | "patch-writer";

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
