/**
 * The ONE place the ACP SDK is imported for types.
 *
 * A 1.4.0 -> 1.5.0 bump has exactly one blast radius: this file. Nothing else in the repository
 * type-imports from "@agentclientprotocol/sdk" (CONTRACTS.md §5.1).
 *
 * FROZEN by the scaffold (M0-PLAN.md §1.2). A change here is a renegotiation of CONTRACTS.md.
 */

export type {
  ContentBlock,
  ToolCall,
  ToolCallUpdate,
  ToolCallStatus,
  ToolCallContent,
  ToolKind,
  Diff,
  AgentCapabilities,
  PromptCapabilities,
  SessionCapabilities,
  McpServer,
  PermissionOption,
  PermissionOptionKind,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionUpdate as V1SessionUpdate,
  InitializeResponse as V1InitializeResponse,
  NewSessionResponse as V1NewSessionResponse,
  PromptResponse as V1PromptResponse,
  Stream as AcpStream,
} from "@agentclientprotocol/sdk";

export {
  PROTOCOL_VERSION as ACP_V1_VERSION,
  RequestError as AcpRequestError,
} from "@agentclientprotocol/sdk";

export type {
  SessionUpdate as V2SessionUpdate,
  StateUpdate as V2StateUpdate,
  StopReason,
  UsageUpdate as V2UsageUpdate,
} from "@agentclientprotocol/sdk/experimental/v2";

import type { SessionUpdate as V2SessionUpdateInternal } from "@agentclientprotocol/sdk/experimental/v2";

/**
 * D1's canonical payload type.
 *
 * Because v2's `SessionUpdate` ends in an open arm `{ sessionUpdate: string; [k: string]: unknown }`
 * (verified, CONTRACTS.md F2), an un-normalized v1 update is structurally assignable to it. The
 * envelope's `payloadVersion` says which you actually hold, so M1 flipping payloads to true v2 is
 * not a wire break.
 */
export type NormalizedSessionUpdate = V2SessionUpdateInternal;
