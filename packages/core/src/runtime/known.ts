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
  /**
   * M3-WP1. A runtime we have never seen has no credential contract we may claim, so a worker on
   * this profile INHERITS the daemon's environment — which is M2's behaviour exactly, and what
   * `credentials.allowInherit: true` keeps as the default.
   */
  credentials: null,
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
  // ── M2's five (M2-WP-J acceptance 8) ────────────────────────────────────────
  //
  // Each is a thing the M2 corpus could NOT show us, and the rule is unchanged: the absence of an
  // observation is not an observation of absence, so the suite refuses to assert them rather than
  // passing them quietly.
  /** D10 declares `elicitation.form` only. No `url` mode was ever offered or exercised (§19.2). */
  "elicitation_url",
  /** The completion callback for a `url` elicitation. Never observed on either agent. */
  "elicitation_complete",
  /** `InteractionAnswer{action:"cancel"}`. Both corpus elicitations were accepted or declined
   *  (claude `12` / `13`); nothing ever cancelled one. */
  "interaction_cancel",
  /** A form with TWO questions. Both recorded elicitations carried exactly one (F29, F30), and
   *  `elicit-multi.mjs` is a FIXTURE — evidence about our mapper, not about this agent. */
  "elicitation_multi_question",
  /** `parkTimeoutAction`. The corpus answered both elicitations in ~1 ms, so what a real agent
   *  does with a park that EXPIRES is §11.9's first open risk and not a recorded fact. */
  "park_timeout_action",
] as const;

/**
 * **THE SINGLE SOURCE OF TRUTH for codex-acp's corpus gaps**, on the same terms as claude's.
 *
 * `permission` heads the list and it is the one that matters: across eight recorded processes
 * codex-acp never sent `session/request_permission` — not in `agent` mode, not after
 * `set_config_option{mode:"read-only"}`, not with `INITIAL_AGENT_MODE`, and not for a path outside
 * the workspace (README, files 02–05, extended to reads by `09`). Every interaction case is
 * therefore a printed `capability` skip for this agent rather than a silent pass.
 */
export const CODEX_ACP_UNVERIFIED = [
  /** Never sent, in any mode, for any path (codex `02`–`05`, `09`). */
  "permission",
  /** No `elicitation/create` in any recorded process; the adapter never asks for input. */
  "elicitation",
  "elicitation_url",
  "elicitation_complete",
  "interaction_cancel",
  "elicitation_multi_question",
  "park_timeout_action",
  /**
   * F38, and it is a POLICY row rather than a wire row: codex's two-file read arrived as one call
   * classified `kind:"read"`, with `locations[]` naming only the inside file and **no `rawInput`
   * whatsoever** — so a `cmd` clause has nothing to match on for a call this agent makes. §20.3
   * rejects such a rule at compile (M2-R18); this row is why the compat suite will not assert one
   * against this runtime either.
   */
  "cmd_rules",
  /** `mcpServers` was `[]` in every recorded process; `mcpCapabilities` advertises http only. */
  "mcp",
  "image_content",
  /** The ChatGPT login is picked up without any `authenticate` call, so the method is unexercised. */
  "authenticate",
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
    /**
     * F25, M2's one new update kind and the reason it is written down rather than tolerated.
     *
     * `session_info_update` has no row in DESIGN §6.1 and appears in 7 of 7 M2 claude runs and in
     * NONE of the 11 M1 runs — the wire moved without a version bump (§11.9). `map: null` is
     * passthrough at `payloadVersion: 1`, which is exactly what the normalizer already did for a
     * kind with no row; writing the row makes that INTENTIONAL, and it is the line a reader
     * checks when asking whether the watchdog is allowed to count it as liveness. It is: it lands
     * 5-22 ms after `session/prompt` resolves, and the silent budget is anchored on the last
     * update precisely so that a post-response frame re-arms it rather than tripping it (§21.2).
     */
    session_info_update: { map: null, stream: true, store: true, digest: false },
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
  /**
   * M3-WP1's credential contract, and every row is MEASURED on this machine (2026-09-12).
   *
   * E1: `CLAUDE_CONFIG_DIR=<dir>` with a `.credentials.json` inside it is sufficient for a
   * complete turn; the agent then creates `.claude.json`, `projects/`, `sessions/` and `backups/`
   * in that directory, which is E7's reason a home must be reused across hibernate/wake/restart.
   *
   * `reload: "file"` — MEASURED, not assumed. With the process live and a turn already completed,
   * the credential file was overwritten with `{"garbage":true}` and the NEXT `session/prompt`
   * failed in 88 ms with `-32000 Authentication required`. So this agent consults the file per
   * request and a credential swap needs no new process: `setCredential` answers
   * `applied: "immediate"`. (The experiment is `docs/M3-WP1-CREDENTIALS.md §Real-agent record`,
   * row R1.)
   *
   * `loginRequiredSignal: "prompt_-32000"` — also measured, three ways: with NO credential file,
   * with a garbage one, and with a valid one. `initialize.authMethods` is `[]` in all three and
   * `session/new` SUCCEEDS in all three; only `session/prompt` tells them apart. An
   * `authMethods`-based check would have called an unauthenticated agent healthy.
   */
  credentials: {
    homeEnv: "CLAUDE_CONFIG_DIR",
    files: [".credentials.json"],
    /** E5: `claude setup-token` mints a long-lived subscription token read from this variable. */
    tokenEnv: "CLAUDE_CODE_OAUTH_TOKEN",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    reload: "file",
    loginRequiredSignal: "prompt_-32000",
  },
};

