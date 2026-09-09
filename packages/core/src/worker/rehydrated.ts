import {
  OmniError,
  type AgentDescriptor,
  type Clock,
  type ClientRef,
  type EventLog,
  type IdGen,
  type Lease,
  type Logger,
  type Normalizer,
  type PermissionResponder,
  type RuntimeDescriptor,
  type SessionStrategy,
  type SpawnSpec,
  type Supervisor,
  type WorkerHandle,
  type WorkerRow,
} from "@omni-acp/protocol";
import { Worker, type CreateWorkerDeps } from "./worker.js";

/**
 * What a persisted row plus the daemon's catalog cannot supply.
 *
 * `WorkerRow` carries a `WorkerSnapshot` and an `agentId`; it does NOT carry the launch spec for
 * that agent, the normalizer, the responder or the limits, because none of those is client-facing
 * and all of them belong to the boot that is reading the row rather than to the boot that wrote
 * it. That is deliberate: a `cwdRoots` or timeout change between runs must take effect, which it
 * cannot do if the row pins them (§15.3 step 2 makes the same argument for the ACL).
 */
export interface RehydrateDeps {
  /** The launch spec for `row.agentId`, from the CURRENT config. Its `id` must match the row. */
  readonly descriptor: AgentDescriptor;
  readonly supervisor: Supervisor;
  readonly session: SessionStrategy;
  readonly lease: Lease;
  readonly clock: Clock;
  readonly ids: IdGen;
  readonly logger: Logger;
  readonly normalizer: Normalizer;
  readonly responder: PermissionResponder;
  readonly limits: CreateWorkerDeps["limits"];
  /** The RESOLVED quirk table for this agent; absent ⇒ `worker.ts`'s `DEFAULT_V1_PROFILE`. */
  readonly runtime?: RuntimeDescriptor;
  /** `"<agentId>@<fingerprint12>"`; absent ⇒ `worker.ts`'s `@unresolved`. */
  readonly runtimeId?: string;
  /** The catalog's `SpawnSpec` producer; absent ⇒ `worker.ts`'s own derivation. */
  readonly toSpawnSpec?: (d: AgentDescriptor, o: { cwd: string }) => SpawnSpec;
  /**
   * The controller a rehydrated worker belongs to.
   *
   * A row records `ownerTokenId` and nothing finer, because a `clientId` is per-`connect()` and
   * dies with the process that minted it (§16.1 rule L4). So the reconstructed owner is
   * `{tokenId, clientId: null}` unless a caller knows better — and `clientId: null` is the honest
   * value, not a placeholder: nobody is holding this worker across a restart.
   */
  readonly owner?: ClientRef;

  // ── M2's seams, forwarded (M2-WP-J) ────────────────────────────────────────
  //
  // A WOKEN worker must be the same worker it was before it hibernated, and `WorkerRow`'s M2
  // rows exist "BECAUSE OF THE WAKE PATH" (§5.8.8): a `park` worker that woke without its
  // strategy would stop declaring `clientCapabilities.elicitation`, which F28 says makes the
  // agent silently degrade to prose — the park never happens again and nothing reports it.
  //
  // Every one is OPTIONAL and absent means M1, exactly as on `CreateWorkerDeps`: this file's M1
  // callers compile and behave unchanged.
  readonly interactions?: CreateWorkerDeps["interactions"];
  readonly watchdog?: CreateWorkerDeps["watchdog"];
  readonly diff?: CreateWorkerDeps["diff"];
  readonly validateContent?: CreateWorkerDeps["validateContent"];
  readonly clientCapabilities?: CreateWorkerDeps["clientCapabilities"];
  readonly mcpServers?: CreateWorkerDeps["mcpServers"];
}

