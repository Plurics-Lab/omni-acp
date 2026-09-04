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
 * **THE SINGLE SOURCE OF TRUTH for claude-acp's corpus gaps** (CONTRACTS.md §17.2, review R8).
 *
 * §18.3's `capability` skip source derives from it; `tests/compat/agents.local.yaml`'s
 * `unverified:` key restates it verbatim so an operator reading only the YAML sees the same seven
 * rows; and M1-PLAN §5's definition-of-done points here rather than re-listing a fifth, different
 * subset.
 *
 * A row leaves this list when a real run exercises it — which is the only event that may ever
 * shorten it. It is exported by name so a test can assert the identity of the two lists rather
 * than their equality by transcription.
 */
export const CLAUDE_ACP_UNVERIFIED = [
  "plan",
  "agent_thought_chunk",
  "current_mode_update",
  "mcp",
  "image_content",
  "authenticate",
  "tool_failure_on_merits",
] as const;

/**
 * `claude-acp` — the ONE non-default builtin M1 ships (CONTRACTS.md §17.2).
 *
 * Every field below is an observation from `docs/research/transcripts/claude-acp-0.73.0/`, and
 * the transcript that warrants it is named on the line. Nothing here is recalled, and nothing
 * here is aspirational: a quirk we did not observe is `false`, because the absence of an
 * observation is not an observation of absence.
 */
const CLAUDE_ACP: RuntimeDescriptor = {
  id: "claude-acp",
  /** Computed per configured agent by `descriptorFingerprint()`; a builtin has no argv of its own. */
  fingerprint: "unresolved",
  /** F24: answers `protocolVersion: 1`, and speaks v2 in places. `prefer` is what carries that. */
  protocolVersion: 1,
  source: "builtin",
  prefer: {
    // F18: BOTH work on one process — `session/resume` in corpus 08, `session/load` in 07.
    resume: { spellings: ["session/resume", "session/load"], onFailure: "fail" },
    // F18 is the decisive fact for the whole registry: `session/set_config_option` and
    // `session/set_mode` are both live here while `session/set_model` — which multica saw on
    // eight runtimes — is `-32601` (corpus 08, ids 3 and 4). A registry that mapped one
    // capability to one method name could not express that, which is why `spellings` is a list.
    //
    // `session/set_model` is deliberately NOT a third spelling here: §17.2's descriptor lists
    // exactly these two, and a spelling the corpus PROVED absent does not belong in a table whose
    // rule is "every field is an observation". The registry's ability to walk three spellings is
    // a property of the registry, exercised in its own test over a three-spelling descriptor.
    setConfig: {
      spellings: ["session/set_config_option", "session/set_mode"],
      onFailure: "fail",
    },
    // `-32601` here (corpus 08, id 5). A vendor extension we OFFER to pass through, so its
    // absence is a warning on the turn rather than a failed request (DESIGN §6.2, review R2).
    setOptions: { spellings: ["session/set_options"], onFailure: "warn" },
    list: { spellings: ["session/list"], onFailure: "fail" },
    close: { spellings: ["session/close"], onFailure: "fail" },
  },
  /** This agent spells `session/update` the standard way (corpus README, review R4). */
  inboundAliases: {},
  quirks: {
    /** Not observed: every resume in the corpus either landed or was refused, never silent. */
    resumeSilentlyCreates: false,
    /**
     * README §10 — `-32002 "Resource not found: <sessionId>"` when `cwd` does not match. NOT in
     * the committed transcripts (F15), so §18's compat suite RE-OBSERVES it rather than letting
     * a quirk stand on a note.
     */
    resumeRequiresSameCwd: true,
    /** F18: `session/load` and `session/resume` return the `session/new` body, against the v1 schema. */
    loadReturnsBody: true,
    /** F14: every `agent_message_chunk` and `user_message_chunk` carries one — do not backfill. */
    messageIdPresent: true,
    /** Corpus finding 3: `tool_call` once, then SPARSE `tool_call_update` patches. */
    toolCallUpdateIsSparse: true,
    /** F19: v1 `oldText`/`newText` are the changed FRAGMENT. The flag that stops a consumer
     *  writing a fragment over a whole file. */
    diffIsFragment: true,
    /** Corpus 03/04/09: v1 `{sessionId, toolCall, options}`. */
    permissionRequestShape: "v1_tool_call",
    /** No `allow_always`/`allow_session` kind is offered ⇒ `allow_once` is the only safe allow
     *  (D4 rule 2). */
    sessionGrantKind: "none",
    /** README's kind table: 60 `usage_update` notifications across the corpus, on a v1 handshake. */
    emitsUsageUpdateOnV1: true,
    /** README: `state_update` is NEVER observed across all 11 runs. */
    emitsStateUpdate: false,
    /** F17 — learned from `-32602 data.configId._errors` (corpus 08, id 7), not from a doc. */
    configIdField: "configId",
    /** Never exercised: the corpus always sends `mcpServers: []`. §2.3 lists MCP as M2. */
    toleratesOmittedMcpCapabilities: false,
    /** README: the unknown-method shape is uniform `-32601` + `data.method`. */
    unknownMethodErrorCode: -32601,
  },
  extensions: {
    /** Corpus 10 — the only transcript carrying `structuredPatch` (ruling M1-R11). */
    patch: { pointer: "/claudeCode/toolResponse", as: "patch", dialect: "claude_structured_patch" },
    /** `_meta["_claude/rateLimit"]` inside `usage_update`; `~1` is RFC-6901's escape for "/". */
    rateLimit: { pointer: "/_claude~1rateLimit", as: "rate_limit", dialect: "claude_rate_limit" },
  },
  updates: {
    /**
     * F13 / §14.6: 275 270 of 313 643 update bytes (87.8 %), 23 notifications, TWO distinct
     * payloads, largest line 12.7 KB. Streamed in full (a client rendering a slash-command
     * palette needs it) and stored ONCE per content digest. Never store-but-do-not-stream —
     * `assertDescriptorLegal` rejects that shape.
     */
    available_commands_update: { map: null, stream: true, store: true, digest: true },
    // Every other kind: the §12.3 default, which is "no row" and therefore M1-WP-B's map.
  },
  errorRules: [
    {
      /**
       * F17: a wrong config VALUE and a genuine internal error share `-32603` and are separated
       * only by `data.details`. Corpus 08 id 9:
       * `{"code":-32603,"message":"Internal error","data":{"details":"Invalid value for config
       * option model: no-such-model-xyz"}}`.
       */
      id: "bad-config-value",
      code: -32603,
      dataPointer: "/details",
      dataMatches: "^Invalid value for config option ",
      classify: "bad_request",
    },
    {
      /**
       * Matched on code + `data.method`, NEVER on the message: the observed message is
       * `"\"Method not found\": session/set_model"` — with embedded quotes — which is not a
       * stable contract, while `data.method` carries the same information in a field.
       */
      id: "unknown-method",
      code: -32601,
      dataPointer: "/method",
      classify: "unsupported_method",
    },
    // There is deliberately NO rule for the `-32002 "Resource not found"` a mismatched resume
    // `cwd` produces (README §10, F15). Ruling M1-R6 settles it as `unknown` + `cwd_mismatch`,
    // which is `classifyResume`'s (M1-WP-C) judgement over the whole attempt — an `errorRule`
    // could only say `resume_permanent` or `resume_transient`, and both would assert a cause the
    // evidence does not support.
  ],
  clientHost: { fs: false, terminal: false },
  budgets: {
    /** Observed ~0.94 s cold `initialize` behind an `npx -y` fetch; the budget covers the fetch. */
    initializeMs: 60_000,
    sessionNewMs: 60_000,
    /** Observed ~0.55 s warm `session/load`; the budget covers a cold spawn in front of it. */
    resumeMs: 90_000,
    turnMs: 600_000,
  },
  unverified: [...CLAUDE_ACP_UNVERIFIED],
};

