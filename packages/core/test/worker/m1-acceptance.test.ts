import { describe, it } from "vitest";

/** M1-WP-C's acceptance bullets, one `it.todo` each (M1-PLAN §2, WP-C). */
describe("M1-WP-C — hibernate, wake, the resume four-state, orphan reaping", () => {
  it.todo(
    "§15.1's state table is a table test, and all FIVE invariants hold after every transition",
  );
  it.todo(
    '§15.4\'s classifier table is green, INCLUDING the negative lock that PERMANENT_TEXT does not match "Resource not found" (F15), and the property "no network/timeout/auth/quota/5xx error ever yields rejected_permanent"',
  );
  it.todo(
    "the replay window marks exactly the updates between request and response and is closed in a finally: a REJECTED resume leaves the next turn's updates unmarked",
  );
  it.todo(
    'hibernate() never sends session/close, releases the lease, leaves supervisor.live.size === 0, and REFUSES on a non-resumable agent under the default whenNotResumable:"keep"',
  );
  it.todo(
    "wake outcomes landed / rejected_transient / rejected_permanent / unknown each produce §15.5's HTTP code and §15.1's end state on a scripted agent — no real agent needed",
  );
  it.todo(
    "concurrent wake() callers share ONE attempt (5 racing callers); maxWakeFailures is enforced and the (N+1)th prompt is 410, not another spawn",
  );
  it.todo(
    "fingerprint is captured at spawn on Linux and darwin and is null on win32; reapOrphan sends NO signal on a mismatch or a null fingerprint (spy-asserted) and the Windows branch compiles",
  );
  it.todo(
    "createRehydratedWorker shares the Worker class; close() on a rehydrated hibernated worker returns {leaderExited:true, treeGone:true, sessionClosed:false}",
  );
  it.todo("the deferred promotion (rule 8) fires at most once and can never overturn a `landed`");
  it.todo(
    "handshake.ts resolves resume.method from the descriptor's preference order and captures modes/configOptions from session/new AND from a resume body",
  );
});
