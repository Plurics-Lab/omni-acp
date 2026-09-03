import { describe, it } from "vitest";

/**
 * DESIGN §11's M0 acceptance criterion, made mechanical (M0-PLAN.md §4). WP-6 owns this file.
 *
 * Fixture: the SDK's own unmodified `dist/examples/agent.js`, launched as
 * `process.execPath <sdkExampleAgentPath()>` so it is shim-free on all three OSes.
 *
 * Setup: two `mkdtemp` dirs under `os.tmpdir()`, both registered as `cwdRoots` on one token;
 * `createDaemon({listen:{host:"127.0.0.1",port:0}, ...})`, `start()`, then
 * `OmniACP.connect({url: daemon.url, token})`.
 *
 * Act: create both workers concurrently, then prompt both concurrently.
 */
describe("two workers do not interfere", () => {
  it.todo("gives the two workers different ids, sessionIds and pids");
  it.todo("gives the two turns different turnIds");
  it.todo("puts only its own workerId and sessionId in each worker's log, seq exactly 1..n");
  it.todo("returns stopReason 'end_turn' for both");
  it.todo(
    "returns text containing the reject-branch sentence, proving the permission was answered",
  );
  it.todo("returns toolCalls ['call_1','call_2'], both terminal");
  it.todo(
    "records exactly one interaction {decision:'deny', rule:'m0:auto-deny', optionId:'reject'}",
  );
  it.todo("returns changes [] and patch null (M0, D8)");
  it.todo("orders seq(running) < every agent update of the turn < seq(idle)");
  it.todo("returns a turn() result deep-equal to prompt()'s (DESIGN §5.5, one aggregate)");
  it.todo(
    "reports treeGone true on POSIX and leaderExited true on Windows, matching waitGone(pid)",
  );
  it.todo("leaves supervisor.live.size === 0 after daemon.stop()");
});
