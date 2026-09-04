import { OmniError } from "@omni-acp/protocol";

/**
 * The on-disk schema (§14.7) and its migrations.
 *
 * `SCHEMA_VERSION` is reported by `GET /v1/info.persistence.schemaVersion`. A file whose
 * `schema_version` is FROM THE FUTURE is a startup failure that NAMES the version — never a
 * silent downgrade, which would quietly drop columns a newer daemon wrote.
 *
 * Owned by M1-WP-A.
 */
export const SCHEMA_VERSION = 1;

export function migrate(_db: unknown, _logger: { warn(m: string): void }): number {
  throw new OmniError("internal", "unimplemented: M1-WP-A");
}
