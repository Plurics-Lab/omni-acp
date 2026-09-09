export type ParsedArgs =
  | {
      cmd: "start";
      configPath?: string;
      host?: string;
      port?: number;
      dataDir?: string;
      printToken?: boolean;
    }
  /**
   * The three READ-ONLY commands M1 adds (CONTRACTS.md §5.7). They talk to a daemon somebody else
   * is running, so each carries the two things a client needs and nothing else — a url and a
   * token — with `OMNI_ACP_URL` / `OMNI_ACP_TOKEN` as the environment fallbacks `main()` applies.
   */
  | { cmd: "agents"; url?: string; token?: string; json?: boolean }
  | { cmd: "workers"; url?: string; token?: string; json?: boolean; includeClosed?: boolean }
  | {
      cmd: "probe";
      agent: string;
      url?: string;
      token?: string;
      json?: boolean;
      deep?: boolean;
      force?: boolean;
    }
  /**
   * M2's four (CONTRACTS.md §5.8.10). Same shape as M1's three and for the same reason (D15):
   * each is `parse → ONE call → print`, so the CLI never orchestrates and never holds state.
   */
  | { cmd: "interactions"; workerId: string; url?: string; token?: string; json?: boolean }
  | {
      cmd: "interactions-answer";
      workerId: string;
      reqId: string;
      answer: { action: "allow" | "deny" } | { action: "answer"; content: Record<string, string> };
      url?: string;
      token?: string;
      json?: boolean;
    }
  | {
      cmd: "config";
      workerId: string;
      configId: string;
      value: string;
      url?: string;
      token?: string;
      json?: boolean;
    }
  | { cmd: "runs"; url?: string; token?: string; json?: boolean }
  | { cmd: "deliveries"; redeliver?: string; url?: string; token?: string; json?: boolean }
  | { cmd: "version" }
  | { cmd: "help" }
  | { cmd: "error"; message: string };

/**
 * The flags each command takes, and whether each one consumes the next argv element.
 *
 * A table per command rather than a switch, because the two things a reader wants to check — "is
 * this flag known here" and "does it take a value" — then have exactly one answer each, and
 * `--help` inside a command cannot accidentally fall through to the unknown-flag branch.
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

/** Shared by `agents`, `workers` and `probe`: where the daemon is, and how to talk to it. */
const REMOTE_FLAGS = {
  "--url": "value",
  "--token": "value",
  "--json": "boolean",
} as const;

const WORKERS_FLAGS = { ...REMOTE_FLAGS, "--include-closed": "boolean" } as const;
const PROBE_FLAGS = { ...REMOTE_FLAGS, "--deep": "boolean", "--force": "boolean" } as const;
/**
 * `--allow` / `--deny` / `--value q=v` — D4's three answers, and the CLI may express only the two
 * a HUMAN can give plus the elicitation form. There is deliberately no `--allow-always`: rule 3
 * makes that a `400` unless the operator set `interaction.allowAlways:"human"`, and a flag for a
 * value the daemon refuses by default is a flag that teaches the wrong habit (F26).
 */
const ANSWER_FLAGS = {
  ...REMOTE_FLAGS,
  "--allow": "boolean",
  "--deny": "boolean",
  "--value": "value",
} as const;
const DELIVERIES_FLAGS = { ...REMOTE_FLAGS, "--redeliver": "value" } as const;

type FlagTable = Readonly<Record<string, "value" | "boolean">>;

/** `--port 0` and `--port=0` are the same flag; splitting here keeps the loop to one shape. */
function split(arg: string): { flag: string; inline: string | null } {
  const eq = arg.indexOf("=");
  if (!arg.startsWith("-") || eq === -1) return { flag: arg, inline: null };
  return { flag: arg.slice(0, eq), inline: arg.slice(eq + 1) };
}

const error = (message: string): ParsedArgs => ({ cmd: "error", message });

/** A parsed flag, or the decision that ended the scan (`help`, `version`, `error`). */
type Scan =
  { done: ParsedArgs } | { flags: Record<string, string | true>; positional: readonly string[] };

/**
 * One flag loop for every command.
 *
 * `positional` is collected rather than refused so that `probe <agent>` has somewhere to put its
 * argument; a command that takes none rejects a non-empty list itself, which keeps the "unexpected
 * argument" message specific to the command the user actually typed.
 */
