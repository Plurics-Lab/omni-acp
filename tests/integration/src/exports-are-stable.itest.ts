import * as cli from "@omni-acp/cli";
import * as client from "@omni-acp/client";
import * as core from "@omni-acp/core";
import * as daemon from "@omni-acp/daemon";
import * as protocol from "@omni-acp/protocol";
import * as testkit from "@omni-acp/testkit";
import { describe, expect, it } from "vitest";

// ── the TYPE half ────────────────────────────────────────────────────────────
//
// Type-only exports leave no runtime trace, so the only way to assert they "resolve and are
// typed" is to name them where the compiler is looking. `tests/integration/tsconfig.json`
// includes `src/**/*.ts`, so `tsc -b` type-checks this file on every build, and a type that has
// been renamed or removed is a build failure — not a test that quietly stops covering it.
//
// This is also the only place in the repository that may import all six barrels (review R15).

import type {
  // protocol — ids, errors, events, worker, turn, control-plane, config, contracts
  AcpErrorDetail,
  AgentCapabilitiesSnapshot,
  AgentCatalogEntry,
  AgentDescriptor,
  AgentListResponse,
  AgentProcess,
  AuthContext,
  Catalog,
  ClientId,
  ClientRef,
  Clock,
  CloseResult,
  ContentBlock,
  CreateWorkerRequest,
  Daemon,
  DaemonConfig,
  DaemonDeps,
  DaemonEvent,
  DaemonId,
  DaemonInfo,
  EventBody,
  EventEnvelope,
  EventInput,
  EventKind,
  EventListener,
  EventLog,
  FileChange,
  HealthResponse,
  IdGen,
  InteractionPayload,
  InteractionRecord,
  KillOutcome,
  Lease,
  Logger,
  NormalizedSessionUpdate,
  Normalizer,
  OmniErrorBody,
  OmniErrorCode,
  PermissionDecision,
  PermissionResponder,
  PlatformOps,
  PlatformOwnership,
  PolicyDecisionPayload,
  ProcessExit,
  ProcessInfo,
  PromptAccepted,
  PromptRequestBody,
  ResolvedDaemonConfig,
  ResolvedListenConfig,
  ResolvedSupervisorConfig,
  ResolvedTurnConfig,
  RunUtility,
  Seq,
  SessionId,
  SettleReason,
  SpawnSpec,
  StderrTail,
  StopReason,
  Subscription,
  Supervisor,
  TerminationRung,
  TimerHandle,
  TokenConfig,
  TokenId,
  ToolCallView,
  TurnId,
  TurnInput,
  TurnOutput,
  TurnResult,
  TurnState,
  TurnStatus,
  V1SessionUpdate,
  V2SessionUpdate,
  WhoAmIResponse,
  WorkerCloseReason,
  WorkerHandle,
  WorkerId,
  WorkerListResponse,
  WorkerRef,
  WorkerRegistry,
  WorkerSnapshot,
  WorkerState,
  WorkerStatePayload,
  // ── M1 (CONTRACTS.md §5.1: lease.ts, resume.ts, runtime.ts, and the §5.1 diffs) ──────────
  AcpLinkLike,
  BuiltinRuntime,
  ClientRefWire,
  CloseOutAction,
  ErrorClass,
  ErrorRule,
  EventLogCoreOptions,
  EventStore,
  EventStoreDiagnostics,
  ExtensionPath,
  HibernateTimer,
  LeaseEventPayload,
  LeaseOp,
  LeaseOptions,
  LeaseRequestBody,
  LeaseSnapshot,
  MappedPermissionRequest,
  MappedUpdate,
  MethodPreferences,
  MethodVerdict,
  OrphanRecord,
  OutboundCall,
  PersistedEventLogOptions,
  PersistenceHandle,
  ProbeRequestBody,
  ProbeResponse,
  ProbeSummary,
  Quirks,
  ResolvedEventLogConfig,
  ResolvedHibernateConfig,
  ResolvedLeaseConfig,
  ResolvedProbeConfig,
  ResumeAttempt,
  ResumeHint,
  ResumeMethod,
  ResumeOutcome,
  ResumeReport,
  RetentionInput,
  RetentionPlan,
  RetentionReport,
  RuntimeDescriptor,
  RuntimeOverlay,
  SessionOpenOptions,
  SessionOpenResult,
  SessionReopenOptions,
  SessionStrategy,
  TurnVerdict,
  TurnWarning,
  UpdateRule,
  WakeRequestBody,
  WorkerRow,
  WorkerStateReason,
  WorkerStore,
} from "@omni-acp/protocol";
import type { FakeAgentProcess, FakeClock, FakeSupervisor, ScriptedAgent } from "@omni-acp/testkit";
import type {
  AcpLink,
  AcpLinkHandlers,
  CreateWorkerDeps,
  SupervisorOptions,
  // ── M1 ────────────────────────────────────────────────────────────────────
  NormalizerOptions,
  OpenPersistenceOptions,
  ProbeOptions,
  RehydrateDeps,
} from "@omni-acp/core";
import type {
  AuthContext as DaemonAuthContext,
  Catalog as DaemonCatalog,
  Daemon as DaemonType,
  DaemonDeps as DaemonDepsType,
  DaemonEvent as DaemonEventType,
  WorkerRegistry as DaemonWorkerRegistry,
  // ── M1 ────────────────────────────────────────────────────────────────────
  ProbeCache,
  ProbeService,
} from "@omni-acp/daemon";
import type {
  ConnectOptions,
  CreateAgentOptions,
  LocalOptions,
  PromptInput,
  PromptOptions,
  Server,
  StreamEvent,
  Worker,
  WorkerEventMap,
  // ── M1 ────────────────────────────────────────────────────────────────────
  WorkerLease,
} from "@omni-acp/client";
import type { ParsedArgs } from "@omni-acp/cli";

