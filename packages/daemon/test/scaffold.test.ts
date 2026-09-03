import { describe, expect, it } from "vitest";
import { createDaemon, createHttpApp } from "@omni-acp/daemon";
import { stubDaemon } from "@omni-acp/testkit";

/**
 * The barrel, exercised through the PUBLISHED entry point rather than through `src/` — the
 * `exports` map and the emitted `.js` specifiers are what a consumer actually resolves (D25).
 *
 * The scaffold's version of this file asserted that both entry points threw `unimplemented:
 * WP-5`; that assertion was this work package's own to retire when the bodies landed.
 */
describe("@omni-acp/daemon barrel", () => {
  it("exports the two entry points the rest of the repository depends on", () => {
    expect(typeof createDaemon).toBe("function");
    expect(typeof createHttpApp).toBe("function");
  });

  it("createHttpApp returns a fetch-shaped app, with no port and no daemon of its own", async () => {
    const app = createHttpApp(stubDaemon());
    const res = await app.fetch(new Request("http://daemon.invalid/v1/health"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
