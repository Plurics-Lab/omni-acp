import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";

// ── D4's policy language (M2-B, §5.8.7) ──────────────────────────────────────

export const POLICY_ACTIONS = ["allow", "deny", "park", "fail"] as const;
export type PolicyAction = (typeof POLICY_ACTIONS)[number];

/**
 * D4's match arm.
 *
 * `strictObject`: an unknown key in a security rule is a typo that would silently WIDEN the rule,
 * so it is a config LOAD failure rather than a clause nobody notices was never applied.
 */
export const PolicyMatch = z.strictObject({
  /** v2's tagged subject arm. `"any"` is the default. */
  subject: z.enum(["tool_call", "command", "any"]).default("any"),
  method: z.enum(["session/request_permission", "elicitation/create", "any"]).default("any"),
  /** v2 `ToolKind` values plus any vendor string, matched case-sensitively. An UNKNOWN kind
   *  matches NOTHING but the literal `["*"]` — D4 rule 6 lifted from the responder to the matcher. */
  kind: z.array(z.string().min(1).max(64)).min(1).max(32).optional(),
  /** Globs over REALPATH'd absolute `subject.toolCall.locations[].path`. `**` crosses separators.
   *  A relative pattern is a load error. F38: this clause NARROWS and never AUTHORISES (§20.3). */
  path: z.array(z.string().min(1).max(512)).min(1).max(64).optional(),
  /** ANCHORED (`^(?:…)$` is applied for you), length-capped, no backreferences, compiled once at
   *  create. Only meaningful with `subject: "command"` — a `cmd` clause on a `tool_call` subject
   *  is rejected at COMPILE, because F38 leaves it nothing to match on. */
  cmd: z.string().min(1).max(512).optional(),
  agent: z.array(z.string().min(1)).max(32).optional(),
  // NOTE: there is deliberately NO `title` / `name` matcher (F27). `no-agent-prose` forbids
  // adding one: an agent's prose is not a security predicate.
});
export type PolicyMatch = z.output<typeof PolicyMatch>;

export const PolicyRule = z.strictObject({
  id: z.string().min(1).max(64),
  match: PolicyMatch,
  action: z.enum(POLICY_ACTIONS),
});
export type PolicyRule = z.output<typeof PolicyRule>;

export const PolicyPreset = z.strictObject({
  extends: z.string().min(1).max(64).optional(),
  default: z.enum(POLICY_ACTIONS).default("deny"),
  rules: z.array(PolicyRule).max(200).default([]),
  /**
   * F40: a read-only `ls -A` ran with NO permission request while `python3 -c …` in the same cwd
   * raised one, and the split is invisible in the frame. So "no permission request" may never be
   * read as "no tool ran": a tool call of a listed kind that never reached the engine becomes
   * `TurnWarning{code:"unpoliced_tool_call"}` (§20.6).
   */
  alertOnUnpoliced: z.array(z.string().min(1)).max(32).default([]),
});
export type PolicyPreset = z.output<typeof PolicyPreset>;

export const PolicyConfig = z.object({
  presets: z.record(z.string().max(64), PolicyPreset).default({}),
  /** The preset a worker gets when the request names none. */
  default: z.string().min(1).default("deny-all"),
});
export type ResolvedPolicyConfig = z.output<typeof PolicyConfig>;

/**
 * A ceiling is written in a DELIBERATELY COARSER language than a rule, because glob∩glob and
 * regex∩regex containment is undecidable and a ceiling that LOOKS precise while being checked
 * approximately is worse than one that is honestly coarse (§20.5, ruling M2-R11).
 */
export const PolicyCeiling = z.strictObject({
  /** The widest action any rule may resolve to. `deny` and `fail` rank EQUAL: neither grants. */
  maxAction: z.enum(POLICY_ACTIONS).default("allow"),
  /** Kinds that may reach `allow`. Absent ⇒ any. */
  allowKinds: z.array(z.string()).optional(),
  /** Kinds that may never exceed `deny`, whatever a rule says. */
  denyKinds: z.array(z.string()).default([]),
  /** Every `path` glob in every rule must be lexically contained in one of these — a literal
   *  prefix test on the pattern's non-wildcard head, which is decidable and total. */
  pathRoots: z.array(z.string()).optional(),
  /** May this token's rules match `subject: command` at all? */
  commands: z.boolean().default(true),
  /** May this token's workers use `onUnresolved:"park"` (⇒ declare elicitation)? */
  park: z.boolean().default(true),
});
export type PolicyCeiling = z.output<typeof PolicyCeiling>;

