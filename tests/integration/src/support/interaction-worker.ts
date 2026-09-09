import {
  alwaysGrantedLease,
  clientCapabilitiesFor,
  createBaselineResponder,
  createInteractionStrategy,
  createMemoryEventLog,
  createNormalizer,
  createSessionStrategy,
  createSupervisor,
  createWorker,
  resolveDescriptor,
} from "@omni-acp/core";
import {
  AgentDescriptor,
  InteractionConfig,
  SupervisorConfig,
  type Clock,
  type ClientRef,
  type DaemonId,
  type EventEnvelope,
  type EventLog,
  type InteractionStrategy,
  type ResolvedInteractionConfig,
  type RuntimeDescriptor,
  type Seq,
  type TimerHandle,
  type TokenId,
  type WorkerHandle,
  type WorkerId,
} from "@omni-acp/protocol";
import { fixtureAgentPath, nullLogger, seqIds } from "@omni-acp/testkit";

/**
 * A REAL worker over a REAL spawned fixture agent, with the M2 interaction strategy injected.
 *
 * It is not `startHarness()` because `packages/daemon/src/create-daemon.ts` does not yet pass
 * `DaemonDeps.interactions` through to `createWorker` — that file is M2-WP-J's, the only owner of
 * daemon wiring (M2-PLAN §3), so the HTTP half of these bullets lands with the join. Everything
 * BELOW the route is real here: a real process, real ndJSON over real pipes, the real `AcpLink`
 * with its `verbatim` `elicitation/create` registration, the real `Normalizer`, and the real
 * `InteractionStrategy`.
 *
 * Owned by M2-A-WP-I.
 */

export type ElicitFixture =
  "elicit-oneof" | "elicit-custom" | "elicit-multi" | "elicit-never-answers";

/**
 * The four `elicit-*` fixtures, through the testkit's own resolver.
 *
 * `FixtureAgentName` now carries the names CONTRACTS §5.8.10 declares (the merge applied WP-I's
 * note N5 and WP-P's frozen-file request 1), so this no longer resolves the path itself.
 */
export function elicitFixture(name: ElicitFixture): string {
  return fixtureAgentPath(name);
}

export const OWNER: ClientRef = { tokenId: "tok_it" as TokenId, clientId: "cli_it" };
export const WHO = { ...OWNER, tokenId: OWNER.tokenId };

const DAEMON_ID = "d_00000000000000000000000001" as DaemonId;
const WORKER_ID = "w_00000000000000000000000001" as WorkerId;

/** A real clock, because a real process's frames cannot wait on a clock nobody advances. */
function realClock(): Clock {
  return {
    now: () => Date.now(),
    iso: () => new Date().toISOString(),
    setTimer: (delayMs, fn): TimerHandle => {
      const handle = setTimeout(fn, delayMs);
      handle.unref?.();
      return { cancel: () => clearTimeout(handle) };
    },
  };
}

export interface InteractionWorker {
  readonly worker: WorkerHandle;
  readonly log: EventLog;
  readonly strategy: InteractionStrategy;
  envelopes(): readonly EventEnvelope[];
  interactions(): readonly EventEnvelope[];
  decisions(): readonly EventEnvelope[];
  states(): readonly EventEnvelope[];
  dispose(): Promise<void>;
}

export interface InteractionWorkerOptions {
  readonly fixture: ElicitFixture;
  readonly cwd: string;
  readonly onUnresolved: "park" | "deny" | "fail";
  readonly parkTimeoutMs?: number;
  readonly parkTimeoutAction?: "deny" | "fail";
  readonly config?: Partial<ResolvedInteractionConfig>;
  /** `OMNI_FIXTURE_RESUMABLE=1`: the fixture advertises a resume spelling, so it can be woken. */
  readonly resumable?: boolean;
}

export async function startInteractionWorker(
  o: InteractionWorkerOptions,
): Promise<InteractionWorker> {
  const clock = realClock();
  const logger = nullLogger();
  const descriptor: RuntimeDescriptor = resolveDescriptor(null, {}, null);
  // Parsed rather than hand-built, so every default the daemon would apply applies here too.
  const agent: AgentDescriptor = AgentDescriptor.parse({
    id: o.fixture,
    // `process.execPath <module>` — never `npx`, which is a `.cmd` shim on Windows (§6.3, F8).
    command: process.execPath,
    args: [elicitFixture(o.fixture)],
    ...(o.resumable === true ? { env: { OMNI_FIXTURE_RESUMABLE: "1" } } : {}),
  });

  const log = createMemoryEventLog({
    workerId: WORKER_ID,
    daemonId: DAEMON_ID,
    clock,
    maxEvents: 10_000,
    subscriberQueueSize: 256,
  });
  const config = InteractionConfig.parse(o.config ?? {});
  let handle: WorkerHandle | null = null;
  const strategy = createInteractionStrategy({
    workerId: WORKER_ID,
    clock,
    ids: seqIds(),
    logger,
    config,
    onUnresolved: o.onUnresolved,
    parkTimeoutMs: o.parkTimeoutMs ?? null,
    parkTimeoutAction: o.parkTimeoutAction ?? "deny",
    responder: createBaselineResponder("deny", clock),
    // The daemon wiring's two extras (`InteractionStrategyDeps`): the log the answer's `seq` is
    // copied off, and the live worker state the answer reports.
    log,
    workerState: () => handle?.snapshot().state ?? "starting",
  });

  const worker = await createWorker({
    workerId: WORKER_ID,
    daemonId: DAEMON_ID,
    descriptor: agent,
    cwd: o.cwd,
    label: "interaction-it",
    owner: OWNER,
    supervisor: createSupervisor({
      config: SupervisorConfig.parse({}),
      clock,
      logger,
    }),
    log,
    normalizer: createNormalizer({ quietMs: 250, hardMs: 10_000, descriptor, cwd: o.cwd }),
    responder: createBaselineResponder("deny", clock),
    lease: alwaysGrantedLease(OWNER, WORKER_ID),
    clock,
    ids: seqIds(),
    logger,
    limits: {
      handshakeTimeoutMs: 30_000,
      cancelGraceMs: 5_000,
      exitGraceMs: 2_000,
      gracefulMs: 3_000,
    },
    session: createSessionStrategy({ descriptor, clock, logger }),
    interactions: strategy,
    // D10's gate, computed ONCE and threaded through both `open` and `reopen` (F42).
    clientCapabilities: clientCapabilitiesFor({ onUnresolved: o.onUnresolved, config }),
  });
  handle = worker;

  const all = (): readonly EventEnvelope[] => log.read(0 as Seq, 10_000);
  return {
    worker,
    log,
    strategy,
    envelopes: all,
    interactions: () => all().filter((e) => e.kind === "acp.interaction"),
    decisions: () => all().filter((e) => e.kind === "omni.policy_decision"),
    states: () => all().filter((e) => e.kind === "omni.worker_state"),
    dispose: async () => {
      await worker.close("client_request").catch(() => {});
    },
  };
}

/** Polls until `predicate` holds or the deadline passes; a real process needs real waiting. */
export async function until(
  predicate: () => boolean,
  o?: { timeoutMs?: number; what?: string },
): Promise<void> {
  const deadline = Date.now() + (o?.timeoutMs ?? 20_000);
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${o?.what ?? "a condition"}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
