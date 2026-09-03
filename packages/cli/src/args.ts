import { OmniError } from "@omni-acp/protocol";

export type ParsedArgs =
  | {
      cmd: "start";
      configPath?: string;
      host?: string;
      port?: number;
      dataDir?: string;
      printToken?: boolean;
    }
  | { cmd: "version" }
  | { cmd: "help" }
  | { cmd: "error"; message: string };

/** Pure: argv in, a decision out. No I/O, no process exit — `main()` owns both. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  throw new OmniError("internal", "unimplemented: WP-6 (cli.parseArgs)");
}
