import { z } from "zod";
import { PolicyCeiling, PolicyRule, POLICY_ACTIONS } from "./config.js";
import type { PlatformOwnership, RetentionReport } from "./contracts.js";
import type { OmniErrorBody } from "./errors.js";
import type { RunState, WorkerState } from "./events.js";
import type {
  DaemonId,
  DeliveryId,
  RunId,
  Seq,
  SessionId,
  TokenId,
  TurnId,
  WorkerId,
} from "./ids.js";
import type { ResumeReport } from "./resume.js";
import type { LoginState, ProbeSummary } from "./runtime.js";
import type { TurnResult } from "./turn.js";
import type { ConfigOptionView, InteractionSnapshot, WorkerSnapshot } from "./worker.js";

/**
 * ACP content blocks are NOT re-modelled (proxy-chains: preserve unknown fields).
 * Only `type` is validated; the array is forwarded verbatim.
 */
export const ContentBlockLoose = z.looseObject({ type: z.string() });

/** A preset name, a list of names, or an inline rule set (D4: 既可引用预设也可内联规则). */
export const PolicySelection = z.union([
  z.string().min(1).max(64),
  z.array(z.string().min(1).max(64)).max(8),
  z.strictObject({
    presets: z.array(z.string().min(1).max(64)).max(8).optional(),
    default: z.enum(POLICY_ACTIONS).optional(),
    rules: z.array(PolicyRule).max(200).optional(),
  }),
]);
export type PolicySelection = z.output<typeof PolicySelection>;

/**
 * Per-worker override of the daemon-wide `watchdog` block, field by field.
 *
 * Spelled out, NOT `WatchdogConfig.partial()` — the `ProbeOverrides` reason (§5.1), verbatim:
 * `.partial()` only makes the keys optional, the inner `.default()`s still fire, and `{}` would
 * silently beat the daemon-wide setting on every field the caller never wrote.
 */
export const WatchdogOverride = z.strictObject({
  silentMs: z.number().int().nonnegative().max(86_400_000).optional(),
  toolMs: z.number().int().nonnegative().max(86_400_000).optional(),
  cancelTimeoutMs: z.number().int().positive().max(600_000).optional(),
  enabled: z.boolean().optional(),
});
export type WatchdogOverride = z.output<typeof WatchdogOverride>;

