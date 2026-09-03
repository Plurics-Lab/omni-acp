import { describe, it } from "vitest";

/** WP-6. Drop the stream mid-turn, reconnect with `?since=`, union is gap-free. */
describe("SSE resume", () => {
  it.todo("reconnects with ?since= and yields a union identical to a full-replay reference");
  it.todo("survives five mid-turn drops with no gaps and no duplicates");
  it.todo("emits omni.stream_truncated when since < tail and keeps the stream open");
  it.todo("returns log.subscriberCount to 0 when the client aborts");
});
