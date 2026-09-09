import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fakeWebhookReceiver } from "@omni-acp/testkit";
import { signDelivery } from "../../src/webhook/sign.js";

/**
 * `Omni-Signature`, against a FIXED VECTOR — a literal, checked-in string rather than a value
 * recomputed by the same code under test.
 *
 * A signature test that hashes with `createHmac` and compares to `signDelivery` proves only that
 * the function is deterministic. The vector below was computed once, out of band, from §24.3's
 * description — HMAC-SHA256 over `"<t>.<raw body>"` — and any change to the format, the
 * separator, the encoding or the timestamp's placement moves it.
 *
 * Owned by M2-B-WP-R.
 */

const SECRET = "omni-acp-fixed-vector-secret-32b!";
/** 2026-01-01T00:00:00Z, the same epoch `fakeClock()` starts at, in seconds. */
const TS_SEC = 1_767_225_600;

/** The eight-key thin payload, serialized exactly as the dispatcher serializes it. */
const BODY = JSON.stringify({
  deliveryId: "dl_00000000000000000000000001",
  event: "run.completed",
  daemonId: "d_00000000000000000000000001",
  workerId: "w_00000000000000000000000001",
  runId: "r_00000000000000000000000001",
  sessionId: null,
  seq: 7,
  ts: "2026-01-01T00:00:00.000Z",
});

const VECTOR = "t=1767225600,v1=362aa7e87fcb22ed7e49542810a701c6bf9d38c82ada04fcab6844fd5ff17dd1";

describe("signDelivery (§24.3)", () => {
  it("matches the fixed vector", () => {
    expect(signDelivery(SECRET, TS_SEC, BODY)).toBe(VECTOR);
  });

  it("signs `<t>.<raw body>` — the timestamp is INSIDE the signed string", () => {
    // The property the fixed vector encodes, stated as the reason it exists: a receiver can
    // reject a replay by AGE without parsing the JSON, which is the only order that is safe when
    // the body is attacker-influenced.
    const digest = signDelivery(SECRET, TS_SEC, BODY).split("v1=")[1];
    expect(digest).toBe(
      createHmac("sha256", SECRET)
        .update(`${String(TS_SEC)}.${BODY}`, "utf8")
        .digest("hex"),
    );
    // ...and NOT over the body alone, which is the mistake the separator exists to prevent.
    expect(digest).not.toBe(createHmac("sha256", SECRET).update(BODY, "utf8").digest("hex"));
  });

  it("moves when the timestamp moves, even for a byte-identical body", () => {
    expect(signDelivery(SECRET, TS_SEC + 1, BODY)).not.toBe(VECTOR);
  });

  it("truncates a fractional timestamp rather than signing `1767225600.5`", () => {
    expect(signDelivery(SECRET, TS_SEC + 0.9, BODY)).toBe(VECTOR);
  });

  describe("fakeWebhookReceiver verifies it, and a WRONG secret fails", () => {
    it("agrees with an INDEPENDENT verifier", async () => {
      // The receiver re-implements the format from §24.3 rather than calling `signDelivery`, so
      // this is two implementations agreeing rather than one function agreeing with itself.
      const receiver = await fakeWebhookReceiver();
      try {
        await fetch(receiver.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "omni-signature": signDelivery(SECRET, TS_SEC, BODY),
          },
          body: BODY,
        });
        expect(receiver.received).toHaveLength(1);
        expect(receiver.verify(0, SECRET)).toBe(true);
        expect(receiver.verify(0, `${SECRET}x`)).toBe(false);
        expect(receiver.verify(0, "")).toBe(false);
        // An index nobody delivered to is not a pass.
        expect(receiver.verify(1, SECRET)).toBe(false);
      } finally {
        await receiver.close();
      }
    });

    it("fails a body that was tampered with in flight", async () => {
      const receiver = await fakeWebhookReceiver();
      try {
        await fetch(receiver.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            // Signed over the REAL body, delivered with one extra byte — the exact thing a
            // signature exists to catch, and the reason the receiver records raw text.
            "omni-signature": signDelivery(SECRET, TS_SEC, BODY),
          },
          body: `${BODY} `,
        });
        expect(receiver.verify(0, SECRET)).toBe(false);
      } finally {
        await receiver.close();
      }
    });

    it("fails a malformed header rather than throwing", async () => {
      const receiver = await fakeWebhookReceiver();
      try {
        for (const header of ["", "v1=abc", "t=nope,v1=abc", "t=1,v1=zz", "t=1"]) {
          await fetch(receiver.url, {
            method: "POST",
            headers: { "content-type": "application/json", "omni-signature": header },
            body: BODY,
          });
        }
        for (let i = 0; i < 5; i++) expect(receiver.verify(i, SECRET)).toBe(false);
      } finally {
        await receiver.close();
      }
    });
  });
});
