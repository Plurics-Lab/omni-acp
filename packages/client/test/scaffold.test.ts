import { OmniACP, OmniError } from "@omni-acp/client";
import { describe, expect, it } from "vitest";

/**
 * The package's published surface, asserted from OUTSIDE — `@omni-acp/client` by name, which
 * resolves through the `exports` map to the built `dist` (D25). It is the cheapest test that
 * fails when the frozen barrel stops matching what the barrel claims to re-export.
 *
 * Behaviour lives in the suites next door; this file only asks "is it all still here".
 */
describe("@omni-acp/client surface", () => {
  it("exposes connect() and local() from one frozen surface", () => {
    expect(typeof OmniACP.connect).toBe("function");
    expect(typeof OmniACP.local).toBe("function");
  });

  it("re-exports OmniError so a caller needs one import, not two", () => {
    expect(new OmniError("worker_busy", "x").status).toBe(409);
  });

  it("reports a bad argument as a REJECTION, never as a synchronous throw", async () => {
    // Both functions return a promise. A synchronous throw out of one is the classic
    // half-async footgun: `await connect(...).catch(...)` would not see it.
    const connecting = OmniACP.connect({ url: "", token: "t" });
    expect(connecting).toBeInstanceOf(Promise);
    await expect(connecting).rejects.toMatchObject({ code: "bad_request" });

    const adopting = OmniACP.local({ adopt: "require" });
    expect(adopting).toBeInstanceOf(Promise);
    await expect(adopting).rejects.toMatchObject({ code: "bad_request" });
  });
});
