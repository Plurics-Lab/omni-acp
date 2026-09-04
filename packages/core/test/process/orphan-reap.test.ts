import { describe, expect, it } from "vitest";
import type { OrphanRecord, PlatformOps, TerminationRung } from "@omni-acp/protocol";
import { createSupervisor } from "../../src/process/supervisor.js";
import { createPlatformOps } from "../../src/process/platform.js";
import {
  POSIX_OWNERSHIP,
  WINDOWS_OWNERSHIP,
  realClock,
  recordingLogger,
  recordingUtility,
  stubPlatform,
  supervisorConfig,
} from "./support.js";

/**
 * `Supervisor.reapOrphan` — §15.7, ruling M1-R9, and M1-PLAN WP-C acceptance 7's second half.
 *
 * Every test here is a SPY assertion, because the property is negative: **no signal is sent
 * without proof.** A test that only checked the return value would pass for an implementation
 * that killed first and reported afterwards, which is the exact bug the fingerprint exists to
 * prevent — Linux pid reuse wraps at `pid_max`, so signalling a stale pid after a reboot is a
 * coin flip on somebody else's process.
 */

interface Spy extends PlatformOps {
  /** Every `signalTreeByGroup` call. MUST stay empty on every refusal path. */
  readonly signals: readonly { groupId: number; sig: "SIGTERM" | "SIGKILL" }[];
  readonly fingerprintCalls: readonly number[];
  /** What `platform.fingerprint(pid)` answers — i.e. what the pid looks like NOW. */
  current: string | null;
  /** Flips to true once a signal has been delivered, so `isGroupGone` can react. */
  gone: boolean;
}

function spyPlatform(o?: {
  windows?: boolean;
  current?: string | null;
  diesOnTerm?: boolean;
}): Spy {
  const base = stubPlatform({
    ownership: o?.windows === true ? WINDOWS_OWNERSHIP : POSIX_OWNERSHIP,
  });
  const signals: { groupId: number; sig: "SIGTERM" | "SIGKILL" }[] = [];
  const fingerprintCalls: number[] = [];
  const spy: Spy = {
    ...base,
    signals,
    fingerprintCalls,
    current: o?.current === undefined ? "linux:100:200" : o.current,
    gone: false,
    fingerprint(pid: number): Promise<string | null> {
      fingerprintCalls.push(pid);
      return Promise.resolve(spy.current);
    },
    signalTreeByGroup(groupId: number, sig: "SIGTERM" | "SIGKILL"): Promise<TerminationRung> {
      signals.push({ groupId, sig });
      if (sig === "SIGKILL" || o?.diesOnTerm !== false) spy.gone = true;
      return Promise.resolve(sig === "SIGTERM" ? "sigterm" : "sigkill");
    },
    isGroupGone(): Promise<boolean> {
      return Promise.resolve(spy.gone);
    },
  };
  return spy;
}

const record = (over: Partial<OrphanRecord> = {}): OrphanRecord => ({
  pid: 4242,
  groupId: 4242,
  startedAt: "2026-09-04T00:00:00.000Z",
  fingerprint: "linux:100:200",
  reaped: false,
  reapSkipped: null,
  ...over,
});

function supervisorWith(platform: PlatformOps, config?: { reapOrphans?: "never" | "fingerprint" }) {
  return createSupervisor({
    config: supervisorConfig({ killConfirmMs: 40, ...config }),
    clock: realClock(),
    logger: recordingLogger(),
    platform,
  });
}

