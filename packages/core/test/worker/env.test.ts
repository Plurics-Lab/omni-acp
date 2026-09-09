import { describe, it } from "vitest";

/**
 * `resolveWorkerEnv` — DESIGN §8's ONE deny table, and the Windows case-folding trap.
 *
 * Owned by M2-B-WP-S.
 */

describe("resolveWorkerEnv (§23.3)", () => {
  it.todo("rejects with a 400 NAMING the key, never a silent drop (M2-R12)");
  it.todo(
    'compares case-INSENSITIVELY on win32, so {"path": "..."} cannot sail past a deny list that only knows PATH',
  );
});
