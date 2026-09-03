import { OmniError, type Logger } from "@omni-acp/protocol";

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";

/**
 * Structured JSON lines on stderr. A bearer token must never reach a log line
 * (CONTRACTS.md §2.1 H13), so this is also where redaction lives.
 */
export function createLogger(level: LogLevel): Logger {
  throw new OmniError("internal", "unimplemented: WP-5 (daemon.createLogger)");
}
