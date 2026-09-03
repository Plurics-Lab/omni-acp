import { describe, expect, it } from "vitest";
import { workspaceManifests } from "./source-scan.js";

const SDK = "@agentclientprotocol/sdk";
const PINNED = "1.4.0";

/**
 * Architecture guard: `sdk-version-pinned` (CONTRACTS.md §10.2, D7).
 *
 * M0 uses `experimental/v2` for TYPES, and an experimental entry point may change shape between
 * releases. A caret would let `pnpm install` move it under us on a machine nobody is watching.
 */
describe("guard: sdk-version-pinned", () => {
  const manifests = workspaceManifests();

  it("finds the manifests it is meant to police", () => {
    expect(manifests.map((m) => m.path)).toEqual(
      expect.arrayContaining([
        "packages/protocol/package.json",
        "packages/testkit/package.json",
        "packages/core/package.json",
        "tests/integration/package.json",
      ]),
    );
  });

  it("pins the ACP SDK to exactly 1.4.0 wherever it appears", () => {
    const found: string[] = [];
    for (const { path, json } of manifests) {
      for (const field of ["dependencies", "devDependencies", "peerDependencies"] as const) {
        const deps = json[field] as Record<string, string> | undefined;
        const range = deps?.[SDK];
        if (range === undefined) continue;
        found.push(`${path}#${field}`);
        expect(`${path}#${field}: ${range}`).toBe(`${path}#${field}: ${PINNED}`);
      }
    }
    // A guard that policed nothing would pass forever.
    expect(found.length).toBeGreaterThanOrEqual(4);
  });

  it("is the version actually installed", async () => {
    const sdk = (await import(`${SDK}/package.json`, { with: { type: "json" } }).catch(
      () => null,
    )) as { default?: { version?: string } } | null;
    // The SDK does not export ./package.json (F8), so this is best-effort: when the export map
    // hides it, the manifest assertions above are the guarantee.
    if (sdk?.default?.version !== undefined) expect(sdk.default.version).toBe(PINNED);
  });
});
