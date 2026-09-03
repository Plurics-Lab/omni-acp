import { describe, expect, it } from "vitest";
import {
  ID_PATTERN,
  OmniError,
  ULID_BODY,
  assertTurnId,
  assertWorkerId,
  createIdGen,
  isDaemonId,
  isTurnId,
  isWorkerId,
  parseWorkerRef,
  workerRef,
  type DaemonId,
  type WorkerId,
} from "@omni-acp/protocol";

const ZERO_BODY = "0".repeat(26);

describe("id guards", () => {
  it("accepts a well-formed prefixed ULID and nothing else", () => {
    expect(isDaemonId(`d_${ZERO_BODY}`)).toBe(true);
    expect(isWorkerId(`w_${ZERO_BODY}`)).toBe(true);
    expect(isTurnId(`t_${ZERO_BODY}`)).toBe(true);

    // Right shape, wrong prefix.
    expect(isWorkerId(`d_${ZERO_BODY}`)).toBe(false);
    expect(isTurnId(`w_${ZERO_BODY}`)).toBe(false);
    // Crockford excludes I, L, O and U.
    expect(isWorkerId(`w_${"I".repeat(26)}`)).toBe(false);
    expect(isWorkerId(`w_${"U".repeat(26)}`)).toBe(false);
    // Wrong length, lower case, trailing junk.
    expect(isWorkerId(`w_${"0".repeat(25)}`)).toBe(false);
    expect(isWorkerId(`w_${"a".repeat(26)}`)).toBe(false);
    expect(isWorkerId(`w_${ZERO_BODY}x`)).toBe(false);
    expect(isWorkerId("")).toBe(false);
  });

  it("elides the offending value from an assertion message and keeps it in `detail`", () => {
    const hostile = "w_<script>alert(1)</script>";
    try {
      assertWorkerId(hostile);
      expect.unreachable("assertWorkerId accepted a malformed id");
    } catch (e) {
      expect(OmniError.is(e, "bad_request")).toBe(true);
      const err = e as OmniError;
      expect(err.status).toBe(400);
      expect(err.message).not.toContain(hostile);
      expect(err.detail).toEqual({ value: hostile });
    }
    expect(() => assertTurnId("nope")).toThrow(OmniError);
    expect(assertWorkerId(`w_${ZERO_BODY}`)).toBe(`w_${ZERO_BODY}`);
    expect(assertTurnId(`t_${ZERO_BODY}`)).toBe(`t_${ZERO_BODY}`);
  });

  it("round-trips a WorkerRef and refuses a malformed one", () => {
    const d = `d_${ZERO_BODY}` as DaemonId;
    const w = `w_${ZERO_BODY}` as WorkerId;
    const ref = workerRef(d, w);
    expect(ref).toBe(`${d}:${w}`);
    expect(parseWorkerRef(ref)).toEqual({ daemonId: d, workerId: w });

    for (const bad of ["", "d_x:w_y", `${d}`, `${w}:${d}`, `${d}:${w}:extra`]) {
      expect(() => parseWorkerRef(bad)).toThrow(OmniError);
    }
  });
});

describe("createIdGen", () => {
  it("is fully determined by the injected now/random", () => {
    const ids = createIdGen({ now: () => 0, random: () => 0 });
    expect(ids.daemon()).toBe(`d_${ZERO_BODY}`);
    // Same millisecond => the random field is incremented, so ids stay strictly increasing.
    expect(ids.worker()).toBe(`w_${"0".repeat(25)}1`);
    expect(ids.turn()).toBe(`t_${"0".repeat(25)}2`);
    expect(ids.request()).toBe(`${"0".repeat(25)}3`);

    const maxed = createIdGen({ now: () => 0, random: () => 0.999999 });
    expect(maxed.worker()).toBe(`w_${"0".repeat(10)}${"Z".repeat(16)}`);
  });

  it("emits prefixed 26-character Crockford ULIDs", () => {
    const ids = createIdGen();
    const d = ids.daemon();
    const w = ids.worker();
    const t = ids.turn();
    expect(d).toMatch(ID_PATTERN.daemon);
    expect(w).toMatch(ID_PATTERN.worker);
    expect(t).toMatch(ID_PATTERN.turn);
    expect(ULID_BODY.test(ids.request())).toBe(true);
    for (const id of [d, w, t]) expect(id).toHaveLength(28);
  });

  it("is monotonic within a millisecond and across a clock that steps backwards", () => {
    let clock = 1_000_000;
    const ids = createIdGen({ now: () => clock });
    const seen: string[] = [];
    for (let i = 0; i < 200; i++) {
      if (i === 100) clock -= 5_000; // NTP step backwards mid-run
      seen.push(ids.worker());
    }
    expect(new Set(seen).size).toBe(seen.length);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]! > seen[i - 1]!).toBe(true);
    }
  });

  it("advances the timestamp field when the clock does", () => {
    let clock = 0;
    const ids = createIdGen({ now: () => clock, random: () => 0 });
    const first = ids.worker();
    clock = 32; // one carry out of the last base-32 digit of the time field
    const second = ids.worker();
    expect(first.slice(2, 12)).toBe("0".repeat(10));
    expect(second.slice(2, 12)).toBe(`${"0".repeat(8)}10`);
    expect(second.slice(12)).toBe("0".repeat(16));
  });

  it("hands out independent counters per id kind but one shared clock", () => {
    const ids = createIdGen({ now: () => 42, random: () => 0 });
    const all = [ids.daemon(), ids.worker(), ids.turn()];
    expect(new Set(all.map((s) => s.slice(2))).size).toBe(3);
    expect(all.every((s) => s.slice(2, 12) === all[0]!.slice(2, 12))).toBe(true);
  });
});
