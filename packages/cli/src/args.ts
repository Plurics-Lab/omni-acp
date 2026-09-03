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

/**
 * The flags `start` takes, and whether each one consumes the next argv element.
 *
 * A table rather than a switch, because the two things a reader wants to check — "is this flag
 * known" and "does it take a value" — then have exactly one answer each, and `--help` inside
 * `start` cannot accidentally fall through to the unknown-flag branch.
 */
const START_FLAGS = {
  "--config": "value",
  "-c": "value",
  "--host": "value",
  "--port": "value",
  "-p": "value",
  "--data-dir": "value",
  "--print-token": "boolean",
} as const;

type StartFlag = keyof typeof START_FLAGS;

function isStartFlag(s: string): s is StartFlag {
  return Object.prototype.hasOwnProperty.call(START_FLAGS, s);
}

/** `--port 0` and `--port=0` are the same flag; splitting here keeps the loop to one shape. */
function split(arg: string): { flag: string; inline: string | null } {
  const eq = arg.indexOf("=");
  if (!arg.startsWith("-") || eq === -1) return { flag: arg, inline: null };
  return { flag: arg.slice(0, eq), inline: arg.slice(eq + 1) };
}

const error = (message: string): ParsedArgs => ({ cmd: "error", message });

/** Pure: argv in, a decision out. No I/O, no process exit — `main()` owns both. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const args = [...argv];
  if (args.length === 0) return { cmd: "help" };

  const head = args[0] ?? "";
  if (head === "--help" || head === "-h" || head === "help") return { cmd: "help" };
  if (head === "--version" || head === "-v" || head === "-V" || head === "version") {
    return { cmd: "version" };
  }
  if (head.startsWith("-")) return error(`unknown flag "${head}"`);
  if (head !== "start") return error(`unknown command "${head}"`);

  const out: Extract<ParsedArgs, { cmd: "start" }> = { cmd: "start" };

  for (let i = 1; i < args.length; i++) {
    const raw = args[i] ?? "";
    if (raw === "--help" || raw === "-h") return { cmd: "help" };
    if (raw === "--version") return { cmd: "version" };
    if (!raw.startsWith("-")) return error(`unexpected argument "${raw}"`);

    const { flag, inline } = split(raw);
    if (!isStartFlag(flag)) return error(`unknown flag "${flag}"`);

    if (START_FLAGS[flag] === "boolean") {
      if (inline !== null) return error(`flag "${flag}" takes no value`);
      out.printToken = true;
      continue;
    }

    let value = inline;
    if (value === null) {
      const next = args[i + 1];
      // A value that itself looks like a flag is almost always a forgotten argument, and
      // silently swallowing `--port --host` would bind the daemon to a port named "--host".
      if (next === undefined || next.startsWith("-")) {
        return error(`flag "${flag}" needs a value`);
      }
      value = next;
      i += 1;
    }

    switch (flag) {
      case "--config":
      case "-c":
        out.configPath = value;
        break;
      case "--host":
        out.host = value;
        break;
      case "--data-dir":
        out.dataDir = value;
        break;
      case "--port":
      case "-p": {
        // `Number("")` is 0 and `Number("8 ")` is 8; neither is a port somebody typed.
        if (!/^\d+$/.test(value)) return error(`--port must be an integer, got "${value}"`);
        const port = Number(value);
        if (port > 65535) return error(`--port must be between 0 and 65535, got "${value}"`);
        out.port = port;
        break;
      }
    }
  }

  return out;
}

export const USAGE = `omni-acp — run an ACP worker daemon

Usage:
  omni-acp start [options]
  omni-acp --version
  omni-acp --help

Options for start:
  -c, --config <file>   YAML configuration file
      --host <host>     listen host (default 127.0.0.1)
  -p, --port <port>     listen port; 0 picks a free one (default 0)
      --data-dir <dir>  state directory (default ~/.omni-acp)
      --print-token     print the generated admin token secret to stdout

CLI flags override the YAML file.
`;
