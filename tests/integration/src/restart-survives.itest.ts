import { describe, it } from "vitest";

/**
 * DESIGN §11's M1 acceptance, half one: **reconnect loses no events**, across a daemon RESTART
 * (M1-PLAN §2, WP-F 7).
 *
 * prompt -> `stop()` -> `createDaemon()` on the same `dataDir` -> `?since=<mid>` returns the
 * exact tail with the SAME `seq`. The `seq` half is the one that matters and is the one §14.4
 * calls the most dangerous line in M1: a worker whose rows retention already evicted must not
 * restart its own sequence at 1.
 *
 * Owned by M1-WP-F.
 */
describe("a daemon restart, over the same dataDir", () => {
  it.todo("?since=<mid> returns the exact tail with the SAME seq after stop() + createDaemon()");
  it.todo("a worker whose rows were fully evicted does NOT restart its seq at 1 (§14.4, L15)");
  it.todo("a hibernated worker is adopted with `generation` preserved");
  it.todo(
    "DELETE on a worker this process never created returns the PERSISTED CloseResult byte-for-byte, never a recomputed treeGone (§15.6)",
  );
});
