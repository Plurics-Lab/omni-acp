import { OmniError } from "@omni-acp/protocol";
import type { Hono } from "hono";
import type { Daemon } from "../types.js";

/**
 * The HTTP adapter, in full. ZERO business logic (D15 constraint 1).
 *
 * `createDaemon()` imports this statically and `daemon.fetch` is therefore always available,
 * port or no port (D27). Module-graph purity here would be theatre that costs `fetch()` without
 * `start()` — the property the whole route suite is built on.
 */
export function createHttpApp(daemon: Daemon): Hono {
  throw new OmniError("internal", "unimplemented: WP-5 (http.createHttpApp)");
}
