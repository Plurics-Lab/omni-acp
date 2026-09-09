import { describe, it } from "vitest";

/**
 * The SDK half of D10: `worker.on("interaction", ...)` and the handle's four verbs.
 *
 * Owned by M2-A-WP-I.
 */

describe('Worker.on("interaction") and InteractionRequestHandle', () => {
  it.todo("fires ONLY for a parked interaction — an auto-resolved one never wakes a listener");
  it.todo(
    'deny() is one verb for both arms: reject_once for a permission, {action:"decline"} for an elicitation',
  );
  it.todo(
    "answer() is keyed by QUESTION id and never sends both a selection and its _custom twin (F30)",
  );
  it.todo(
    "worker.interactions tracks the pending set from the envelope tail with no extra round trip",
  );
});
