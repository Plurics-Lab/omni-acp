import { describe, expect, it } from "vitest";
import { importedModules, packageSources, workspaceManifests } from "./source-scan.js";

/**
 * Architecture guard: `dependency-direction` (CONTRACTS.md §10.2, §3.1).
 *
 *   protocol ──┬──► testkit
 *              ├──► core ──► daemon ──► cli
 *              └──► client            integration ──► {client, daemon, core, testkit}
 *
 * Two properties, and the second is the one that bites: `@omni-acp/client` must never carry
 * `hono`, `yaml` or `@omni-acp/daemon` in its RUNTIME closure (D14), because a browser or a
 * lambda that installs the client should not be installing an HTTP server.
 */

const INTERNAL = /^@omni-acp\//;

interface Allowance {
  readonly dependencies: readonly string[];
  readonly devDependencies: readonly string[];
  readonly peerDependencies: readonly string[];
}

const ALL_PACKAGES = [
  "@omni-acp/protocol",
  "@omni-acp/testkit",
  "@omni-acp/core",
  "@omni-acp/daemon",
  "@omni-acp/client",
  "@omni-acp/cli",
];

const ALLOWED: Record<string, Allowance> = {
  "@omni-acp/protocol": { dependencies: [], devDependencies: [], peerDependencies: [] },
  "@omni-acp/testkit": {
    dependencies: ["@omni-acp/protocol"],
    devDependencies: [],
    peerDependencies: [],
  },
  "@omni-acp/core": {
    dependencies: ["@omni-acp/protocol"],
    devDependencies: ["@omni-acp/testkit"],
    peerDependencies: [],
  },
  "@omni-acp/daemon": {
    dependencies: ["@omni-acp/protocol", "@omni-acp/core"],
    devDependencies: ["@omni-acp/testkit"],
    peerDependencies: [],
  },
  "@omni-acp/client": {
    dependencies: ["@omni-acp/protocol"],
    devDependencies: ["@omni-acp/testkit", "@omni-acp/daemon"],
    peerDependencies: ["@omni-acp/daemon"],
  },
  "@omni-acp/cli": {
    dependencies: ["@omni-acp/protocol", "@omni-acp/daemon"],
    devDependencies: ["@omni-acp/testkit"],
    peerDependencies: [],
  },
  "@omni-acp/integration-tests": {
    dependencies: [],
    devDependencies: ALL_PACKAGES,
    peerDependencies: [],
  },
};

const manifests = workspaceManifests().filter((m) => m.name in ALLOWED);

const deps = (json: Record<string, unknown>, field: keyof Allowance): string[] =>
  Object.keys((json[field] as Record<string, string> | undefined) ?? {});

describe("guard: dependency-direction", () => {
  it("covers every workspace package", () => {
    expect(manifests.map((m) => m.name).sort()).toEqual(
      [...ALL_PACKAGES, "@omni-acp/integration-tests"].sort(),
    );
  });

  it("keeps every internal edge inside the DAG", () => {
    const violations: string[] = [];
    for (const { name, path, json } of manifests) {
      const allowance = ALLOWED[name];
      if (allowance === undefined) continue;
      for (const field of ["dependencies", "devDependencies", "peerDependencies"] as const) {
        for (const dep of deps(json, field).filter((d) => INTERNAL.test(d))) {
          if (!allowance[field].includes(dep)) violations.push(`${path}#${field} -> ${dep}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("has no cycles", () => {
    const graph = new Map<string, string[]>();
    for (const { name, json } of manifests) {
      graph.set(
        name,
        deps(json, "dependencies").filter((d) => INTERNAL.test(d)),
      );
    }
    const state = new Map<string, "visiting" | "done">();
    const walk = (node: string, trail: string[]): void => {
      if (state.get(node) === "done") return;
      if (state.get(node) === "visiting") {
        throw new Error(`dependency cycle: ${[...trail, node].join(" -> ")}`);
      }
      state.set(node, "visiting");
      for (const next of graph.get(node) ?? []) walk(next, [...trail, node]);
      state.set(node, "done");
    };
    expect(() => {
      for (const node of graph.keys()) walk(node, []);
    }).not.toThrow();
  });

  it("keeps hono, yaml and the daemon out of the client's RUNTIME closure (D14)", () => {
    const runtime = new Map<string, string[]>();
    for (const { name, json } of manifests) runtime.set(name, deps(json, "dependencies"));

    const closure = new Set<string>();
    const collect = (name: string): void => {
      for (const dep of runtime.get(name) ?? []) {
        if (closure.has(dep)) continue;
        closure.add(dep);
        collect(dep);
      }
    };
    collect("@omni-acp/client");

    expect([...closure].sort()).toEqual(["@agentclientprotocol/sdk", "@omni-acp/protocol", "zod"]);
    for (const forbidden of [
      "hono",
      "@hono/node-server",
      "yaml",
      "@omni-acp/daemon",
      "@omni-acp/core",
    ]) {
      expect(closure.has(forbidden)).toBe(false);
    }
  });

  it("reaches the daemon only through an OPTIONAL peer dependency", () => {
    const client = manifests.find((m) => m.name === "@omni-acp/client")?.json ?? {};
    expect(deps(client, "dependencies")).not.toContain("@omni-acp/daemon");
    expect(deps(client, "peerDependencies")).toContain("@omni-acp/daemon");
    expect(
      (client["peerDependenciesMeta"] as Record<string, { optional?: boolean }> | undefined)?.[
        "@omni-acp/daemon"
      ]?.optional,
    ).toBe(true);
  });

  it("lets `protocol` compile standalone: its source imports no @omni-acp package", () => {
    const offenders = packageSources()
      .filter((s) => s.path.startsWith("packages/protocol/src/"))
      .filter((s) => importedModules(s).some((m) => INTERNAL.test(m)))
      .map((s) => s.path);
    expect(offenders).toEqual([]);
  });

  it("imports only what the manifest declares, in every package's src", () => {
    const violations: string[] = [];
    for (const file of packageSources()) {
      const parts = file.path.split("/");
      const dir = parts[1];
      const manifest = manifests.find((m) => m.path === `packages/${dir}/package.json`);
      if (manifest === undefined) continue;
      const declared = new Set([
        ...deps(manifest.json, "dependencies"),
        ...deps(manifest.json, "peerDependencies"),
      ]);
      for (const spec of importedModules(file).filter((m) => INTERNAL.test(m))) {
        if (!declared.has(spec)) violations.push(`${file.path} -> ${spec}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
