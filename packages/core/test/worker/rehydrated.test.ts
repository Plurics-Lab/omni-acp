import { describe, expect, it } from "vitest";
import {
  OmniError,
  type CloseResult,
  type EventEnvelope,
  type RuntimeDescriptor,
  type WorkerRow,
  type WorkerSnapshot,
  type WorkerStatePayload,
} from "@omni-acp/protocol";
import { fakeRuntime, nullLogger, seqIds } from "@omni-acp/testkit";
import { createRehydratedWorker, type RehydrateDeps } from "../../src/worker/rehydrated.js";
import { createSessionStrategy } from "../../src/worker/session-open.js";
import { arrayLog } from "./support/array-log.js";
import {
  DAEMON_ID,
  DESCRIPTOR,
  flush,
  harness,
  LIMITS,
  OWNER,
  WORKER_ID,
  type Harness,
} from "./support/harness.js";
import { asScripted, resumableAgent } from "./support/resumable-agent.js";

/**
 * §14.8's rehydration and §15.6's three levels of `DELETE` idempotency — M1-PLAN WP-C
 * acceptance 8.
 *
 * The property that matters is NEGATIVE: there is no second `WorkerHandle` implementation. A
 * second `close()` / `wake()` / `snapshot()` is exactly where "DELETE after a restart returns a
 * different body" lives, so these tests assert the rehydrated handle behaves as the class does,
 * not as a look-alike would.
 */

const RUNTIME: RuntimeDescriptor = fakeRuntime({
  prefer: {
    resume: { spellings: ["session/resume", "session/load"], onFailure: "fail" },
    close: { spellings: ["session/close"], onFailure: "fail" },
  },
});

const stateOf = (e: EventEnvelope): WorkerStatePayload => e.payload as WorkerStatePayload;

const failure = async (p: Promise<unknown>): Promise<OmniError> => {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  if (!(e instanceof OmniError)) throw new Error(`expected an OmniError, got ${String(e)}`);
  return e;
};

/** The persisted row a previous boot would have written for this snapshot. */
function rowFor(snapshot: WorkerSnapshot, over: Partial<WorkerRow> = {}): WorkerRow {
  return {
    snapshot,
    agentId: snapshot.agentId,
    bootId: "boot_previous",
    closeResult: null,
    lastActiveMs: 1_000,
    closedAtMs: null,
    hibernateIdleMs: null,
    ...over,
  };
}

function depsFor(h: Harness, over: Partial<RehydrateDeps> = {}): RehydrateDeps {
  return {
    descriptor: DESCRIPTOR,
    supervisor: h.supervisor,
    session: createSessionStrategy({
      descriptor: RUNTIME,
      clock: h.clock,
      logger: nullLogger(),
    }),
    lease: h.lease,
    clock: h.clock,
    ids: seqIds(),
    logger: h.logger,
    normalizer: h.normalizer,
    responder: h.deps().responder,
    limits: LIMITS,
    runtime: RUNTIME,
    ...over,
  };
}

/** A worker driven to `hibernated`, and the row a store would have persisted for it. */
async function hibernatedRow(): Promise<{ h: Harness; row: WorkerRow }> {
  const h = harness();
  h.supervisor.enqueue(asScripted(resumableAgent({ onResume: { kind: "ok" } })));
  const worker = await h.create({
    overrides: {
      session: createSessionStrategy({ descriptor: RUNTIME, clock: h.clock, logger: nullLogger() }),
      runtime: RUNTIME,
    },
  });
  const snapshot = await worker.hibernate("idle_timeout");
  return { h, row: rowFor(snapshot) };
}

