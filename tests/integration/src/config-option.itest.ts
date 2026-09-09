import { describe, it } from "vitest";

/**
 * `POST /v1/workers/{wid}/config` end to end, including the wake path.
 *
 * Owned by M2-A-WP-C.
 */

describe("config option (M2-A, H24)", () => {
  it.todo(
    "the live catalogue is replaced wholesale from the method result and survives a hibernate/wake round trip",
  );
  it.todo("409 while a turn is live, 423 without the lease, auto-wake from hibernated");
});
