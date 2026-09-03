import { describe, expect, it } from "vitest";
import { main, parseArgs, yamlToDaemonConfig } from "@omni-acp/cli";

describe("@omni-acp/cli scaffold", () => {
  it("keeps the three testable units out of the executable", () => {
    expect(typeof parseArgs).toBe("function");
    expect(typeof yamlToDaemonConfig).toBe("function");
    expect(typeof main).toBe("function");
  });

  it("throws a typed unimplemented error until WP-6 lands", () => {
    expect(() => parseArgs(["start"])).toThrow(/unimplemented: WP-6/);
  });
});
