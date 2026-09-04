import {
  type Clock,
  type CloseResult,
  type EventLog,
  type LeaseEventPayload,
  type Logger,
  type OrphanRecord,
  type PersistenceHandle,
  type ProcessInfo,
  type ResolvedDaemonConfig,
  type Supervisor,
  type WorkerId,
  type WorkerRow,
  type WorkerSnapshot,
  type WorkerState,
} from "@omni-acp/protocol";

/** The states §15.7 calls "live": a row in one of these was owned by a running process. */
const LIVE_STATES: readonly WorkerState[] = ["starting", "ready", "running", "requires_action"];

/**
 * One adoption pass, reported for its TWO audiences.
 *
 * `GET /v1/info.orphansAtStart` wants `{found, reaped, skipped}` — what a previous boot left
 * behind and what we could do about it. `WorkerRegistry.adopt()` is declared as
 * `{hibernated, closed, orphans}` — where every abandoned row ended up. They are the same pass,
 * and running it twice would append two sets of envelopes to every abandoned worker's log.
 */
export interface BootRecoveryResult {
  /** Abandoned rows in a LIVE state. Not the same as orphan processes: a row may have had none. */
  readonly found: number;
  readonly reaped: number;
  readonly skipped: number;
  /** Rows that converged on `hibernated` — the session pointer survives. */
  readonly hibernated: number;
  /** Rows that converged on `closed` — there was nothing left to resume. */
  readonly closed: number;
  readonly orphans: readonly OrphanRecord[];
}

/**
 * Runs ONCE inside `createDaemon()` before `start()` returns (CONTRACTS.md §15.7, H21).
 *
 * Three obligations, in this order, and the first is the one that matters:
 *
 *  1. RECORD every orphan a previous boot left behind. A process we cannot reap is still a
 *     process an operator needs to see — `GET /v1/info.orphansAtStart` says `{found, reaped,
 *     skipped}` and `skipped: n` is the honest Windows answer, not silence.
 *  2. Reap ONLY a matching fingerprint. A null or mismatched token is never signalled, because
 *     pid reuse makes that a coin flip on somebody else's process.
 *  3. Converge every abandoned row on `hibernated` or `closed`, appending the in-band
 *     `omni.error`, the `daemon_restart` / `orphaned` state envelope, and the
 *     `omni.lease{expired, how:"daemon_restart"}` that makes a restart's lease transfer AUDITED
 *     rather than silent (ruling M1-R8).
 *
 * It is a NO-OP on a second run: `abandoned(bootId)` selects rows whose `boot_id` is not the
 * current one, and every row this function touches is rewritten with the current one.
 *
 * Owned by M1-WP-E.
 */
export async function recoverFromPreviousBoot(o: {
  persistence: PersistenceHandle;
  supervisor: Supervisor;
  config: ResolvedDaemonConfig;
  clock: Clock;
  logger: Logger;
  logFor: (id: WorkerId) => EventLog;
}): Promise<BootRecoveryResult> {
  const bootId = o.persistence.bootId;
  const rows = o.persistence.workers
    .abandoned(bootId)
    .filter((r) => LIVE_STATES.includes(r.snapshot.state));

  let reaped = 0;
  let skipped = 0;
  let hibernated = 0;
  let closed = 0;
  const orphans: OrphanRecord[] = [];

  for (const row of rows) {
    const orphan = await reapIfProven(row, o);
    if (orphan !== null) {
      orphans.push(orphan);
      if (orphan.reaped) reaped += 1;
      else skipped += 1;
    }
    if (adoptRow(row, orphan, bootId, o) === "hibernated") hibernated += 1;
    else closed += 1;
  }

  const result: BootRecoveryResult = {
    found: rows.length,
    reaped,
    skipped,
    hibernated,
    closed,
    orphans,
  };
  if (rows.length > 0) {
    o.logger.info("boot adoption", { ...result, bootId });
  }
  return result;
}

