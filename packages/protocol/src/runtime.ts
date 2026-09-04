/**
 * DESIGN §7's Runtime descriptor (CONTRACTS.md §5.1 `src/runtime.ts`, §17).
 *
 * TYPES ONLY. The descriptor is the ONLY thing the Normalizer branches on: a compatible fork is
 * a new descriptor, not new code, and the `descriptor-is-the-only-branch` guard (§10.2) fails
 * the build on an agent-id string literal anywhere under `core/src/normalizer/**`.
 */

import type { ResumeMethod } from "./resume.js";

/**
 * One capability's spellings, in preference order, plus what a failure MEANS.
 *
 * `onFailure` is per capability and it is DESIGN §6.2's rule made a field: `set_model` failing is
 * `fail` (the caller asked for a model and did not get one), `set_options` failing is `warn` (a
 * vendor extension we offered to pass through). Without it the descriptor cannot express the one
 * distinction §6.2 draws, and every extension would have to be all-or-nothing (review R2).
 */
export interface MethodPreference {
  readonly spellings: readonly string[];
  readonly onFailure: "fail" | "warn";
}

/**
 * PREFERENCE ORDER OVER SPELLINGS, not one name per capability. F18 is decisive: on ONE
 * claude-acp process `session/set_mode` and `session/set_config_option` are both live while
 * `session/set_model` is `-32601`. A registry that maps one capability to one method name cannot
 * express that.
 *
 * The first entry not already known-unsupported is used; a `-32601` marks it unsupported for the
 * life of the process (never persisted — a version bump may add it) and the next one is tried.
 *
 * A RECORD, not four fixed arrays (review R2): `session/set_options` is a vendor extension DESIGN
 * §6.2 requires the descriptor to carry, and a fixed shape would have made adding it an edit to a
 * type frozen for the whole of M1. The well-known keys are `resume` / `setConfig` / `setOptions` /
 * `list` / `close`; a runtime may carry more, and a consumer that does not know a key ignores it.
 *
 * `prefer.resume.spellings` holds `ResumeMethod` values — the type stays `string[]` because the
 * record is uniform, and the one place that consumes it (`handshake.ts`, M1-WP-C) narrows against
 * `ResumeMethod` and drops a spelling it does not recognise rather than sending it blind.
 */
export type MethodPreferences = Readonly<Record<string, MethodPreference>>;

export interface UpdateRule {
  /** The v2 `sessionUpdate` kind, or `null` = no row in the map (vendor passthrough). */
  readonly map: string | null;
  readonly stream: boolean;
  /**
   * `stream: false, store: true` is FORBIDDEN and rejected at descriptor resolution: an envelope
   * withheld from the live tail but present in `?since=` makes two subscribers disagree about the
   * log (§14.6, ruling M1-R3). The legal shapes are stream+store, or drop (neither).
   */
  readonly store: boolean;
  /** Store this payload under its sha256 in a side table and reference it (§14.6). */
  readonly digest: boolean;
}

/** A vendor field the descriptor promotes out of `_meta` into a typed slot. */
export interface ExtensionPath {
  /** RFC-6901 JSON pointer, rooted at the update's `_meta`. `~1` escapes a "/" in a key. */
  readonly pointer: string;
  readonly as: "patch" | "rate_limit" | "provenance" | "opaque";
  readonly dialect?: "claude_structured_patch" | "claude_rate_limit";
}

/**
 * Classify a JSON-RPC error by CODE + a JSON pointer into `data`. NEVER by message text:
 * F17 shows the message carries embedded quotes (`"\"Method not found\": <m>"`) and is not a
 * stable contract, while `data.method` / `data.details` / `data.<field>._errors` carry the same
 * information in a field. `messageMatches` exists for runtimes that leave us nothing else and is
 * discouraged in prose and in review.
 */
export interface ErrorRule {
  readonly id: string;
  readonly code?: number;
  readonly dataPointer?: string;
  readonly dataMatches?: string;
  readonly messageMatches?: string;
  readonly classify:
    "bad_request" | "agent_error" | "unsupported_method" | "resume_permanent" | "resume_transient";
}