/**
 * Referencing every imported type in one place, so an unused-import lint could never quietly
 * delete the coverage. `never` inhabits every position, and none of this is evaluated.
 */
type Named =
  // ── M1 (the Land step's additions; see the import blocks above) ─────────────
  | AcpLinkLike
  | BuiltinRuntime
  | ClientRefWire
  | CloseOutAction
  | ErrorClass
  | ErrorRule
  | EventLogCoreOptions
  | EventStore
  | EventStoreDiagnostics
  | ExtensionPath
  | HibernateTimer
  | LeaseEventPayload
  | LeaseOp
  | LeaseOptions
  | LeaseRequestBody
  | LeaseSnapshot
  | MappedPermissionRequest
  | MappedUpdate
  | MethodPreferences
  | MethodVerdict
  | OrphanRecord
  | OutboundCall
  | PersistedEventLogOptions
  | PersistenceHandle
  | ProbeRequestBody
  | ProbeResponse
  | ProbeSummary
  | Quirks
  | ResolvedEventLogConfig
  | ResolvedHibernateConfig
  | ResolvedLeaseConfig
  | ResolvedProbeConfig
  | ResumeAttempt
  | ResumeHint
  | ResumeMethod
  | ResumeOutcome
  | ResumeReport
  | RetentionInput
  | RetentionPlan
  | RetentionReport
  | RuntimeDescriptor
  | RuntimeOverlay
  | SessionOpenOptions
  | SessionOpenResult
  | SessionReopenOptions
  | SessionStrategy
  | TurnVerdict
  | TurnWarning
  | UpdateRule
  | WakeRequestBody
  | WorkerRow
  | WorkerStateReason
  | WorkerStore
  | NormalizerOptions
  | OpenPersistenceOptions
  | ProbeOptions
  | RehydrateDeps
  | ProbeCache
  | ProbeService
  | WorkerLease
  | AcpErrorDetail
  | AgentCapabilitiesSnapshot
  | AgentCatalogEntry
  | AgentDescriptor
  | AgentListResponse
  | AgentProcess
  | AuthContext
  | Catalog
  | ClientRef
  | Clock
  | CloseResult
  | ContentBlock
  | CreateWorkerRequest
  | Daemon
  | DaemonConfig
  | DaemonDeps
  | DaemonEvent
  | DaemonInfo
  | EventBody
  | EventEnvelope
  | EventInput
  | EventListener
  | EventLog
  | FileChange
  | HealthResponse
  | IdGen
  | InteractionPayload
  | InteractionRecord
  | KillOutcome
  | Lease
  | Logger
  | NormalizedSessionUpdate
  | Normalizer
  | OmniErrorBody
  | PermissionDecision
  | PermissionResponder
  | PlatformOps
  | PlatformOwnership
  | PolicyDecisionPayload
  | ProcessExit
  | ProcessInfo
  | PromptAccepted
  | PromptRequestBody
  | ResolvedDaemonConfig
  | ResolvedListenConfig
  | ResolvedSupervisorConfig
  | ResolvedTurnConfig
  | RunUtility
  | SpawnSpec
  | StderrTail
  | Subscription
  | Supervisor
  | TimerHandle
  | TokenConfig
  | ToolCallView
  | TurnInput
  | TurnOutput
  | TurnResult
  | TurnStatus
  | V1SessionUpdate
  | V2SessionUpdate
  | WhoAmIResponse
  | WorkerHandle
  | WorkerListResponse
  | WorkerRegistry
  | WorkerSnapshot
  | WorkerStatePayload
  | FakeAgentProcess
  | FakeClock
  | FakeSupervisor
  | ScriptedAgent
  | AcpLink
  | AcpLinkHandlers
  | CreateWorkerDeps
  | SupervisorOptions
  | DaemonAuthContext
  | DaemonCatalog
  | DaemonType
  | DaemonDepsType
  | DaemonEventType
  | DaemonWorkerRegistry
  | ConnectOptions
  | CreateAgentOptions
  | LocalOptions
  | Server
  | StreamEvent
  | Worker
  | WorkerEventMap
  | ParsedArgs;

