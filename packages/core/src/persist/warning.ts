import { OmniError } from "@omni-acp/protocol";

/**
 * `node:sqlite` prints exactly ONE `ExperimentalWarning` at first import (F12). Suppressing it
 * with `--no-warnings` would silence every other warning in the user's process, and
 * `OmniACP.local()` runs inside somebody else's script.
 *
 * So the suppression is SURGICAL (§14.2): a `process.emitWarning` interposer that drops only the
 * one warning naming SQLite, for only the duration of the import, and passes everything else
 * through untouched. Both directions are tested — zero of ours, and an unrelated
 * `ExperimentalWarning` still gets out.
 *
 * Owned by M1-WP-A.
 */
export function withSuppressedSqliteWarning<T>(_fn: () => T): T {
  throw new OmniError("internal", "unimplemented: M1-WP-A");
}
