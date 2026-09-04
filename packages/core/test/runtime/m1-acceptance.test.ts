import { describe, it } from "vitest";

/**
 * M1-WP-E's acceptance bullets, one `it.todo` each (M1-PLAN §2, WP-E).
 *
 * The daemon-wiring half of WP-E lives under `packages/daemon/test/`; this file carries the
 * bullets whose subject is the runtime descriptor itself, and names the rest so the list is
 * complete in one place.
 */
describe("M1-WP-E — runtime descriptors, vendor registry, probe, daemon wiring, boot adoption", () => {
  it.todo(
    "classifyProbe reproduces all five corpus verdicts of §17.4, INCLUDING learning `configId` from -32602 data.configId._errors",
  );
  it.todo(
    "POST /v1/agents/{id}/probe returns a ProbeSummary inside timeoutMs, spawns EXACTLY ONE process, reclaims the tree, leaves no temp dir, and 403s a forbidden agent BEFORE any process exists",
  );
  it.todo(
    "the cache round-trips through <dataDir>/probes/<id>.json at mode 0600; cached:true on the second call; a fingerprint change invalidates; GET /v1/agents serves `probed` with args still redacted",
  );
  it.todo(
    "resolveDescriptor's builtin (+) config (+) probe merge is table-tested; the registry expresses preference order (set_config_option -> set_mode -> set_model) and learns -32601 PER PROCESS",
  );
  it.todo(
    "createDaemon opens persistence -> takes the lock -> migrates -> runs boot adoption -> arms retention; stop() flushes and closes the store AFTER closeAll",
  );
  it.todo(
    "boot adoption converges every abandoned row on hibernated or closed, appends the in-band omni.error + the daemon_restart/orphaned envelope + omni.lease{expired}, and is a NO-OP on a second run",
  );
  it.todo(
    "lazy rehydration in get()/delete(); list() straight from the store with live entries overriding; hibernated workers counted separately from maxWorkers, and a wake that would exceed it is 429",
  );
  it.todo(
    "the three new route families are THREE LINES each; http-has-no-logic and sse-is-unchanged both pass; 423/422 flow through the SINGLE existing error mapper",
  );
  it.todo(
    "GET /v1/info reports persistence, bootId and orphansAtStart honestly, including {found:n, reaped:0, skipped:n} on Windows",
  );
  it.todo(
    "a migration test: empty file, v1 file (no-op), and a schema_version FROM THE FUTURE => a startup failure NAMING the version, never a silent downgrade",
  );
});
