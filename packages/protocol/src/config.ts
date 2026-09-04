import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";

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
  })
  .refine((t) => (t.secret == null) !== (t.secretSha256 == null), {
    message: "exactly one of secret / secretSha256",
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
  prefer: z
    .object({
      resume: z.array(z.enum(["session/load", "session/resume"])).optional(),
      setConfig: z.array(z.string()).optional(),
      list: z.array(z.string()).optional(),
      close: z.array(z.string()).optional(),
    })
    .optional(),
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

export const DaemonConfig = z.strictObject({
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
