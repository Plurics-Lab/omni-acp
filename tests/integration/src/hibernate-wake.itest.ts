import { describe, it } from "vitest";

/**
 * DESIGN §11's M1 acceptance, half two: **hibernated workers wake** (M1-PLAN §2, WP-F 6).
 *
 * Tier 3: the SDK example agent (`loadSession: true`), a real process, a real socket, and
 * `idleTimeoutMs: 200` so the idle timer fires inside a test rather than in thirty minutes.
 *
 * Owned by M1-WP-F.
 */
describe("hibernate and wake, end to end", () => {
  it.todo(
    "idleTimeoutMs:200 drives ready -> hibernated, the process tree is reclaimed, and the session pointer and the log survive",
  );
  it.todo(
    "the next prompt AUTO-WAKES: it blocks for the wake budget, then behaves normally, and the recorded ResumeReport's outcome is `landed`",
  );
  it.todo("POST /wake is idempotent and single-flight: five racing callers share ONE attempt");
  it.todo(
    "a hibernated worker holds no maxWorkers slot and one hibernate.maxHibernated slot instead",
  );
});
