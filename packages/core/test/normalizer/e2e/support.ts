import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBaselineResponder,
  createMemoryEventLog,
  createNormalizer,
  createSupervisor,
  createWorker,
  type CreateWorkerDeps,
} from "@omni-acp/core";
import { fixtureAgentPath, nullLogger, seqIds, type FixtureAgentName } from "@omni-acp/testkit";
import { mapCapabilities } from "../../../src/normalizer/map/capabilities.js";
import type {
  AcpLinkLike,
  AgentDescriptor,
  Clock,
  ClientRef,
  DaemonId,
  EventEnvelope,
  EventLog,
  Lease,
  LeaseSnapshot,
  RuntimeDescriptor,
  SessionId,
  SessionOpenOptions,
  SessionOpenResult,
  SessionReopenOptions,
  SessionStrategy,
  TimerHandle,
  TokenId,
  WorkerHandle,
  WorkerId,
} from "@omni-acp/protocol";

/**
 * TEST SUPPORT for `test/normalizer/e2e/**` — a REAL `Worker`, a REAL process, real pipes.
 *
 * It is deliberately not `test/worker/support/harness.ts`: that harness is M1-WP-C's, it is
 * built on `fakeSupervisor()`, and the whole point of these two files is that the close-out
 * ladder runs against a process that can actually observe `close_stdin` and actually end its
 * stdout. A ladder that passes the reducer's unit tests and cannot run in a Worker is a failure
 * of M1-WP-B's acceptance bullet 7, not of the Land step (M1-PLAN §2, WP-B).
 */

export const DAEMON_ID = "d_00000000000000000000000001" as DaemonId;
export const WORKER_ID = "w_00000000000000000000000001" as WorkerId;
export const OWNER: ClientRef = { tokenId: "tok_e2e" as TokenId, clientId: "cli_e2e" };

/** A real clock. `fakeClock()` cannot drive a real process's real deadlines. */
export function systemClock(): Clock {
  return {
    now: () => Date.now(),
    iso: () => new Date().toISOString(),
    setTimer(ms: number, fn: () => void): TimerHandle {
      const handle = setTimeout(fn, ms);
      handle.unref?.();
      return { cancel: () => clearTimeout(handle) };
    },
  };
}

/** M1-WP-D's `Lease`; these tests are not about it, so it grants and records nothing. */
function grantingLease(): Lease {
  const snapshot = (): LeaseSnapshot => ({
    workerId: WORKER_ID,
    holder: { tokenId: OWNER.tokenId, clientId: OWNER.clientId },
    epoch: 0,
    expiresAt: null,
    acquiredAt: null,
    pinned: false,
  });
  return {
    holder: OWNER,
    epoch: 0,
    snapshot,
    assertHolder: snapshot,
    acquire: snapshot,
    release: snapshot,
    steal: snapshot,
    pinExpiry: () => () => {},
    releaseForHibernate: snapshot,
    onChange: () => () => {},
    close: () => {},
  };
}

/**
 * SEAM 2's strategy, as a TEST DOUBLE.
 *
 * `createSessionStrategy` is M1-WP-C's and is still a stub, and `Worker.hibernate()` refuses to
 * run without one — so without this, the ladder's hibernate trigger could not be exercised at
 * all from this work package. The double is deliberately the smallest thing that satisfies the
 * interface, and its `open()` runs `mapCapabilities` over a REAL handshake, which is the one
 * part of §12.3 rows 20-21 that a unit test on recorded bytes cannot reach.
 */
function testSessionStrategy(descriptor: RuntimeDescriptor): SessionStrategy {
  const openWith = async (
    link: AcpLinkLike,
    o: SessionOpenOptions,
    sessionId: SessionId | null,
  ): Promise<SessionOpenResult> => {
    const initialize = await link.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    const body = await link.request(sessionId === null ? "session/new" : "session/load", {
      ...(sessionId === null ? {} : { sessionId }),
      cwd: o.cwd,
      mcpServers: [],
    });
    const capabilities = mapCapabilities(initialize, body, descriptor);
    const id = (body as { sessionId?: string } | null)?.sessionId;
    if (id === undefined) throw new Error("the agent returned no sessionId");
    return { capabilities, sessionId: id as SessionId, resume: null };
  };

  return {
    open: (link, o) => openWith(link, o, null),
    reopen: (link, o: SessionReopenOptions) => openWith(link, o, o.sessionId),
    async close(link, sessionId) {
      try {
        await link.request("session/close", { sessionId });
      } catch {
        /* best effort, and it NEVER throws (§5.1) */
      }
    },
  };
}

