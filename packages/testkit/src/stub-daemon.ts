import { OmniError, type Daemon } from "@omni-acp/protocol";

/**
 * A Daemon whose methods are recorded stubs — for pure HTTP routing tests.
 *
 * This is why `Daemon` lives in `@omni-acp/protocol/contracts` rather than in
 * `@omni-acp/daemon`: testkit must be able to produce one without importing the package
 * whose tests consume testkit (CONTRACTS.md §4).
 */
export function stubDaemon(
  overrides?: Partial<Daemon>,
): Daemon & { readonly calls: readonly { method: string; args: unknown[] }[] } {
  throw new OmniError("internal", "unimplemented: WP-1 (testkit.stubDaemon)");
}