/**
 * §15.7 rule 2, and the reason the `reapOrphans` knob is not a boolean.
 *
 * A reap kills the GROUP, not the leader — the agent's MCP servers and shells are in that group
 * (the same rule as §6.5) — and it happens ONLY when the fingerprint captured at spawn still
 * matches. `Supervisor.reapOrphan` owns that comparison and ALWAYS resolves: a refusal is data
 * (`reapSkipped`), not an exception, which is what lets this loop report `{found, reaped,
 * skipped}` instead of dying on the first Windows row.
 *
 * Returns `null` when the row never had a process to orphan (a `starting` row whose spawn had not
 * returned) — that is not a skipped reap, it is nothing to reap.
 */
async function reapIfProven(
  row: WorkerRow,
  o: { supervisor: Supervisor; config: ResolvedDaemonConfig; logger: Logger },
): Promise<OrphanRecord | null> {
  const info: ProcessInfo | null = row.snapshot.process;
  if (info === null) return null;

  const record: OrphanRecord = {
    pid: info.pid,
    groupId: info.groupId,
    startedAt: info.startedAt,
    fingerprint: info.fingerprint,
    reaped: false,
    reapSkipped: null,
  };

  if (o.config.supervisor.reapOrphans === "never") {
    // The operator asked us not to. Recorded rather than silently dropped — a leaked agent tree
    // holds a cwd and an API quota, and `GET /v1/info` is where that becomes visible.
    return { ...record, reapSkipped: "policy" };
  }

  try {
    return await o.supervisor.reapOrphan(record);
  } catch (e) {
    // `reapOrphan` is documented never to reject; if a Supervisor implementation does anyway, an
    // un-reaped orphan must still be REPORTED. Losing the whole adoption pass over one row would
    // leave every later row abandoned as well.
    o.logger.warn("reapOrphan threw; recording the orphan un-reaped", {
      workerId: row.snapshot.workerId,
      error: String(e),
    });
    return { ...record, reapSkipped: "policy" };
  }
}

/**
 * Is there anything left to wake?
 *
 * Both halves are required. Without a `sessionId` there is nothing to resume — §15.7 says a
 * worker that was `starting` when the daemon died is `closed` + `orphaned`, and it is right:
 * a half-initialised process is precisely the kind that must be reaped. Without a resolved
 * resume SPELLING there is no way to ask, and converging such a row on `hibernated` would turn a
 * dead worker into a guaranteed `422` on somebody's next wake — the one-way door ruling M1-R15
 * refuses to build.
 */
function isResumable(snapshot: WorkerSnapshot): boolean {
  if (snapshot.sessionId === null) return false;
  return (snapshot.capabilities?.resume.method ?? null) !== null;
}

/**
 * §15.7 rules 2-4, as three appends and one upsert.
 *
 * The appends go to the WORKER'S OWN LOG, continuing the same `seq` space (§14.4), so a client
 * reconnecting with the cursor it held learns what happened IN BAND, at the next seq it expects,
 * rather than by noticing that its stream went quiet.
 */
