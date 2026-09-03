import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT, workspaceManifests } from "./source-scan.js";

const SDK = "@agentclientprotocol/sdk";
const PINNED = "1.4.0";
const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies"] as const;

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
      for (const field of DEP_FIELDS) {
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

  it("is the version actually installed, in every package that declares it", () => {
    // Read from disk rather than `import(\`${SDK}/package.json\`)`: the SDK's export map does
    // not expose ./package.json (F8), so the import ALWAYS rejects and a guard written around
    // it asserts nothing on any machine. This one fails when the tree on disk disagrees with
    // the manifests, which is the whole question.
    const declaring = manifests.filter(({ json }) =>
      DEP_FIELDS.some((f) => (json[f] as Record<string, string> | undefined)?.[SDK] !== undefined),
    );
    expect(declaring.length).toBeGreaterThanOrEqual(4);

    for (const { path } of declaring) {
      const installed = join(REPO_ROOT, dirname(path), "node_modules", SDK, "package.json");
      expect(existsSync(installed) ? installed : `MISSING: ${installed}`).toBe(installed);
      const json = JSON.parse(readFileSync(installed, "utf8")) as { version?: string };
      expect(`${path} -> ${String(json.version)}`).toBe(`${path} -> ${PINNED}`);
    }
  });
});
