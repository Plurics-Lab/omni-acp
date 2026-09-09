import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createDaemon } from "@omni-acp/daemon";
import { OmniError, type DaemonConfig } from "@omni-acp/protocol";
import { USAGE, parseArgs, type ParsedArgs } from "./args.js";
import {
  answerInteraction,
  listAgents,
  listDeliveries,
  listInteractions,
  listRuns,
  listWorkers,
  probeAgentAt,
  redeliver,
  renderAgents,
  renderConfig,
  renderDeliveries,
  renderInteractions,
  renderProbe,
  renderRuns,
  renderWorkers,
  setWorkerConfig,
  targetOf,
} from "./remote.js";
import { declaresEventLogDriver, yamlToDaemonConfig } from "./yaml-config.js";

export interface CliIo {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

const EXIT_OK = 0;
const EXIT_FAILURE = 1;
/** The conventional shell exit code for "you typed it wrong". Asserted by an integration test. */
const EXIT_USAGE = 2;

/**
 * The signals that mean "shut down".
 *
 * `SIGBREAK` is Windows-only and `process.on("SIGBREAK", …)` THROWS on POSIX, so the list is
 * built from the platform rather than filtered later.
 */
function shutdownSignals(): NodeJS.Signals[] {
  return process.platform === "win32" ? ["SIGINT", "SIGTERM", "SIGBREAK"] : ["SIGINT", "SIGTERM"];
}

function write(stream: NodeJS.WritableStream, text: string): void {
  stream.write(text);
}

function messageOf(e: unknown): string {
  if (e instanceof OmniError) return e.message;
  if (typeof e === "object" && e !== null) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return String(e);
}

/**
 * Read from the package manifest rather than baked into the source, so `--version` cannot drift
 * from what npm published. Resolved relative to THIS MODULE, which is correct from `dist/` and
 * from `src/` alike, and never from `process.cwd()`.
 */
async function version(): Promise<string> {
  try {
    const text = await readFile(new URL("../package.json", import.meta.url), "utf8");
    const json = JSON.parse(text) as { version?: unknown };
    return typeof json.version === "string" ? json.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * Ruling M1-R17: `omni-acp start` writes `sqlite` where `createDaemon()` keeps `memory`.
 *
 * A daemon you started from a shell is a LONG-RUNNING one, and D2's whole claim is that a
 * restart loses nothing; an embedded `OmniACP.local()` inside somebody's script is the opposite
 * case and must not leave a database file behind or load an experimental module. One default per
 * entry point, and `GET /v1/info.persistence.driver` reports which is in force so it is never a
 * guess.
 */
const SQLITE_DEFAULT = { eventLog: { driver: "sqlite" } } as const;

/** CLI flags -> a `Partial<DaemonConfig>`. Absent flags stay absent (see `yamlToDaemonConfig`). */
function overridesFor(args: Extract<ParsedArgs, { cmd: "start" }>): Partial<DaemonConfig> {
  const listen =
    args.host === undefined && args.port === undefined
      ? undefined
      : {
          ...(args.host === undefined ? {} : { host: args.host }),
          ...(args.port === undefined ? {} : { port: args.port }),
        };
  return {
    ...(listen === undefined ? {} : { listen }),
    ...(args.dataDir === undefined ? {} : { dataDir: args.dataDir }),
  };
}

/**
 * The three read-only commands, which share one shape: resolve the target, make ONE call, print.
 *
 * `--json` prints the daemon's answer verbatim, because a command whose output is piped into `jq`
 * should not be reformatting the contract; without it the same answer is rendered as columns for
 * a person. Failures come back as the daemon's own sentence and exit 1 — never as a stack, and
 * never as "HTTP 403" when the daemon already wrote a better message (§9).
 */
type RemoteCommand = Extract<
  ParsedArgs,
  {
    cmd:
      | "agents"
      | "workers"
      | "probe"
      | "interactions"
      | "interactions-answer"
      | "config"
      | "runs"
      | "deliveries";
  }
>;

async function remote(args: RemoteCommand, env: NodeJS.ProcessEnv, out: CliIo): Promise<number> {
  try {
    const target = targetOf(args, env, `omni-acp ${args.cmd}`);
    /** `--json` prints the daemon's answer verbatim; without it, columns for a person. */
    const print = (body: unknown, rendered: () => string): number => {
      write(out.stdout, `${args.json === true ? JSON.stringify(body, null, 2) : rendered()}\n`);
      return EXIT_OK;
    };

    if (args.cmd === "agents") {
      const body = await listAgents(target);
      write(
        out.stdout,
        `${args.json === true ? JSON.stringify(body, null, 2) : renderAgents(body)}\n`,
      );
      return EXIT_OK;
    }

    if (args.cmd === "workers") {
      const body = await listWorkers(target);
      write(
        out.stdout,
        `${
          args.json === true
            ? JSON.stringify(body, null, 2)
            : renderWorkers(body.workers, {
                ...(args.includeClosed === true ? { includeClosed: true } : {}),
              })
        }\n`,
      );
      return EXIT_OK;
    }

    // ── M2's four (§5.8.10). Each is parse -> ONE call -> print (D15). ──────
    if (args.cmd === "interactions") {
      const body = await listInteractions(target, args.workerId);
      return print(body, () => renderInteractions(body));
    }
    if (args.cmd === "interactions-answer") {
      // The daemon re-checks D4's rules on what it receives — an `optionId` that was not
      // OFFERED, or an `allow_always` under `allowAlways:"never"` — so this sends the operator's
      // intent and never a pre-selected option (§19.7).
      const body = await answerInteraction(target, args.workerId, args.reqId, args.answer);
      return print(
        body,
        () =>
          `${body.interaction.requestId} ${body.interaction.status}` +
          `${body.interaction.answer === null ? "" : ` by ${body.interaction.answer.by}`}` +
          `, worker ${body.state}, seq ${String(body.seq)}`,
      );
    }
    if (args.cmd === "config") {
      const body = await setWorkerConfig(target, args.workerId, args.configId, args.value);
      return print(body, () => renderConfig(body));
    }
    if (args.cmd === "runs") {
      const body = await listRuns(target);
      return print(body, () => renderRuns(body));
    }
    if (args.cmd === "deliveries") {
      if (args.redeliver !== undefined) {
        const one = await redeliver(target, args.redeliver);
        return print(one, () => renderDeliveries({ deliveries: [one], cursor: null }));
      }
      const body = await listDeliveries(target);
      return print(body, () => renderDeliveries(body));
    }

    const body = await probeAgentAt(target, args.agent, {
      ...(args.deep === true ? { deep: true } : {}),
      ...(args.force === true ? { force: true } : {}),
    });
    return print(body, () => renderProbe(body));
  } catch (e) {
    write(out.stderr, `omni-acp: ${messageOf(e)}\n`);
    return EXIT_FAILURE;
  }
}

/**
 * The whole shell: argv/YAML -> DaemonConfig -> createDaemon -> start -> await a signal.
 *
 * SIGINT/SIGTERM (and SIGBREAK on Windows) call `daemon.stop({graceful:true})` EXACTLY ONCE — a
 * second signal during shutdown must not start a second teardown, and an integration test spawns
 * the real binary on all three OSes to prove it exits 0 and leaves no orphans. The "exactly
 * once" property is made OBSERVABLE from outside the process by the single `stopping` line: a
 * test that sends two SIGINTs counts one.
 *
 * Returns the process exit code rather than calling `process.exit`, so it is testable.
 */
export async function main(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  io?: CliIo,
): Promise<number> {
  const out: CliIo = io ?? { stdout: process.stdout, stderr: process.stderr };
  const args = parseArgs(argv);

  if (args.cmd === "help") {
    write(out.stdout, USAGE);
    return EXIT_OK;
  }
  if (args.cmd === "version") {
    write(out.stdout, `${await version()}\n`);
    return EXIT_OK;
  }
  if (args.cmd === "error") {
    write(out.stderr, `omni-acp: ${args.message}\n\n${USAGE}`);
    return EXIT_USAGE;
  }
  if (
    args.cmd === "agents" ||
    args.cmd === "workers" ||
    args.cmd === "probe" ||
    args.cmd === "interactions" ||
    args.cmd === "interactions-answer" ||
    args.cmd === "config" ||
    args.cmd === "runs" ||
    args.cmd === "deliveries"
  ) {
    return remote(args, env, out);
  }

  let config: DaemonConfig;
  let generatedSecret: string | null = null;
  try {
    const overrides = overridesFor(args);

    if (args.configPath === undefined) {
      // Zero-config (D14's spirit, from the CLI side): one generated admin token, taken from
      // OMNI_ACP_TOKEN when the operator supplied one so that a restart keeps working clients.
      generatedSecret = env["OMNI_ACP_TOKEN"] ?? randomBytes(32).toString("hex");
      config = yamlToDaemonConfig("", {
        ...overrides,
        ...SQLITE_DEFAULT,
        tokens: [{ id: "local", secret: generatedSecret, role: "admin" }],
        listen: { host: args.host ?? "127.0.0.1", port: args.port ?? 0 },
      });
    } else {
      // A config file that forgets `tokens` is the operator's mistake, not something to paper
      // over with a token they never see: `yamlToDaemonConfig` says so by name.
      const text = await readFile(args.configPath, "utf8");
      config = yamlToDaemonConfig(text, {
        ...overrides,
        // Ruling M1-R17, and only when the file did not choose: `eventLog` merges field by field,
        // so this adds a driver without touching the operator's `retentionDays`.
        ...(declaresEventLogDriver(text) ? {} : SQLITE_DEFAULT),
      });
    }
  } catch (e) {
    write(out.stderr, `omni-acp: ${messageOf(e)}\n`);
    return EXIT_FAILURE;
  }

  let daemon;
  try {
    daemon = await createDaemon(config);
    await daemon.start();
  } catch (e) {
    write(out.stderr, `omni-acp: failed to start: ${messageOf(e)}\n`);
    return EXIT_FAILURE;
  }

  write(
    out.stdout,
    daemon.url === null
      ? `omni-acp: started ${daemon.id} with no socket (listen: null)\n`
      : `omni-acp: listening on ${daemon.url}\n`,
  );
  if (generatedSecret !== null) {
    write(out.stdout, `omni-acp: generated admin token id "local"\n`);
    if (args.printToken === true) write(out.stdout, `omni-acp: token ${generatedSecret}\n`);
  }
  write(out.stdout, `omni-acp: ready\n`);

  // ── wait for a signal, then stop exactly once ─────────────────────────────
  let stopping: Promise<number> | null = null;
  const signals = shutdownSignals();

  const stop = (why: string): Promise<number> => {
    if (stopping !== null) return stopping;
    write(out.stdout, `omni-acp: stopping (${why}, graceful)\n`);
    stopping = daemon
      .stop({ graceful: true })
      .then(() => EXIT_OK)
      .catch((e: unknown) => {
        write(out.stderr, `omni-acp: shutdown failed: ${messageOf(e)}\n`);
        return EXIT_FAILURE;
      });
    return stopping;
  };

  const handlers = new Map<NodeJS.Signals, () => void>();
  const settled = new Promise<number>((resolve) => {
    for (const signal of signals) {
      const handler = (): void => {
        void stop(signal).then(resolve);
      };
      handlers.set(signal, handler);
      process.on(signal, handler);
    }
  });

  try {
    const code = await settled;
    write(out.stdout, `omni-acp: stopped\n`);
    return code;
  } finally {
    // Leaving a signal listener attached keeps the event loop's reference alive and turns a
    // clean exit into a hang — the exact failure `cli-start.itest.ts` exists to catch.
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
}
