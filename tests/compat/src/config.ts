import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OmniError } from "@omni-acp/protocol";
import { parse } from "yaml";

/**
 * The agent list is YAML, and adding an agent is a YAML edit with ZERO code changes
 * (CONTRACTS.md §18.1, L24). This module is the ONLY place that reads it.
 *
 * `source` is what keeps that promise honest: `sdk-example` and `fixture` resolve through
 * `@omni-acp/testkit`, and `command` is the operator's own argv. No `.ts` file in this repository
 * may contain a real agent's launch argv — a test asserts it.
 *
 * Owned by M1-WP-F.
 */
export interface CompatAgentConfig {
  readonly id: string;
  readonly source: "sdk-example" | "fixture" | "command";
  readonly fixture?: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Selection, half one (§18.2): `OMNI_COMPAT_CONFIG` ⊕ `OMNI_COMPAT_AGENTS` ⊕ this. Absent is
   * `true`; `false` is a `config` skip with the reason "disabled in <file>".
   */
  readonly enabled?: boolean;
  /**
   * Selection, half two: what this entry needs from THIS MACHINE. Unmet is the `precondition`
   * skip source (§18.3) — never a failure, and never a silent pass. `login` names the credential
   * an operator would have to have (today only `"claude-code"`); `env` names variables that must
   * be set and non-empty.
   */
  readonly requires?: { readonly login?: string; readonly env?: readonly string[] };
  /**
   * The win32 launch override. §6.3 REFUSES a `.cmd` shim, so an entry whose `command` is `npx`
   * is unrunnable on Windows without one — and "adding an agent is a YAML edit" has to survive
   * contact with all three OSes, which is exactly why this is data and not a branch (review R15).
   * `${execPath}` and `${npxResolved:<spec>}` are the two substitutions the runner understands.
   */
  readonly windows?: { readonly command: string; readonly args: readonly string[] };
  /**
   * The `config` skip source (§18.3): cases this agent must NOT be asserted against, each with a
   * reason of at least 10 characters. A skip with no source is a FAILURE, so this is how a
   * deliberate gap stays visible in `compat-report.json` instead of decaying into silence.
   */
  readonly skip?: readonly { readonly case: string; readonly reason: string }[];
  /**
   * Rows the suite must NOT assert for this agent — corpus gaps, not failures (§18.3, the
   * `capability` source). The SINGLE SOURCE OF TRUTH is the runtime descriptor's own `unverified`
   * list (§17.2); this key exists so an operator can add one for an agent that has no builtin
   * descriptor, and for `claude-acp` it must MATCH §17.2 rather than be a smaller hand-written
   * subset (review R8).
   */
  readonly unverified?: readonly string[];
  /**
   * What this runtime is EXPECTED to exercise: `tools`, `permission`, `cancel`.
   *
   * `resume` is deliberately NOT settled here — the probe answers it (`ProbeSummary.resumeMethod`),
   * and a YAML that claimed otherwise would be a second opinion about a fact we measure. These
   * three cannot be probed for: no method battery can tell you whether an agent will use a tool
   * when you ask it something, so they are declared, and a case that requires one this entry does
   * not list becomes a `capability` skip rather than a failure.
   */
  readonly provides?: readonly string[];
  /**
   * A `RuntimeOverlay` (`AgentDescriptor.runtime`), forwarded to the daemon verbatim.
   *
   * It is how an operator says `quirks: {resumeRequiresSameCwd: true}` for a runtime with no
   * builtin descriptor — which is what makes `resume-cwd-mismatch` a `cwd_mismatch` hint rather
   * than an `unclassified` one (§15.4 rule 4). Config-driven, so a new runtime's quirks are still
   * a YAML edit.
   */
  readonly runtime?: Readonly<Record<string, unknown>>;
  readonly expect?: Readonly<Record<string, unknown>>;
  readonly budgets?: Readonly<Record<string, number>>;
}

export interface CompatConfig {
  readonly version: 1;
  /** Applied to every entry that does not override them (§18.2). */
  readonly defaults?: Readonly<Record<string, unknown>>;
  readonly agents: readonly CompatAgentConfig[];
  /** Where this configuration came from, so a skip reason can name the file (§18.3). */
  readonly path: string;
}