export const CreateWorkerRequest = z.strictObject({
  agent: z.string().min(1),
  cwd: z.string().min(1),
  label: z.string().max(200).optional(),
  /**
   * PRESET NAMES ONLY, resolved against `DaemonConfig.mcpServers`. A client can never put a
   * `command` on this wire — DESIGN §8's 🔴 row is enforced by the TYPE, not by a validator
   * somebody could move. An unknown name is `400` **naming it**; a name outside the token's `mcp`
   * allowlist is `403`. Never a silent drop, which would let a client believe a tool was
   * available (M2-B-WP-S).
   */
  mcp: z.array(z.string().min(1).max(64)).max(8).optional(),
  /** D4. `"park"` is ALSO the D10 switch: the only value under which this worker declares
   *  `clientCapabilities.elicitation` (F28). Default `"deny"` — M1's behaviour, and the only
   *  fail-closed default. */
  onUnresolved: z.enum(["park", "deny", "fail"]).default("deny"),
  /** 0 ⇒ a park never expires (a human is genuinely expected). Default `interaction.parkTimeoutMs`. */
  parkTimeoutMs: z.number().int().nonnegative().max(86_400_000).optional(),
  /** `"allow"` is deliberately NOT a value: an auto-allow on a timer is a remote-execution
   *  primitive whose only guard is a clock (ruling M2-R7). Default `"deny"`. */
  parkTimeoutAction: z.enum(["deny", "fail"]).optional(),
  /** M2-B. A preset name, a list of them, or an inline document. Merged preset ⊕ inline, then
   *  checked against the token's `policyCeiling`; exceeding it is `403 policy_exceeds_ceiling`. */
  policy: PolicySelection.optional(),
  /** M2-B. Blacklisted keys are REJECTED with a 400 naming them, never silently dropped (§23.3). */
  env: z.record(z.string().min(1).max(256), z.string().max(8_192)).optional(),
  /** M2-A. Per-worker override of the daemon-wide `watchdog` block, field by field. */
  watchdog: WatchdogOverride.optional(),
  /** M2-B. Per-worker `diff.mode`. */
  patch: z.enum(["off", "on_write", "always"]).optional(),
  /** Handshake budget in ms. Default 60_000. */
  timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
  /** Per-worker override of `hibernate.idleMs`. 0 disables hibernation for this worker. */
  idleTimeoutMs: z.number().int().nonnegative().max(86_400_000).optional(),
  /** "take" (default) ⇒ the creator holds the lease; "observe" ⇒ created lease-free (D5). */
  lease: z.enum(["take", "observe"]).optional(),
  // ── M3-WP1 ────────────────────────────────────────────────────────────────
  /**
   * WHICH stored credential this worker runs on, by NAME — never by value.
   *
   * Omitted ⇒ this token's `default` for this agent, and `"inherit"` when it has none (M2's
   * behaviour exactly, gated by `credentials.allowInherit`). `"none"` ⇒ an EMPTY home, which is
   * how an operator proves a worker is unauthenticated rather than quietly borrowing the
   * daemon's own login. `"inherit"` is the explicit spelling of the fallback.
   *
   * A name this token does not own is `403 credential_forbidden` and never a 404: the answer must
   * not say whether somebody else's credential exists.
   */
  credential: z
    .string()
    .min(1)
    .max(64)
    .regex(/^(?:[A-Za-z0-9][A-Za-z0-9._-]*)$/, "a credential name is [A-Za-z0-9._-], not a path")
    .optional(),
  /**
   * `"isolated"` (the default) ⇒ `<dataDir>/homes/<workerId>`, with the credential files LINKED to
   * the store's canonical copy. `"shared"` ⇒ no per-worker home at all and the daemon's own
   * environment, which is M2.
   *
   * Isolation is the default because E3 is unavoidable: the agent REFRESHES its token, so two
   * workers sharing one home race on the same file, and two workers with independent COPIES
   * diverge from the source. A link per home is what makes a refresh land back on the one
   * canonical file every worker reads.
   */
  home: z.enum(["isolated", "shared"]).optional(),
});
/**
 * The INPUT shape — what a caller WRITES — deliberately, and this is the one place in the file
 * where `z.input` beats `z.infer`.
 *
 * `onUnresolved` gained a `.default("deny")` in M2, which makes the OUTPUT type's field
 * REQUIRED. `WorkerRegistry.create` is D15's in-process entry point and is called directly by
 * `client/src/server.ts`, by `OmniACP.local()` and by a dozen tests, none of which should have to
 * spell a field whose whole point is that it defaults. The parsed body is still assignable to
 * this type (every output field is a subtype of its optional input), so the HTTP route is
 * unchanged and the wire default still fires where it matters — at `parse`.
 */
export type CreateWorkerRequest = z.input<typeof CreateWorkerRequest>;

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
 * H28. M0's text-only `.refine` is **DELETED, not widened**, and that is the dangerous half of
 * this diff: zod holds no worker, so it can enforce neither this agent's `promptCapabilities` nor
 * this token's `cwdRoots`, and DESIGN §5.1 requires BOTH.
 *
 * The semantic gate moves into **`Worker.prompt()`** as the injected `deps.validateContent` →
 * `@omni-acp/core`'s `assertPromptContent` (§26.2), which the daemon's worker-creation path MUST
 * bind to the token's `cwdRoots` and the worker's `promptCapabilities`. Absent an injection the
 * fallback is `worker.ts`'s deliberately differently-spelled `assertTextOnlyContent` (review R2)
 * — M0's text-only whitelist verbatim — so the behaviour is unchanged at the Land step and the
 * 400 still comes back, from the worker instead of from the schema. The
 * `assert-prompt-content-is-called` guard is STRUCTURAL: it asserts the INJECTION, not a name,
 * because a schema that silently stopped enforcing containment looks exactly like a schema that
 * got more capable.
 *
 * The blocks themselves are still NOT re-modelled: only `type` is inspected, and the array is
 * forwarded verbatim.
 */