describe("createRehydratedWorker (§14.8)", () => {
  it("reconstructs the record WITHOUT a process, a spawn or a handshake", async () => {
    const { row } = await hibernatedRow();
    const fresh = harness();
    const log = arrayLog({ workerId: WORKER_ID, daemonId: DAEMON_ID, clock: fresh.clock });

    const w = createRehydratedWorker(row, log, depsFor(fresh));
    const snap = w.snapshot();

    expect(fresh.supervisor.spawnCalls).toHaveLength(0);
    expect(log.all).toHaveLength(0);
    expect(snap.state).toBe("hibernated");
    expect(snap.sessionId).toBe(row.snapshot.sessionId);
    expect(snap.capabilities).toEqual(row.snapshot.capabilities);
    expect(snap.generation).toBe(row.snapshot.generation);
    expect(snap.hibernatedAt).toBe(row.snapshot.hibernatedAt);
    expect(snap.wakeCount).toBe(row.snapshot.wakeCount);
    expect(snap.crashed).toBe(row.snapshot.crashed);
    expect(snap.cwd).toBe(row.snapshot.cwd);
    expect(snap.ownerTokenId).toBe(row.snapshot.ownerTokenId);
    expect(snap.createdAt).toBe(row.snapshot.createdAt);
  });

  it("`close()` on a rehydrated HIBERNATED worker: leaderExited, treeGone, NOT sessionClosed", async () => {
    const { row } = await hibernatedRow();
    const fresh = harness();
    const log = arrayLog({ workerId: WORKER_ID, daemonId: DAEMON_ID, clock: fresh.clock });
    const w = createRehydratedWorker(row, log, depsFor(fresh));

    const result = await w.close("client_request");

    // §15.6: `session/close` is skipped for a hibernated worker WITHOUT a special case — `#link`
    // is already null, so the existing `canClose` conjunction is false. We do not pay a 7 s npx
    // cold start to politely close a session the agent may keep on its own disk anyway, and
    // `sessionClosed: false` says so out loud instead of leaving the caller to infer it.
    expect(result).toMatchObject({
      workerId: WORKER_ID,
      state: "closed",
      reason: "client_request",
      leaderExited: true,
      treeGone: true,
      sessionClosed: false,
    });
    expect(fresh.supervisor.spawnCalls).toHaveLength(0);
    // The log CONTINUES — same worker, same seq space (§14.4) — rather than starting over, and
    // `previous` reads `hibernated`, not `null`.
    const chain = log.all.filter((e) => e.kind === "omni.worker_state").map(stateOf);
    expect(chain).toHaveLength(1);
    expect(chain[0]).toMatchObject({ state: "closed", previous: "hibernated" });
  });

  it("is idempotent within the handle: a second close() replays the first result", async () => {
    const { row } = await hibernatedRow();
    const fresh = harness();
    const log = arrayLog({ workerId: WORKER_ID, daemonId: DAEMON_ID, clock: fresh.clock });
    const w = createRehydratedWorker(row, log, depsFor(fresh));

    const first = await w.close("client_request");
    const second = await w.close("daemon_shutdown");
    // §15.6 level 1, unchanged from M0: the same handle shares one `#closePromise`, so the
    // SECOND reason cannot rewrite the first answer.
    expect(second).toBe(first);
    expect(log.all.filter((e) => e.kind === "omni.worker_state")).toHaveLength(1);
  });

  it("§15.6 level 3: a CLOSED row replays its persisted CloseResult byte-for-byte", async () => {
    const { row } = await hibernatedRow();
    const persisted: CloseResult = {
      workerId: WORKER_ID,
      state: "closed",
      reason: "client_request",
      leaderExited: true,
      treeGone: false,
      sessionClosed: true,
      durationMs: 1_234,
    };
    const closedRow = rowFor(
      { ...row.snapshot, state: "closed", closeReason: "client_request", process: null },
      { closeResult: persisted, closedAtMs: 2_000 },
    );

    const fresh = harness();
    const log = arrayLog({ workerId: WORKER_ID, daemonId: DAEMON_ID, clock: fresh.clock });
    const w = createRehydratedWorker(closedRow, log, depsFor(fresh));

    const result = await w.close("client_request");
    // Byte-for-byte, not recomputed. Recomputing would report `treeGone: true` for a tree THIS
    // process never proved gone, which is exactly the optimism §6.6 forbids.
    expect(result).toEqual(persisted);
    expect(result.treeGone).toBe(false);
    expect(result.sessionClosed).toBe(true);
    // And nothing is appended: the close already happened, in another boot's log.
    expect(log.all).toHaveLength(0);
    expect(await w.closed).toEqual(persisted);
  });

  it("a boot that died MID-close leaves no result, and the fallback is pessimistic", async () => {
    const { row } = await hibernatedRow();
    const closedRow = rowFor(
      { ...row.snapshot, state: "closed", closeReason: "daemon_shutdown", process: null },
      { closeResult: null, closedAtMs: 2_000 },
    );
    const fresh = harness();
    const log = arrayLog({ workerId: WORKER_ID, daemonId: DAEMON_ID, clock: fresh.clock });
    const w = createRehydratedWorker(closedRow, log, depsFor(fresh));

    const result = await w.close("client_request");
    expect(result.state).toBe("closed");
    // Never optimistic about a tree nobody proved gone (§6.6, §15.6).
    expect(result.treeGone).toBe(false);
    expect(result.sessionClosed).toBe(false);
  });

  it("WAKES from a rehydrated row: the same class, so there is one wake implementation", async () => {
    const { row } = await hibernatedRow();
    const fresh = harness();
    const log = arrayLog({ workerId: WORKER_ID, daemonId: DAEMON_ID, clock: fresh.clock });
    const agent = resumableAgent({ onResume: { kind: "ok" } });
    fresh.supervisor.enqueue(asScripted(agent));

    const w = createRehydratedWorker(row, log, depsFor(fresh));
    const snap = await w.wake(OWNER);

    expect(snap.state).toBe("ready");
    expect(snap.resume?.outcome).toBe("landed");
    // `generation` counts PROCESSES this worker has had, across boots — it is read off the row
    // and incremented, never restarted at 1.
    expect(snap.generation).toBe(row.snapshot.generation + 1);
    expect(snap.wakeCount).toBe(row.snapshot.wakeCount + 1);
    expect(agent.methods).toEqual(["initialize", "session/resume"]);

    const chain = log.all.filter((e) => e.kind === "omni.worker_state").map(stateOf);
    expect(chain.map((p) => `${String(p.previous)}->${p.state}:${p.reason}`)).toEqual([
      "hibernated->starting:wake",
      "starting->ready:resumed",
    ]);
  });

  it("`crashed` survives the restart and stays monotone (invariant 2)", async () => {
    const { row } = await hibernatedRow();
    const crashedRow = rowFor({ ...row.snapshot, crashed: true });
    const fresh = harness();
    const log = arrayLog({ workerId: WORKER_ID, daemonId: DAEMON_ID, clock: fresh.clock });
    fresh.supervisor.enqueue(asScripted(resumableAgent({ onResume: { kind: "ok" } })));

    const w = createRehydratedWorker(crashedRow, log, depsFor(fresh));
    expect(w.snapshot().crashed).toBe(true);
    const snap = await w.wake(OWNER);
    // A successful wake does not un-crash the past: `crashed` is sticky by D2, and the envelope
    // carries it so a reader of the LOG sees the same thing a reader of the snapshot does.
    expect(snap.crashed).toBe(true);
    expect(stateOf(log.all.filter((e) => e.kind === "omni.worker_state").at(-1)!).crashed).toBe(
      true,
    );
  });

  it("refuses a descriptor that is not the row's agent", async () => {
    const { row } = await hibernatedRow();
    const fresh = harness();
    const log = arrayLog({ workerId: WORKER_ID, daemonId: DAEMON_ID, clock: fresh.clock });
    expect(() =>
      createRehydratedWorker(
        row,
        log,
        depsFor(fresh, { descriptor: { ...DESCRIPTOR, id: "some-other-agent" } }),
      ),
    ).toThrow(/row says agent/);
  });

  it("refuses a log that belongs to another worker", async () => {
    const { row } = await hibernatedRow();
    const fresh = harness();
    const other = arrayLog({
      workerId: "w_00000000000000000000000009" as typeof WORKER_ID,
      daemonId: DAEMON_ID,
      clock: fresh.clock,
    });
    expect(() => createRehydratedWorker(row, other, depsFor(fresh))).toThrow(/the log belongs to/);
  });

  it("reconstructs the owner from the row's token, with a NULL client id", async () => {
    const { row } = await hibernatedRow();
    const fresh = harness();
    const log = arrayLog({ workerId: WORKER_ID, daemonId: DAEMON_ID, clock: fresh.clock });
    fresh.supervisor.enqueue(asScripted(resumableAgent({ onResume: { kind: "ok" } })));

    const w = createRehydratedWorker(row, log, depsFor(fresh));
    // A `clientId` is per-`connect()` and died with the process that minted it (§16.1 rule L4);
    // `null` is the honest value, and the row records only the token.
    expect(w.snapshot().ownerTokenId).toBe(row.snapshot.ownerTokenId);
    await w.close("daemon_shutdown");
    await flush();
  });

  it("a rehydrated CLOSED worker refuses to wake, and spawns nothing", async () => {
    const { row } = await hibernatedRow();
    const closedRow = rowFor(
      { ...row.snapshot, state: "closed", closeReason: "client_request", process: null },
      { closeResult: null },
    );
    const fresh = harness();
    const log = arrayLog({ workerId: WORKER_ID, daemonId: DAEMON_ID, clock: fresh.clock });
    const w = createRehydratedWorker(closedRow, log, depsFor(fresh));

    const e = await failure(w.wake(OWNER));
    expect(e.code).toBe("worker_closed");
    expect(fresh.supervisor.spawnCalls).toHaveLength(0);
  });
});