// NOTE: `PolicySelection` — the REQUEST-side union (a preset name, a list, or an inline rule
// set) — lives in `control-plane.ts` beside `CreateWorkerRequest`, because it is a wire body and
// not a config block. It is built from `PolicyRule` / `POLICY_ACTIONS` above (§5.8.6).

/** The merged, ceiling-checked document a `PolicyEngine` is built from (§5.8.9). */
export interface ResolvedPolicy {
  readonly id: string;
  readonly sources: readonly string[];
  readonly default: PolicyAction;
  readonly rules: readonly PolicyRule[];
  readonly alertOnUnpoliced: readonly string[];
}

export const TokenConfig = z
  .object({
    id: z.string().min(1),
    /** Exactly one of secret / secretSha256. Plaintext is hashed at load and dropped (DESIGN §8). */
    secret: z.string().min(16).optional(),
    secretSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    role: z.enum(["user", "admin"]).default("user"),
    agents: z.union([z.literal("*"), z.array(z.string())]).default("*"),
    /** Every cwd must realpath into one of these. Defaults to [os.homedir()] at load. */
    cwdRoots: z.array(z.string()).default([]),
    maxWorkers: z.number().int().positive().default(16),
    // ── M2 (§5.8.7) ─────────────────────────────────────────────────────────
    /** D4. A named preset or an inline document; the MERGE of preset ⊕ inline may never exceed it. */
    policyCeiling: PolicyCeiling.nullable().default(null),
    policyPresets: z.union([z.literal("*"), z.array(z.string())]).default("*"),
    /** FAIL CLOSED: default `[]`, not `"*"` (DESIGN §8's 🔴). An MCP server is arbitrary code on
     *  this machine, so a token gets none until an operator names one. */
    mcpPresets: z.union([z.literal("*"), z.array(z.string())]).default([]),
    /** Env var NAMES this token may set per worker, ON TOP of the hard blacklist. Default: none. */
    envAllow: z.array(z.string().min(1)).default([]),
    /**
     * D9's HMAC key. Unlike `secret` this CANNOT be stored hashed — signing needs the plaintext.
     * It is never returned by any route and never logged; `webhookSecretFile` (0600, read at
     * load) is the recommended spelling and at most one of the two may be set.
     */
    webhookSecret: z.string().min(32).optional(),
    webhookSecretFile: z.string().optional(),
  })
  .refine((t) => (t.secret == null) !== (t.secretSha256 == null), {
    message: "exactly one of secret / secretSha256",
  })
  .refine((t) => !(t.webhookSecret != null && t.webhookSecretFile != null), {
    message: "at most one of webhookSecret / webhookSecretFile",
  });
export type TokenConfig = z.infer<typeof TokenConfig>;

/**
 * The operator's overlay on a builtin Runtime descriptor (CONTRACTS.md §17.2). Every field is
 * optional and every field is a PARTIAL of the descriptor's own: the merge is
 * builtin ⊕ config ⊕ probe, and an overlay that had to restate a whole descriptor would rot the
 * moment the builtin gained a row.
 *
 * The nested shapes stay loose here on purpose — `protocol` owns the descriptor TYPE
 * (`runtime.ts`), while `resolveDescriptor` (core, M1-WP-E) is what validates a merged result
 * and rejects the forbidden `stream:false, store:true` shape.
 */
