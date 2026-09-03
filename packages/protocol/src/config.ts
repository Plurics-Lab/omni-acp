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

export const AgentDescriptor = z.object({
  id: z.string().min(1),
  /** Absolute path or PATH-resolvable name. NEVER a shell string. See CONTRACTS.md §6.3. */
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  /** Trusted, config-supplied. Per-request env is M2 (D19). */
  env: z.record(z.string(), z.string()).default({}),
  protocolVersion: z.literal(1).default(1),
  shutdown: z
    .object({
      signal: z.string().default("SIGTERM"),
      graceMs: z.number().int().min(0).default(5_000),
    })
    .prefault({}),
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
});

export type ResolvedTurnConfig = z.output<typeof TurnConfig>;
export type ResolvedListenConfig = z.output<typeof ListenConfig>;

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
  eventLog: z
    .object({
      /** M0: "memory" only. "sqlite" parses but is rejected at runtime (M1). */
      driver: z.enum(["memory", "sqlite"]).default("memory"),
      maxEventsPerWorker: z.number().int().positive().default(10_000),
      subscriberQueueSize: z.number().int().positive().default(1_024),
      sseHeartbeatMs: z.number().int().positive().default(15_000),
    })
    .prefault({}),
  handshakeTimeoutMs: z.number().int().positive().default(60_000),
  supervisor: SupervisorConfig.prefault({}),
  turn: TurnConfig.prefault({}),
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
