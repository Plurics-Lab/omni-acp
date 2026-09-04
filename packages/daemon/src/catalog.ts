import { extname } from "node:path";
import {
  BUILTIN_RUNTIMES,
  DEFAULT_V1_PROFILE,
  descriptorFingerprint,
  resolveDescriptor,
} from "@omni-acp/core";
import {
  OmniError,
  redactArgs,
  type AgentCatalogEntry,
  type AgentDescriptor,
  type AuthContext,
  type BuiltinRuntime,
  type ProbeRequestBody,
  type ProbeResponse,
  type ProbeSummary,
  type ResolvedDaemonConfig,
  type RuntimeDescriptor,
  type SpawnSpec,
} from "@omni-acp/protocol";
import type { Catalog } from "./types.js";

/**
 * The version window §17.2 records beside the claude-acp profile: `>=0.70.0 <1.0.0`.
 *
 * It lives HERE rather than in `@omni-acp/core` for one structural reason: `BuiltinRuntime` is
 * frozen in `protocol` for the whole of M1 and carries only `matches`, and `@omni-acp/core`'s
 * barrel is Land-owned and frozen too — so a constant in `runtime/known.ts` could not be read by
 * the one module that does the SELECTING. Selection is the Agent Catalog's job (DESIGN §7); the
 * window is a selection rule; so this is where it can be defined once and tested.
 *
 * Outside the window the profile is NOT applied and the agent falls back to `DEFAULT_V1_PROFILE`:
 * every quirk in the claude-acp table is an observation of 0.7x, and asserting them about a 2.x
 * adapter would be exactly the recalled-rather-than-observed claim the corpus exists to prevent.
 */
export const BUILTIN_VERSION_WINDOWS: Readonly<
  Record<string, { readonly min: string; readonly ltMajor: number }>
> = {
  "claude-acp": { min: "0.70.0", ltMajor: 1 },
};

/**
 * What the Catalog needs from the probe layer, and nothing more.
 *
 * A two-method hook rather than the `ProbeService` interface, because the wiring is circular by
 * nature — the probe service asks the catalog for a `SpawnSpec` and a descriptor, and the
 * catalog's `probe()` façade row hands H16 back to the probe service. Naming only the two calls
 * it makes keeps that a late binding rather than a construction-order puzzle.
 */
export interface CatalogProbeHooks {
  /** The cached `ProbeSummary` for this agent, if one is loaded. NEVER fabricated (H4). */
  cached(agentId: string): ProbeSummary | null;
  run(id: string, o: ProbeRequestBody, auth: AuthContext): Promise<ProbeResponse>;
}

export interface CatalogOptions {
  readonly hooks?: CatalogProbeHooks;
  /** Injected by the selection tests; defaults to the repository's own table. */
  readonly builtins?: readonly BuiltinRuntime[];
  readonly versionWindows?: Readonly<Record<string, { min: string; ltMajor: number }>>;
}

/**
 * Semver-lite, on purpose.
 *
 * The window this milestone needs is one range for one profile, and a comparator that understood
 * pre-release tags and build metadata would be a dependency and a surface to get wrong. A version
 * this cannot parse does NOT disqualify the profile: an agent reporting `"0.73.0-beta.1"` is
 * still the agent the corpus describes, and refusing the profile over a suffix would be worse
 * than accepting it.
 */
