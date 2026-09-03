import { describe, it } from "vitest";

/** WP-6. The real binary, as a real child process, on all three OSes. */
describe("omni-acp start", () => {
  it.todo("serves GET /v1/health 200 with --port 0");
  it.todo("calls daemon.stop({graceful:true}) exactly once on SIGINT (and SIGBREAK on Windows)");
  it.todo("exits 0 and leaves no orphan processes");
  it.todo("exits 2 with usage on an unknown flag, and lets CLI flags override YAML");
});
