import { describe, expect, it } from "vitest";
import { OmniACP, OmniError } from "@omni-acp/client";

describe("@omni-acp/client scaffold", () => {
  it("exposes connect() and local() from one frozen surface", () => {
    expect(typeof OmniACP.connect).toBe("function");
    expect(typeof OmniACP.local).toBe("function");
  });

  it("re-exports OmniError so a caller needs one import, not two", () => {
    expect(new OmniError("worker_busy", "x").status).toBe(409);
  });

  it("throws a typed unimplemented error until WP-6 lands", () => {
    expect(() => OmniACP.connect({ url: "http://127.0.0.1:1", token: "t" })).toThrow(
      /unimplemented: WP-6/,
    );
  });
});
