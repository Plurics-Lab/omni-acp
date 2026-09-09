import { describe, it } from "vitest";

/**
 * A real park, end to end: `onUnresolved:"park"` -> `requires_action` -> a human answer over
 * `POST /v1/workers/{wid}/interactions/{reqId}` -> the turn resumes.
 *
 * Owned by M2-A-WP-I.
 */

describe("interaction park (M2-A, §19)", () => {
  it.todo(
    "a parked interaction moves the worker to requires_action and back, with the lease pin held throughout",
  );
  it.todo(
    "the answer's seq lets a non-streaming client poll ?since=seq-1 and watch its own answer land",
  );
  it.todo("prompt() survives a park longer than the client's requestTimeoutMs");
});