/**
 * `codex-acp` — M2's second builtin, and every row is an observation from
 * `docs/research/transcripts/codex-acp-1.8.0/` with the file named on the line.
 *
 * It exists because M2 is the milestone that runs a SECOND real agent, and because two of its
 * observed behaviours are decisions the daemon has to make per runtime rather than per agent id:
 * it never asks permission (so every interaction case must be a printed `capability` skip, not a
 * failure), and its `mcpCapabilities` block declares `http` while it happily takes stdio servers
 * (§23.2's "stdio is never filtered"). A quirk we did NOT observe is `false` here, on the same
 * terms as claude's profile: the absence of an observation is not an observation of absence.
 *
 * Owned by M2-WP-J.
 */
const CODEX_ACP: RuntimeDescriptor = {
  id: "codex-acp",
  fingerprint: "unresolved",
  /** README: `initialize` answers `protocolVersion: 1`, with v2-ish blocks in `session/new`. */
  protocolVersion: 1,
  source: "builtin",
  prefer: {
    /** `sessionCapabilities {resume, list, close, delete, fork, …}` (README). */
    resume: { spellings: ["session/resume", "session/load"], onFailure: "fail" },
    /**
     * `session/set_config_option` is the ONLY config surface, it works, and it notifies nothing
     * (codex `07`, F35). `session/set_mode` is deliberately absent: nothing in the corpus shows
     * it answering, and a spelling we never saw work does not belong in a table whose rule is
     * "every field is an observation".
     */
    setConfig: { spellings: ["session/set_config_option"], onFailure: "fail" },
    setOptions: { spellings: ["session/set_options"], onFailure: "warn" },
    list: { spellings: ["session/list"], onFailure: "fail" },
    close: { spellings: ["session/close"], onFailure: "fail" },
  },
  inboundAliases: {},
  quirks: {
    resumeSilentlyCreates: false,
    /** Not observed either way for this agent; `false` is the claim we can support. */
    resumeRequiresSameCwd: false,
    loadReturnsBody: false,
    /**
     * F41: a host BANNER arrives as a `messageId`-less `agent_message_chunk`, unlike every real
     * answer chunk. So `messageIdPresent` is false HERE where it is true for claude — grouping
     * keyed on `messageId` must tolerate absence for this runtime.
     */
    messageIdPresent: false,
    /** codex `02`/`08`: `tool_call` then a single terminal `tool_call_update`, never a patch series. */
    toolCallUpdateIsSparse: false,
    /** No v1 `diff` block was observed at all, so nothing claims its fragments are widened. */
    diffIsFragment: false,
    permissionRequestShape: "v1_tool_call",
    /** It never asks, so it offers no grant kind to remember (README, files 02-05). */
    sessionGrantKind: "none",
    /** README: `usage_update {used, size}`, no `cost`, on a v1 handshake. */
    emitsUsageUpdateOnV1: true,
    /** No `state_update` in any recorded process; `session_info_update` is its liveness frame. */
    emitsStateUpdate: false,
    /** codex `07`: the request parameter is `configId`, exactly as claude spells it (review R3). */
    configIdField: "configId",
    /**
     * `mcpCapabilities {acp:false, http:true, sse:false}` IS declared, so the omission rule never
     * applies to this agent — and stdio is never filtered anyway (§23.2).
     */
    toleratesOmittedMcpCapabilities: false,
    unknownMethodErrorCode: -32601,
  },
  extensions: {},
  updates: {
    /** README: once per session, `commands[]._meta.commandAction`. Same handling as claude's. */
    available_commands_update: { map: null, stream: true, store: true, digest: true },
    /**
     * codex `08`: `session_info_update` carries `_meta.codex.threadStatus:{type:"idle"}` and
     * arrives BEFORE the prompt response — the other half of F25's anchor argument. Passthrough,
     * and it counts as liveness for the silent budget exactly as claude's does.
     */
    session_info_update: { map: null, stream: true, store: true, digest: false },
  },
  errorRules: [
    {
      /**
       * codex `06`: `session/new` fails `-32603 "approval_policy = \"untrusted\" is no longer
       * supported"` for a `CODEX_CONFIG` the operator set. That is the operator's configuration
       * being wrong, which is a `bad_request` and not an agent that broke.
       */
      id: "unsupported-config",
      code: -32603,
      dataPointer: "/details",
      dataMatches: "is no longer supported",
      classify: "bad_request",
    },
    {
      id: "unknown-method",
      code: -32601,
      dataPointer: "/method",
      classify: "unsupported_method",
    },
  ],
  clientHost: { fs: false, terminal: false },
  budgets: {
    /**
     * README: warm `initialize` ~1.6 s, `session/new` ~0.4 s more, an edit turn 8-10 s — and a
     * COLD `npx -y` that downloads the bundled `@openai/codex` binary took **>90 s once**, which
     * is why this budget is twice claude's rather than the same number.
     */
    initializeMs: 120_000,
    sessionNewMs: 60_000,
    resumeMs: 90_000,
    turnMs: 600_000,
  },
  unverified: [...CODEX_ACP_UNVERIFIED],
  /**
   * M3-WP1's credential contract, MEASURED on this machine (2026-09-12).
   *
   * E2: `CODEX_HOME=<dir>` with an `auth.json` inside it is sufficient; the agent then creates
   * `sessions/`, `thread_history_1.sqlite`, `cache/`, `skills/` and a dozen more sqlite files in
   * that directory — E7 again, and rather more of it than claude produces.
   *
   * `reload: "restart"` — MEASURED, with a control. With the process live and a turn already
   * completed, `auth.json` was overwritten with `{"garbage":true}` and the NEXT `session/prompt`
   * still answered `end_turn` in 2.06 s: this agent caches the credential in the process. The
   * control rules out "the file never mattered": the SAME garbage file present from the START
   * makes `session/new` fail `-32603 "plan type is required for chatgpt authentication"`. So a
   * credential swap here needs a new process, and `setCredential` answers `applied: "restarted"`
   * when the worker is idle and `"on-next-start"` when a turn is live.
   *
   * `loginRequiredSignal: "session_new"` — measured, and it is the row that CORRECTS E4. E4 read
   * codex's non-empty `authMethods` as the not-logged-in signal; with a VALID credential and
   * `NO_BROWSER=1` this agent still answers `authMethods: [api-key]`, so the array says nothing
   * about the login. What does is `session/new`: `-32000 Authentication required` with no file,
   * `-32603 "plan type is required…"` with a malformed one, and a session id with a good one.
   */
  credentials: {
    homeEnv: "CODEX_HOME",
    files: ["auth.json"],
    /** E5: `codex login --with-access-token` takes the token on stdin; there is no env spelling
     *  for a SUBSCRIPTION token, so only the api-key variable is declared here. */
    apiKeyEnv: "CODEX_API_KEY",
    reload: "restart",
    loginRequiredSignal: "session_new",
  },
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
  {
    // The adapter answers `agentInfo.name: "codex-acp"`, and the compat entry's id is the same
    // word; the scoped specifier appears in the argv `npx -y @agentclientprotocol/codex-acp@1.8.0`.
    matches: ["codex-acp", "@agentclientprotocol/codex-acp"],
    descriptor: CODEX_ACP,
  },
];

// §17.2 also records a VERSION WINDOW for this profile — `>=0.70.0 <1.0.0`. It is not a field
// here because `BuiltinRuntime` is frozen in `protocol` for the whole of M1 and carries only
// `matches`, and because this package's barrel is Land-owned: a constant added here could not be
// read by the module that does the selecting. It lives with the selection instead, as
// `BUILTIN_VERSION_WINDOWS` in `daemon/src/catalog.ts`, defined once and tested there.