function versionInWindow(version: string, window: { min: string; ltMajor: number }): boolean {
  const parse = (v: string): [number, number, number] | null => {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
    return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const actual = parse(version);
  const min = parse(window.min);
  if (actual === null || min === null) return true;
  if (actual[0]! >= window.ltMajor) return false;
  for (let i = 0; i < 3; i += 1) {
    if (actual[i]! > min[i]!) return true;
    if (actual[i]! < min[i]!) return false;
  }
  return true;
}

/**
 * The program's own name, extension and directories stripped, on BOTH separators.
 *
 * `node:path.basename` is platform-dependent: on POSIX a backslash is an ordinary character, so
 * a config written on Windows (`C:\bin\claude-code-acp.cmd`) that reaches a Linux daemon — a
 * shared YAML, a container, a test matrix — would come back whole and match nothing. The
 * SEPARATOR is not the platform's here; it is whatever the operator typed. `extname` is applied
 * after the split so `claude-code-acp.cmd` and `claude-code-acp` are one program (§6.3 refuses to
 * LAUNCH the shim; that is a different question from what to call it).
 */
function commandBasename(command: string): string {
  const last = Math.max(command.lastIndexOf("/"), command.lastIndexOf("\\"));
  const name = last === -1 ? command : command.slice(last + 1);
  return name.slice(0, name.length - extname(name).length);
}

/**
 * The tokens an agent presents when claiming a builtin profile.
 *
 * Four sources, because none of them alone identifies `npx -y
 * @agentclientprotocol/claude-agent-acp@0.73.0`: the config id is whatever the operator typed,
 * the command basename is `npx`, the package specifier is buried in argv, and the authoritative
 * name (`agentInfo.name`) only exists after a probe.
 *
 * For a scoped npm specifier both the whole name and its last path segment are offered, because
 * §17.2's `/^claude-(code|agent)-acp$/` is a match on the SEGMENT — the real agent answers
 * `agentInfo.name: "@agentclientprotocol/claude-agent-acp"`.
 */
function candidateTokens(d: AgentDescriptor, probe: ProbeSummary | null): Set<string> {
  const tokens = new Set<string>();
  const add = (raw: string): void => {
    const value = raw.trim();
    if (value === "") return;
    tokens.add(value);
    const slash = value.lastIndexOf("/");
    if (slash !== -1) tokens.add(value.slice(slash + 1));
  };

  add(d.id);
  add(commandBasename(d.command));

  for (const arg of d.args) {
    if (arg.startsWith("-")) continue;
    // Strip an npm version suffix, but never the `@` that opens a scope: `@scope/pkg@1.2.3`
    // must become `@scope/pkg`, not `` and not `scope/pkg@1`.
    const at = arg.lastIndexOf("@");
    add(at > 0 ? arg.slice(0, at) : arg);
  }

  const name = probe?.agentInfo?.["name"];
  if (typeof name === "string") add(name);

  return tokens;
}

/**
 * builtin ⊕ config ⊕ probe's FIRST step: which builtin, if any, describes this agent (§17.2).
 *
 * It lives here rather than in `@omni-acp/core` because it needs the `AgentDescriptor` and the
 * cached probe TOGETHER, which is the Agent Catalog's material — `resolveDescriptor` takes the
 * builtin already chosen. Exported for its own test.
 */
export function selectBuiltin(
  d: AgentDescriptor,
  probe: ProbeSummary | null,
  windows: Readonly<Record<string, { min: string; ltMajor: number }>> = BUILTIN_VERSION_WINDOWS,
  runtimes: readonly BuiltinRuntime[] = BUILTIN_RUNTIMES,
): RuntimeDescriptor | null {
  const tokens = candidateTokens(d, probe);
  for (const builtin of runtimes) {
    if (!builtin.matches.some((m) => tokens.has(m))) continue;

    const window = windows[builtin.descriptor.id];
    const version = probe?.agentInfo?.["version"];
    if (window !== undefined && typeof version === "string" && !versionInWindow(version, window)) {
      continue;
    }
    return builtin.descriptor;
  }
  return null;
}

/**
 * `"<agentId>@<fingerprint12>"` — the descriptor identity that governs a worker created now.
 *
 * Exported so `registry.ts` stamps the SAME value onto `CreateWorkerDeps.runtimeId` that
 * `GET /v1/agents` publishes: two computations of one identity is how the event log and the
 * catalog come to disagree about which quirk table ran.
 *
 * Twelve hex characters — 48 bits — is a display id, not a boundary: the full digest stays in the
 * probe cache for anyone who needs to compare exactly.
 */
export function runtimeIdFor(d: AgentDescriptor, probe: ProbeSummary | null): string {
  const agentInfo = probe?.agentInfo;
  const name = agentInfo?.["name"];
  const version = agentInfo?.["version"];
  const info =
    agentInfo === null || agentInfo === undefined
      ? undefined
      : {
          ...(typeof name === "string" ? { name } : {}),
          ...(typeof version === "string" ? { version } : {}),
        };
  return `${d.id}@${descriptorFingerprint(d, info).slice(0, 12)}`;
}

/**
 * The ONLY producer of `SpawnSpec` (CONTRACTS.md §5.4). Composing the child environment in one
 * place is what lets `SpawnSpec.env` be documented as complete — the Supervisor adds nothing and
 * removes nothing, so what you read in the catalog is what the agent gets.
 *
 * M1 adds the descriptor half: builtin ⊕ config ⊕ cached-probe (§17.2), `runtimeId` computed
 * from the real `descriptorFingerprint`, and `probed` served from `<dataDir>/probes/<id>.json`
 * with `args` STILL redacted — the probe result must not become the leak `redactArgs` closed.
 */
export function createCatalog(config: ResolvedDaemonConfig, o?: CatalogOptions): Catalog {
  const byId = new Map<string, AgentDescriptor>();
  for (const agent of config.agents) {
    if (byId.has(agent.id)) {
      throw new OmniError("bad_request", `duplicate agent id "${agent.id}"`);
    }
    byId.set(agent.id, agent);
  }

  const builtins = o?.builtins ?? BUILTIN_RUNTIMES;
  const windows = o?.versionWindows ?? BUILTIN_VERSION_WINDOWS;
  const hooks = o?.hooks;

  const cachedProbe = (id: string): ProbeSummary | null => hooks?.cached(id) ?? null;

  // EAGER, at construction: an overlay with a typo'd quirk or §14.6's forbidden
  // `{stream:false, store:true}` must fail the daemon START, where the operator is looking,
  // rather than becoming a silently-ignored knob on every later request. `resolveDescriptor`
  // throws `bad_request`, and `createDaemon` already turns that into a refused start.
  for (const agent of config.agents) {
    resolveDescriptor(selectBuiltin(agent, null, windows, builtins), agent.runtime, null);
  }

  /**
   * builtin ⊕ config overlay ⊕ probe (§17.2). NEVER throws — an unknown agent falls back to the
   * generic v1 profile, because "which quirk table governs this?" must always have an answer.
   *
   * The two `catch`es are not defensive noise. The eager pass above already proved the
   * builtin ⊕ config half legal at startup, so a throw HERE can only come from the probe layer;
   * the honest answer to a probe that produced something the merge refuses is the descriptor we
   * had before that probe, never a 500 on `GET /v1/agents`.
   */
  const resolve = (agent: AgentDescriptor, probe: ProbeSummary | null): RuntimeDescriptor => {
    const builtin = selectBuiltin(agent, probe, windows, builtins);
    try {
      return { ...resolveDescriptor(builtin, agent.runtime, probe), id: agent.id };
    } catch {
      try {
        return { ...resolveDescriptor(builtin, agent.runtime, null), id: agent.id };
      } catch {
        return { ...DEFAULT_V1_PROFILE, id: agent.id };
      }
    }
  };

  /**
   * `runtimeIdFor` is a sha256, and `list()` is what a dashboard polls and what `registry.create`
   * reads to stamp `runtimeId` onto a new worker. Memoised on the PROBE'S OBJECT IDENTITY, which
   * is exactly the thing that can change it: the probe service replaces the summary wholesale on
   * every completed probe, so a stale entry is impossible and a `===` is the whole check.
   */
  const runtimeIds = new Map<string, { probe: ProbeSummary | null; runtimeId: string }>();
  const runtimeIdCached = (a: AgentDescriptor, probe: ProbeSummary | null): string => {
    const hit = runtimeIds.get(a.id);
    if (hit !== undefined && hit.probe === probe) return hit.runtimeId;
    const runtimeId = runtimeIdFor(a, probe);
    runtimeIds.set(a.id, { probe, runtimeId });
    return runtimeId;
  };

  const entryFor = (a: AgentDescriptor): AgentCatalogEntry => {
    const probe = cachedProbe(a.id);
    return {
      id: a.id,
      command: a.command,
      // Redacted, on the SAME rule `ProcessInfo.argsRedacted` uses. `GET /v1/agents` is readable
      // by every bearer token — including one whose `agents` list does not contain this agent at
      // all — so serving `--api-key sk-…` verbatim here would hand the operator's agent
      // credentials to the lowest-privilege client on the daemon (DESIGN §8). `toSpawnSpec`
      // below still passes the REAL argv to the child; this entry is the description, not the
      // launch.
      args: redactArgs(a.args),
      source: "config",
      // Never fabricated: the CACHED `ProbeSummary`, or null (H4). A summary carries an
      // `agentInfo`, a capability block and method verdicts — and no argv — so serving it does
      // not reopen the leak `redactArgs` closed. `http/agents.test.ts` asserts that against a
      // secret-bearing agent, on the bytes.
      probed: probe,
      // "Which quirk table WILL govern a worker created now" (§5.1 `AgentCatalogEntry`), as a
      // real sha256 over command ⊕ args ⊕ version ⊕ the probed agentInfo. A descriptor change is
      // therefore VISIBLE here and in `WorkerSnapshot.runtimeId` rather than silent (§17.2).
      runtimeId: runtimeIdCached(a, probe),
    };
  };

  return {
    list: () => config.agents.map(entryFor),

    get(id: string): AgentDescriptor {
      const descriptor = byId.get(id);
      if (descriptor === undefined) {
        // 400, not a new `agent_not_found`: an agent id is a request parameter (§9, D29).
        throw new OmniError("bad_request", `unknown agent "${id}"`);
      }
      return descriptor;
    },

    descriptor(id: string): RuntimeDescriptor {
      const agent = byId.get(id);
      // An agent that is not configured still gets an answer, because `Catalog.descriptor()`
      // NEVER throws (§5.4) — and the answer for an agent we have never heard of is the profile
      // that claims nothing about it.
      if (agent === undefined) return { ...DEFAULT_V1_PROFILE, id };
      return resolve(agent, cachedProbe(id));
    },

    /** H16. The one throwaway process lives in `probe-service.ts`; this row is the façade. */
    probe(id: string, body: ProbeRequestBody, auth: AuthContext): Promise<ProbeResponse> {
      if (hooks === undefined) {
        // A daemon built without a probe service is a real configuration (an embedder wiring its
        // own catalog), and D29's answer to "not available here" is a `bad_request` that says
        // so — never a 500.
        return Promise.reject(
          new OmniError("bad_request", "this daemon was built without a probe service"),
        );
      }
      return hooks.run(id, body, auth);
    },

    /**
     * The complete child environment, in one expression, in one place.
     *
     * The daemon's own environment is inherited because an ACP agent needs `PATH`, `HOME` and
     * whatever credentials the operator exported for it; `descriptor.env` (trusted, config
     * supplied — D19) overrides it. Per-request `env` is M2 and is rejected by
     * `CreateWorkerRequest`'s `strictObject`, so there is no untrusted contribution here at all.
     *
     * `process.env` values are typed `string | undefined`; an undefined entry is dropped rather
     * than stringified into the literal `"undefined"`.
     */
    toSpawnSpec(d: AgentDescriptor, spawnOpts: { cwd: string }): SpawnSpec {
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) env[key] = value;
      }
      for (const [key, value] of Object.entries(d.env)) env[key] = value;

      return {
        command: d.command,
        args: [...d.args],
        cwd: spawnOpts.cwd,
        env,
        // The agent-specific shutdown contract wins over the daemon-wide default: an agent that
        // documents a 30 s drain gets 30 s, and every other knob is the supervisor's policy.
        gracefulMs: d.shutdown.graceMs,
        shutdownSignal: d.shutdown.signal,
        killConfirmMs: config.supervisor.killConfirmMs,
        exitGraceMs: config.supervisor.exitGraceMs,
        maxFrameBytes: config.supervisor.maxFrameBytes,
        stderrTailBytes: config.supervisor.stderrTailBytes,
        label: d.id,
      };
    },
  };
}
