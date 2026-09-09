import { describe, it } from "vitest";

/**
 * D10's gate, observed rather than asserted: transcript `14` is the CONTROL — the same prompt with
 * elicitation NOT declared produced no `elicitation/create` at all, and the agent asked in prose
 * instead (F28).
 *
 * Owned by M2-A-WP-I.
 */

describe("elicitation capability gate (D10, F28)", () => {
  it.todo(
    'clientCapabilities.elicitation is declared iff onUnresolved === "park", and AgentCapabilitiesSnapshot records what was sent',
  );
  it.todo("the SAME value is re-declared on reopen after a wake — F42's regression");
  it.todo(
    'an elicitation/create that arrives without having been offered is answered {action:"decline"}',
  );
});