export const RuntimeOverlay = z.object({
  /**
   * A RECORD of capability -> { spellings, onFailure }, mirroring `MethodPreferences`
   * (`runtime.ts`, review R2). The well-known keys are `resume` / `setConfig` / `setOptions` /
   * `list` / `close`; an operator may add another, because a vendor extension that DESIGN §6.2
   * requires the descriptor to carry must not need a schema edit to express.
   *
   * `onFailure` defaults to `"fail"`: an operator who names a spelling is asking for it to work,
   * and the one capability whose failure is only a warning (`setOptions`) says so out loud in the
   * builtin descriptor.
   */
  prefer: z
    .record(
      z.string(),
      z.object({
        spellings: z.array(z.string()),
        onFailure: z.enum(["fail", "warn"]).default("fail"),
      }),
    )
    .optional(),
  /**
   * Inbound method aliases, mirroring `RuntimeDescriptor.inboundAliases`: an agent→client
   * notification whose method matches a key is normalized to the value (DESIGN §1.3's
   * `session/notification`). Unregistered methods keep §7.6's `-32601` (review R4).
   */
  inboundAliases: z.record(z.string(), z.string()).optional(),
  updates: z
    .record(
      z.string(),
      z.object({
        map: z.string().nullable(),
        stream: z.boolean(),
        store: z.boolean(),
        digest: z.boolean().default(false),
      }),
    )
    .optional(),
  extensions: z
    .record(
      z.string(),
      z.object({
        pointer: z.string(),
        as: z.enum(["patch", "rate_limit", "provenance", "opaque"]),
        dialect: z.enum(["claude_structured_patch", "claude_rate_limit"]).optional(),
      }),
    )
    .optional(),
  errorRules: z
    .array(
      z.object({
        id: z.string(),
        code: z.number().int().optional(),
        dataPointer: z.string().optional(),
        dataMatches: z.string().optional(),
        messageMatches: z.string().optional(),
        classify: z.enum([
          "bad_request",
          "agent_error",
          "unsupported_method",
          "resume_permanent",
          "resume_transient",
        ]),
      }),
    )
    .optional(),
  /** A partial quirk table; unspecified quirks keep the builtin's (or the v1 profile's) value. */
  quirks: z.record(z.string(), z.union([z.boolean(), z.string(), z.number()])).optional(),
  budgets: z
    .object({
      initializeMs: z.number().int().positive().optional(),
      sessionNewMs: z.number().int().positive().optional(),
      resumeMs: z.number().int().positive().optional(),
      turnMs: z.number().int().positive().optional(),
    })
    .optional(),
  unverified: z.array(z.string()).optional(),
});
export type RuntimeOverlay = z.output<typeof RuntimeOverlay>;

export const ProbeConfig = z.object({
  onStart: z.enum(["never", "cached", "always"]).default("cached"),
  ttlHours: z.number().int().positive().default(168),
  timeoutMs: z.number().int().positive().default(90_000),
  maxConcurrent: z.number().int().positive().default(2),
  /** The method battery after `session/new`. ~0 tokens — corpus `08` ran 11 probes and no prompt. */
  deep: z.boolean().default(true),
});
export type ResolvedProbeConfig = z.output<typeof ProbeConfig>;

/**
 * Per-agent probe OVERRIDES.
 *
 * Spelled out rather than written `ProbeConfig.partial()`, because `.partial()` only makes the
 * keys optional — the inner `.default()`s still fire, so `{}` would parse into the full default
 * block and an agent's overlay would silently beat the daemon-wide `probe` setting on every
 * field the operator never wrote. An override that cannot be absent is not an override.
 */
export const ProbeOverrides = z.object({
  onStart: z.enum(["never", "cached", "always"]).optional(),
  ttlHours: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
  maxConcurrent: z.number().int().positive().optional(),
  deep: z.boolean().optional(),
});
export type ProbeOverrides = z.output<typeof ProbeOverrides>;

export const AgentDescriptor = z.object({
  id: z.string().min(1),
  /** Absolute path or PATH-resolvable name. NEVER a shell string. See CONTRACTS.md §6.3. */
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  /** Trusted, config-supplied. Per-request env is M2 (D19). */
  env: z.record(z.string(), z.string()).default({}),
  protocolVersion: z.union([z.literal(1), z.literal(2)]).default(1),
  shutdown: z
    .object({
      signal: z.string().default("SIGTERM"),
      graceMs: z.number().int().min(0).default(5_000),
    })
    .prefault({}),
  /** Operator overlay on the builtin descriptor; the probe overlays this in turn (§17.2). */
  runtime: RuntimeOverlay.prefault({}),
  /** Per-agent probe overrides; unset fields inherit the daemon-wide `probe` block. */
  probe: ProbeOverrides.prefault({}),
});
export type AgentDescriptor = z.infer<typeof AgentDescriptor>;

