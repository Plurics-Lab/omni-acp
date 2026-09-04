import { z } from "zod";
import type { PlatformOwnership, RetentionReport } from "./contracts.js";
import type { Seq, TokenId, TurnId, DaemonId } from "./ids.js";
import type { ProbeSummary } from "./runtime.js";
import type { WorkerSnapshot } from "./worker.js";

/**
 * ACP content blocks are NOT re-modelled (proxy-chains: preserve unknown fields).
 * Only `type` is validated; the array is forwarded verbatim.
 */
export const ContentBlockLoose = z.looseObject({ type: z.string() });

export const CreateWorkerRequest = z.strictObject({
  agent: z.string().min(1),
  cwd: z.string().min(1),
  label: z.string().max(200).optional(),
  /** M0: must be absent or []. Anything else -> bad_request (DESIGN §8). */
  mcp: z.array(z.string()).max(0).optional(),
  /** M0: must be absent or "deny". park/fail need the policy engine (M2). */
  onUnresolved: z.literal("deny").optional(),
  /** Handshake budget in ms. Default 60_000. */
  timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
  /** Per-worker override of `hibernate.idleMs`. 0 disables hibernation for this worker. */
  idleTimeoutMs: z.number().int().nonnegative().max(86_400_000).optional(),
  /** "take" (default) ⇒ the creator holds the lease; "observe" ⇒ created lease-free (D5). */
  lease: z.enum(["take", "observe"]).optional(),
  // M2, still rejected by strictObject: policy, env
});
export type CreateWorkerRequest = z.infer<typeof CreateWorkerRequest>;

export const LeaseRequestBody = z.strictObject({
  ttlMs: z.number().int().nonnegative().max(86_400_000).optional(),
  /** `steal` only; recorded VERBATIM in the `omni.lease` audit envelope (D5: 带审计). */
  reason: z.string().max(500).optional(),
});
export type LeaseRequestBody = z.infer<typeof LeaseRequestBody>;

export const WakeRequestBody = z.strictObject({
  timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
});
export type WakeRequestBody = z.infer<typeof WakeRequestBody>;

export const ProbeRequestBody = z.strictObject({
  force: z.boolean().optional(),
  deep: z.boolean().optional(),
  timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
});
export type ProbeRequestBody = z.infer<typeof ProbeRequestBody>;

export interface ProbeResponse {
  readonly probe: ProbeSummary;
  /** true ⇒ served from `<dataDir>/probes/<id>.json` without spawning anything. */
  readonly cached: boolean;
}

/**
 * M0 accepts ONLY `type: "text"` blocks (CONTRACTS.md §2.3, review R12).
 *
 * DESIGN §5.1 requires that `resource_link` and embedded-resource paths be absolute and
 * realpath into the token's `cwdRoots`; that containment check is M2. Under D3 the agent reads
 * and writes the disk itself, so forwarding an unvalidated absolute path is exactly the
 * cwd-containment escape D18 calls arbitrary code execution. M0 therefore closes the hole with a
 * whitelist rather than shipping an unchecked path surface — and text is all the M0 fixture
 * needs. The zod failure is what produces H8's `400 bad_request`.
 *
 * The blocks themselves are still NOT re-modelled: only `type` is inspected, and the array is
 * forwarded verbatim, so M1 relaxing this to the full `ContentBlock` union is additive.
 */
export const PromptRequestBody = z.strictObject({
  content: z
    .array(ContentBlockLoose)
    .min(1)
    .refine((blocks) => blocks.every((b) => b.type === "text"), {
      message: 'M0 accepts only content blocks with type "text" (resource paths are M2)',
    }),
});
export type PromptRequestBody = z.infer<typeof PromptRequestBody>;

export interface PromptAccepted {
  readonly turnId: TurnId;
  /**
   * seq of this turn's `state_update{running}`. A client that subscribes with
   * `since = seq - 1` is GUARANTEED to see the whole turn. This is what removes the
   * subscribe/prompt race without requiring a pre-existing subscription.
   */
  readonly seq: Seq;
}

export interface WhoAmIResponse {
  readonly tokenId: TokenId;
  readonly role: "user" | "admin";
  readonly daemonId: DaemonId;
  readonly agents: readonly string[] | "*";
  readonly cwdRoots: readonly string[];
  readonly maxWorkers: number;
  /** M2; present-and-null so the field never appears/disappears. */
  readonly policyCeiling: null;
}

export interface HealthResponse {
  readonly ok: true;
}

export interface DaemonInfo {
  readonly daemonId: DaemonId;
  readonly version: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly nodeVersion: string;
  /** M0: [1]. */
  readonly protocolVersions: readonly (1 | 2)[];
  readonly startedAt: string;
  /** CONTRACTS.md §6 — the honesty field. */
  readonly ownership: PlatformOwnership;
  /** The version of the canonical payload this daemon WRITES. M1: 2 (ruling M1-R10). */
  readonly canonicalPayloadVersion: 2;
  /**
   * §14.9 / H21. `driver` says whether this daemon's logs survive a restart, `writeFailures`
   * says whether they still do. An operator must be able to read these BEFORE anything goes
   * wrong (§6.6's rule, extended).
   */
  readonly persistence: {
    readonly driver: "memory" | "sqlite";
    readonly file: string | null;
    readonly schemaVersion: number;
    readonly sizeBytes: number;
    readonly writeFailures: number;
    readonly retentionDays: number;
    readonly lastSweep: RetentionReport | null;
  };
  /** This daemon INSTANCE's id (not the stable `daemonId`). Distinguishes boots (§15.7). */
  readonly bootId: string;
  /** What a previous boot left behind — including `skipped: n` on Windows, where nothing can be reaped. */
  readonly orphansAtStart: {
    readonly found: number;
    readonly reaped: number;
    readonly skipped: number;
  };
}

export interface AgentCatalogEntry {
  readonly id: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly source: "config";
  /** The cached probe, or null if never probed — NEVER fabricated (H4). */
  readonly probed: ProbeSummary | null;
  /** The descriptor that WILL govern a worker created now: `"<agentId>@<fingerprint12>"`. */
  readonly runtimeId: string;
}

export interface WorkerListResponse {
  readonly workers: readonly WorkerSnapshot[];
}

export interface AgentListResponse {
  readonly agents: readonly AgentCatalogEntry[];
}

export const HEADER = {
  auth: "authorization",
  clientId: "omni-client-id",
  lastEventId: "last-event-id",
  /** Optional fencing token. Present and stale ⇒ 423 (§16.1 rule L7). */
  leaseEpoch: "omni-lease-epoch",
} as const;

/** SSE control frames that are NOT envelopes and consume no seq (CONTRACTS.md §8.4). */
export const SSE_CONTROL = {
  truncated: "omni.stream_truncated",
  overflow: "omni.stream_overflow",
  end: "omni.stream_end",
} as const;
