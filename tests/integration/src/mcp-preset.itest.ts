import { describe, it } from "vitest";

/**
 * MCP presets end to end — the first time §12.3 row 22's `type` injection is exercised from the
 * wire, because M1 had no way to reach it.
 *
 * Owned by M2-B-WP-S.
 */

describe("mcp presets (M2-B, §23)", () => {
  it.todo(
    "a client names a preset and gets it; an unknown name is 400 naming it and a disallowed one is 403",
  );
  it.todo(
    "a preset the agent cannot take is reported as dropped on the snapshot with a TurnWarning, and the worker still starts",
  );
});
