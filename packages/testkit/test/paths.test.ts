import { statSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute } from "node:path";
import { describe, expect, it } from "vitest";
import { fixtureAgentPath, sdkExampleAgentPath } from "@omni-acp/testkit";

const require_ = createRequire(import.meta.url);

describe("sdkExampleAgentPath", () => {
  it("resolves to a real file and stats successfully", () => {
    const p = sdkExampleAgentPath();
    expect(isAbsolute(p)).toBe(true);
    expect(p.replace(/\\/g, "/").endsWith("dist/examples/agent.js")).toBe(true);
    expect(statSync(p).isFile()).toBe(true);
    // Never `new URL(...).pathname`, which yields "/C:/..." on Windows.
    expect(p).not.toMatch(/^\/[A-Za-z]:/);
  });

  it("has to be derived from the main entry, because the subpaths are not exported (F8)", () => {
    // This is the fact the helper exists for: if the SDK ever exported them, the derivation
    // would still be correct — but while it does not, nothing else can work.
    const outcome = (spec: string): string => {
      try {
        require_.resolve(spec);
        return "resolved";
      } catch (e) {
        return (e as NodeJS.ErrnoException).code ?? "unknown";
      }
    };
    expect(outcome("@agentclientprotocol/sdk/package.json")).toBe("ERR_PACKAGE_PATH_NOT_EXPORTED");
    expect(outcome("@agentclientprotocol/sdk/dist/examples/agent.js")).toBe(
      "ERR_PACKAGE_PATH_NOT_EXPORTED",
    );
    expect(require_.resolve("@agentclientprotocol/sdk")).toContain("dist");
  });
});

describe("fixtureAgentPath", () => {
  it("resolves all six fixtures to real files, from dist, on any platform", () => {
    const names = ["echo", "crash", "slow", "chatty", "orphan", "noisy"] as const;
    for (const name of names) {
      const p = fixtureAgentPath(name);
      expect(isAbsolute(p)).toBe(true);
      expect(p.endsWith(`${name}.mjs`)).toBe(true);
      expect(statSync(p).isFile()).toBe(true);
    }
  });
});
