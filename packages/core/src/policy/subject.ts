import { OmniError } from "@omni-acp/protocol";
import type { InteractionRequest, PolicySubject } from "@omni-acp/protocol";

/**
 * The v2-mapped request → the thing rules match on.
 *
 * Two details carry the whole file:
 *
 *  - **realpath, then contain.** A symlink inside `src/` that resolves outside it must NOT
 *    satisfy `src/**`; comparing the written path would let a symlink author a permission.
 *  - **a file that does not exist yet.** A create names a path with no inode, so the deepest
 *    EXISTING ancestor is realpath'd and the remainder re-appended. Without that, every `allow`
 *    rule for `src/**` fails on exactly the writes it exists to permit.
 *
 * Owned by M2-B-WP-P.
 */
export function toPolicySubject(
  _req: InteractionRequest,
  _ctx: { cwd: string; agentId: string; realpath: (p: string) => Promise<string> },
): Promise<PolicySubject> {
  throw new OmniError("internal", "unimplemented: M2-B-WP-P");
}