export const PromptRequestBody = z.strictObject({
  content: z.array(ContentBlockLoose).min(1).max(64),
});
export type PromptRequestBody = z.infer<typeof PromptRequestBody>;

// ── M2 request/response shapes (§5.8.6) ──────────────────────────────────────

/**
 * H22. `allow` without an `optionId` lets D4 rule 2's ordering choose; WITH one, it must have
 * been offered (rule 1) or the answer is `400`.
 */
export const InteractionAnswerBody = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("allow"),
    optionId: z.string().min(1).max(200).optional(),
    note: z.string().max(500).optional(),
  }),
  z.strictObject({ action: z.literal("deny"), note: z.string().max(500).optional() }),
  /** elicitation. Keyed by QUESTION id — ONE value per question; the daemon decides which wire
   *  property carries it (F30, §19.4). */
  z.strictObject({
    action: z.literal("answer"),
    content: z.record(
      z.string().min(1).max(200),
      z.union([
        z.string().max(16_384),
        z.number(),
        z.boolean(),
        z.array(z.string().max(4_096)).max(64),
      ]),
    ),
    note: z.string().max(500).optional(),
  }),
  /** UNVERIFIED: no `action:"cancel"` was ever observed on either agent. Descriptor-gated. */
  z.strictObject({ action: z.literal("cancel") }),
]);
export type InteractionAnswerBody = z.output<typeof InteractionAnswerBody>;

export interface InteractionAnswerResult {
  readonly interaction: InteractionSnapshot;
  /** The worker state AFTER the answer landed — `running` when the turn resumed. */
  readonly state: WorkerState;
  /** Seq of the `acp.interaction{settled}` this call produced, so a non-streaming client can poll
   *  `?since=seq-1` and watch its own answer land. */
  readonly seq: Seq;
}

export interface InteractionListResponse {
  readonly interactions: readonly InteractionSnapshot[];
}

/**
 * H24. One option per call, mirroring `session/set_config_option`.
 *
 * `configId` is the REQUEST spelling (F34); the descriptor's `configIdField` quirk decides
 * what actually reaches the wire, so this body names the canonical word and
 * `Normalizer.mapRequest` does the translation (§17.3, corpus: `optionId` is `-32602` on
 * claude-acp).
 */
export const SetConfigBody = z.strictObject({
  configId: z.string().min(1).max(200),
  value: z.union([z.string().max(4_096), z.number(), z.boolean()]),
});
export type SetConfigBody = z.output<typeof SetConfigBody>;

export interface SetConfigResponse {
  /** The FULL replacement list, from the method's own result (F34, F35). */
  readonly configOptions: readonly ConfigOptionView[];
  /** Present when the returned membership differs from what we held — F34's shrink is real, not
   *  a bug. */
  readonly removed: readonly string[];
  readonly added: readonly string[];
  /** true ⇒ the method returned NO list; the previous one is KEPT and never merged with a guess. */
  readonly stale: boolean;
}

export const WEBHOOK_EVENTS = [
  "run.completed",
  "run.failed",
  "run.requires_action",
  "worker.requires_action",
  "worker.closed",
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/** H25 (D9, DESIGN §9.3). */
export const WebhookTarget = z.strictObject({
  url: z.string().url().max(2_048),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).optional(),
  /** Names a secret in `DaemonConfig.webhooks.secrets`. A client never sends a secret VALUE. */
  secret: z.string().min(1).max(64).optional(),
});
export type WebhookTarget = z.output<typeof WebhookTarget>;

