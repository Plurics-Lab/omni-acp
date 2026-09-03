import { describe, it } from "vitest";

/**
 * M0's own milestone wording: raw `fetch` against every route, asserting the literal JSON shapes
 * of CONTRACTS.md §2.1 with no SDK in the loop. If the SDK and the wire ever disagree, this is
 * the test that says which one moved. WP-6 owns this file.
 */
describe("raw HTTP shapes", () => {
  it.todo("GET /v1/health is unauthenticated and returns exactly {ok:true}");
  it.todo("GET /v1/info returns DaemonInfo including the ownership honesty fields");
  it.todo("GET /v1/whoami returns WhoAmIResponse with policyCeiling present and null");
  it.todo("GET /v1/agents returns the static catalog with probed:null");
  it.todo(
    "POST /v1/workers returns 201 WorkerSnapshot{state:'ready'} with real handshake capabilities",
  );
  it.todo("POST /v1/workers/{wid}/prompt returns 202 {turnId, seq}");
  it.todo("GET /v1/workers/{wid}/turns/{turnId} returns TurnStatus");
  it.todo(
    "GET /v1/workers/{wid}/turns/{unknown} returns 200 {state:'unknown', result:null}, not 404",
  );
  it.todo("DELETE /v1/workers/{wid} returns 200 CloseResult and is idempotent");
  it.todo("every error body is exactly {code, message, acp?}");
});