/**
 * Descriptors shipped in the repository — EXACTLY ONE non-default entry today (§17.2).
 *
 * `matches` is the set of tokens a caller may present to claim this profile: the config
 * `agents[].id`, the command basename, an npm package specifier appearing in argv, and the
 * `agentInfo.name` a probe returned. The selection itself lives in the Agent Catalog
 * (`daemon/src/catalog.ts`), because it needs the AgentDescriptor and the probe together, and
 * because `resolveDescriptor` takes the builtin already chosen (§17.2's signature).
 *
 * The real agent answers `agentInfo.name: "@agentclientprotocol/claude-agent-acp"`, so both the
 * scoped specifier and its last path segment are listed: §17.2's `/^claude-(code|agent)-acp$/`
 * is a match on the segment, not on the whole scoped name.
 */
export const BUILTIN_RUNTIMES: readonly BuiltinRuntime[] = [
  {
    matches: [
      "claude-acp",
      "claude-agent-acp",
      "claude-code-acp",
      "@agentclientprotocol/claude-agent-acp",
      "@zed-industries/claude-code-acp",
    ],
    descriptor: CLAUDE_ACP,
  },
];

// §17.2 also records a VERSION WINDOW for this profile — `>=0.70.0 <1.0.0`. It is not a field
// here because `BuiltinRuntime` is frozen in `protocol` for the whole of M1 and carries only
// `matches`, and because this package's barrel is Land-owned: a constant added here could not be
// read by the module that does the selecting. It lives with the selection instead, as
// `BUILTIN_VERSION_WINDOWS` in `daemon/src/catalog.ts`, defined once and tested there.
