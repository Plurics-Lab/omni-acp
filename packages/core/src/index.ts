/**
 * @omni-acp/core — process supervision, the event log, the normalizer and the worker kernel.
 *
 * FROZEN by the scaffold (M0-PLAN.md §1.2): re-export only. The contract types come back out of
 * here by name so a consumer needs one import, not two (CONTRACTS.md §5.3).
 */

// ── the shared contracts this package implements ────────────────────────────
export type {
  AgentProcess,
  Clock,
  ClientRef,
  CloseOutAction,
  ErrorClass,
  EventListener,
  EventLog,
  EventLogCoreOptions,
  EventStore,
  EventStoreDiagnostics,
  HibernateTimer,
  IdGen,
  KillOutcome,
  Lease,
  LeaseOptions,
  Logger,
  MappedPermissionRequest,
  MappedUpdate,
  Normalizer,
  OutboundCall,
  PermissionDecision,
  PermissionResponder,
  PersistedEventLogOptions,
  PersistenceHandle,
  PlatformOps,
  PlatformOwnership,
  ProcessExit,
  RetentionInput,
  RetentionPlan,
  RetentionReport,
  RunUtility,
  SessionOpenOptions,
  SessionOpenResult,
  SessionReopenOptions,
  SessionStrategy,
  SettleReason,
  SpawnSpec,
  StderrTail,
  Subscription,
  Supervisor,
  TerminationRung,
  TimerHandle,
  TurnInput,
  TurnOutput,
  WorkerHandle,
  WorkerRow,
  WorkerStore,
} from "@omni-acp/protocol";

// ── process layer (WP-2) ────────────────────────────────────────────────────
export { createPlatformOps } from "./process/platform.js";
export { runUtility } from "./process/spawn.js";
export { createSupervisor, type SupervisorOptions } from "./process/supervisor.js";

// ── event log (WP-3; M1-WP-A extends) ───────────────────────────────────────
export { createMemoryEventLog, type MemoryEventLogOptions } from "./event-log/memory-log.js";
export { createEventLogCore } from "./event-log/log-core.js";
export { createPersistedEventLog } from "./event-log/sqlite-log.js";
export { planRetention, runRetention } from "./event-log/retention.js";

// ── persistence (M1-WP-A) ───────────────────────────────────────────────────
export { openPersistence, type OpenPersistenceOptions } from "./persist/open.js";
export { acquireDataDirLock } from "./persist/lock.js";
export { SCHEMA_VERSION } from "./persist/schema.js";

// ── normalizer (WP-3; M1-WP-B extends) ──────────────────────────────────────
export { createNormalizer, type NormalizerOptions } from "./normalizer/normalizer.js";

// ── runtime descriptors (M1-WP-E) ───────────────────────────────────────────
export { BUILTIN_RUNTIMES, DEFAULT_V1_PROFILE } from "./runtime/known.js";
export { descriptorFingerprint } from "./runtime/descriptor.js";
export { resolveDescriptor } from "./runtime/merge.js";
export { classifyProbe } from "./runtime/classify.js";
export { probeAgent, type ProbeOptions } from "./runtime/probe.js";

// ── ACP link and worker kernel (WP-4) ───────────────────────────────────────
export { openAcpLink, type AcpLink, type AcpLinkHandlers } from "./acp/link.js";
export { createBaselineResponder } from "./worker/permission-responder.js";
export { createWorker, type CreateWorkerDeps } from "./worker/worker.js";

// ── hibernate / wake / resume (M1-WP-C) ─────────────────────────────────────
export { createSessionStrategy } from "./worker/session-open.js";
export { classifyResume } from "./worker/resume-classify.js";
export { createHibernateTimer } from "./worker/hibernate.js";
export { createRehydratedWorker, type RehydrateDeps } from "./worker/rehydrated.js";
export { fingerprintOf } from "./process/fingerprint.js";

// ── lease (M1-WP-D) ─────────────────────────────────────────────────────────
export { alwaysGrantedLease } from "./lease/always-granted.js";
export { createLease } from "./lease/lease.js";

// ── the M2 contracts this package implements (§5.8.8) ───────────────────────
export type {
  DiffProvider,
  EnvResolution,
  InteractionAnswer,
  InteractionContext,
  InteractionDeps,
  InteractionOutcome,
  InteractionRequest,
  InteractionResolution,
  InteractionStrategy,
  MappedElicitationRequest,
  McpResolution,
  OptionChoice,
  PatchHandle,
  PatchResult,
  PolicyEngine,
  PolicySubject,
  PolicyVerdict,
  Resolver,
  RunRegistry,
  RunRow,
  RunStore,
  DeliveryStore,
  Watchdog,
  WatchdogDeps,
  WatchdogSignal,
  WatchdogState,
  WatchdogVerdict,
  WebhookDispatcher,
  WebhookPayload,
} from "@omni-acp/protocol";

// ── interactions: park / deny / fail, elicitation (M2-A-WP-I) ───────────────
export { createInteractionStrategy } from "./worker/interaction/strategy.js";
export { baselineInteractions } from "./worker/interaction/baseline.js";
export { createParkTimer } from "./worker/interaction/park.js";
export { clientCapabilitiesFor } from "./worker/interaction/capability.js";
export {
  createPendingInteractions,
  type PendingInteractions,
} from "./worker/interaction/registry.js";
export { buildElicitationContent, mapElicitation } from "./normalizer/map/elicitation.js";

// ── idle watchdog, dual budget (M2-A-WP-W) ─────────────────────────────────
export { initialWatchdogState, watchdogStep } from "./worker/watchdog-state.js";
export { createWatchdog } from "./worker/watchdog.js";

// ── session/set_config_option (M2-A-WP-C) ──────────────────────────────────
export { configOptionsDelta, viewConfigOptions } from "./worker/config-options.js";

// ── policy rule engine (M2-B-WP-P) ─────────────────────────────────────────
export { createPolicyEngine } from "./policy/engine.js";
export { matchRule } from "./policy/match.js";
export { compileGlob, globHead } from "./policy/glob.js";
export { toPolicySubject } from "./policy/subject.js";
export { assertWithinCeiling, clampVerdict } from "./policy/ceiling.js";
export { BUILTIN_POLICIES, resolvePolicySelection } from "./policy/presets.js";

// ── mcp presets, per-worker env, prompt containment (M2-B-WP-S) ────────────
export { resolveMcpPresets } from "./mcp/presets.js";
export { filterMcpCapabilities } from "./mcp/capabilities.js";
export { resolveWorkerEnv } from "./worker/env.js";
export { assertPromptContent } from "./worker/prompt-content.js";

// ── runs, webhooks, persistence v2 (M2-B-WP-R) ─────────────────────────────
export { createRunRegistry, type RunRegistryDeps } from "./run/registry.js";
export { recoverRuns } from "./run/recovery.js";
export {
  createWebhookDispatcher,
  recoverDeliveries,
  type WebhookDispatcherDeps,
} from "./webhook/dispatcher.js";
export { planNextAttempt } from "./webhook/ladder.js";
export { signDelivery } from "./webhook/sign.js";
export { assertWebhookUrl } from "./webhook/guard.js";
export { createRunStore } from "./persist/run-store.js";
export { createDeliveryStore } from "./persist/delivery-store.js";

// ── git diff provider (M2-WP-J, D8) ────────────────────────────────────────
export { createGitDiffProvider } from "./diff/git-provider.js";
export { withTempIndex } from "./diff/temp-index.js";
export { classifyWorktree } from "./diff/worktrees.js";
