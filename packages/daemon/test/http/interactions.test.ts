import { describe, it } from "vitest";

/**
 * H22 / H23 against a recording `stubDaemon()`: the route is parse -> ONE registry call ->
 * serialize, and §19.6's status table arrives through the one error mapper.
 *
 * Owned by M2-A-WP-I.
 */

describe("interaction routes (H22, H23)", () => {
  it.todo(
    "GET /v1/workers/{wid}/interactions is UNGATED (rule L2) and calls exactly one registry method",
  );
  it.todo(
    "POST /v1/workers/{wid}/interactions/{reqId} parses InteractionAnswerBody and calls exactly one registry method",
  );
  it.todo("a malformed reqId is 400 with the value ELIDED from the message");
  it.todo(
    "404 interaction_not_found and 409 interaction_settled are distinguishable from the worker's own 404/409",
  );
});
