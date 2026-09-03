import { describe, expect, it } from "vitest";
import { WINDOWS_OWNERSHIP, ladderHarness, stubPlatform, type StubPlatform } from "./support.js";

/**
 * CONTRACTS.md §6.5, the escalation ladder — WP-2 acceptance 6, 7 and 10.
 *
 * Driven against an injected `PlatformOps`, so both platforms' rungs are observable from one
 * machine and the assertions are about the LADDER rather than about this OS. The same rungs are
 * then proven against real processes in `tree-kill.test.ts`.
 */

const posix = (o?: Parameters<typeof stubPlatform>[0]): StubPlatform => stubPlatform(o);
const windows = (o?: Omit<Parameters<typeof stubPlatform>[0], "ownership">): StubPlatform =>
  stubPlatform({ ...o, ownership: WINDOWS_OWNERSHIP });

describe("the escalation ladder — POSIX", () => {
  it("rung 1: stdin EOF is tried FIRST, and a cooperative agent stops the ladder there", async () => {
    const platform = posix();
    const harness = ladderHarness(platform, {
      onCloseStdin: (h) => {
        // The agent exits on EOF and takes its group with it.
        platform.treeGone = true;
        platform.leaderGone = true;
        h.die(0, null);
      },
    });

    const outcome = await harness.process.terminate();

    expect(harness.events).toEqual(["closeStdin"]);
    expect(platform.signals).toEqual([]); // nothing was ever signalled
    expect(outcome.escalatedTo).toBe("stdin_eof");
    expect(outcome.leaderExited).toBe(true);
    expect(outcome.treeGone).toBe(true);
    expect(outcome.exit).toMatchObject({ code: 0, requested: true });
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("rung 2: a leader that exits while its GRANDCHILD lives keeps the ladder climbing", async () => {
    // The orphan.mjs shape: the leader is gone, the work is not done, and stopping here would
    // leave a process writing to a file nobody is watching (§6.5, acceptance 5).
    const platform = posix({
      onSignal: (sig, p) => {
        if (sig === "SIGTERM") p.treeGone = true;
      },
    });
    const harness = ladderHarness(platform, {
      onCloseStdin: (h) => {
        platform.leaderGone = true;
        h.die(0, null); // leader gone, tree NOT gone
      },
    });

    const outcome = await harness.process.terminate();

    expect(platform.signals).toEqual(["SIGTERM"]);
    expect(outcome.escalatedTo).toBe("sigterm");
    expect(outcome.treeGone).toBe(true);
  });

  it("rung 3: nothing cooperates, so it ends at SIGKILL", async () => {
    const platform = posix({
      onSignal: (sig, p) => {
        if (sig === "SIGKILL") {
          p.treeGone = true;
          p.leaderGone = true;
        }
      },
    });
    const harness = ladderHarness(platform, { gracefulMs: 20, killConfirmMs: 60 });
    // The process only dies when the force rung lands.
    const outcome = await harness.process.terminate();

    expect(platform.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(outcome.escalatedTo).toBe("sigkill");
    expect(outcome.leaderExited).toBe(true);
    expect(outcome.treeGone).toBe(true);
  });

  it("acceptance 7: treeGone is NEVER true when confirmation timed out", async () => {
    // Everything is signalled, nothing can be proven: the honest outcome is `false`, not the
    // optimistic one, even though the ladder ran to the end.
    const platform = posix({ leaderGone: true });
    const harness = ladderHarness(platform, { gracefulMs: 20, killConfirmMs: 30 });

    const outcome = await harness.process.terminate();

    expect(outcome.escalatedTo).toBe("sigkill");
    expect(outcome.treeGone).toBe(false);
    expect(outcome.leaderExited).toBe(true); // the weaker fact, which IS provable here
  });

  it("reports leaderExited: false when even the leader cannot be confirmed gone", async () => {
    const platform = posix({ leaderGone: false });
    const harness = ladderHarness(platform, { gracefulMs: 20, killConfirmMs: 30 });

    const outcome = await harness.process.terminate();

    expect(outcome.leaderExited).toBe(false);
    expect(outcome.treeGone).toBe(false);
  });

  it("rung 0: an already-exited process with a reaped tree signals nothing", async () => {
    const platform = posix({ treeGone: true, leaderGone: true });
    const harness = ladderHarness(platform);
    harness.die(0, null);

    const outcome = await harness.process.terminate();

    expect(outcome.escalatedTo).toBe("already_exited");
    expect(outcome.treeGone).toBe(true);
    expect(outcome.leaderExited).toBe(true);
    expect(harness.events).toEqual([]);
    expect(platform.signals).toEqual([]);
  });

  it("rung 0: an already-exited process whose tree survives reports treeGone: false", async () => {
    const platform = posix({ treeGone: false, leaderGone: true });
    const harness = ladderHarness(platform);
    harness.die(0, null);

    const outcome = await harness.process.terminate();

    expect(outcome.escalatedTo).toBe("already_exited");
    expect(outcome.treeGone).toBe(false);
  });

  it("acceptance 9: force on an already-exited leader reclaims the tree it left behind", async () => {
    // §6.7's zombie: `exited` fired, `stdoutEnded` never did because a grandchild inherited the
    // pipe. `terminate({force:true})` is the documented response, and it must not sit through
    // the cooperative rungs waiting for a process that is already gone.
    const platform = posix({
      treeGone: false,
      leaderGone: true,
      onSignal: (sig, p) => {
        if (sig === "SIGKILL") p.treeGone = true;
      },
    });
    const harness = ladderHarness(platform, { gracefulMs: 10_000, killConfirmMs: 100 });
    harness.die(0, null);

    const started = Date.now();
    const outcome = await harness.process.terminate({ force: true });

    expect(platform.signals).toEqual(["SIGKILL"]); // no stdin rung, no SIGTERM rung
    expect(harness.events).toEqual([]);
    expect(outcome.escalatedTo).toBe("sigkill");
    expect(outcome.treeGone).toBe(true);
    // gracefulMs is 10s; the whole point is that none of it is spent.
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("force on a LIVE process skips straight to the force rung", async () => {
    const platform = posix({
      onSignal: (sig, p) => {
        if (sig === "SIGKILL") {
          p.treeGone = true;
          p.leaderGone = true;
        }
      },
    });
    const harness = ladderHarness(platform, { gracefulMs: 10_000, killConfirmMs: 100 });

    const outcome = await harness.process.terminate({ force: true });

    expect(harness.events).toEqual([]);
    expect(platform.signals).toEqual(["SIGKILL"]);
    expect(outcome.escalatedTo).toBe("sigkill");
  });

  it("honours a per-call gracefulMs override", async () => {
    const platform = posix();
    const harness = ladderHarness(platform, { gracefulMs: 10_000, killConfirmMs: 20 });
    const started = Date.now();
    await harness.process.terminate({ gracefulMs: 40 });
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});

describe("the escalation ladder — Windows", () => {
  it("acceptance 6: ends at taskkill, treeGone false, leaderExited true per tasklist", async () => {
    const platform = windows({
      leaderGone: false,
      onSignal: (sig, p) => {
        // taskkill reaps the leader; `tasklist` is then the only thing that can say so.
        if (sig === "SIGKILL") p.leaderGone = true;
      },
    });
    const harness = ladderHarness(platform, { gracefulMs: 20, killConfirmMs: 40 });

    const outcome = await harness.process.terminate();

    expect(platform.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(outcome.escalatedTo).toBe("taskkill");
    expect(outcome.leaderExited).toBe(true);
    // Never optimistic — `/T` cannot prove it, so M0 does not claim it (D10, §6.6).
    expect(outcome.treeGone).toBe(false);
    expect(platform.leaderProbes.count).toBeGreaterThan(0);
  });

  it("has no cooperative signal rung: the SIGTERM rung never reports `sigterm`", async () => {
    const platform = windows({
      leaderGone: false,
      onSignal: (sig, p) => {
        // The process happens to die during the SIGTERM rung's window — NOT because of it:
        // Windows has nothing cooperative to send.
        if (sig === "SIGTERM") p.leaderGone = true;
      },
    });
    const harness = ladderHarness(platform, { gracefulMs: 20, killConfirmMs: 20 });

    const outcome = await harness.process.terminate();

    // SIGTERM is still ASKED FOR — the ladder is one ladder — and Windows answers "still on
    // stdin_eof", which is why no call site here branches on the platform (§6.5).
    expect(platform.signals).toEqual(["SIGTERM"]);
    expect(outcome.escalatedTo).toBe("stdin_eof");
    expect(outcome.escalatedTo).not.toBe("sigterm");
  });

  it("stops at stdin EOF when the agent cooperates, because taskkill would add nothing", async () => {
    const platform = windows();
    const harness = ladderHarness(platform, {
      onCloseStdin: (h) => {
        h.die(0, null);
      },
    });

    const outcome = await harness.process.terminate();

    expect(outcome.escalatedTo).toBe("stdin_eof");
    expect(outcome.leaderExited).toBe(true);
    expect(outcome.treeGone).toBe(false); // unprovable here, always
    expect(platform.signals).toEqual([]);
  });

  it("rung 0 on Windows never claims a reaped tree", async () => {
    const platform = windows();
    const harness = ladderHarness(platform);
    harness.die(0, null);
    const outcome = await harness.process.terminate();
    expect(outcome.escalatedTo).toBe("already_exited");
    expect(outcome.treeGone).toBe(false);
    expect(outcome.leaderExited).toBe(true);
  });
});

describe("idempotency and concurrency (acceptance 10)", () => {
  it("two concurrent callers run the ladder ONCE and receive the same KillOutcome", async () => {
    const platform = posix({
      onSignal: (sig, p) => {
        if (sig === "SIGKILL") {
          p.treeGone = true;
          p.leaderGone = true;
        }
      },
    });
    const harness = ladderHarness(platform, { gracefulMs: 20, killConfirmMs: 40 });

    const [a, b, c] = await Promise.all([
      harness.process.terminate(),
      harness.process.terminate({ force: true }),
      harness.process.terminate({ gracefulMs: 1 }),
    ]);

    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(platform.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(harness.events).toEqual(["closeStdin"]);
  });

  it("a later call returns the same outcome instead of running the ladder again", async () => {
    const platform = posix({ treeGone: true, leaderGone: true });
    const harness = ladderHarness(platform, {
      onCloseStdin: (h) => {
        h.die(0, null);
      },
    });

    const first = await harness.process.terminate();
    const second = await harness.process.terminate();

    expect(second).toBe(first);
    expect(harness.events).toEqual(["closeStdin"]);
  });

  it("marks the exit as REQUESTED from the moment terminate() is entered", async () => {
    const platform = posix({ treeGone: true, leaderGone: true });
    const harness = ladderHarness(platform, {
      onCloseStdin: (h) => {
        h.die(0, null);
      },
    });
    expect(harness.exitNow()).toBeNull();
    await harness.process.terminate();
    expect(harness.exitNow()?.requested).toBe(true);
  });

  it("an exit the agent chose on its own is NOT requested", async () => {
    const platform = posix({ treeGone: true, leaderGone: true });
    const harness = ladderHarness(platform);
    harness.die(3, null);
    const outcome = await harness.process.terminate();
    expect(outcome.exit).toMatchObject({ code: 3, requested: false });
  });
});
