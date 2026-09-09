import { describe, it } from "vitest";

/**
 * `assertPromptContent` — H28's moved gate. Realpath FIRST, then contain, and always BEFORE the
 * prompt reaches the wire.
 *
 * Owned by M2-B-WP-S.
 */

describe("assertPromptContent (§26, H28)", () => {
  it.todo(
    "the M0 text-only whitelist is still the default, so an un-configured worker behaves exactly as M1",
  );
  it.todo(
    "a symlink inside cwd that realpaths outside it is rejected — a string comparison would pass it",
  );
  it.todo("in every rejected case the fixture agent recorded ZERO session/prompt calls (F37, F38)");
});
