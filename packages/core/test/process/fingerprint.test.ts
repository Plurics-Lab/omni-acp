import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fingerprintOf } from "../../src/process/fingerprint.js";
import { createPlatformOps } from "../../src/process/platform.js";
import { createPosixPlatformOps } from "../../src/process/platform-posix.js";
import { runUtility } from "../../src/process/spawn.js";
import { recordingUtility } from "./support.js";

/**
 * §15.7's incarnation token — M1-PLAN WP-C acceptance 7's first half.
 *
 * The rule the whole mechanism exists for: **a restarted daemon must never signal a pid it
 * cannot prove is the same process.** `null` is therefore not a failure value, it is the
 * REFUSAL value, and every path that cannot produce a token must produce it.
 */

const isLinux = process.platform === "linux";
const isDarwin = process.platform === "darwin";
const isWindows = process.platform === "win32";

/** Nothing here spawns; the utility answers whatever the test says it does. */
const noUtility = recordingUtility();

describe("fingerprintOf — the platform split", () => {
  it.skipIf(!isLinux)("linux: `linux:<btime>:<starttime>`, from kernel state", async () => {
    const fingerprint = await fingerprintOf(process.pid, "linux", noUtility.fn);
    expect(fingerprint).toMatch(/^linux:\d+:\d+$/);

    // Both halves are checked against `/proc` directly, because a token that agreed with itself
    // and not with the kernel would match after a reboot — which is the coin flip §15.7 forbids.
    const btime = /^btime\s+(\d+)$/m.exec(await readFile("/proc/stat", "utf8"))?.[1];
    const stat = await readFile(`/proc/${String(process.pid)}/stat`, "utf8");
    const starttime = stat
      .slice(stat.lastIndexOf(")") + 1)
      .trim()
      .split(/\s+/)[19];
    expect(fingerprint).toBe(`linux:${String(btime)}:${String(starttime)}`);

    // Stable across calls for a LIVE process: it is the identity, not a timestamp.
    expect(await fingerprintOf(process.pid, "linux", noUtility.fn)).toBe(fingerprint);
  });

  it.skipIf(!isLinux)("linux: a pid that does not exist has no token", async () => {
    // 0x7FFFFFFF is above every plausible `pid_max`, so `/proc/<pid>/stat` cannot exist.
    expect(await fingerprintOf(2_147_483_647, "linux", noUtility.fn)).toBeNull();
  });

  it.skipIf(!isDarwin)(
    "darwin: `darwin:<lstart-epoch>`, through the injected RunUtility",
    async () => {
      const fingerprint = await fingerprintOf(process.pid, "darwin", runUtility);
      expect(fingerprint).toMatch(/^darwin:\d+$/);
      expect(await fingerprintOf(process.pid, "darwin", runUtility)).toBe(fingerprint);
    },
  );

  it("darwin: parses `ps -o lstart=`, and asks for exactly that", async () => {
    const utility = recordingUtility();
    const ps: typeof utility.fn = (file, args) => {
      utility.calls.push({ file, args: [...args] });
      return Promise.resolve({ code: 0, stdout: "Thu Sep  4 12:34:56 2026\n" });
    };
    const fingerprint = await fingerprintOf(4242, "darwin", ps);
    expect(utility.calls).toEqual([{ file: "ps", args: ["-o", "lstart=", "-p", "4242"] }]);
    expect(fingerprint).toBe(`darwin:${String(Date.parse("Thu Sep 4 12:34:56 2026"))}`);
  });

  it("darwin: a non-zero exit, empty output or unparseable date all refuse", async () => {
    const answers: readonly { code: number; stdout: string }[] = [
      { code: 1, stdout: "" },
      { code: 0, stdout: "" },
      { code: 0, stdout: "   \n" },
      { code: 0, stdout: "not a date at all" },
    ];
    for (const answer of answers) {
      expect(await fingerprintOf(4242, "darwin", () => Promise.resolve(answer))).toBeNull();
    }
  });

  it("darwin: a utility that THROWS refuses rather than failing the caller", async () => {
    const boom = (): Promise<never> => Promise.reject(new Error("ps is not on PATH"));
    await expect(fingerprintOf(4242, "darwin", boom)).resolves.toBeNull();
  });

  it("win32 is `null`, deliberately and FINALLY — §15.7, not a stub", async () => {
    // There is no cheap, dependency-free incarnation token on Windows, and M0's Windows platform
    // already refuses to claim `treeGone` for the same reason. A reaper that cannot prove what
    // it killed is what §6.6's honesty contract forbids, so Windows REPORTS and does not touch.
    expect(await fingerprintOf(process.pid, "win32", noUtility.fn)).toBeNull();
    expect(await fingerprintOf(4242, "win32", runUtility)).toBeNull();
    expect(noUtility.calls).toEqual([]);
  });

  it("an unverified platform is `null` too: a wrong token would AUTHORISE a kill", async () => {
    for (const platform of ["freebsd", "aix", "sunos", "openbsd"] as const) {
      expect(await fingerprintOf(process.pid, platform, noUtility.fn)).toBeNull();
    }
  });

  it("a pid that is not addressable is refused before any syscall", async () => {
    for (const pid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(await fingerprintOf(pid, "linux", noUtility.fn)).toBeNull();
    }
  });
});

describe("PlatformOps.fingerprint — the injection, and the guard it respects", () => {
  it("createPlatformOps supplies the POSIX flavour, so this machine can fingerprint itself", async () => {
    const ops = createPlatformOps();
    const fingerprint = await ops.fingerprint(process.pid);
    if (isWindows) {
      expect(fingerprint).toBeNull();
    } else {
      expect(fingerprint).toMatch(/^(linux|darwin):/);
    }
  });

  it("a POSIX ops built WITHOUT a platform hint refuses — the safe answer, not a guess", async () => {
    // `platform-posix.ts` may not read `process.platform` (§6.1, and a guard test asserts it), so
    // an un-hinted construction genuinely does not know which token to take. `null` forbids the
    // signal, which is the direction that cannot destroy somebody else's process.
    expect(await createPosixPlatformOps().fingerprint(process.pid)).toBeNull();
  });

  it("Windows ops always answer null, and never run a utility to find out", async () => {
    const utility = recordingUtility();
    const ops = createPlatformOps("win32", { runUtility: utility.fn });
    expect(await ops.fingerprint(process.pid)).toBeNull();
    expect(utility.calls).toEqual([]);
  });

  it.skipIf(isWindows)("is captured at SPAWN and lands on ProcessInfo", async () => {
    const { realSupervisor, fixtureSpec } = await import("./support.js");
    const supervisor = realSupervisor();
    const proc = await supervisor.spawn(fixtureSpec("echo"));
    try {
      expect(proc.info.fingerprint).toMatch(/^(linux|darwin):/);
      // It is THIS process's token, taken while it was known live — so it still matches now.
      expect(await supervisor.platform.fingerprint(proc.info.pid)).toBe(proc.info.fingerprint);
    } finally {
      await proc.terminate({ force: true });
    }
  });
});
