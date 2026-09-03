import { OmniError } from "@omni-acp/protocol";
import type { Hono } from "hono";
import type { Daemon } from "../types.js";

/**
 * Registers H1-H15 of CONTRACTS.md §2.1.
 *
 * Every route is exactly three moves: parse with zod, call ONE daemon method, serialize. That is
 * literally satisfiable because `WorkerRegistry` carries the result-returning façade
 * (`snapshot` / `prompt` / `cancel` / `turn` / `logFor`, review R11); the single exception is
 * `POST /v1/workers`, which serializes `snapshot()` on the handle `create()` just returned — a
 * pure accessor, not a decision.
 *
 * No branching on domain state, no import of `@omni-acp/core`, no `node:child_process` — the
 * `http-has-no-logic` guard (CONTRACTS.md §10.2) fails the build on any of those, and a
 * companion test with a recording `stubDaemon()` asserts the one-method rule per route.
 */
export function registerRoutes(app: Hono, daemon: Daemon): Hono {
  throw new OmniError("internal", "unimplemented: WP-5 (http.registerRoutes)");
}
