import {
  OmniError,
  type AcpStream,
  type Logger,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
} from "@omni-acp/protocol";

export interface AcpLinkHandlers {
  onSessionUpdate(n: { sessionId: string; update: Record<string, unknown> }): void;
  /** MUST resolve or throw acp.RequestError. Throwing anything else maps to -32603. */
  onPermissionRequest(req: RequestPermissionRequest): Promise<RequestPermissionResponse>;
  /** Fires exactly once, before `closed` resolves. */
  onClosed(err: Error | null): void;
}

export interface AcpLink {
  request<R = unknown>(method: string, params: unknown): Promise<R>;
  notify(method: string, params: unknown): Promise<void>;
  readonly closed: Promise<void>;
  close(): void;
}

/**
 * Wraps an `AgentProcess.stream` in `acp.client(...)`.
 *
 * Unknown agent->client requests are answered `-32601`, never left hanging (DESIGN §6.2) — a
 * silent drop is how a turn ends up waiting forever on an agent that asked us something we do
 * not implement. `clientCapabilities` is `{}` in M0 (D3): we advertise no fs and no terminal,
 * so nothing can be asked of us that we would have to refuse.
 */
export function openAcpLink(stream: AcpStream, h: AcpLinkHandlers, o: { logger: Logger }): AcpLink {
  throw new OmniError("internal", "unimplemented: WP-4 (acp.openAcpLink)");
}
