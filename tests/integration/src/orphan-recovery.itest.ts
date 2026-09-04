import { describe, it } from "vitest";

/**
 * §15.7's orphan handling, proven against a process that REALLY survived (M1-PLAN §2, WP-F 8).
 *
 * A daemon in a CHILD process with `orphan.mjs`, SIGKILLed; the marker file keeps growing, which
 * is what proves the orphan outlived its daemon rather than the test asserting a fixture.
 *
 * The RECORD half runs everywhere — including Windows, where `orphansAtStart` must report
 * `{found: 1, reaped: 0, skipped: 1}` rather than silence. Only the REAP half is
 * `skipIf(win32)`, because a null fingerprint forbids signalling the pid at all.
 *
 * Owned by M1-WP-F.
 */
describe("recovery from a previous boot", () => {
  it.todo(
    "the orphan really survives: the marker file keeps growing after the daemon is SIGKILLed",
  );
  it.todo("on restart, orphansAtStart.found === 1 on every platform — the RECORD half");
  it.todo("on Linux, reaped === 1 and the marker stops inside 2 s — the REAP half, skipIf(win32)");
  it.todo(
    "on win32, orphansAtStart is {found:1, reaped:0, skipped:1} and the record says unsupported_platform",
  );
  it.todo("boot adoption is a NO-OP on a second run");
});
