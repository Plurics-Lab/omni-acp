import { OmniError, type DaemonConfig } from "@omni-acp/protocol";

/**
 * Pure. D15 constraint 3: YAML exists ONLY in this package — the daemon library takes a
 * `DaemonConfig` object and knows nothing about files, which is what lets `createDaemon()` be
 * embedded in someone else's process without dragging a config-file format along.
 *
 * CLI flags override the YAML.
 */
export function yamlToDaemonConfig(text: string, overrides: Partial<DaemonConfig>): DaemonConfig {
  throw new OmniError("internal", "unimplemented: WP-6 (cli.yamlToDaemonConfig)");
}