export const CreateRunRequest = z.strictObject({
  agent: z.string().min(1),
  cwd: z.string().min(1),
  prompt: z.array(ContentBlockLoose).min(1).max(64),
  label: z.string().max(200).optional(),
  mcp: z.array(z.string().min(1).max(64)).max(8).optional(),
  policy: PolicySelection.optional(),
  env: z.record(z.string().min(1), z.string()).optional(),
  onUnresolved: z.enum(["park", "deny", "fail"]).optional(),
  parkTimeoutMs: z.number().int().nonnegative().max(86_400_000).optional(),
  parkTimeoutAction: z.enum(["deny", "fail"]).optional(),
  watchdog: WatchdogOverride.optional(),
  patch: z.enum(["off", "on_write", "always"]).optional(),
  /** false (default) ⇒ the worker is closed when the run settles (DESIGN §9.3). */
  keepWorker: z.boolean().optional(),
  webhook: WebhookTarget.optional(),
  /** Idempotency, scoped to the token. A repeat returns the ORIGINAL run, never a second one. */
  idempotencyKey: z.string().min(8).max(200).optional(),
  timeoutMs: z.number().int().min(1_000).max(86_400_000).optional(),
});
export type CreateRunRequest = z.output<typeof CreateRunRequest>;

export interface RunSnapshot {
  readonly runId: RunId;
  readonly daemonId: DaemonId;
  readonly state: RunState;
  readonly agentId: string;
  readonly cwd: string;
  readonly workerId: WorkerId | null;
  readonly turnId: TurnId | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly result: TurnResult | null;
  readonly error: OmniErrorBody | null;
  /** Mirrors `WorkerSnapshot.persistence`. `"memory"` ⇒ this run does NOT survive a restart, and
   *  we say so rather than letting `GET /v1/runs/{rid}` 404 mysteriously later (ruling M2-R14). */
  readonly persistence: "memory" | "durable" | "degraded";
  readonly webhook: { readonly url: string; readonly deliveries: number } | null;
}

export interface DeliveryRecord {
  readonly deliveryId: DeliveryId;
  readonly runId: RunId;
  readonly event: WebhookEvent;
  readonly state: "pending" | "delivering" | "delivered" | "failed";
  readonly attempt: number;
  readonly nextAttemptAt: string | null;
  readonly lastStatus: number | null;
  readonly lastError: string | null;
  readonly responseMs: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RunListResponse {
  readonly runs: readonly RunSnapshot[];
  readonly cursor: string | null;
}

export interface DeliveryListResponse {
  readonly deliveries: readonly DeliveryRecord[];
  readonly cursor: string | null;
}

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
  /**
   * M2-B. The ceiling this token may not exceed, or `null` for an unbounded token. The field
   * never appeared or disappeared — only its TYPE widened, which is the one compile break in M2
   * (§11.9).
   */
  readonly policyCeiling: PolicyCeiling | null;
  readonly policyPresets: readonly string[] | "*";
  /** FAIL CLOSED: `[]` by default, not `"*"` — an MCP server is arbitrary code on this machine. */
  readonly mcpPresets: readonly string[] | "*";
  /** true ⇒ this token may create runs with a webhook (an operator-allowlisted origin exists). */
  readonly webhooks: boolean;
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
  /**
   * M3-WP1. Whether THIS TOKEN can log this agent in right now, computed per request.
   *
   * Per token and not per agent, which is why it is on the catalog ENTRY rather than inside
   * `probed`: the probe is a shared, cached fact about the binary, and "am I logged in" is a fact
   * about the caller's credential. Absent/null ⇒ this daemon has no credential layer wired.
   */
  readonly login?: LoginState | null;
}

export interface WorkerListResponse {
  readonly workers: readonly WorkerSnapshot[];
}

