import { describe, it } from "vitest";

/**
 * The portable oracle: `orphan.mjs` spawns a grandchild that appends to `$MARKER_FILE` every
 * 100 ms. After DELETE, the file stops growing within 2 s. This needs no pid introspection,
 * which is precisely what Windows cannot give us (CONTRACTS.md §6.4). WP-6 owns this file.
 */
describe("tree kill", () => {
  it.todo("stops the grandchild's marker file growing within 2 s of DELETE, on all three OSes");
  it.todo("reports treeGone true on POSIX and false on Windows — never optimistic");
});
