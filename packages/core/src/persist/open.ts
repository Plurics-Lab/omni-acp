import {
  OmniError,
  type Clock,
  type Logger,
  type PersistenceHandle,
  type ResolvedEventLogConfig,
} from "@omni-acp/protocol";

export interface OpenPersistenceOptions {
  readonly dataDir: string;
  /** Defaults to `<dataDir>/events.db`. */
  readonly file?: string;
  readonly config: ResolvedEventLogConfig;
  readonly clock: Clock;
  readonly logger: Logger;
}

/**
 * lock → open → migrate, in that order (§14.10, §14.7).
 *
 * The `node:sqlite` import is LAZY and DRIVER-GATED: `driver:"memory"` must never load it, which
 * is what keeps `OmniACP.local()` free of both a database file and an experimental-module
 * warning (ruling M1-R17, F12).
 *
 * Owned by M1-WP-A.
 */
export function openPersistence(_o: OpenPersistenceOptions): Promise<PersistenceHandle> {
  throw new OmniError("internal", "unimplemented: M1-WP-A");
}
