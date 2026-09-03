import { describe, expect, it } from "vitest";
import { isAlive, waitGone } from "@omni-acp/testkit";

describe("isAlive / waitGone", () => {
  it("sees this very process", async () => {
    expect(await isAlive(process.pid)).toBe(true);
  });

  it("refuses nonsense pids without throwing", async () => {
    for (const pid of [0, -1, 1.5, Number.NaN]) {
      expect(await isAlive(pid)).toBe(false);
    }
  });

  it("reports a pid that cannot exist as gone", async () => {
    // 2^22 is above every default pid_max; nothing can be running there.
    const impossible = 4_194_303;
    expect(await isAlive(impossible)).toBe(false);
    expect(await waitGone(impossible, 100)).toBe(true);
  });

  it("times out to `false` rather than hanging when the process stays alive", async () => {
    expect(await waitGone(process.pid, 60)).toBe(false);
  });
});