export const ListenConfig = z.object({
  host: z.string().default("127.0.0.1"),
  /** 0 = ephemeral. */
  port: z.number().int().min(0).max(65535).default(0),
});

export const SupervisorConfig = z.object({
  gracefulMs: z.number().int().positive().default(5_000),
  killConfirmMs: z.number().int().positive().default(2_000),
  /** Wait for `exit` after stdout EOF before declaring a crash and forcing. */
  exitGraceMs: z.number().int().positive().default(1_000),
  /** Hard cap on one ndjson frame. Over it => protocol_error + kill. */
  maxFrameBytes: z
    .number()
    .int()
    .positive()
    .default(32 * 1024 * 1024),
  stderrTailBytes: z
    .number()
    .int()
    .positive()
    .default(32 * 1024),
  /** Refuse to launch a .cmd/.bat shim on win32 unless true (CONTRACTS.md §6.3). */
  allowShimLaunch: z.boolean().default(false),
  /** Windows only. See CONTRACTS.md §6.4 for why this is a knob and not a constant. */
  windowsHide: z.boolean().default(true),
  /**
   * What to do with a process a PREVIOUS boot left behind (§15.7).
   * "fingerprint" signals only when the captured incarnation token still matches; it degrades to
   * "never" wherever `PlatformOps.fingerprint` returns null (win32 today) and SAYS SO in the
   * envelope and in `GET /v1/info`, rather than silently doing nothing.
   */
  reapOrphans: z.enum(["never", "fingerprint"]).default("fingerprint"),
});

/**
 * Resolved (post-parse) views of the nested config blocks.
 *
 * They exist so that packages downstream of `protocol` can name a fully-defaulted config without
 * taking a zod dependency of their own — CONTRACTS.md §3.2 pins zod to `protocol` alone, and
 * `z.output<typeof SupervisorConfig>` at a `core` call site would quietly break that.
 * Structurally identical to the inline form CONTRACTS.md §5.3 writes.
 */
export type ResolvedSupervisorConfig = z.output<typeof SupervisorConfig>;

export const TurnConfig = z.object({
  quietMs: z.number().int().nonnegative().default(250),
  hardMs: z.number().int().positive().default(5_000),
  cancelGraceMs: z.number().int().positive().default(10_000),
  /** Forced close-out rung 3: how long to drain stdout after stdin EOF (§13.2). */
  drainGraceMs: z.number().int().nonnegative().default(2_000),
});

export type ResolvedTurnConfig = z.output<typeof TurnConfig>;
export type ResolvedListenConfig = z.output<typeof ListenConfig>;

export const HibernateConfig = z.object({
  /** DESIGN §12: 30 min. 0 disables hibernation daemon-wide. */
  idleMs: z.number().int().nonnegative().default(1_800_000),
  /** Budget for spawn + initialize + resume. Separate from `handshakeTimeoutMs`: a wake is warm
   *  (claude-acp ~0.94 s initialize + ~0.55 s load) where a create may be cold (~7 s). */
  wakeTimeoutMs: z.number().int().positive().default(90_000),
  /**
   * A worker whose agent advertises NO resume spelling.
   * "keep"  — refuse to hibernate; hold the process. The default (ruling M1-R15): hibernating a
   *           worker you can never wake turns a healthy worker into a guaranteed 422 on a timer.
   * "close" — reclaim the process and close with `idle_timeout`. For operators who would rather
   *           lose the session than the memory.
   */
  whenNotResumable: z.enum(["keep", "close"]).default("keep"),
  /** Consecutive TRANSIENT wake failures before the pointer is abandoned (`wake_failed`). Without
   *  a cap, a worker whose agent binary was uninstalled retries a 7 s npx spawn on every prompt. */
  maxWakeFailures: z.number().int().positive().default(3),
  /** A hibernated worker owns no process, so it is bounded separately from `maxWorkers` (H14). */
  maxHibernated: z.number().int().nonnegative().default(256),
});
export type ResolvedHibernateConfig = z.output<typeof HibernateConfig>;

