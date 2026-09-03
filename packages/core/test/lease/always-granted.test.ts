import { describe, expect, it } from "vitest";
import { alwaysGrantedLease } from "@omni-acp/core";
import { OmniError, type ClientRef, type TokenId } from "@omni-acp/protocol";

const OWNER: ClientRef = { tokenId: "tok_owner" as TokenId, clientId: "cli_owner" };
const OTHER: ClientRef = { tokenId: "tok_other" as TokenId, clientId: "cli_other" };

describe("alwaysGrantedLease (L8, D5)", () => {
  it("reports the creator as the holder", () => {
    expect(alwaysGrantedLease(OWNER).holder).toEqual(OWNER);
  });

  it("assertHolder never throws in M0 — not even for a different client", () => {
    const lease = alwaysGrantedLease(OWNER);
    expect(() => {
      lease.assertHolder(OWNER);
    }).not.toThrow();
    // D5's single-controller rule is M1 (CONTRACTS.md §2.3). Until then every caller is let
    // through, which is exactly why every call site already passes a ClientRef.
    expect(() => {
      lease.assertHolder(OTHER);
    }).not.toThrow();
  });

  it("acquire and release throw bad_request naming M1, never lease_held", () => {
    const lease = alwaysGrantedLease(OWNER);
    for (const call of [() => lease.acquire(OTHER), () => lease.release(OWNER)]) {
      let caught: unknown;
      try {
        call();
      } catch (e) {
        caught = e;
      }
      expect(OmniError.is(caught, "bad_request")).toBe(true);
      expect((caught as OmniError).status).toBe(400);
      expect((caught as OmniError).message).toContain("M1");
    }
  });

  it("acquire({steal:true}) is refused the same way — no partial M1 behaviour leaks", () => {
    const lease = alwaysGrantedLease(OWNER);
    expect(() => {
      lease.acquire(OTHER, { steal: true });
    }).toThrow(OmniError);
    expect(lease.holder).toEqual(OWNER);
  });
});