export interface AgentListResponse {
  readonly agents: readonly AgentCatalogEntry[];
}

// ── M3-WP1: the credential store (docs/M3-WP1-CREDENTIALS.md §凭据仓库) ───────

/**
 * The three shapes a credential can arrive in, and they are a DISCRIMINATED UNION so that the
 * daemon never has to guess which one it got.
 *
 * `files` is the shape both real agents actually use (E1/E2): a map of FILE NAME → content, and
 * the names are validated against the descriptor's own `credentials.files` list so a client
 * cannot write `../../id_rsa` into the store. `token` and `apiKey` land as the env var the
 * descriptor declares (`CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` / `CODEX_API_KEY`).
 *
 * SECRETS ONLY GO UP. There is no response shape in this file that carries one, and
 * `CredentialSummary` is what every read returns.
 */
export const CredentialInput = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("files"),
    /**
     * FILE NAME → content. A name with a separator, a `..`, a NUL or a leading dot-dot is refused
     * at parse: the store joins these onto a directory it owns, and a path that escapes it is the
     * one bug in a credential store that matters.
     */
    files: z.record(
      z
        .string()
        .min(1)
        .max(128)
        .regex(/^\.?[A-Za-z0-9][A-Za-z0-9._-]*$/, "a credential file name is a bare file name"),
      z
        .string()
        .min(1)
        .max(256 * 1024),
    ),
  }),
  z.strictObject({
    kind: z.literal("token"),
    token: z
      .string()
      .min(1)
      .max(16 * 1024),
  }),
  z.strictObject({
    kind: z.literal("apiKey"),
    apiKey: z
      .string()
      .min(1)
      .max(16 * 1024),
  }),
]);
export type CredentialInput = z.output<typeof CredentialInput>;

/**
 * What a READ of a credential returns. Every field is metadata.
 *
 * `fingerprint` is the first 12 hex characters of a sha256 over the canonical content — enough to
 * tell two credentials apart and useless for authenticating anything, which is the whole design
 * (§凭据仓库: secret 只上行).
 */
export interface CredentialSummary {
  readonly agentId: string;
  readonly name: string;
  readonly ownerTokenId: TokenId;
  readonly method: "files" | "token" | "apiKey";
  readonly fingerprint: string;
  /** File names present in the store, sorted. `[]` for the token / apiKey shapes. */
  readonly files: readonly string[];
  /** The env var a token / apiKey credential lands as, or null for the files shape. */
  readonly env: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Read out of the credential's own body where it carries one (claude's `expiresAt`). */
  readonly expiresAt: string | null;
  /** LIVE workers currently linked to this credential. A `DELETE` with `inUseBy > 0` is a 409. */
  readonly inUseBy: number;
}

export interface CredentialListResponse {
  readonly credentials: readonly CredentialSummary[];
}

/**
 * `PUT` on a name that already exists is an IN-PLACE update, and these two fields are why the
 * route returns more than a summary.
 *
 * A store write re-points nothing by itself: every live worker's home already LINKS to the file
 * that just changed, so a `reload:"file"` agent picks the new credential up on its next request
 * and a `reload:"restart"` one does not. `restartRequired` names the workers in the second group,
 * so an operator who swapped an expired token knows exactly which processes are still using it.
 */
export interface CredentialPutResult extends CredentialSummary {
  /** Live workers whose home links to this credential. */
  readonly workersAffected: number;
  /** Of those, the ones whose runtime is `reload:"restart"` — they need `POST …/restart`. */
  readonly restartRequired: readonly WorkerId[];
}

export const CredentialCheckBody = z.strictObject({
  /** true ⇒ spawn one throwaway process and send a minimal prompt. Costs tokens; opt-in. */
  deep: z.boolean().optional(),
  timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
});
export type CredentialCheckBody = z.output<typeof CredentialCheckBody>;

