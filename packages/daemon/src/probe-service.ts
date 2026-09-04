import {
  OmniError,
  type AuthContext,
  type Clock,
  type Logger,
  type ProbeRequestBody,
  type ProbeResponse,
  type ResolvedDaemonConfig,
  type RuntimeDescriptor,
  type Supervisor,
} from "@omni-acp/protocol";
import type { Catalog } from "./types.js";
import type { ProbeCache } from "./probe-cache.js";

/**
 * The probe, as a service: cache lookup, descriptor resolution, and ONE throwaway process
 * through `Supervisor.spawn` (never a second spawn site, F10).
 *
 * Concurrent probes of one agent SHARE one in-flight process — otherwise `POST /probe` becomes a
 * way to start N `npx` cold starts with N HTTP requests. Probes do not consume `maxWorkers`
 * slots, but they do reclaim their tree on every edge and are bounded by `probe.maxConcurrent`.
 *
 * Owned by M1-WP-E.
 */
export interface ProbeService {
  probe(id: string, o: ProbeRequestBody, auth: AuthContext): Promise<ProbeResponse>;
  descriptor(id: string): RuntimeDescriptor;
  /** `probe.onStart` = `"cached"` / `"always"`; a no-op for `"never"`. */
  warmup(): Promise<void>;
}

export function createProbeService(_o: {
  config: ResolvedDaemonConfig;
  catalog: Catalog;
  supervisor: Supervisor;
  cache: ProbeCache;
  clock: Clock;
  logger: Logger;
}): ProbeService {
  throw new OmniError("internal", "unimplemented: M1-WP-E");
}