export const LeaseConfig = z.object({
  /** 0 = never expires. A holder that vanishes without releasing must not wedge a worker. */
  ttlMs: z.number().int().nonnegative().default(900_000),
  renewOnUse: z.boolean().default(true),
  /** A same-token peer waits this long after the holder's last use before stealing. Admin never
   *  waits (D13). 0 = immediately, which is D5's plain reading. */
  stealAfterIdleMs: z.number().int().nonnegative().default(0),
  /** true ⇒ a lease-gated request with no `Omni-Client-Id` is `400`. Default false so raw-curl and
   *  `curl-shapes.itest.ts` keep working; the SDK mints a ULID per `connect()` (§16.1 rule L4). */
  requireClientId: z.boolean().default(false),
});
export type ResolvedLeaseConfig = z.output<typeof LeaseConfig>;

export const ResumeReplayConfig = z.object({
  /**
   * "mark_all" (DEFAULT) — replay envelopes are stored, streamed and marked `replay:true`.
   * "drop_duplicates" — additionally drop, BEFORE `append()`, any replayed `*_message_chunk`
   *   whose `messageId` the log already holds. Correct for claude-acp (F14) but resting on one
   *   agent at one version, so it is opt-in (ruling M1-R5). Dropping before append means no seq is
   *   consumed and the log stays gap-free.
   * "drop_all" — the blunt instrument; loses history the daemon never saw.
   */
  replay: z.enum(["mark_all", "drop_duplicates", "drop_all"]).default("mark_all"),
});
export type ResolvedResumeReplayConfig = z.output<typeof ResumeReplayConfig>;

/**
 * The event-log block. `driver` stays "memory" BY DEFAULT (ruling M1-R17): `omni-acp start`
 * writes "sqlite" into the config it builds, because a long-running daemon must survive a
 * restart, while `createDaemon()` keeps a zero-file, zero-experimental-module footprint so
 * `OmniACP.local()` in a user's script does not leave a database behind. One default per entry
 * point, no magic in the schema, and `GET /v1/info.persistence.driver` reports which is in force.
 */
export const EventLogConfig = z.object({
  driver: z.enum(["memory", "sqlite"]).default("memory"),
  /** Default `<dataDir>/events.db`, resolved at open time — never here, where dataDir is unknown. */
  file: z.string().optional(),
  /** RAM ring; bounds MEMORY only (§14.5 bound 1). */
  maxEventsPerWorker: z.number().int().positive().default(10_000),
  /** Durable row cap per worker; 0 = unbounded (§14.5 bound 2). */
  maxPersistedEventsPerWorker: z.number().int().nonnegative().default(200_000),
  /** DESIGN §12: 7 days after CLOSE (§14.5 bound 3). */
  retentionDays: z.number().int().nonnegative().default(7),
  retentionSweepMs: z.number().int().positive().default(3_600_000),
  /** WAL + NORMAL: a daemon crash loses nothing; only power loss can. */
  synchronous: z.enum(["off", "normal", "full"]).default("normal"),
  /** §14.2 — surgical, per-warning, never `--no-warnings`. */
  suppressExperimentalWarning: z.boolean().default(true),
  subscriberQueueSize: z.number().int().positive().default(1_024),
  sseHeartbeatMs: z.number().int().positive().default(15_000),
});
export type ResolvedEventLogConfig = z.output<typeof EventLogConfig>;

/**
 * DESIGN §8: the ONLY place a stdio MCP command may appear (§5.8.7).
 *
 * A client names a PRESET; it can never put a `command` on the wire, and that is enforced by the
 * TYPE of `CreateWorkerRequest.mcp` rather than by a validator somebody could move.
 */
export const McpServerPreset = z.strictObject({
  type: z.enum(["stdio", "http", "sse"]).default("stdio"),
  /** stdio only. NEVER a shell string — the same rule as `AgentDescriptor.command` (§6.3). */
  command: z.string().min(1).optional(),
  args: z.array(z.string()).default([]),
  url: z.string().url().optional(), // http/sse only
  headers: z.record(z.string(), z.string()).default({}),
  /** Preset-owned and operator-supplied. A client can NEVER contribute to it. */
  env: z.record(z.string(), z.string()).default({}),
});
export type McpServerPreset = z.output<typeof McpServerPreset>;

