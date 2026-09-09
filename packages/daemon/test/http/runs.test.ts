import { describe, it } from "vitest";

/**
 * H25's routes against a recording `stubDaemon()`.
 *
 * Owned by M2-B-WP-R.
 */

describe("run routes (H25)", () => {
  it.todo("each route is parse -> ONE daemon.runs call -> serialize");
  it.todo(
    ".../events?since= reuses the SAME sse writer as a worker stream, so sse.ts stays byte-identical",
  );
});