/** The string-literal and alias types, pinned by assignment rather than by union membership. */
const LITERALS: {
  clientId: ClientId;
  daemonId: DaemonId;
  workerId: WorkerId;
  turnId: TurnId;
  tokenId: TokenId;
  sessionId: SessionId;
  workerRef: WorkerRef;
  seq: Seq;
  eventKind: EventKind;
  workerState: WorkerState;
  closeReason: WorkerCloseReason;
  errorCode: OmniErrorCode;
  stopReason: StopReason;
  turnState: TurnState;
  settleReason: SettleReason;
  rung: TerminationRung;
  promptInput: PromptInput;
  promptOptions: PromptOptions;
} = {
  clientId: "c_1",
  daemonId: "d_01J00000000000000000000000",
  workerId: "w_01J00000000000000000000000",
  turnId: "t_01J00000000000000000000000",
  tokenId: "local",
  sessionId: "s1",
  workerRef: "d_01J00000000000000000000000:w_01J00000000000000000000000",
  seq: 1,
  eventKind: "acp.session_update",
  workerState: "ready",
  closeReason: "client_request",
  errorCode: "worker_busy",
  stopReason: "end_turn",
  turnState: "completed",
  settleReason: "quiet",
  rung: "sigterm",
  promptInput: "hello",
  promptOptions: { queue: true },
};

// ── the RUNTIME half ─────────────────────────────────────────────────────────

/**
 * Architecture guard: `exports-are-stable` (CONTRACTS.md §10.2, review R15).
 *
 * Every name in each frozen `index.ts` resolves and is typed. The lists are literal on purpose:
 * the barrels are FROZEN (M0-PLAN §1.2, M1-PLAN §1.1), so a diff here is a renegotiation of
 * CONTRACTS.md, and the test is supposed to say so out loud rather than accommodate it.
 *
 * The M1 names were added by the Land step, which is the one commit allowed to move them
 * (M1-PLAN §1.1); every one of them is a signature-complete stub whose body throws
 * `unimplemented: M1-WP-x` until its work package fills it in. `resolves every exported value`
 * below checks that the BINDING exists, never that calling it works — a stub that throws is
 * exactly what this milestone's barrel is supposed to contain.
 */
