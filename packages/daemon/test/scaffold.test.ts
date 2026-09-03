import { describe, expect, it } from "vitest";
import { createDaemon, createHttpApp } from "@omni-acp/daemon";

describe("@omni-acp/daemon scaffold", () => {
  it("exports the two entry points the rest of the repository depends on", () => {
    expect(typeof createDaemon).toBe("function");
    expect(typeof createHttpApp).toBe("function");
  });

  it("throws a typed unimplemented error until WP-5 lands", () => {
    expect(() => createHttpApp({} as never)).toThrow(/unimplemented: WP-5/);
  });
});