describe("reapOrphan — the refusals, each spy-asserted", () => {
  it("`reapOrphans: never` is `policy`, and asks for nothing", async () => {
    const platform = spyPlatform();
    const s = supervisorWith(platform, { reapOrphans: "never" });

    const out = await s.reapOrphan(record());

    expect(out).toMatchObject({ reaped: false, reapSkipped: "policy" });
    expect(platform.signals).toEqual([]);
    // It does not even LOOK: an operator who turned reaping off did not ask us to inspect pids.
    expect(platform.fingerprintCalls).toEqual([]);
  });

  it("a NULL recorded fingerprint is `unsupported_platform`, and NOTHING is signalled", async () => {
    const platform = spyPlatform();
    const s = supervisorWith(platform);

    const out = await s.reapOrphan(record({ fingerprint: null }));

    // This is win32 by construction (§15.7 fixes its fingerprint at null), and it is any POSIX
    // spawn whose /proc read or `ps` call failed. Either way there is no proof, so no signal.
    expect(out).toMatchObject({ reaped: false, reapSkipped: "unsupported_platform" });
    expect(platform.signals).toEqual([]);
    expect(platform.fingerprintCalls).toEqual([]);
  });

  it("a MISMATCHED fingerprint is `fingerprint_mismatch` — the recycled-pid case", async () => {
    // The pid is live, but it is somebody else's process now: the machine rebooted, or the pid
    // wrapped. This is the single case the whole mechanism exists to catch.
    const platform = spyPlatform({ current: "linux:999:200" });
    const s = supervisorWith(platform);

    const out = await s.reapOrphan(record({ fingerprint: "linux:100:200" }));

    expect(out).toMatchObject({ reaped: false, reapSkipped: "fingerprint_mismatch" });
    expect(platform.signals).toEqual([]);
    expect(platform.fingerprintCalls).toEqual([4242]);
  });

  it("a pid with no CURRENT token is `gone`, and is still not signalled", async () => {
    const platform = spyPlatform({ current: null });
    const s = supervisorWith(platform);

    const out = await s.reapOrphan(record());

    expect(out).toMatchObject({ reaped: false, reapSkipped: "gone" });
    expect(platform.signals).toEqual([]);
  });

  it("a record with no GROUP is `unsupported_platform`: the leader alone is not the tree", async () => {
    const platform = spyPlatform();
    const s = supervisorWith(platform);

    const out = await s.reapOrphan(record({ groupId: null }));

    // §6.5's rule — kill the group, not the leader — because the agent's MCP servers and shells
    // are in that group. Falling back to the pid would convert one orphan into several.
    expect(out).toMatchObject({ reaped: false, reapSkipped: "unsupported_platform" });
    expect(platform.signals).toEqual([]);
  });

  it("refuses the group ids that mean the daemon itself, or everything (0, 1, and worse)", async () => {
    for (const groupId of [0, 1, -1, -4242, 1.5, Number.NaN]) {
      const platform = spyPlatform();
      const out = await supervisorWith(platform).reapOrphan(record({ groupId }));

      // The one case where a `reaped: true` would be a pure lie: nothing was sent, because
      // nothing COULD be sent. `platform-posix.ts` refuses these again; this asserts that the
      // supervisor never gets far enough to claim a kill it did not make.
      expect(out, `groupId ${String(groupId)}`).toMatchObject({
        reaped: false,
        reapSkipped: "unsupported_platform",
      });
      expect(platform.signals).toEqual([]);
    }
  });

  it("ALWAYS resolves: an exploding platform is DATA, never an exception", async () => {
    const platform = spyPlatform();
    const boom: PlatformOps = {
      ...platform,
      fingerprint: () => Promise.reject(new Error("/proc is not mounted")),
    };
    const s = supervisorWith(boom);

    const out = await s.reapOrphan(record());

    expect(out.reaped).toBe(false);
    // NOT rounded up to "gone" and not down to "policy": both would put a false statement in the
    // adoption envelope an operator reads to decide whether a tree is still running.
    expect(out.reapSkipped).toBe("error");
  });

  it("keeps every field of the record it was handed, so an envelope can carry it verbatim", async () => {
    const platform = spyPlatform({ current: "linux:999:200" });
    const s = supervisorWith(platform);
    const input = record({ startedAt: "2026-01-01T00:00:00.000Z", pid: 777, groupId: 777 });

    const out = await s.reapOrphan(input);

    expect(out.pid).toBe(777);
    expect(out.groupId).toBe(777);
    expect(out.startedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(out.fingerprint).toBe(input.fingerprint);
  });
});

describe("reapOrphan — the one path that DOES signal", () => {
  it("a MATCHING fingerprint reaps the GROUP, SIGTERM first", async () => {
    const platform = spyPlatform();
    const s = supervisorWith(platform);

    const out = await s.reapOrphan(record());

    expect(out).toMatchObject({ reaped: true, reapSkipped: null });
    // The group, not the leader; and the agent gets its normal shutdown first — we are
    // reclaiming a process, not punishing it.
    expect(platform.signals).toEqual([{ groupId: 4242, sig: "SIGTERM" }]);
  });

  it("escalates to SIGKILL when the group does not go away", async () => {
    const platform = spyPlatform({ diesOnTerm: false });
    const s = supervisorWith(platform);

    const out = await s.reapOrphan(record());

    expect(out.reaped).toBe(true);
    expect(platform.signals).toEqual([
      { groupId: 4242, sig: "SIGTERM" },
      { groupId: 4242, sig: "SIGKILL" },
    ]);
  });

  it("proves it first: the fingerprint is read BEFORE the first signal", async () => {
    const order: string[] = [];
    const base = spyPlatform();
    const platform: PlatformOps = {
      ...base,
      fingerprint: (pid) => {
        order.push("fingerprint");
        return base.fingerprint(pid);
      },
      signalTreeByGroup: (groupId, sig) => {
        order.push(`signal:${sig}`);
        return base.signalTreeByGroup(groupId, sig);
      },
    };
    await supervisorWith(platform).reapOrphan(record());
    expect(order[0]).toBe("fingerprint");
  });
});

/**
 * The Windows branch COMPILES and runs, on every OS, and answers `unsupported_platform` — which
 * is `GET /v1/info.orphansAtStart.skipped`'s content on that platform (§15.7, M1-R9).
 */
describe("reapOrphan — Windows", () => {
  it("records the orphan and touches nothing", async () => {
    const utility = recordingUtility();
    const platform = createPlatformOps("win32", { runUtility: utility.fn });
    const s = supervisorWith(platform);

    // A Windows spawn writes `fingerprint: null` and `groupId: null` — both of which are
    // refusals on their own, and this asserts the record a Windows boot would actually hold.
    const out = await s.reapOrphan(record({ fingerprint: null, groupId: null }));

    expect(out).toMatchObject({ reaped: false, reapSkipped: "unsupported_platform" });
    // Not one `taskkill`, not one `tasklist`: Windows REPORTS the orphan and does not touch it.
    expect(utility.calls).toEqual([]);
  });

  it("`signalTreeByGroup` on Windows is a no-op that signals nothing", async () => {
    const utility = recordingUtility();
    const platform = createPlatformOps("win32", { runUtility: utility.fn });
    expect(await platform.signalTreeByGroup(1234, "SIGKILL")).toBe("taskkill");
    expect(await platform.signalTreeByGroup(1234, "SIGTERM")).toBe("sigterm");
    expect(await platform.isGroupGone(1234)).toBe(false);
    expect(utility.calls).toEqual([]);
  });
});

/** The POSIX group primitives, which the reaper is built on. */
describe("POSIX signalTreeByGroup / isGroupGone", () => {
  const posix = createPlatformOps("linux");

  it("refuses the group ids that mean something else entirely to kill(2)", async () => {
    // 0 is "every process in MY group" — the daemon itself — and -1 is "everything I may
    // signal". A `groupId` can only be one of those through a bug, and the blast radius of that
    // bug is the whole machine.
    for (const groupId of [0, 1, -1, -4242, 1.5, Number.NaN]) {
      expect(await posix.isGroupGone(groupId), `isGroupGone(${String(groupId)})`).toBe(false);
      // It still reports the rung it was asked for; what it does not do is deliver a signal.
      expect(await posix.signalTreeByGroup(groupId, "SIGKILL")).toBe("sigkill");
    }
  });

  it.skipIf(process.platform === "win32")(
    "tracks a REAL detached tree: not gone while it lives, gone once it is reaped",
    async () => {
      // `detached: true` is what makes `pgid === pid`, and it is the only reason a group id is an
      // address at all. A spawned fixture is the only honest subject here: this test process is
      // not a group leader, so `kill(-process.pid, 0)` is ESRCH for a process that plainly exists.
      const { realSupervisor, fixtureSpec } = await import("./support.js");
      const supervisor = realSupervisor();
      const proc = await supervisor.spawn(fixtureSpec("echo"));
      const groupId = proc.info.groupId;
      expect(groupId).not.toBeNull();

      expect(await posix.isGroupGone(groupId as number)).toBe(false);
      await proc.terminate({ force: true });
      expect(await posix.isGroupGone(groupId as number)).toBe(true);
    },
  );

  it("reports an implausible group as gone", async () => {
    expect(await posix.isGroupGone(2_147_483_646)).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "reapOrphan really does kill a tree this Supervisor did not spawn",
    async () => {
      // The end-to-end proof, on the real platform ops: spawn through ONE supervisor, forget it,
      // and reap it through ANOTHER as if a previous boot had left it behind.
      const { realSupervisor, fixtureSpec } = await import("./support.js");
      const owner = realSupervisor();
      const proc = await owner.spawn(fixtureSpec("echo"));
      const platform = createPlatformOps();
      const fingerprint = proc.info.fingerprint;
      expect(fingerprint).not.toBeNull();

      const reaper = supervisorWith(platform);
      const out = await reaper.reapOrphan(
        record({ pid: proc.info.pid, groupId: proc.info.groupId, fingerprint }),
      );

      expect(out).toMatchObject({ reaped: true, reapSkipped: null });
      await proc.exited;
      expect(await platform.isGroupGone(proc.info.groupId as number)).toBe(true);
    },
  );

  it.skipIf(process.platform === "win32")(
    "…and REFUSES the same live tree once the recorded fingerprint no longer matches",
    async () => {
      const { realSupervisor, fixtureSpec } = await import("./support.js");
      const owner = realSupervisor();
      const proc = await owner.spawn(fixtureSpec("echo"));
      try {
        const platform = createPlatformOps();
        const out = await supervisorWith(platform).reapOrphan(
          record({
            pid: proc.info.pid,
            groupId: proc.info.groupId,
            // The token a PREVIOUS incarnation of this pid would have had.
            fingerprint: "linux:1:1",
          }),
        );
        expect(out).toMatchObject({ reaped: false, reapSkipped: "fingerprint_mismatch" });
        // Still alive: the refusal is the whole point.
        expect(await platform.isGroupGone(proc.info.groupId as number)).toBe(false);
      } finally {
        await proc.terminate({ force: true });
      }
    },
  );
});
