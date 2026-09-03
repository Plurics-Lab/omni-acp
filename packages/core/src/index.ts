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
  EventListener,
  EventLog,
  IdGen,
  KillOutcome,
  Lease,
  Logger,
  Normalizer,
  PermissionDecision,
  PermissionResponder,
  PlatformOps,
  PlatformOwnership,
  ProcessExit,
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
} from "@omni-acp/protocol";

// ── process layer (WP-2) ────────────────────────────────────────────────────
export { createPlatformOps } from "./process/platform.js";
export { createSupervisor, type SupervisorOptions } from "./process/supervisor.js";

// ── event log (WP-3) ────────────────────────────────────────────────────────
export { createMemoryEventLog, type MemoryEventLogOptions } from "./event-log/memory-log.js";

// ── normalizer (WP-3) ───────────────────────────────────────────────────────
export { createNormalizer } from "./normalizer/normalizer.js";

// ── ACP link and worker kernel (WP-4) ───────────────────────────────────────
export { openAcpLink, type AcpLink, type AcpLinkHandlers } from "./acp/link.js";
export { createBaselineResponder } from "./worker/permission-responder.js";
export { alwaysGrantedLease } from "./lease/always-granted.js";
export { createWorker, type CreateWorkerDeps } from "./worker/worker.js";