export const WatchdogConfig = z.object({
  enabled: z.boolean().default(true),
  /**
   * Budget A (DESIGN §7's 无消息 N 分钟杀): nothing at all appended since the last update while a
   * turn runs. 0 disables this half only. The clock starts at the LAST UPDATE, never at the
   * prompt response — F25 makes that 7/7 on claude-acp, and codex emits `threadStatus:idle`
   * BEFORE its response.
   */
  silentMs: z.number().int().nonnegative().max(86_400_000).default(300_000),
  /**
   * Budget B (DESIGN §7's npm install 沉默 20 分钟是正常的): at least one tool call is OPEN. F36
   * says an open call can be a PERMANENT condition, which is why this is a budget and not a
   * suspension, and why it must be the larger of the two.
   */
  toolMs: z.number().int().nonnegative().max(86_400_000).default(1_800_000),
  /** After the watchdog's `session/cancel`, how long the turn has to settle before the worker is
   *  closed with `cancel_timeout`. MUST exceed `turn.cancelGraceMs` — enforced by `superRefine`
   *  on `DaemonConfig`, because a watchdog that closed first would report a fake agent timeout
   *  for a turn that was settling. */
  cancelTimeoutMs: z.number().int().positive().default(60_000),
  /**
   * "cancel" (default) ⇒ `session/cancel` then M1's existing escalation; "close" skips straight to
   * the close, WITHOUT waiting out `cancelTimeoutMs`.
   *
   * `"close"` still appends `omni.error{agent_timeout}` and `worker_state{reason:"watchdog_idle"}`
   * FIRST, and closes with **`cancel_timeout`** — M1's existing reason (§21.5). It carries that one
   * because Land exit criterion 4 forbids adding a `WorkerCloseReason` and every alternative would
   * be a false statement in a different way; review R7 is the record that the reason was CHOSEN
   * rather than left open. Nothing in the acceptance script uses it.
   */
  action: z.enum(["cancel", "close"]).default("cancel"),
});
export type ResolvedWatchdogConfig = z.output<typeof WatchdogConfig>;

export const InteractionConfig = z.object({
  /** Default `CreateWorkerRequest.parkTimeoutMs`. 0 ⇒ a park waits forever. */
  parkTimeoutMs: z.number().int().nonnegative().max(86_400_000).default(600_000),
  parkTimeoutAction: z.enum(["deny", "fail"]).default("deny"),
  /**
   * D4 rule 3 is ABSOLUTE for the daemon. This decides whether a HUMAN may pick an `allow_always`
   * option through `POST …/interactions/{reqId}`.
   *
   * "never" (default) — a human answer naming one is `400` quoting rule 3 and citing F26.
   * "human" — permitted, and the daemon then does what the wire does not: `blindsPolicy:true` on
   *   the decision, sticky `WorkerSnapshot.policyBlinded`, and a `TurnWarning{code:"policy_blinded"}`
   *   on every subsequent turn of that worker.
   */
  allowAlways: z.enum(["never", "human"]).default("never"),
  /** Max simultaneously parked interactions per worker. Over it the newest is DENIED with
   *  `rule:"limit:max_parked"` and never dropped — an unanswered agent request hangs a turn forever. */
  maxParked: z.number().int().positive().default(8),
  /** D10, narrowed: we declare `elicitation.form` under `park`. We do NOT declare `url` — there is
   *  no browser here and `elicitation/complete` is unobserved. Flip only with a real url handler. */
  declareUrlElicitation: z.boolean().default(false),
});
export type ResolvedInteractionConfig = z.output<typeof InteractionConfig>;

export const DiffConfig = z.object({
  provider: z.enum(["none", "git"]).default("none"),
  /** "on_write" runs git only when the turn had a write-ish tool call or any `changes`. */
  mode: z.enum(["off", "on_write", "always"]).default("on_write"),
  timeoutMs: z.number().int().positive().default(15_000),
  maxBytes: z
    .number()
    .int()
    .positive()
    .default(4 * 1024 * 1024),
  /** Absolute path for the temp index files. MUST be outside every worktree (§25.2). */
  tmpDir: z.string().optional(),
});
export type ResolvedDiffConfig = z.output<typeof DiffConfig>;

