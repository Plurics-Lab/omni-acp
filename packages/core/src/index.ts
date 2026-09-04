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
