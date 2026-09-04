import { DaemonConfig, OmniError } from "@omni-acp/protocol";
import { parse } from "yaml";

function isMapping(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Pure. D15 constraint 3: YAML exists ONLY in this package — the daemon library takes a
 * `DaemonConfig` object and knows nothing about files, which is what lets `createDaemon()` be
 * embedded in someone else's process without dragging a config-file format along.
 *
 * CLI flags override the YAML.
 *
 * Two merge rules, and the second is the one that would otherwise be a bug report:
 *
 *  - An `undefined` value in `overrides` is an ABSENT flag, not an instruction to unset. `{...yaml,
 *    ...overrides}` would let `--host` alone erase the YAML's `dataDir`.
 *  - `listen` and `eventLog` merge field by field. `--port 8080` must not delete the YAML's
 *    `listen.host`, and `start`'s `eventLog.driver: "sqlite"` (ruling M1-R17) must not delete the
 *    YAML's `retentionDays`. They are the only two nested objects the CLI addresses.
 *
 * The result is validated here rather than at `createDaemon()`, so a typo in a config file is a
 * message about that file instead of a stack from inside the daemon.
 */
export function yamlToDaemonConfig(text: string, overrides: Partial<DaemonConfig>): DaemonConfig {
  let document: unknown;
  try {
    document = parse(text);
  } catch (e) {
    throw new OmniError("bad_request", `config is not valid YAML: ${describe(e)}`, { cause: e });
  }

  // An empty file is an empty document, and `overrides` alone may well be a complete config.
  if (document === null || document === undefined) document = {};
  if (!isMapping(document)) {
    throw new OmniError("bad_request", "config must be a YAML mapping at the top level");
  }

  const merged: Record<string, unknown> = { ...document };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    merged[key] = value;
  }

  const listenOverride = overrides.listen;
  if (listenOverride !== undefined && listenOverride !== null) {
    const fromYaml = document["listen"];
    merged["listen"] = isMapping(fromYaml)
      ? { ...fromYaml, ...listenOverride }
      : { ...listenOverride };
  }

  const eventLogOverride = overrides.eventLog;
  if (eventLogOverride !== undefined && eventLogOverride !== null) {
    const fromYaml = document["eventLog"];
    merged["eventLog"] = isMapping(fromYaml)
      ? { ...fromYaml, ...eventLogOverride }
      : { ...eventLogOverride };
  }

  const parsed = DaemonConfig.safeParse(merged);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.length === 0 ? "(root)" : i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new OmniError("bad_request", `invalid configuration: ${issues}`, {
      cause: parsed.error,
    });
  }

  // The fully-defaulted config. It is still a valid `DaemonConfig` INPUT — every field it
  // carries is one the schema accepts — so `createDaemon()` re-parsing it is a no-op.
  return parsed.data;
}

/**
 * True when the document ALREADY chose an `eventLog.driver` (ruling M1-R17).
 *
 * `omni-acp start` writes `"sqlite"` — a long-running daemon must survive a restart — while
 * `createDaemon()` keeps `"memory"`, so an `OmniACP.local()` inside somebody's script leaves no
 * database file and loads no experimental module. One default per entry point, and no magic in
 * the schema.
 *
 * The CLI's default is a DEFAULT and not an override: an operator who wrote `driver: memory` in a
 * config file meant it, and a `start` that silently reversed that choice would be the "magic in
 * the schema" the ruling rejected, moved one layer up. Hence a predicate rather than a merge.
 */
export function declaresEventLogDriver(text: string): boolean {
  let document: unknown;
  try {
    document = parse(text);
  } catch {
    // Not parseable: `yamlToDaemonConfig` is about to say so, with a better message than this
    // function could. Reporting "no driver" here just means the override is offered and the
    // parse failure still wins.
    return false;
  }
  if (!isMapping(document)) return false;
  const eventLog = document["eventLog"];
  return isMapping(eventLog) && eventLog["driver"] !== undefined;
}

function describe(e: unknown): string {
  if (typeof e === "object" && e !== null) {
    const message = (e as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(e);
}
