import { OmniError } from "@omni-acp/protocol";

/**
 * The agent list is YAML, and adding an agent is a YAML edit with ZERO code changes
 * (CONTRACTS.md §18.1, L24). This module is the ONLY place that reads it.
 *
 * `source` is what keeps that promise honest: `sdk-example` and `fixture` resolve through
 * `@omni-acp/testkit`, and `command` is the operator's own argv. No `.ts` file in this repository
 * may contain a real agent's command string — a test asserts it.
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
  readonly budgets?: Readonly<Record<string, number>>;
  /** Rows the suite must NOT assert for this agent — corpus gaps, not failures (§18.3). */
  readonly unverified?: readonly string[];
  readonly expect?: Readonly<Record<string, unknown>>;
}

export interface CompatConfig {
  readonly version: 1;
  readonly agents: readonly CompatAgentConfig[];
}

export function loadCompatConfig(_path: string): CompatConfig {
  throw new OmniError("internal", "unimplemented: M1-WP-F");
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
}

export function selectAgents(_c: CompatConfig, _env: NodeJS.ProcessEnv): CompatSelection {
  throw new OmniError("internal", "unimplemented: M1-WP-F");
}
