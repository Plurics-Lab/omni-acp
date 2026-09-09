import { describe, expect, it } from "vitest";
import { ID_PATTERN, ULID_BODY, isDaemonId, isTurnId, isWorkerId } from "@omni-acp/protocol";
import { nullLogger, seqIds } from "@omni-acp/testkit";

describe("seqIds", () => {
  it("produces d_...001, w_...001, t_...001", () => {
    const ids = seqIds();
    expect(ids.daemon()).toBe(`d_${"0".repeat(23)}001`);
    expect(ids.worker()).toBe(`w_${"0".repeat(23)}001`);
    expect(ids.turn()).toBe(`t_${"0".repeat(23)}001`);
  });

  it("counts each kind independently and stays inside the id grammar", () => {
    const ids = seqIds();
    for (let i = 1; i <= 3; i++) {
      const d = ids.daemon();
      const w = ids.worker();
      const t = ids.turn();
      expect(d.endsWith(String(i).padStart(3, "0"))).toBe(true);
      expect(isDaemonId(d) && isWorkerId(w) && isTurnId(t)).toBe(true);
      expect(ULID_BODY.test(d.slice(2))).toBe(true);
      expect(d).toMatch(ID_PATTERN.daemon);
    }
  });

  it("gives request ids their own visibly non-addressable prefix", () => {
    const ids = seqIds();
    expect(ids.request()).toBe(`q_${"0".repeat(23)}001`);
    expect(ids.request()).toBe(`q_${"0".repeat(23)}002`);
  });

  it("makes two generators independent", () => {
    expect(seqIds().worker()).toBe(seqIds().worker());
  });
});

describe("nullLogger", () => {
  it("swallows every level and returns itself from child()", () => {
    const logger = nullLogger();
    expect(logger.child({ workerId: "w_1" })).toBe(logger);
    expect(() => {
      logger.debug("d", { a: 1 });
      logger.info("i");
      logger.warn("w");
      logger.error("e", { err: new Error("x") });
    }).not.toThrow();
  });
});
