import { OmniError, type DaemonConfig } from "@omni-acp/protocol";
import type { Server } from "./server.js";

export interface LocalOptions {
  /**
   * M0 default: `"never"` — a bare `OmniACP.local()` always starts a fresh embedded daemon.
   *
   * DESIGN D14's canonical example writes `adopt: "prefer"`; discovery and reuse of a running
   * daemon through `~/.omni-acp/daemon.json` arrives with the other adopt modes in M3, and until
   * then `"prefer"` and `"require"` throw `bad_request` naming M3 (review R13, CONTRACTS.md L11).
   */
  readonly adopt?: "prefer" | "never" | "require";
  /** M0: true throws until M3. */
  readonly detach?: boolean;
  readonly dataDir?: string;
  readonly config?: Partial<DaemonConfig>;
}

/**
 * D14, implemented for `adopt: "never", detach: false` — which is also the M0 end-to-end harness,
 * so D14 and D15 share one code path from day one.
 *
 * `@omni-acp/daemon` is reached ONLY through `await import("@omni-acp/daemon")` inside this
 * function. It is an OPTIONAL peer dependency, never a static import — the
 * `client-has-no-daemon-import` guard fails on one, and a test imports the built client with the
 * daemon absent from `node_modules`. When it is absent, this throws a message naming
 * `npm i @omni-acp/daemon`, not a module-not-found stack.
 *
 * The embedded daemon binds `127.0.0.1:0` with a generated admin token and is then reached by an
 * ordinary `connect()` over loopback HTTP — no in-memory shortcut, which is what makes the
 * bad-token `401` in `local-mode.itest.ts` meaningful.
 */
export function local(opts?: LocalOptions): Promise<Server> {
  throw new OmniError("internal", "unimplemented: WP-6 (client.local)");
}
