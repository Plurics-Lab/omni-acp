/**
 * @omni-acp/client — the SDK.
 *
 * FROZEN by the scaffold (M0-PLAN.md §1.2): re-export only.
 *
 * This package's runtime dependency closure is `@omni-acp/protocol` and nothing else: no `hono`,
 * no `yaml`, no `@omni-acp/daemon` (D14, CONTRACTS.md §3.1). `local()` reaches the daemon through
 * a dynamic import of an optional peer.
 */

export { OmniACP, type ConnectOptions } from "./omni-acp.js";
export type { LocalOptions } from "./local.js";
export type { Server, CreateAgentOptions } from "./server.js";
export type { Worker, PromptInput, PromptOptions, StreamEvent, WorkerEventMap } from "./worker.js";
export type { WorkerLease } from "./lease.js";
// ── M2 (CONTRACTS.md §5.8.10) ───────────────────────────────────────────────
export type { InteractionRequestHandle } from "./interactions.js";
export type { RunsChannel } from "./runs.js";
// ── M3-WP1 (docs/M3-WP1-CREDENTIALS.md) ─────────────────────────────────────
export type { CredentialsChannel } from "./credentials.js";
export type { McpChannel } from "./mcp.js";
export type { LocalCredentialOptions } from "./local-credential.js";

export { OmniError } from "@omni-acp/protocol";
export type {
  TurnResult,
  TurnStatus,
  EventEnvelope,
  WorkerSnapshot,
  WorkerState,
  OmniErrorBody,
  WhoAmIResponse,
  DaemonInfo,
  AgentCatalogEntry,
  // ── M1 (CONTRACTS.md §5.7) ────────────────────────────────────────────────
  LeaseSnapshot,
  ProbeResponse,
  ProbeSummary,
  ResumeReport,
  RuntimeDescriptor,
  // ── M2 (CONTRACTS.md §5.8.10) ─────────────────────────────────────────────
  ConfigOptionView,
  DeliveryRecord,
  ElicitationField,
  InteractionSnapshot,
  PolicySnapshot,
  RunSnapshot,
  // ── M3-WP1 ────────────────────────────────────────────────────────────────
  CredentialApplied,
  CredentialInput,
  CredentialPutResult,
  CredentialSummary,
  LoginState,
  RestartResult,
  InstallMcpRequest,
  RegisterMcpPresetRequest,
  McpInstallationMetadata,
  McpPresetMetadata,
} from "@omni-acp/protocol";