export interface Quirks {
  readonly resumeSilentlyCreates: boolean;
  /** claude-acp: a MISMATCHED cwd is refused for a session that is alive and healthy (F15). */
  readonly resumeRequiresSameCwd: boolean;
  /** `session/load` / `session/resume` return the `session/new` body, contrary to the v1 schema. */
  readonly loadReturnsBody: boolean;
  readonly messageIdPresent: boolean;
  readonly toolCallUpdateIsSparse: boolean;
  /** v1 `oldText`/`newText` are the changed FRAGMENT, not whole-file content (F19). */
  readonly diffIsFragment: boolean;
  readonly permissionRequestShape: "v1_tool_call" | "v2_subject";
  /** D4 rule 2's preferred `allow_session` / `approve_for_session`. "none" ⇒ `allow_once` only. */
  readonly sessionGrantKind: "none" | "allow_session";
  readonly emitsUsageUpdateOnV1: boolean;
  readonly emitsStateUpdate: boolean;
  readonly configIdField: "configId" | "optionId";
  readonly toleratesOmittedMcpCapabilities: boolean;
  readonly unknownMethodErrorCode: number;
}

export interface RuntimeBudgets {
  readonly initializeMs: number;
  readonly sessionNewMs: number;
  readonly resumeMs: number;
  readonly turnMs: number;
}

/** Resolution order is builtin ⊕ config overlay ⊕ probe, and `source` records which layers ran. */
export interface RuntimeDescriptor {
  readonly id: string;
  /** sha256 over command ⊕ args ⊕ descriptor version ⊕ agentInfo.name/version. Cache + audit key. */
  readonly fingerprint: string;
  readonly protocolVersion: 1 | 2;
  readonly source: "builtin" | "config" | "probe" | "merged";
  readonly prefer: MethodPreferences;
  readonly updates: Readonly<Record<string, UpdateRule>>;
  readonly extensions: Readonly<Record<string, ExtensionPath>>;
  readonly errorRules: readonly ErrorRule[];
  readonly quirks: Quirks;
  /**
   * INBOUND method aliases: an agent→client notification whose method matches a key is
   * normalized to the value before the update map runs. `{"session/notification":
   * "session/update"}` is DESIGN §1.3's non-standard spelling, and this is where §6.2 requires a
   * vendor extension to be registered (review R4). Empty by default, and empty for claude-acp —
   * an unregistered method keeps §7.6's `-32601`, so a typo cannot silently swallow updates.
   */
  readonly inboundAliases: Readonly<Record<string, string>>;
  /** D3: both false for every agent M1 knows about. */
  readonly clientHost: { readonly fs: boolean; readonly terminal: boolean };
  readonly budgets: RuntimeBudgets;
  /** Rows the compat suite must NOT assert for this agent — corpus gaps, not failures (§18.3). */
  readonly unverified: readonly string[];
}

/**
 * A descriptor shipped in the repository, keyed by the agent id an operator writes in config.
 * `BUILTIN_RUNTIMES` (core, M1-WP-E) has exactly one entry today: claude-acp.
 */
export interface BuiltinRuntime {
  /** Config `agents[].id` values this profile claims, plus a command-basename match. */
  readonly matches: readonly string[];
  readonly descriptor: RuntimeDescriptor;
}

/** What a probe learned. Never fabricated; `null` on `AgentCatalogEntry.probed` until probed. */
export interface ProbeSummary {
  readonly at: string;
  readonly agentId: string;
  readonly descriptorFingerprint: string;
  readonly protocolVersion: number;
  readonly agentInfo: Readonly<Record<string, unknown>> | null;
  readonly capabilities: Readonly<Record<string, unknown>>;
  /** Methods answered `-32601`. Recorded so the registry skips them next time. */
  readonly unsupportedMethods: readonly string[];
  readonly supportedMethods: readonly string[];
  readonly resumeMethod: ResumeMethod | null;
  /** What `-32602 data.<field>._errors` taught us about param names (F17). */
  readonly learnedParams: Readonly<Record<string, string>>;
  readonly timings: Readonly<Record<string, number>>;
}

export type MethodVerdict =
  | { readonly kind: "implemented"; readonly result: unknown }
  | { readonly kind: "not_implemented"; readonly code: number }
  /** `-32602` with `data.<field>._errors`: implemented, WRONG PARAM NAME — this is the row that
   *  teaches the probe the field is `configId` and not `optionId` (F17). */
  | {
      readonly kind: "implemented_other_params";
      readonly code: -32602;
      readonly hints: readonly string[];
    }
  /** `-32603` with `data.details`: implemented, value rejected. Indistinguishable from a genuine
   *  internal error by `code` alone, which is why the registry keys on the pointer. */
  | { readonly kind: "implemented_bad_value"; readonly code: -32603; readonly details: string }
  | { readonly kind: "error"; readonly code: number; readonly message: string }
  | { readonly kind: "skipped"; readonly reason: string };
