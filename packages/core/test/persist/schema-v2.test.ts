import { describe, it } from "vitest";

/**
 * Schema v2 is CREATE-only: `runs` and `webhook_deliveries` are added and nothing M1 wrote is
 * touched. The direction that matters is BACKWARD: a v2 file opened by an M1 daemon must still
 * fail loudly naming the version, rather than reading rows it does not understand.
 *
 * Owned by M2-B-WP-R.
 */

describe("SCHEMA_VERSION 2 (§14.11)", () => {
  it.todo("a v1 file opened by an M2 daemon migrates forward keeping every M1 event");
  it.todo("§14.11's conformance suite runs VERBATIM against the v2 schema");
  it.todo("a v2 file opened by an M1 daemon fails loudly, naming the version");
});