export interface E2eWorker {
  readonly worker: WorkerHandle;
  readonly log: EventLog;
  readonly cwd: string;
  /** Every envelope so far, in seq order. */
  events(): readonly EventEnvelope[];
  dispose(): Promise<void>;
}

export interface E2eOptions {
  readonly agent: FixtureAgentName;
  readonly env?: Record<string, string>;
  readonly descriptor: RuntimeDescriptor;
  readonly quietMs?: number;
  readonly drainGraceMs?: number;
  readonly cancelGraceMs?: number;
}

export async function startE2eWorker(o: E2eOptions): Promise<E2eWorker> {
  const clock = systemClock();
  const logger = nullLogger();
  const cwd = mkdtempSync(join(tmpdir(), "omni-e2e-"));

  const supervisor = createSupervisor({
    config: {
      gracefulMs: 2_000,
      killConfirmMs: 2_000,
      exitGraceMs: 500,
      maxFrameBytes: 4_000_000,
      stderrTailBytes: 64_000,
    },
    clock,
    logger,
  });

  const log = createMemoryEventLog({
    workerId: WORKER_ID,
    daemonId: DAEMON_ID,
    clock,
    maxEvents: 10_000,
    subscriberQueueSize: 256,
  });

  // `process.execPath <path>`, never npx (§6.3) — and the fixture's own env knobs, which are
  // what make the ladder's rungs observable from the AGENT's side.
  const descriptor: AgentDescriptor = {
    id: `e2e-${o.agent}`,
    command: process.execPath,
    args: [fixtureAgentPath(o.agent)],
    env: { ...o.env },
    protocolVersion: 1,
    shutdown: { signal: "SIGTERM", graceMs: 2_000 },
  };

  const deps: CreateWorkerDeps = {
    workerId: WORKER_ID,
    daemonId: DAEMON_ID,
    descriptor,
    cwd,
    label: "e2e",
    owner: OWNER,
    supervisor,
    log,
    normalizer: createNormalizer({
      quietMs: o.quietMs ?? 100,
      hardMs: 5_000,
      drainGraceMs: o.drainGraceMs ?? 300,
      cancelGraceMs: o.cancelGraceMs ?? 400,
      descriptor: o.descriptor,
      cwd,
    }),
    session: testSessionStrategy(o.descriptor),
    responder: createBaselineResponder("deny", clock),
    lease: grantingLease(),
    clock,
    ids: seqIds(),
    logger,
    limits: {
      handshakeTimeoutMs: 20_000,
      cancelGraceMs: 1_000,
      exitGraceMs: 500,
      gracefulMs: 2_000,
      closeOutMs: 10_000,
    },
    runtime: o.descriptor,
  };

  const worker = await createWorker(deps);
  return {
    worker,
    log,
    cwd,
    events: () => log.read(0),
    async dispose(): Promise<void> {
      // `close()` is idempotent, but calling it on an already-closed worker and then shutting the
      // supervisor down races the SDK's web-stream adapter, which rejects the writer it is still
      // holding on the agent's stdin. That rejection has nowhere to go and lands as vitest's
      // "unhandled error" — the same one `tree-kill.itest.ts` has always produced. Skipping the
      // redundant close is what keeps this suite's output clean.
      if (worker.snapshot().state !== "closed") {
        try {
          await worker.close("client_request");
        } catch {
          /* raced another close */
        }
      }
      if (supervisor.live.size > 0) await supervisor.shutdown();
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

/** Wait until `predicate` holds, or fail loudly with what was actually seen. */
export async function until(
  what: string,
  predicate: () => boolean,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A compact, order-preserving projection of the log, for readable assertions. */
export function tags(events: readonly EventEnvelope[]): string[] {
  return events.map((e) => {
    if (e.kind === "omni.error") return `error(${e.payload.code})`;
    if (e.kind === "omni.worker_state") return `state(${e.payload.state})`;
    if (e.kind !== "acp.session_update") return e.kind;
    const p = e.payload as { sessionUpdate: string; state?: string; stopReason?: string | null };
    if (p.sessionUpdate !== "state_update") return p.sessionUpdate;
    return p.state === "idle" ? `idle(${String(p.stopReason)})` : String(p.state);
  });
}
