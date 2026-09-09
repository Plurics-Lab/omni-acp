import { describe, it } from "vitest";

/**
 * Prompt containment, against transcript `17`'s recorded shape: a `resource_link` inside cwd and
 * one outside it.
 *
 * The acceptance is not the 400 — it is that in every rejected case the fixture agent recorded
 * ZERO `session/prompt` calls (F37, F38). Once a path reaches the agent, D3 says the agent reads
 * the disk itself, and the question is already answered the wrong way.
 *
 * Owned by M2-B-WP-S.
 */

describe("prompt containment (M2-B, §26)", () => {
  it.todo(
    "a resource_link outside cwdRoots is 400 and the agent recorded ZERO session/prompt calls",
  );
  it.todo(
    "a symlink inside cwd that realpaths outside it is rejected — realpath first, contain second",
  );
  it.todo("the error message ELIDES the path");
});
