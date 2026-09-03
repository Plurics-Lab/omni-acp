import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main, parseArgs, yamlToDaemonConfig } from "@omni-acp/cli";
import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("@omni-acp/cli surface", () => {
  it("keeps the three testable units out of the executable", () => {
    expect(typeof parseArgs).toBe("function");
    expect(typeof yamlToDaemonConfig).toBe("function");
    expect(typeof main).toBe("function");
  });

  it("keeps bin.js to a shebang and a call, so nothing testable hides in it", () => {
    // D15: the CLI is a shell. `bin.ts` exists to be the file `npm` links, and every line in it
    // is a line no test can reach.
    const bin = readFileSync(join(PACKAGE_ROOT, "src", "bin.ts"), "utf8");
    const code = bin
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "" && !l.startsWith("//") && !l.startsWith("#!"));
    expect(code).toEqual([
      'import { main } from "./main.js";',
      "process.exitCode = await main(process.argv.slice(2), process.env);",
    ]);
  });

  it("declares the bin under the name npm installs globally", () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as {
      bin?: Record<string, string>;
    };
    expect(manifest.bin).toEqual({ "omni-acp": "./dist/bin.js" });
  });
});
