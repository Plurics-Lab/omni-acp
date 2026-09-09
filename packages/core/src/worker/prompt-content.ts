import { OmniError } from "@omni-acp/protocol";
import type { PromptCapabilities } from "@omni-acp/protocol";

/**
 * §26 / H28: the containment check that M0's zod `.refine` could not perform, because zod holds
 * no worker and DESIGN §5.1 requires BOTH this agent's `promptCapabilities` and this token's
 * `cwdRoots`.
 *
 * It throws `bad_request` BEFORE the prompt is sent, and "before" is the entire acceptance: in
 * every rejected case the fixture agent must record ZERO `session/prompt` calls (F37, F38). Once
 * a path reaches the agent, D3 says the agent reads the disk itself, and the containment question
 * is already answered the wrong way.
 *
 * REALPATH FIRST, then contain — a symlink inside `cwd` that resolves outside it is the case a
 * string comparison passes and this must not. The rejections, in full: a `resource_link` outside
 * `cwdRoots`; such a symlink; a relative or non-`file://` uri; a `..` traversal; an embedded
 * `resource` block failing any of the above; and a block type the worker's `promptCapabilities`
 * does not advertise.
 *
 * The message ELIDES the path, for `ids.ts`'s reason: the value came from the wire, and echoing
 * it back is how a reflected-value log line is born.
 *
 * Owned by M2-B-WP-S.
 */
export function assertPromptContent(_o: {
  content: readonly unknown[];
  cwd: string;
  cwdRoots: readonly string[];
  promptCapabilities: PromptCapabilities | null;
  realpath: (p: string) => Promise<string>;
}): Promise<readonly unknown[]> {
  throw new OmniError("internal", "unimplemented: M2-B-WP-S");
}
