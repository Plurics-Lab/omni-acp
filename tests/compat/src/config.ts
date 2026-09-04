import { OmniError } from "@omni-acp/protocol";

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
  readonly expect?: Readonly<Record<string, unknown>>;
  readonly budgets?: Readonly<Record<string, number>>;
}

export interface CompatConfig {
  readonly version: 1;
  /** Applied to every entry that does not override them (§18.2). */
  readonly defaults?: Readonly<Record<string, unknown>>;
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