function scan(args: readonly string[], from: number, table: FlagTable): Scan {
  const flags: Record<string, string | true> = {};
  const positional: string[] = [];

  for (let i = from; i < args.length; i++) {
    const raw = args[i] ?? "";
    if (raw === "--help" || raw === "-h") return { done: { cmd: "help" } };
    if (raw === "--version") return { done: { cmd: "version" } };
    if (!raw.startsWith("-")) {
      positional.push(raw);
      continue;
    }

    const { flag, inline } = split(raw);
    const kind = Object.prototype.hasOwnProperty.call(table, flag) ? table[flag] : undefined;
    if (kind === undefined) return { done: error(`unknown flag "${flag}"`) };

    if (kind === "boolean") {
      if (inline !== null) return { done: error(`flag "${flag}" takes no value`) };
      flags[flag] = true;
      continue;
    }

    let value = inline;
    if (value === null) {
      const next = args[i + 1];
      // A value that itself looks like a flag is almost always a forgotten argument, and
      // silently swallowing `--port --host` would bind the daemon to a port named "--host".
      if (next === undefined || next.startsWith("-")) {
        return { done: error(`flag "${flag}" needs a value`) };
      }
      value = next;
      i += 1;
    }
    flags[flag] = value;
  }

  return { flags, positional };
}

/** The two flags every remote command shares, lifted out of `flags` in one place. */
function remoteOf(flags: Record<string, string | true>): {
  url?: string;
  token?: string;
  json?: boolean;
} {
  const url = flags["--url"];
  const token = flags["--token"];
  return {
    ...(typeof url === "string" ? { url } : {}),
    ...(typeof token === "string" ? { token } : {}),
    ...(flags["--json"] === true ? { json: true } : {}),
  };
}

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

  if (head === "start") return parseStart(args);
  if (head === "agents") return parseAgents(args);
  if (head === "workers") return parseWorkers(args);
  if (head === "probe") return parseProbe(args);
  if (head === "interactions") return parseInteractions(args);
  if (head === "config") return parseConfig(args);
  if (head === "runs") return parseRuns(args);
  if (head === "deliveries") return parseDeliveries(args);
  return error(`unknown command "${head}"`);
}

function parseStart(args: readonly string[]): ParsedArgs {
  const scanned = scan(args, 1, START_FLAGS);
  if ("done" in scanned) return scanned.done;
  const first = scanned.positional[0];
  if (first !== undefined) return error(`unexpected argument "${first}"`);

  const out: Extract<ParsedArgs, { cmd: "start" }> = { cmd: "start" };
  const { flags } = scanned;

  const config = flags["--config"] ?? flags["-c"];
  if (typeof config === "string") out.configPath = config;
  const host = flags["--host"];
  if (typeof host === "string") out.host = host;
  const dataDir = flags["--data-dir"];
  if (typeof dataDir === "string") out.dataDir = dataDir;
  if (flags["--print-token"] === true) out.printToken = true;

  const port = flags["--port"] ?? flags["-p"];
  if (typeof port === "string") {
    // `Number("")` is 0 and `Number("8 ")` is 8; neither is a port somebody typed.
    if (!/^\d+$/.test(port)) return error(`--port must be an integer, got "${port}"`);
    const parsed = Number(port);
    if (parsed > 65535) return error(`--port must be between 0 and 65535, got "${port}"`);
    out.port = parsed;
  }

  return out;
}

function parseAgents(args: readonly string[]): ParsedArgs {
  const scanned = scan(args, 1, REMOTE_FLAGS);
  if ("done" in scanned) return scanned.done;
  const first = scanned.positional[0];
  if (first !== undefined) return error(`unexpected argument "${first}"`);
  return { cmd: "agents", ...remoteOf(scanned.flags) };
}

function parseWorkers(args: readonly string[]): ParsedArgs {
  const scanned = scan(args, 1, WORKERS_FLAGS);
  if ("done" in scanned) return scanned.done;
  const first = scanned.positional[0];
  if (first !== undefined) return error(`unexpected argument "${first}"`);
  return {
    cmd: "workers",
    ...remoteOf(scanned.flags),
    ...(scanned.flags["--include-closed"] === true ? { includeClosed: true } : {}),
  };
}

function parseProbe(args: readonly string[]): ParsedArgs {
  const scanned = scan(args, 1, PROBE_FLAGS);
  if ("done" in scanned) return scanned.done;
  const [agent, extra] = scanned.positional;
  if (agent === undefined) return error("probe needs an agent id");
  if (extra !== undefined) return error(`unexpected argument "${extra}"`);
  return {
    cmd: "probe",
    agent,
    ...remoteOf(scanned.flags),
    ...(scanned.flags["--deep"] === true ? { deep: true } : {}),
    ...(scanned.flags["--force"] === true ? { force: true } : {}),
  };
}

/**
 * `omni-acp interactions <wid>` and `omni-acp interactions answer <wid> <reqId> …`.
 *
 * The sub-verb is a POSITIONAL rather than a flag, because the two forms take different
 * arguments and a `--answer` flag would make `interactions --answer` (with no ids) parse.
 */
