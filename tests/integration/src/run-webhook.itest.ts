import { describe, it } from "vitest";

/**
 * The Run API and one real delivery, against `fakeWebhookReceiver()` on loopback.
 *
 * Owned by M2-B-WP-R.
 */

describe("runs and webhooks (M2-B, D9)", () => {
  it.todo(
    "POST /v1/runs creates, prompts, settles and closes, and .../events?since= replays with M1's exact semantics",
  );
  it.todo("a hung receiver never delays the run's TurnResult");
  it.todo("a delivery carries exactly the eight thin-payload keys and a verifiable Omni-Signature");
});
