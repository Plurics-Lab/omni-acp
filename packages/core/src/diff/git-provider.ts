import { OmniError } from "@omni-acp/protocol";
import type {
  Clock,
  DiffProvider,
  IdGen,
  Logger,
  ResolvedDiffConfig,
  RunUtility,
} from "@omni-acp/protocol";

/**
 * D8's disk truth: `TurnResult.patch`, from git and from nothing else.
 *
 * It reaches git ONLY through the injected `RunUtility` — the same seam `fingerprint.ts` uses for
 * `ps`, which `core/test/process/no-direct-spawn.test.ts` already enforces — so its unit tests
 * run with NO GIT INSTALLED at all.
 *
 * The honest nulls, each with its own named `TurnWarning`, because D8's rule is "never wrong":
 * outside a repo; when the agent created `.git/` MID-SESSION (F39 — codex-acp's observed
 * behaviour, not a hypothetical, which is why `begin` runs per TURN and not once per worker);
 * over `diff.maxBytes`, truncated at a hunk boundary with `truncated: true`; on any git failure;
 * and on timeout. Never a throw, never a failed turn.
 *
 * `--no-ext-diff` and `--no-textconv` are present because a repository's own `diff.external`
 * config would otherwise run an arbitrary program of the repository's choosing inside the daemon
 * — the test plants one and asserts it is not executed.
 *
 * Owned by M2-WP-J.
 */
export function createGitDiffProvider(_o: {
  run: RunUtility;
  cfg: ResolvedDiffConfig;
  clock: Clock;
  ids: IdGen;
  logger: Logger;
}): DiffProvider {
  throw new OmniError("internal", "unimplemented: M2-WP-J");
}
