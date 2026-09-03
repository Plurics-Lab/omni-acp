import { describe, it } from "vitest";

/**
 * D15 constraint 1, proven at runtime rather than asserted in prose: with `listen: null` the
 * daemon binds no socket, `daemon.url === null`, and the FULL worker lifecycle still works
 * in-process. WP-6 owns this file.
 */
describe("library-only daemon", () => {
  it.todo(
    "runs create -> prompt -> events -> turn -> delete with url === null and no socket bound",
  );
  it.todo("never calls daemon.fetch on this path");
});
