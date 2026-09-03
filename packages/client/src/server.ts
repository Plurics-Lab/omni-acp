import {
  OmniError,
  assertWorkerId,
  type AgentCatalogEntry,
  type AgentListResponse,
  type CreateWorkerRequest,
  type DaemonId,
  type DaemonInfo,
  type WhoAmIResponse,
  type WorkerListResponse,
  type WorkerSnapshot,
} from "@omni-acp/protocol";
import { createTransport, type Transport, type TransportOptions } from "./transport.js";
import { createWorkerHandle, disposeWorker, type Worker } from "./worker.js";

export interface CreateAgentOptions {
  readonly cwd: string;
  readonly label?: string;
  readonly timeoutMs?: number;
  /** M0: only the empty tuple type-checks. MCP presets are M2. */
  readonly mcp?: readonly [];
  readonly onUnresolved?: "deny";
}

export interface Server {
  readonly url: string;
  readonly daemonId: DaemonId;
  /** From connect()'s single GET /v1/whoami. */
  readonly me: WhoAmIResponse;
  info(): Promise<DaemonInfo>;
  agents(): Promise<readonly AgentCatalogEntry[]>;
  createAgent(agentId: string, opts: CreateAgentOptions): Promise<Worker>;
  /** Snapshots, not live handles — a listing must not open N SSE streams (D31). */
  workers(): Promise<readonly WorkerSnapshot[]>;
  attach(workerId: string): Promise<Worker>;
  /** Closes local streams. For local(), also stops the embedded daemon. Remote workers survive. */
  close(): Promise<void>;
}

/**
 * The one code path both `OmniACP.connect()` and `OmniACP.local()` take.
 *
 * It issues EXACTLY ONE request, `GET /v1/whoami` (DESIGN §8): a client that has to probe
 * several endpoints to learn what it may do is a client whose permissions can drift between
 * probes. `local()` differs only in supplying an `onClose` that also stops the embedded daemon,
 * which is what keeps D14 and D15 on one path rather than two.
 */
export async function connectServer(
  options: TransportOptions,
  onClose?: () => Promise<void>,
): Promise<Server> {
  const transport = createTransport(options);
  const me = await transport.request<WhoAmIResponse>("GET", "/v1/whoami");
  return createServer(transport, me, options.url, onClose);
}

export function createServer(
  transport: Transport,
  me: WhoAmIResponse,
  url: string,
  onClose?: () => Promise<void>,
): Server {
  // Handles this Server minted. `close()` stops their local streams — it does NOT close the
  // remote workers, which outlive the client by design (that is what `attach()` is for).
  const handles = new Set<Worker>();
  let closed = false;

  const assertOpen = (): void => {
    if (closed) throw new OmniError("bad_request", "this Server is closed");
  };

  const track = (snapshot: WorkerSnapshot): Worker => {
    const worker = createWorkerHandle(transport, snapshot);
    handles.add(worker);
    return worker;
  };

  return {
    url,
    daemonId: me.daemonId,
    me,

    async info(): Promise<DaemonInfo> {
      assertOpen();
      return transport.request<DaemonInfo>("GET", "/v1/info");
    },

    async agents(): Promise<readonly AgentCatalogEntry[]> {
      assertOpen();
      const body = await transport.request<AgentListResponse>("GET", "/v1/agents");
      return body.agents;
    },

    async createAgent(agentId: string, opts: CreateAgentOptions): Promise<Worker> {
      assertOpen();
      if (agentId === "") throw new OmniError("bad_request", "createAgent() needs an agent id");
      if (opts.cwd === "") throw new OmniError("bad_request", "createAgent() needs a cwd");

      // Built key by key rather than by spreading `opts`: `CreateWorkerRequest` is a
      // `strictObject`, so a field this milestone does not accept has to fail here with a
      // sentence, not on the wire with a zod path.
      const body: CreateWorkerRequest = {
        agent: agentId,
        cwd: opts.cwd,
        ...(opts.label === undefined ? {} : { label: opts.label }),
        ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
        ...(opts.mcp === undefined ? {} : { mcp: [...opts.mcp] }),
        ...(opts.onUnresolved === undefined ? {} : { onUnresolved: opts.onUnresolved }),
      };

      // H5 is synchronously ready: the 201 already carries `state:"ready"` and the real
      // handshake capabilities, so there is nothing to poll for.
      const snapshot = await transport.request<WorkerSnapshot>("POST", "/v1/workers", body);
      return track(snapshot);
    },

    async workers(): Promise<readonly WorkerSnapshot[]> {
      assertOpen();
      const body = await transport.request<WorkerListResponse>("GET", "/v1/workers");
      return body.workers;
    },

    async attach(workerId: string): Promise<Worker> {
      assertOpen();
      const snapshot = await transport.request<WorkerSnapshot>(
        "GET",
        `/v1/workers/${assertWorkerId(workerId)}`,
      );
      return track(snapshot);
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      for (const worker of handles) disposeWorker(worker);
      handles.clear();
      await onClose?.();
    },
  };
}
