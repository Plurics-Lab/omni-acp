import { describe, it } from "vitest";

/**
 * The daemon half of MCP presets: 400 for unknown, 403 for disallowed, `dropped` for unusable.
 *
 * Owned by M2-B-WP-S.
 */

describe("resolveMcpForWorker", () => {
  it.todo("an unknown preset name is 400 NAMING it and one outside the token's mcpPresets is 403");
  it.todo(
    "a preset the AGENT cannot take is reported as dropped with a TurnWarning, never as an error",
  );
});