/** `PUT /v1/workers/{wid}/credential`. */
export const SetCredentialBody = z.strictObject({
  /** A stored name, or the two sentinels. NEVER a value: a secret does not travel per worker. */
  credential: z
    .string()
    .min(1)
    .max(64)
    .regex(/^(?:[A-Za-z0-9][A-Za-z0-9._-]*)$/, "a credential name is [A-Za-z0-9._-], not a path"),
  /**
   * `"auto"` (default) — re-point the link, then do whatever the descriptor's `reload` says:
   * `"file"` ⇒ nothing more (`applied: "immediate"`), `"restart"` ⇒ restart NOW when idle and
   * after this turn otherwise (`applied: "restarted"` / `"on-next-start"`).
   * `"restart"` — force it. `409 worker_busy` while a turn is live unless the caller restarts
   * with `force` itself.
   * `"defer"` — re-point and stop (`applied: "deferred"`), for an operator rotating credentials
   * across a fleet who will restart on their own schedule.
   */
  apply: z.enum(["auto", "restart", "defer"]).optional(),
});
export type SetCredentialBody = z.output<typeof SetCredentialBody>;

export interface CredentialApplied {
  readonly credential: {
    readonly name: string | null;
    readonly method: "files" | "token" | "apiKey" | "inherit" | "none";
    readonly fingerprint: string | null;
  };
  readonly applied: "immediate" | "restarted" | "on-next-start" | "deferred";
  readonly generation: number;
  /** The fingerprint this replaced, or null when the worker had none. */
  readonly previous: string | null;
}

/** `POST /v1/workers/{wid}/restart`. */
export const RestartRequestBody = z.strictObject({
  /** Recorded verbatim in the `omni.worker_state{reason:"restart"}` envelope's audit line. */
  reason: z.string().max(500).optional(),
  /** Required to interrupt a LIVE turn; without it a `running` worker is `409 worker_busy`. */
  force: z.boolean().optional(),
  /** Default true. The new process resumes the SAME session, so the conversation survives. */
  resume: z.boolean().optional(),
  /** Explicitly abandon the session and open a new one. Required when the agent cannot resume. */
  fresh: z.boolean().optional(),
  /** Swap the credential as part of the restart — one operation, one process replacement. */
  credential: z
    .string()
    .min(1)
    .max(64)
    .regex(/^(?:[A-Za-z0-9][A-Za-z0-9._-]*)$/, "a credential name is [A-Za-z0-9._-], not a path")
    .optional(),
  timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
});
export type RestartRequestBody = z.output<typeof RestartRequestBody>;

export interface RestartResult {
  /** `generation` AFTER the restart: always the previous value + 1 (§15.1's counter). */
  readonly generation: number;
  readonly pid: number | null;
  /** The four-state verdict, or `{outcome:"fresh"}` when `fresh:true` opened a new session. */
  readonly resume: ResumeReport | { readonly outcome: "fresh" };
  readonly sessionId: SessionId | null;
  /** The turn `force:true` interrupted, or null. Its `TurnResult.error.code` is `"restarted"`. */
  readonly terminatedTurn: TurnId | null;
  readonly elapsedMs: number;
}

export const HEADER = {
  auth: "authorization",
  clientId: "omni-client-id",
  lastEventId: "last-event-id",
  /** Optional fencing token. Present and stale ⇒ 423 (§16.1 rule L7). */
  leaseEpoch: "omni-lease-epoch",
} as const;

/**
 * Outbound only. Never parsed by the daemon; listed here so exactly ONE file spells them (D9).
 */
export const WEBHOOK_HEADER = {
  signature: "omni-signature",
  deliveryId: "omni-delivery-id",
  event: "omni-event",
  attempt: "omni-attempt",
} as const;

/** SSE control frames that are NOT envelopes and consume no seq (CONTRACTS.md §8.4). */
export const SSE_CONTROL = {
  truncated: "omni.stream_truncated",
  overflow: "omni.stream_overflow",
  end: "omni.stream_end",
} as const;