const EXPECTED: Record<string, readonly string[]> = {
  "@omni-acp/protocol": [
    "ACP_V1_VERSION",
    "AcpRequestError",
    "AgentDescriptor",
    "ContentBlockLoose",
    "CreateWorkerRequest",
    "DaemonConfig",
    "ERROR_STATUS",
    "EVENT_KINDS",
    "EventLogConfig",
    "HEADER",
    "HibernateConfig",
    "ID_PATTERN",
    "LeaseConfig",
    "LeaseRequestBody",
    "ListenConfig",
    "M0_WORKER_STATES",
    "M1_WORKER_STATES",
    "OMNI_ERROR_CODES",
    "OmniError",
    "ProbeConfig",
    "ProbeOverrides",
    "ProbeRequestBody",
    "PromptRequestBody",
    "RESUME_OUTCOMES",
    "ResumeReplayConfig",
    "RuntimeOverlay",
    "SSE_CONTROL",
    "SupervisorConfig",
    "TokenConfig",
    "TurnConfig",
    "ULID_BODY",
    "WORKER_STATES",
    "WakeRequestBody",
    "assertTurnId",
    "assertWorkerId",
    "createIdGen",
    "eventEnvelopeSchema",
    "hashSecret",
    "isDaemonId",
    "isTurnId",
    "isWorkerId",
    "parseWorkerRef",
    "redactArgs",
    "reduceTurn",
    "turnStatus",
    "verifySecret",
    "workerRef",
  ],
  "@omni-acp/testkit": [
    "collectSse",
    "fakeClock",
    "fakeRuntime",
    "fakeSupervisor",
    "fixtureAgentPath",
    "isAlive",
    "loadTranscript",
    "memoryStreamPair",
    "nullLogger",
    "parseSse",
    "runEventLogConformance",
    "runLeaseConformance",
    "scriptedAgent",
    "sdkExampleAgentPath",
    "seqIds",
    "stubDaemon",
    "tmpPersistence",
    "transcriptNames",
    "transcriptUpdates",
    "waitGone",
    "wireAgentPath",
  ],
  "@omni-acp/core": [
    "BUILTIN_RUNTIMES",
    "DEFAULT_V1_PROFILE",
    "SCHEMA_VERSION",
    "acquireDataDirLock",
    "alwaysGrantedLease",
    "classifyProbe",
    "classifyResume",
    "createBaselineResponder",
    "createEventLogCore",
    "createHibernateTimer",
    "createLease",
    "createMemoryEventLog",
    "createNormalizer",
    "createPersistedEventLog",
    "createPlatformOps",
    "createRehydratedWorker",
    "createSessionStrategy",
    "createSupervisor",
    "createWorker",
    "descriptorFingerprint",
    "fingerprintOf",
    "openAcpLink",
    "openPersistence",
    "planRetention",
    "probeAgent",
    "resolveDescriptor",
    "runRetention",
    "runUtility",
  ],
  "@omni-acp/daemon": [
    "createDaemon",
    "createHttpApp",
    "createProbeCache",
    "createProbeService",
    "openDaemonPersistence",
    "recoverFromPreviousBoot",
    "registerAgentRoutes",
    "registerLeaseRoutes",
  ],
  "@omni-acp/client": ["OmniACP", "OmniError"],
  "@omni-acp/cli": ["main", "parseArgs", "yamlToDaemonConfig"],
};

const NAMESPACES: Record<string, Record<string, unknown>> = {
  "@omni-acp/protocol": protocol,
  "@omni-acp/testkit": testkit,
  "@omni-acp/core": core,
  "@omni-acp/daemon": daemon,
  "@omni-acp/client": client,
  "@omni-acp/cli": cli,
};

describe("guard: exports-are-stable", () => {
  for (const [name, expected] of Object.entries(EXPECTED)) {
    it(`${name} exports exactly its frozen surface`, () => {
      const actual = Object.keys(NAMESPACES[name] ?? {}).sort();
      expect(actual).toEqual([...expected].sort());
    });

    it(`${name} resolves every exported value`, () => {
      const namespace = NAMESPACES[name] ?? {};
      for (const key of expected) {
        expect(`${name}.${key}: ${typeof namespace[key]}`).not.toBe(`${name}.${key}: undefined`);
      }
    });
  }

  it("keeps the type-level surface referenced, so `tsc -b` covers it too", () => {
    // The compiler already proved every name above exists; this asserts the file did the work
    // rather than being deleted as "unused imports".
    const sample: Named | null = null;
    expect(sample).toBeNull();
    expect(LITERALS.daemonId.startsWith("d_")).toBe(true);
    expect(LITERALS.workerRef).toContain(":");
  });

  it("re-exports the shared contract types from daemon under the documented path", () => {
    // A1: `Daemon` and friends are DECLARED in `protocol/src/contracts.ts` and re-exported
    // unchanged from `daemon/src/types.ts`, which is what keeps testkit's `stubDaemon(): Daemon`
    // from forcing a `testkit -> daemon -> testkit` cycle. Structural identity, asserted by
    // assignment in both directions.
    const forward: DaemonType | null = null as Daemon | null;
    const backward: Daemon | null = null as DaemonType | null;
    expect(forward).toBeNull();
    expect(backward).toBeNull();
  });
});