/** `tests/compat/`, resolved from THIS MODULE so the suite runs identically from any directory. */
export function compatDir(): string {
  // dist/config.js -> <package root>
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

const MIN_REASON = 10;

function fail(path: string, what: string): never {
  throw new OmniError("bad_request", `${path}: ${what}`);
}

function isMapping(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringArray(v: unknown, path: string, what: string): readonly string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    fail(path, `${what} must be an array of strings`);
  }
  return v as readonly string[];
}

/**
 * Reads and VALIDATES one agents file.
 *
 * Validation is not decoration: a `skip` entry whose reason is three characters, or missing
 * entirely, is exactly the silent gap §18.3 exists to prevent — so it is a load error here rather
 * than a skip nobody can argue with in the report. Same for a duplicate id, which would make the
 * report's `agent × case` grid ambiguous.
 */
export function loadCompatConfig(path: string): CompatConfig {
  const absolute = isAbsolute(path) ? path : join(compatDir(), path);
  let text: string;
  try {
    text = readFileSync(absolute, "utf8");
  } catch (e) {
    throw new OmniError("bad_request", `cannot read compat config ${absolute}`, { cause: e });
  }

  let document: unknown;
  try {
    document = parse(text);
  } catch (e) {
    throw new OmniError("bad_request", `${absolute} is not valid YAML`, { cause: e });
  }
  if (!isMapping(document)) fail(absolute, "the document must be a mapping");
  if (document["version"] !== 1) fail(absolute, "version must be 1");

  const raw = document["agents"];
  if (!Array.isArray(raw)) fail(absolute, "agents must be a list");

  const seen = new Set<string>();
  const agents = raw.map((entry, index): CompatAgentConfig => {
    if (!isMapping(entry)) fail(absolute, `agents[${String(index)}] must be a mapping`);
    const id = entry["id"];
    if (typeof id !== "string" || id === "") fail(absolute, `agents[${String(index)}].id`);
    if (seen.has(id)) fail(absolute, `duplicate agent id "${id}"`);
    seen.add(id);

    const source = entry["source"];
    if (source !== "sdk-example" && source !== "fixture" && source !== "command") {
      fail(absolute, `${id}.source must be sdk-example | fixture | command`);
    }
    if (source === "fixture" && typeof entry["fixture"] !== "string") {
      fail(absolute, `${id}.fixture is required when source is "fixture"`);
    }
    if (source === "command" && typeof entry["command"] !== "string") {
      fail(absolute, `${id}.command is required when source is "command"`);
    }

    const skip = entry["skip"];
    const skips: { case: string; reason: string }[] = [];
    if (skip !== undefined) {
      if (!Array.isArray(skip)) fail(absolute, `${id}.skip must be a list`);
      for (const row of skip) {
        if (!isMapping(row) || typeof row["case"] !== "string") {
          fail(absolute, `${id}.skip entries need a "case"`);
        }
        const reason = row["reason"];
        if (typeof reason !== "string" || reason.length < MIN_REASON) {
          // §18.3: "`reason` is required, minimum 10 characters". A skip nobody can argue with is
          // the only kind worth having, and an empty one decays into silence within a milestone.
          fail(
            absolute,
            `${id}.skip["${row["case"]}"].reason must be at least ${String(MIN_REASON)} characters`,
          );
        }
        skips.push({ case: row["case"], reason });
      }
    }

    const requires = entry["requires"];
    if (requires !== undefined && !isMapping(requires)) fail(absolute, `${id}.requires`);
    const windows = entry["windows"];
    if (windows !== undefined) {
      if (!isMapping(windows) || typeof windows["command"] !== "string") {
        fail(absolute, `${id}.windows needs a command`);
      }
    }

    return {
      id,
      source,
      ...(typeof entry["fixture"] === "string" ? { fixture: entry["fixture"] } : {}),
      ...(typeof entry["command"] === "string" ? { command: entry["command"] } : {}),
      ...(stringArray(entry["args"], absolute, `${id}.args`) === undefined
        ? {}
        : { args: stringArray(entry["args"], absolute, `${id}.args`) }),
      ...(isMapping(entry["env"]) ? { env: entry["env"] as Record<string, string> } : {}),
      ...(typeof entry["enabled"] === "boolean" ? { enabled: entry["enabled"] } : {}),
      ...(isMapping(requires)
        ? {
            requires: {
              ...(typeof requires["login"] === "string" ? { login: requires["login"] } : {}),
              ...(stringArray(requires["env"], absolute, `${id}.requires.env`) === undefined
                ? {}
                : { env: stringArray(requires["env"], absolute, `${id}.requires.env`) }),
            },
          }
        : {}),
      ...(isMapping(windows)
        ? {
            windows: {
              command: windows["command"] as string,
              args: stringArray(windows["args"], absolute, `${id}.windows.args`) ?? [],
            },
          }
        : {}),
      ...(skips.length === 0 ? {} : { skip: skips }),
      ...(stringArray(entry["unverified"], absolute, `${id}.unverified`) === undefined
        ? {}
        : { unverified: stringArray(entry["unverified"], absolute, `${id}.unverified`) }),
      ...(stringArray(entry["provides"], absolute, `${id}.provides`) === undefined
        ? {}
        : { provides: stringArray(entry["provides"], absolute, `${id}.provides`) }),
      ...(isMapping(entry["runtime"]) ? { runtime: entry["runtime"] } : {}),
      ...(isMapping(entry["expect"]) ? { expect: entry["expect"] } : {}),
      ...(isMapping(entry["budgets"])
        ? { budgets: entry["budgets"] as Record<string, number> }
        : {}),
    };
  });

  return {
    version: 1,
    ...(isMapping(document["defaults"]) ? { defaults: document["defaults"] } : {}),
    agents,
    path: absolute,
  };
}

