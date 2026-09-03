import { describe, it } from "vitest";

/**
 * D15 constraint 1, proven at runtime rather than asserted in prose: with `listen: null` the
 * daemon binds no socket, `daemon.url === null`, and the FULL worker lifecycle still works
 * in-process. WP-6 owns this file.
 *
 * The in-process path takes its `AuthContext` from `daemon.authContextFor("local")` — never from
 * a forged `new Headers({ authorization: "Bearer …" })`, which would route the library path
 * through an HTTP-shaped credential and make "HTTP is only an adapter" false (review R10).
 */
describe("library-only daemon", () => {
  it.todo(
    "runs create -> prompt -> events -> turn -> delete with url === null and no socket bound",
  );
  it.todo("takes its AuthContext from daemon.authContextFor(tokenId), forging no Bearer header");
  it.todo("never calls daemon.fetch on this path");
});