function adoptRow(
  row: WorkerRow,
  orphan: OrphanRecord | null,
  bootId: string,
  o: {
    persistence: PersistenceHandle;
    clock: Clock;
    logger: Logger;
    logFor: (id: WorkerId) => EventLog;
  },
): "hibernated" | "closed" {
  const snapshot = row.snapshot;
  const workerId = snapshot.workerId;
  const previous = snapshot.state;
  const resumable = isResumable(snapshot);
  const state: WorkerState = resumable ? "hibernated" : "closed";
  const reason = resumable ? "daemon_restart" : "orphaned";

  const log = o.logFor(workerId);

  // 2. The in-band `omni.error`. `agent_error` rather than `internal`: the thing that went wrong
  // is the agent PROCESS, which is gone, and §9's settled table has no code for "the daemon
  // restarted" — inventing one is exactly what D29 forbids. (`agent_crashed` is a
  // `WorkerCloseReason` and appears on the state envelope below, where it belongs.)
  log.append({
    kind: "omni.error",
    payloadVersion: 2,
    turnId: snapshot.currentTurnId,
    payload: {
      code: "agent_error",
      message:
        `the daemon restarted; this worker's process was owned by a previous boot ` +
        `(was ${previous}, now ${state})`,
    },
  });

  // 3. The state envelope. A reader must be able to tell "your worker is asleep and will wake"
  // from "your session is gone", which is why the reason is `daemon_restart` in one case and
  // `orphaned` in the other rather than one reason with a flag.
  log.append({
    kind: "omni.worker_state",
    payloadVersion: 2,
    turnId: null,
    payload: {
      state,
      previous,
      reason,
      // Sticky, and it never goes back to false (D2): a previous boot's abnormal exit IS an
      // abnormal death of this worker's process.
      crashed: true,
      ...(orphan === null ? {} : { orphan }),
      ...(state === "closed"
        ? { leaderExited: orphan?.reaped ?? false, treeGone: orphan?.reaped ?? false }
        : {}),
    },
  });

  // 4. The audited lease transfer. Leases are not persisted (ruling M1-R8), so without this the
  // holder simply changes across a boot with nothing in the log — which is the opposite of D5's
  // 抢占带审计. `by: null`: nobody caused it, a restart did.
  const lease: LeaseEventPayload = {
    op: "expired",
    lease: {
      workerId,
      holder: null,
      // +1 on every acquire / steal / expiry (§16.1 rule L7), so a client that cached the old
      // epoch is fenced out rather than silently continuing against a worker it no longer holds.
      epoch: snapshot.lease.epoch + 1,
      expiresAt: null,
      acquiredAt: null,
      pinned: false,
    },
    previous: snapshot.lease.holder,
    by: null,
    how: "daemon_restart",
    reason: null,
  };
  log.append({ kind: "omni.lease", payloadVersion: 2, turnId: null, payload: lease });

  /**
   * The persisted `CloseResult`, so `DELETE` after a restart is byte-for-byte idempotent
   * (§15.6 level 3).
   *
   * Deliberately PESSIMISTIC: `treeGone` is true only when a fingerprint-matched reap proved it,
   * and `sessionClosed` is false because nobody sent `session/close` — we did not spawn a process
   * to politely close a session, and claiming otherwise is exactly the optimism §6.6 forbids.
   */
  const closeResult: CloseResult | null =
    state === "closed"
      ? {
          workerId,
          state: "closed",
          reason: "orphaned",
          leaderExited: orphan?.reaped ?? false,
          treeGone: orphan?.reaped ?? false,
          sessionClosed: false,
        }
      : null;

  const nowIso = o.clock.iso();
  const adopted: WorkerRow = {
    ...row,
    // The CURRENT boot id is what makes a second run a no-op: `abandoned()` will not select it.
    bootId,
    closeResult,
    ...(state === "closed" ? { closedAtMs: o.clock.now() } : {}),
    snapshot: {
      ...snapshot,
      state,
      updatedAt: nowIso,
      // The process is gone whichever way this went; a row that kept its `ProcessInfo` would
      // offer a pid for a second adoption pass to try to reap.
      process: null,
      currentTurnId: null,
      crashed: true,
      closeReason: state === "closed" ? "orphaned" : snapshot.closeReason,
      hibernatedAt: state === "hibernated" ? nowIso : snapshot.hibernatedAt,
      lease: lease.lease,
      orphan,
      headSeq: log.head,
    },
  };
  o.persistence.workers.upsert(adopted);

  o.logger.info("adopted a worker from a previous boot", {
    workerId,
    previous,
    state,
    reason,
    reaped: orphan?.reaped ?? false,
    reapSkipped: orphan?.reapSkipped ?? null,
  });

  return state;
}
