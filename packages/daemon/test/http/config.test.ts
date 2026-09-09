import { describe, it } from "vitest";

/**
 * H24's route and its status table.
 *
 * Owned by M2-A-WP-C.
 */

describe("config route (H24)", () => {
  it.todo(
    "409 worker_busy while a turn is live; 423 without the lease or with a stale epoch; auto-wake from hibernated; ready succeeds",
  );
  it.todo(
    "a bad value is 502 carrying -32603 data.details verbatim, classified through errorRules on code + a data pointer and never on message text (F44)",
  );
  it.todo("parses SetConfigBody and calls exactly one registry method");
});