/**
 * A `WorkerHandle` with NO process, built over a persisted row and its log (§14.8).
 *
 * It shares the SAME `Worker` class, constructed in a non-`starting` initial state. A second
 * class would give `close()` / `wake()` / `snapshot()` two implementations each, and the second
 * one is exactly where the "DELETE after a restart returns a different body" bug lives — which
 * is why `CloseResult` is persisted and replayed byte-for-byte rather than recomputed (§15.6).
 *
 * The construction that makes that possible is Land-written and frozen (M1-PLAN §1.2, seam 2's
 * third verb): `new Worker(deps, { row })` seeds every record field from `row.snapshot` and, for
 * an already-`closed` row, pre-resolves the close with `row.closeResult`. So this body is a
 * `CreateWorkerDeps` assembly and one `new`.
 *
 * Owned by M1-WP-C.
 */
export function createRehydratedWorker(
  row: WorkerRow,
  log: EventLog,
  deps: RehydrateDeps,
): WorkerHandle {
  const snapshot = row.snapshot;

  // The row and the descriptor must be talking about the same agent. Building a worker whose
  // `agentId` says one thing and whose launch spec says another would spawn the wrong binary
  // into a session that belongs to the right one — and `WorkerSnapshot.agentId` is read off the
  // DESCRIPTOR, so the log would then contradict the row it was rehydrated from.
  if (deps.descriptor.id !== row.agentId) {
    throw new OmniError(
      "internal",
      `cannot rehydrate ${snapshot.workerId}: row says agent "${row.agentId}", ` +
        `descriptor says "${deps.descriptor.id}"`,
      { detail: { workerId: snapshot.workerId, row: row.agentId, descriptor: deps.descriptor.id } },
    );
  }
  // The log has to be THIS worker's, or `?since=` would replay somebody else's life (§8.2).
  if (log.workerId !== snapshot.workerId) {
    throw new OmniError(
      "internal",
      `cannot rehydrate ${snapshot.workerId}: the log belongs to ${log.workerId}`,
      { detail: { workerId: snapshot.workerId, log: log.workerId } },
    );
  }

  const workerDeps: CreateWorkerDeps = {
    workerId: snapshot.workerId,
    daemonId: snapshot.daemonId,
    descriptor: deps.descriptor,
    // Already realpath'd when the row was written, and re-checked against the CURRENT ACL by
    // §15.3 step 2 before a wake ever spawns — which is the check that makes persisting a row
    // safe at all.
    cwd: snapshot.cwd,
    label: snapshot.label,
    owner: deps.owner ?? { tokenId: snapshot.ownerTokenId, clientId: null },
    supervisor: deps.supervisor,
    log,
    normalizer: deps.normalizer,
    responder: deps.responder,
    lease: deps.lease,
    clock: deps.clock,
    ids: deps.ids,
    logger: deps.logger,
    limits: deps.limits,
    session: deps.session,
    ...(deps.runtime === undefined ? {} : { runtime: deps.runtime }),
    ...(deps.runtimeId === undefined ? {} : { runtimeId: deps.runtimeId }),
    ...(deps.toSpawnSpec === undefined ? {} : { toSpawnSpec: deps.toSpawnSpec }),
    // M2's seams, forwarded verbatim. A `?? {}` spread rather than an assignment, because
    // `CreateWorkerDeps` distinguishes "absent" from "present and undefined" nowhere else either.
    ...(deps.interactions === undefined ? {} : { interactions: deps.interactions }),
    ...(deps.watchdog === undefined ? {} : { watchdog: deps.watchdog }),
    ...(deps.diff === undefined ? {} : { diff: deps.diff }),
    ...(deps.validateContent === undefined ? {} : { validateContent: deps.validateContent }),
    ...(deps.clientCapabilities === undefined
      ? {}
      : { clientCapabilities: deps.clientCapabilities }),
    ...(deps.mcpServers === undefined ? {} : { mcpServers: deps.mcpServers }),
  };

  // No `start()`: there is no process to open and no handshake to run. `restore` seeds the state
  // machine from the row, so the FIRST envelope this worker appends reports the row's state as
  // `previous` rather than announcing itself as new in the middle of its own log.
  return new Worker(workerDeps, { row });
}