export const WebhookConfig = z.object({
  enabled: z.boolean().default(false),
  /** D9: 0s / 30s / 2m / 10m / 30m / 2h. Six attempts, then `failed`. */
  backoffMs: z
    .array(z.number().int().nonnegative())
    .default([0, 30_000, 120_000, 600_000, 1_800_000, 7_200_000]),
  /** Full jitter fraction on every rung after the first (§24.3). Without it a restart makes
   *  hundreds of deliveries due in one tick, the receiver 429s the lot, and they all retry
   *  together 30 s later. */
  jitter: z.number().min(0).max(1).default(0.1),
  timeoutMs: z.number().int().positive().default(10_000),
  maxConcurrent: z.number().int().positive().default(4),
  retentionDays: z.number().int().nonnegative().default(30),
  /** name → secret. A client names one; the VALUE never crosses the wire in either direction. */
  secrets: z.record(z.string().min(1), z.string().min(32)).default({}),
  /**
   * FAIL CLOSED. This is the daemon's first OUTBOUND surface and the URL comes from a client:
   * "allowlist" with an empty `allow` makes a webhook run `403` until an operator names an
   * origin. `"any"` exists for a closed network and says so out loud.
   */
  mode: z.enum(["allowlist", "any"]).default("allowlist"),
  /** Exact scheme+host+port, no wildcards. */
  allow: z.array(z.string().url()).default([]),
  /**
   * CIDRs the RESOLVED address may never be in. Blocks DNS rebinding to cloud metadata.
   *
   * `0.0.0.0/8` is here because `0.0.0.0` is a standard localhost alias on Linux — a connect to
   * it reaches the loopback interface exactly as `127.0.0.1` does — and review finding V7 caught
   * it ALLOWED under a default that already refused every other spelling of "this machine".
   */
  denyCidrs: z
    .array(z.string())
    .default([
      "127.0.0.0/8",
      "0.0.0.0/8",
      "::1/128",
      "169.254.0.0/16",
      "fe80::/10",
      "10.0.0.0/8",
      "172.16.0.0/12",
      "192.168.0.0/16",
      "fc00::/7",
    ]),
  maxBodyBytes: z
    .number()
    .int()
    .positive()
    .default(64 * 1024),
});
export type ResolvedWebhookConfig = z.output<typeof WebhookConfig>;

export const RunConfig = z.object({
  maxConcurrent: z.number().int().positive().default(16),
  /** Hard ceiling on one run, independent of the watchdog. 0 = none. */
  maxDurationMs: z.number().int().nonnegative().default(3_600_000),
  retentionDays: z.number().int().nonnegative().default(30),
});
export type ResolvedRunConfig = z.output<typeof RunConfig>;

/**
 * DESIGN §5.1's list, plus the ones that are arbitrary code execution rather than a preference.
 *
 * ONE table, in ONE module — a second copy is how one of two callers quietly stops enforcing it
 * (`redactArgs`'s argument, §5.1). `envDeny` in config EXTENDS it; nothing shrinks it.
 */
export const ENV_DENY_EXACT: readonly string[] = [
  "HOME",
  "PATH",
  "USER",
  "USERNAME",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "PWD",
  "OLDPWD",
  "SYSTEMROOT",
  "COMSPEC",
  "WINDIR",
  "PATHEXT",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "NODE_OPTIONS",
  "BASH_ENV",
  "ENV",
  "IFS",
  "CLASSPATH",
  "JAVA_TOOL_OPTIONS",
  "RUBYOPT",
  "PERL5OPT",
];

export const ENV_DENY_PREFIX: readonly string[] = [
  "OMNI_",
  "LD_",
  "DYLD_",
  "GIT_",
  "NODE_",
  "npm_",
  "PYTHON",
];