function parseInteractions(args: readonly string[]): ParsedArgs {
  const isAnswer = args[1] === "answer";
  const scanned = scan(args, isAnswer ? 2 : 1, isAnswer ? ANSWER_FLAGS : REMOTE_FLAGS);
  if ("done" in scanned) return scanned.done;
  const { flags, positional } = scanned;

  if (!isAnswer) {
    const [workerId, extra] = positional;
    if (workerId === undefined) return error("interactions needs a worker id");
    if (extra !== undefined) return error(`unexpected argument "${extra}"`);
    return { cmd: "interactions", workerId, ...remoteOf(flags) };
  }

  const [workerId, reqId, extra] = positional;
  if (workerId === undefined || reqId === undefined) {
    return error("interactions answer needs a worker id and a request id");
  }
  if (extra !== undefined) return error(`unexpected argument "${extra}"`);

  const allow = flags["--allow"] === true;
  const deny = flags["--deny"] === true;
  const value = flags["--value"];
  const given = [allow, deny, typeof value === "string"].filter(Boolean).length;
  if (given === 0) return error("interactions answer needs --allow, --deny or --value q=v");
  if (given > 1) return error("interactions answer takes exactly one of --allow, --deny, --value");

  if (typeof value === "string") {
    const at = value.indexOf("=");
    // `q=v`, and the FIRST `=` splits: a value may legitimately contain one, a question id may not.
    if (at <= 0) return error(`--value must be written question=value, got "${value}"`);
    return {
      cmd: "interactions-answer",
      workerId,
      reqId,
      answer: { action: "answer", content: { [value.slice(0, at)]: value.slice(at + 1) } },
      ...remoteOf(flags),
    };
  }
  return {
    cmd: "interactions-answer",
    workerId,
    reqId,
    answer: { action: allow ? "allow" : "deny" },
    ...remoteOf(flags),
  };
}

/** `omni-acp config <wid> <configId> <value>` (H24). */
function parseConfig(args: readonly string[]): ParsedArgs {
  const scanned = scan(args, 1, REMOTE_FLAGS);
  if ("done" in scanned) return scanned.done;
  const [workerId, configId, value, extra] = scanned.positional;
  if (workerId === undefined || configId === undefined || value === undefined) {
    return error("config needs a worker id, a config id and a value");
  }
  if (extra !== undefined) return error(`unexpected argument "${extra}"`);
  return { cmd: "config", workerId, configId, value, ...remoteOf(scanned.flags) };
}

function parseRuns(args: readonly string[]): ParsedArgs {
  const scanned = scan(args, 1, REMOTE_FLAGS);
  if ("done" in scanned) return scanned.done;
  const first = scanned.positional[0];
  if (first !== undefined) return error(`unexpected argument "${first}"`);
  return { cmd: "runs", ...remoteOf(scanned.flags) };
}

function parseDeliveries(args: readonly string[]): ParsedArgs {
  const scanned = scan(args, 1, DELIVERIES_FLAGS);
  if ("done" in scanned) return scanned.done;
  const first = scanned.positional[0];
  if (first !== undefined) return error(`unexpected argument "${first}"`);
  const redeliver = scanned.flags["--redeliver"];
  return {
    cmd: "deliveries",
    ...(typeof redeliver === "string" ? { redeliver } : {}),
    ...remoteOf(scanned.flags),
  };
}

export const USAGE = `omni-acp — run an ACP worker daemon

Usage:
  omni-acp start [options]
  omni-acp agents [options]
  omni-acp workers [options]
  omni-acp probe <agent> [options]
  omni-acp interactions <worker> [options]
  omni-acp interactions answer <worker> <reqId> --allow|--deny|--value q=v
  omni-acp config <worker> <configId> <value> [options]
  omni-acp runs [options]
  omni-acp deliveries [--redeliver <deliveryId>] [options]
  omni-acp --version
  omni-acp --help

Options for start:
  -c, --config <file>   YAML configuration file
      --host <host>     listen host (default 127.0.0.1)
  -p, --port <port>     listen port; 0 picks a free one (default 0)
      --data-dir <dir>  state directory (default ~/.omni-acp)
      --print-token     print the generated admin token secret to stdout

CLI flags override the YAML.
\`start\` writes eventLog.driver: sqlite unless the config file chooses one:
a long-running daemon must survive a restart.

Options for agents, workers and probe (they talk to a running daemon):
      --url <url>       daemon base url        (default $OMNI_ACP_URL)
      --token <secret>  bearer token           (default $OMNI_ACP_TOKEN)
      --json            print the raw response instead of a table

  workers --include-closed   also list workers that have already closed
  probe   --deep             run the full method battery
  probe   --force            ignore the cached probe and spawn a fresh process

  interactions answer --allow          take the offered allow-once option
  interactions answer --deny           take the offered reject-once option
  interactions answer --value q=v      answer an elicitation question
  deliveries --redeliver <id>          re-send one delivery from the dead-letter queue
`;
