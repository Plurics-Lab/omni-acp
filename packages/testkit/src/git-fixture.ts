import { OmniError } from "@omni-acp/protocol";

/**
 * A temporary git repository, and a temporary directory that can BECOME one mid-test.
 *
 * `tempNonRepo().initRepo()` is not a convenience: F39 records codex-acp creating `.git/` in its
 * own cwd MID-SESSION, which is why `DiffProvider.begin` runs per TURN and why "outside a repo ⇒
 * null" cannot be decided once at worker start. The fixture exists so that is a test rather than
 * a comment.
 *
 * Owned by M2-WP-J.
 */
export function tempRepo(): Promise<{ dir: string; dispose(): Promise<void> }> {
  throw new OmniError("internal", "unimplemented: M2-WP-J");
}

export function tempNonRepo(): Promise<{
  dir: string;
  initRepo(): Promise<void>;
  dispose(): Promise<void>;
}> {
  throw new OmniError("internal", "unimplemented: M2-WP-J");
}
