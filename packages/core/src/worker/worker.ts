import {
  OmniError,
  type AgentDescriptor,
  type Clock,
  type ClientRef,
  type DaemonId,
  type EventLog,
  type IdGen,
  type Lease,
  type Logger,
  type Normalizer,
  type PermissionResponder,
  type Supervisor,
  type WorkerHandle,
  type WorkerId,
} from "@omni-acp/protocol";

export interface CreateWorkerDeps {
  readonly workerId: WorkerId;
  readonly daemonId: DaemonId;
  readonly descriptor: AgentDescriptor;
  /** Already realpath'd and ACL-checked. */
  readonly cwd: string;
  readonly label: string | null;
  readonly owner: ClientRef;
  readonly supervisor: Supervisor;
  readonly log: EventLog;
  readonly normalizer: Normalizer;
  readonly responder: PermissionResponder;
  readonly lease: Lease;
  readonly clock: Clock;
  readonly ids: IdGen;
  readonly logger: Logger;
  readonly limits: {
    handshakeTimeoutMs: number;
    cancelGraceMs: number;
    exitGraceMs: number;
    gracefulMs: number;
  };
}

/**
 * spawn -> initialize{protocolVersion:1, clientCapabilities:{}} -> session/new{mcpServers:[]}.
 *
 * Resolves ONLY when state === "ready". On ANY failure edge it reclaims the process tree,
 * appends `omni.error` + `omni.worker_state{closed, ...}`, and REJECTS with an `OmniError` whose
 * code is already correct (`agent_error` / `agent_timeout`) — so the HTTP layer maps it with the
 * one table and adds no judgement of its own.
 *
 * The worker also owns the two things the pure Normalizer cannot: the tick timer that drives the
 * quiet window, and the crash classifier — which lives here rather than in `AcpLink` because it
 * needs the worker's state to know whether a mid-turn death is a crash or a requested close
 * (CONTRACTS.md §6.7).
 */
export function createWorker(deps: CreateWorkerDeps, signal?: AbortSignal): Promise<WorkerHandle> {
  throw new OmniError("internal", "unimplemented: WP-4 (worker.createWorker)");
}
