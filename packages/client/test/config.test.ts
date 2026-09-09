import { describe, it } from "vitest";

/**
 * `worker.setConfig()` / `worker.config` (§5.8.10).
 *
 * Owned by M2-A-WP-C.
 */

describe("Worker.setConfig and Worker.config", () => {
  it.todo(
    "worker.config is updated SYNCHRONOUSLY with the promise's resolution — no round trip, no notification wait",
  );
  it.todo("a 503 or network failure leaves worker.config UNCHANGED");
});