export const DaemonConfig = z
  .strictObject({
    /** Else generated + persisted to dataDir. */
    daemonId: z.string().optional(),
    dataDir: z.string().default("~/.omni-acp"),
    /** null => no socket, in-process only (D15 constraint 1). */
    listen: ListenConfig.nullable().default(null),
    tokens: z.array(TokenConfig).min(1),
    /** M0: explicit list only. `"auto"` discovery is M1/M4. */
    agents: z.array(AgentDescriptor).default([]),
    maxWorkers: z.number().int().positive().default(64),
    eventLog: EventLogConfig.prefault({}),
    handshakeTimeoutMs: z.number().int().positive().default(60_000),
    supervisor: SupervisorConfig.prefault({}),
    turn: TurnConfig.prefault({}),
    hibernate: HibernateConfig.prefault({}),
    lease: LeaseConfig.prefault({}),
    probe: ProbeConfig.prefault({}),
    resume: ResumeReplayConfig.prefault({}),
    logLevel: z.enum(["silent", "error", "warn", "info", "debug"]).default("info"),
    // ── M2 (§5.8.7). Every block DEFAULTS, so an unmodified M1 config file still parses — that
    // is a Land exit criterion (M2-PLAN §1.5 item 2).
    policy: PolicyConfig.prefault({}),
    /** DESIGN §8: the ONLY place a stdio MCP command may appear. */
    mcpServers: z.record(z.string().max(64), McpServerPreset).default({}),
    watchdog: WatchdogConfig.prefault({}),
    interaction: InteractionConfig.prefault({}),
    diff: DiffConfig.prefault({}),
    webhooks: WebhookConfig.prefault({}),
    run: RunConfig.prefault({}),
    /** Extra keys the operator forbids in `CreateWorkerRequest.env`. Extends the hard list; can
     *  never shrink it. */
    envDeny: z.array(z.string().max(256)).default([]),
  })
  .superRefine((c, ctx) => {
    // A watchdog that closed FIRST would report a fake agent timeout for a turn that was settling,
    // so the ordering is a config LOAD error rather than a runtime surprise (§5.8.7, WP-W bullet 5).
    if (c.watchdog.cancelTimeoutMs <= c.turn.cancelGraceMs) {
      ctx.addIssue({
        code: "custom",
        path: ["watchdog", "cancelTimeoutMs"],
        message: "watchdog.cancelTimeoutMs must exceed turn.cancelGraceMs",
      });
    }
  });
export type DaemonConfig = z.input<typeof DaemonConfig>;
export type ResolvedDaemonConfig = z.output<typeof DaemonConfig>;

/** Plain sha256, lower-case hex. The one hashing function in the repository (DESIGN §8). */
export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/**
 * Constant-time comparison of `sha256(secret)` against a stored digest.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself be a timing signal, so the
 * lengths are compared first and a malformed stored digest is simply `false`. Both operands are
 * the ASCII bytes of the hex digests: decoding first would silently accept a truncated digest.
 */
export function verifySecret(secret: string, sha256Hex: string): boolean {
  const actual = Buffer.from(hashSecret(secret), "ascii");
  const expected = Buffer.from(sha256Hex.toLowerCase(), "ascii");
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/** Flags whose VALUE never belongs in a snapshot, a log line or an HTTP response. */
const SECRET_FLAG = /^--?[^=]*(token|secret|password|passwd|api[-_]?key|auth)[^=]*$/i;

/**
 * Agent argv with anything credential-shaped blanked. ONE rule, in ONE place (DESIGN §8).
 *
 * Config-supplied args are trusted input, but they are served over HTTP on two surfaces —
 * `ProcessInfo.argsRedacted` inside `WorkerSnapshot.process`, and `AgentCatalogEntry.args` from
 * `GET /v1/agents`, which any bearer token can read regardless of which agents it may USE. A
 * `--api-key sk-…` in a descriptor must not become an API response on either. It lives here,
 * beside `hashSecret`/`verifySecret`, because a second copy is how one of the two surfaces
 * quietly stops redacting.
 *
 * Both spellings are covered: `--flag=value` and `--flag value`.
 */
export function redactArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  let redactNext = false;
  for (const arg of args) {
    if (redactNext) {
      out.push("<redacted>");
      redactNext = false;
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq > 0 && SECRET_FLAG.test(arg.slice(0, eq))) {
      out.push(`${arg.slice(0, eq)}=<redacted>`);
      continue;
    }
    if (eq === -1 && SECRET_FLAG.test(arg)) {
      out.push(arg);
      redactNext = true;
      continue;
    }
    out.push(arg);
  }
  return out;
}
