import { statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fixtureAgentPath, sdkExampleAgentPath } from "@omni-acp/testkit";

/**
 * The two path helpers are real in the scaffold — everything else in testkit is a stub — because
 * the acceptance fixture has to be provably reachable on this machine before WP-1 starts
 * (CONTRACTS.md F8, WP-1 acceptance item 8).
 */
describe("@omni-acp/testkit scaffold", () => {
  it("resolves the SDK example agent from the SDK's main entry", () => {
    const p = sdkExampleAgentPath();
    expect(p.endsWith("agent.js")).toBe(true);
    expect(statSync(p).isFile()).toBe(true);
    // Derived from the main entry, never from `.../package.json` and never via URL.pathname.
    expect(p).not.toMatch(/^\/[A-Za-z]:/);
  });

  it("resolves every fixture agent to a real file", () => {
    for (const name of ["echo", "crash", "slow", "chatty", "orphan", "noisy"] as const) {
      expect(statSync(fixtureAgentPath(name)).isFile()).toBe(true);
    }
  });
});