/**
 * Which configured agents can actually run HERE. Every exclusion carries a SOURCE
 * (`config` / `capability` / `precondition`) and a reason; a skip with no source is a FAILURE,
 * and `OMNI_COMPAT_REQUIRE=1` fails an empty selection outright (§18.2).
 */
export interface CompatSelection {
  readonly selected: readonly CompatAgentConfig[];
  readonly skipped: readonly {
    readonly id: string;
    readonly source: "config" | "capability" | "precondition";
    readonly reason: string;
  }[];
  /** The file the selection came from, and whether an empty one is a failure. */
  readonly path: string;
  readonly required: boolean;
}

/** `OMNI_COMPAT_AGENTS=a,b` — an explicit allow-list, applied before everything else. */
function filterOf(env: NodeJS.ProcessEnv): ReadonlySet<string> | null {
  const raw = env["OMNI_COMPAT_AGENTS"];
  if (raw === undefined || raw.trim() === "") return null;
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== ""),
  );
}

export function selectAgents(c: CompatConfig, env: NodeJS.ProcessEnv): CompatSelection {
  const filter = filterOf(env);
  const real = env["OMNI_COMPAT_REAL"] === "1";
  const selected: CompatAgentConfig[] = [];
  const skipped: CompatSelection["skipped"][number][] = [];

  for (const agent of c.agents) {
    if (filter !== null && !filter.has(agent.id)) {
      skipped.push({
        id: agent.id,
        source: "config",
        reason: `not named in OMNI_COMPAT_AGENTS=${env["OMNI_COMPAT_AGENTS"] ?? ""}`,
      });
      continue;
    }
    if (agent.enabled === false) {
      skipped.push({ id: agent.id, source: "config", reason: `disabled in ${c.path}` });
      continue;
    }

    const requires = agent.requires;
    if (requires?.login !== undefined && !real) {
      // A login cannot be verified from here — there is no API that answers "is this machine's
      // Claude Code signed in" short of running it — so `OMNI_COMPAT_REAL=1` IS the operator's
      // assertion that it is, and its absence is a precondition skip rather than a guess. That is
      // also what keeps a machine without the login green instead of red (§18.2).
      skipped.push({
        id: agent.id,
        source: "precondition",
        reason: `needs a ${requires.login} login; set OMNI_COMPAT_REAL=1 to run it`,
      });
      continue;
    }
    const missing = (requires?.env ?? []).filter((name) => (env[name] ?? "") === "");
    if (missing.length > 0) {
      skipped.push({
        id: agent.id,
        source: "precondition",
        reason: `unset environment: ${missing.join(", ")}`,
      });
      continue;
    }

    selected.push(agent);
  }

  return {
    selected,
    skipped,
    path: c.path,
    required: env["OMNI_COMPAT_REQUIRE"] === "1",
  };
}

/** The config file this run should read: `OMNI_COMPAT_CONFIG`, else the hermetic default. */
export function configPathOf(env: NodeJS.ProcessEnv): string {
  return env["OMNI_COMPAT_CONFIG"] ?? "agents.ci.yaml";
}
