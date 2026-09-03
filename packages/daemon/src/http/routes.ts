import { OmniError } from "@omni-acp/protocol";
import type { Hono } from "hono";
import type { Daemon } from "../types.js";

/**
 * Registers H1-H15 of CONTRACTS.md §2.1.
 *
 * Every route is exactly three moves: parse with zod, call ONE daemon method, serialize. No
 * branching on domain state, no timers, no `WorkerState` literals, no import of
 * `@omni-acp/core` — the `http-has-no-logic` guard fails the build on any of those, and a
 * companion test with a recording `stubDaemon()` asserts the one-method rule per route.
 */
export function registerRoutes(app: Hono, daemon: Daemon): Hono {
  throw new OmniError("internal", "unimplemented: WP-5 (http.registerRoutes)");
}
