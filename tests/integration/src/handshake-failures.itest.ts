import { describe, it } from "vitest";

/** WP-6. Both failure edges reclaim the process tree BEFORE responding (CONTRACTS.md H5). */
describe("handshake failures", () => {
  it.todo("returns 502 agent_error on a handshake JSON-RPC error, with no orphan process");
  it.todo("returns 504 agent_timeout when timeoutMs elapses, with no orphan process");
});
