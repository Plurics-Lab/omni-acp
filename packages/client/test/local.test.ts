import { OmniACP } from "@omni-acp/client";
import { describe, expect, it } from "vitest";

/**
 * The M0 boundary of `OmniACP.local()` (D14, review R13, CONTRACTS.md §2.3).
 *
 * The end-to-end behaviour — an embedded daemon on `127.0.0.1:0`, a real loopback `401`, trees
 * reclaimed on `close()` — is `tests/integration/src/local-mode.itest.ts`, because it needs a
 * daemon this package must never import. What belongs HERE is the half that is decided before
 * the dynamic import happens: which options M0 refuses, and how it says so.
 *
 * "Throws `bad_request` with a milestone in the message" is a settled ruling (D29): no
 * `not_implemented` code is introduced, because the caller asked for something this version does
 * not do, which is exactly what 400 describes.
 */
describe("OmniACP.local — the M0 boundary", () => {
  it("refuses adopt:'prefer' and adopt:'require' with a message naming M3", async () => {
    for (const adopt of ["prefer", "require"] as const) {
      const failure = await OmniACP.local({ adopt }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(failure).toMatchObject({ name: "OmniError", code: "bad_request", status: 400 });
      expect((failure as Error).message).toContain("M3");
      expect((failure as Error).message).toContain(adopt);
    }
  });

  it("refuses detach:true with a message naming M3", async () => {
    const failure = await OmniACP.local({ detach: true, adopt: "never" }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(failure).toMatchObject({ code: "bad_request" });
    expect((failure as Error).message).toContain("M3");
  });

  it("refuses before importing the daemon at all — the check is on the caller's arguments", async () => {
    // If the order were the other way round, `local({adopt:"prefer"})` on a machine without the
    // optional peer would report the wrong problem.
    const started = Date.now();
    await expect(OmniACP.local({ adopt: "prefer" })).rejects.toMatchObject({
      code: "bad_request",
    });
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
