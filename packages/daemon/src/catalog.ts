import {
  OmniError,
  redactArgs,
  type AgentCatalogEntry,
  type AgentDescriptor,
  type ResolvedDaemonConfig,
  type SpawnSpec,
} from "@omni-acp/protocol";
import type { Catalog } from "./types.js";

/**
 * The ONLY producer of `SpawnSpec` (CONTRACTS.md §5.4). Composing the child environment in one
 * place is what lets `SpawnSpec.env` be documented as complete — the Supervisor adds nothing and
 * removes nothing, so what you read in the catalog is what the agent gets.
 */
export function createCatalog(config: ResolvedDaemonConfig): Catalog {
  const byId = new Map<string, AgentDescriptor>();
  for (const agent of config.agents) {
    if (byId.has(agent.id)) {
      throw new OmniError("bad_request", `duplicate agent id "${agent.id}"`);
    }
    byId.set(agent.id, agent);
  }

  const entries: AgentCatalogEntry[] = config.agents.map((a) => ({
    id: a.id,
    command: a.command,
    // Redacted, on the SAME rule `ProcessInfo.argsRedacted` uses. `GET /v1/agents` is readable by
    // every bearer token — including one whose `agents` list does not contain this agent at all —
    // so serving `--api-key sk-…` verbatim here would hand the operator's agent credentials to
    // the lowest-privilege client on the daemon (DESIGN §8). `toSpawnSpec` below still passes the
    // REAL argv to the child; this entry is the description, not the launch.
    args: redactArgs(a.args),
    source: "config",
    // M1 probes for the real capabilities; a fabricated value here would be worse than a null.
    probed: null,
  }));

  return {
    list: () => entries,

    get(id: string): AgentDescriptor {
      const descriptor = byId.get(id);
      if (descriptor === undefined) {
        // 400, not a new `agent_not_found`: an agent id is a request parameter (§9, D29).
        throw new OmniError("bad_request", `unknown agent "${id}"`);
      }
      return descriptor;
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
    toSpawnSpec(d: AgentDescriptor, o: { cwd: string }): SpawnSpec {
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) env[key] = value;
      }
      for (const [key, value] of Object.entries(d.env)) env[key] = value;

      return {
        command: d.command,
        args: [...d.args],
        cwd: o.cwd,
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
