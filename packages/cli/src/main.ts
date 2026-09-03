import { OmniError } from "@omni-acp/protocol";

/**
 * The whole shell: argv/YAML -> DaemonConfig -> createDaemon -> start -> await a signal.
 *
 * SIGINT/SIGTERM (and SIGBREAK on Windows) call `daemon.stop({graceful:true})` EXACTLY ONCE — a
 * second signal during shutdown must not start a second teardown, and an integration test spawns
 * the real binary on all three OSes to prove it exits 0 and leaves no orphans.
 *
 * Returns the process exit code rather than calling `process.exit`, so it is testable.
 */
export function main(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  io?: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream },
): Promise<number> {
  throw new OmniError("internal", "unimplemented: WP-6 (cli.main)");
}
