import type { BuiltinRuntime, RuntimeDescriptor } from "@omni-acp/protocol";

/**
 * The generic v1 profile: zero quirks, zero vendor extensions, no map rows of its own.
 *
 * It is a REAL value rather than a stub because it is the fallback every other layer resolves
 * against — `Catalog.descriptor()` "NEVER throws; falls back to the v1 profile" (CONTRACTS.md
 * §5.4) — and a throwing constant would make the fallback path the one that cannot run.
 * Everything it asserts is the *absence* of a quirk, which is the only thing we may claim about
 * a runtime we have never probed.
 *
 * `updates` is empty on purpose: a kind with no row is vendor passthrough (`payloadVersion: 1`),
 * which is exactly what "we know nothing about this agent" should produce. The v1→v2 rows live
 * in M1-WP-B's map and are folded in by `resolveDescriptor`.
 *
 * Owned by M1-WP-E.
 */
export const DEFAULT_V1_PROFILE: RuntimeDescriptor = {
  id: "default-v1",
  /**
   * The sentinel for "no fingerprint has been computed yet". `descriptorFingerprint()` (M1-WP-E)
   * produces the real sha256 over command ⊕ args ⊕ descriptor version ⊕ agentInfo; until a
   * descriptor has been resolved against an actual agent there is nothing to hash, and inventing
   * a hex string here would make `runtimeId` look authoritative when it is not.
   */
  fingerprint: "unresolved",
  protocolVersion: 1,
  source: "builtin",
  prefer: {
    // v2's spelling first, v1's second: F18 shows one process answering both, and the order is
    // "the canonical name, then the compatible one".
    resume: { spellings: ["session/resume", "session/load"], onFailure: "fail" },
    // A caller that asked to set a config option and did not get one has NOT had its request
    // honoured, so the failure is `fail` (DESIGN §6.2, review R2).
    setConfig: { spellings: [], onFailure: "fail" },
    // `session/set_options` is a vendor extension we offer to pass through; an agent that does
    // not implement it has done nothing wrong, so the failure is a WARNING on the turn.
    setOptions: { spellings: ["session/set_options"], onFailure: "warn" },
    list: { spellings: [], onFailure: "fail" },
    close: { spellings: ["session/close"], onFailure: "fail" },
  },
  updates: {},
  extensions: {},
  errorRules: [],
  quirks: {
    resumeSilentlyCreates: false,
    resumeRequiresSameCwd: false,
    loadReturnsBody: false,
    messageIdPresent: false,
    toolCallUpdateIsSparse: false,
    diffIsFragment: false,
    permissionRequestShape: "v1_tool_call",
    sessionGrantKind: "none",
    emitsUsageUpdateOnV1: false,
    emitsStateUpdate: false,
    configIdField: "configId",
    toleratesOmittedMcpCapabilities: false,
    /** JSON-RPC's own "Method not found". */
    unknownMethodErrorCode: -32601,
  },
  /** No agent M1 knows about spells `session/update` differently (§12.3, review R4). */
  inboundAliases: {},
  /** D3: the client host declares nothing, for every agent M1 knows about. */
  clientHost: { fs: false, terminal: false },
  budgets: {
    initializeMs: 60_000,
    sessionNewMs: 60_000,
    resumeMs: 90_000,
    turnMs: 600_000,
  },
  /** Nothing has been verified against a real agent for a profile that describes no agent. */
  unverified: [],
};

/**
 * Descriptors shipped in the repository. M1-WP-E lands the single entry the corpus supports
 * (claude-acp); until then an unknown agent resolves to `DEFAULT_V1_PROFILE`, which is the
 * documented fallback rather than a failure.
 */
export const BUILTIN_RUNTIMES: readonly BuiltinRuntime[] = [];
