import { realpath } from "node:fs/promises";
import {
  CreateWorkerRequest,
  LeaseRequestBody,
  OmniError,
  PromptRequestBody,
  RestartRequestBody,
  SetConfigBody,
  SetCredentialBody,
  assertInteractionId,
  type Clock,
  type ClientRef,
  type CredentialApplied,
  type CredentialBinding,
  type RestartResult,
  type WorkerCredentialBinding,
  type CloseResult,
  type DaemonId,
  type DiffProvider,
  type EventLog,
  type HibernateTimer,
  type IdGen,
  type InteractionAnswerResult,
  type InteractionDeps,
  type InteractionListResponse,
  type InteractionRequest,
  type InteractionStrategy,
  type Lease,
  type LeaseSnapshot,
  type Logger,
  type OrphanRecord,
  type McpResolution,
  type PermissionResponder,
  type PersistenceHandle,
  type PolicyEngine,
  type PolicySubject,
  type PromptAccepted,
  type ResolvedDaemonConfig,
  type ResolvedWatchdogConfig,
  type Seq,
  type SessionStrategy,
  type SpawnSpec,
  type SetConfigResponse,
  type Subscription,
  type Supervisor,
  type TokenId,
  type TurnId,
  type TurnStatus,
  type AgentDescriptor,
  type WorkerCloseReason,
  type WorkerHandle,
  type WorkerId,
  type WorkerRow,
  type WorkerSnapshot,
  type WorkerState,
  type Watchdog,
  type WatchdogDeps,
} from "@omni-acp/protocol";
import {
  alwaysGrantedLease,
  assertPromptContent,
  createHibernateTimer,
  createMemoryEventLog,
  createNormalizer,
  createPersistedEventLog,
  createRehydratedWorker,
  createWorker,
  resolveWorkerEnv,
  toPolicySubject,
} from "@omni-acp/core";
import { recoverFromPreviousBoot, type BootRecoveryResult } from "./boot-recovery.js";
import type { CredentialLayer } from "./credentials/layer.js";
import { homeDir } from "./credentials/paths.js";
import { resolveMcpForWorker } from "./mcp.js";
import type { AuthContext, Catalog, WorkerRegistry } from "./types.js";

export interface WorkerRegistryOptions {
  readonly daemonId: DaemonId;
  readonly config: ResolvedDaemonConfig;
  readonly catalog: Catalog;
  readonly supervisor: Supervisor;
  readonly responder: PermissionResponder;
  readonly clock: Clock;
  readonly ids: IdGen;
  readonly logger: Logger;
  /** Every appended envelope, for `daemon.on("worker.event" | "worker.state")`. */
  readonly onEnvelope?: (workerId: string, envelope: unknown) => void;
  /**
   * SEAM 3 (M1-PLAN §1.2, review R14). D5 enforcement is a change to the FACTORY this registry
   * passes in, and to nothing else: `Worker.prompt()` / `cancel()` / `wake()` already call
   * `lease.assertHolder(who)` as their first statement, and `delete()` below does too.
   *
   * Absent ⇒ `alwaysGrantedLease`, which is M0's behaviour exactly: one in-process controller by
   * construction. `create-daemon.ts` defaults it to M1-WP-D's `createLease`.
   *
   * The third parameter is the worker's own event log, and it is why this declaration is WIDER
   * than `DaemonDeps.leaseFactory` (which is frozen at two). §16.1 rule L9 says every lease
   * transition appends `omni.lease` TO THE WORKER'S LOG, and `LeaseOptions.onEvent` is the sink
   * that does it — so a factory that is never handed the log can only build a lease whose audit
   * trail goes nowhere. The log is in scope at both call sites below, and a two-parameter
   * function stays assignable to this type, so an injected `DaemonDeps.leaseFactory` written
   * against the frozen shape keeps working and simply ignores the argument.
   */
  readonly leaseFactory?: (
    owner: ClientRef | null,
    workerId: WorkerId,
    log: EventLog,
    initialEpoch?: number,
  ) => Lease;
  /**
   * The durable half (§14). Absent or `null` ⇒ memory only, which is `createDaemon()`'s default
   * (ruling M1-R17) and M0's behaviour exactly: no store to read, so `list()` is the live map,
   * `get()` cannot rehydrate, and `adopt()` has nothing to adopt.
   */
  readonly persistence?: PersistenceHandle | null;
  /**
   * SEAM 2 (M1-PLAN §1.2): the strategy `Worker` calls instead of naming `initialize` /
   * `session/new` itself. Absent ⇒ `worker.ts`'s inline M0 handshake, so the M0 suite runs
   * untouched.
   */
  readonly session?: SessionStrategy;
  /**
   * Boot adoption's FULL result, handed back when `adopt()` runs.
   *
   * `WorkerRegistry.adopt()` is frozen at `{hibernated, closed, orphans}` while
   * `GET /v1/info.orphansAtStart` needs `{found, reaped, skipped}` — the same pass, two audiences.
   * A callback is how `createDaemon` reads the second half without a second adoption run, and
   * without widening a frozen contract type.
   */
  readonly onBootAdoption?: (r: BootRecoveryResult) => void;

  // ── M2's seams, one per feature, ALL optional (M2-PLAN §1.2, §1.3) ──────────
  //
  // With every one of them absent this registry builds exactly the M1 worker: no strategy (so
  // `worker.ts`'s inline baseline responder answers, byte for byte), no watchdog (disarmed), no
  // provider (`TurnResult.patch` stays null), no engine (the strategy, if any, falls back to the
  // request's own `onUnresolved`), and M0's text-only whitelist as the content gate. That is
  // ruling M2-R1 made mechanical, and it is what lets the whole M1 suite run against this file
  // unedited. `create-daemon.ts` is the ONE place the six defaults are flipped.

  /**
   * SEAM A. One strategy per worker, built from the request's own disposition.
   *
   * The parameter is WIDER than `DaemonDeps.interactions`'s `InteractionDeps` by the three
   * members `createInteractionStrategy` also accepts (`log`, `workerState`, `toSubject`) — a
   * function written against the narrower shape is still assignable, so an injected factory keeps
   * working and simply ignores what it does not read.
   */
  readonly interactions?: (
    d: InteractionDeps & {
      readonly log?: Pick<EventLog, "head" | "read">;
      readonly workerState?: () => WorkerState;
      readonly toSubject?: (req: InteractionRequest) => PolicySubject | Promise<PolicySubject>;
    },
  ) => InteractionStrategy;
  /** SEAM B. Built only when the RESOLVED budgets say `enabled`. */
  readonly watchdog?: (d: WatchdogDeps) => Watchdog;
  /** SEAM C (D8). ONE provider per daemon; `CreateWorkerRequest.patch:"off"` opts a worker out. */
  readonly diff?: DiffProvider;
  /**
   * D4's engine, resolved per REQUEST because the ceiling is per TOKEN and the selection is per
   * worker. It throws `403 policy_exceeds_ceiling` at CREATE — before a process exists, which is
   * the whole point of §20.5 — so it is called before the slot is reserved.
   */
  readonly policyFor?: (
    sel: ParsedCreateWorkerRequest["policy"],
    auth: AuthContext,
    onUnresolved: "park" | "deny" | "fail",
  ) => PolicyEngine;
  /**
   * The daemon's token store, and the ONE resolver of everything an `AuthContext` carries.
   *
   * The create path has a live `AuthContext`; the WAKE path has none — nobody holds one across a
   * restart (ruling M1-R8) — and it needs two things the raw config cannot give it: the token's
   * RESOLVED `cwdRoots` (review finding V3: `[]` means `homedir()` and `~` must be expanded, and
   * `auth.ts` is where that happens) and a context to rebuild the policy engine with (review
   * finding V2/V8). Reading them through `contextFor` is what stops the daemon growing a second
   * spelling of either.
   *
   * Absent ⇒ a registry with no auth at all, which is what a unit test that constructs one
   * directly gets: the containment gate then sees `[]` and refuses every path-bearing block, and
   * a rehydrated worker gets no engine. Both are the fail-closed answers.
   */
  readonly tokens?: { contextFor(tokenId: TokenId, clientId?: string | null): AuthContext };

  /**
   * M3-WP1's ONE seam (docs/M3-WP1-CREDENTIALS.md).
   *
   * ABSENT ⇒ M2 exactly: no credential is resolved, no home is built, `WorkerSnapshot.credential`
   * is absent, and `PUT …/credential` answers `bad_request` naming the work package. Every
   * existing test constructs this registry without it, and that is the compatibility bar.
   *
   * `restart` needs NONE of this — replacing a process is not a credential operation — which is
   * why it works on a registry with no layer wired at all.
   */
  readonly credentials?: CredentialLayer;
}

interface Entry {
  readonly id: WorkerId;
  readonly handle: WorkerHandle;
  readonly ownerTokenId: TokenId;
  /** The fan-out subscription that feeds `daemon.on(...)`; closed with the worker. */
  subscription: Subscription | null;
  /** The FIRST close, shared by every later caller — this is what makes DELETE idempotent. */
  closing: Promise<CloseResult> | null;
  /** Whether this worker still occupies a `maxWorkers` slot. */
  live: boolean;
  /** The agent id this worker was created for, for the persisted row (`WorkerRow.agentId`). */
  readonly agentId: string;
  /** Unsubscribes the row-persisting state listener; run once, when the entry is dropped. */
  offStateChange: (() => void) | null;
  /**
   * This worker's idle budget in ms, or `null` when hibernation is off for it.
   *
   * `CreateWorkerRequest.idleTimeoutMs` overrides `hibernate.idleMs` per worker, and `0` in
   * either place means "never hibernate this worker" — which has to survive as `null` rather
   * than as a zero-millisecond timer that fires immediately (`WorkerRow.hibernateIdleMs`).
   */
  readonly hibernateIdleMs: number | null;
  /** §15.2's `ready -> hibernated` driver. Armed by `watchEntry`, cancelled with the worker. */
  idleTimer: HibernateTimer | null;
  /**
   * The M2 rows of `WorkerSnapshot` this REGISTRY owns, and `worker.ts` cannot (§5.8.4).
   *
   * They are facts about the REQUEST — the disposition it asked for, the presets it named, the
   * env keys it set, the policy it resolved to — and `worker.ts` is frozen after the Land step,
   * so the worker has nowhere to hold them. The registry does, it is the thing that resolved
   * them, and `viewOf` stamps them onto every snapshot that leaves this file (including the
   * `201` body, which is why `create()` hands back a decorated handle rather than the raw one).
   *
   * MUTABLE since M3-WP1, and only for `credentialName`: a `setCredential` changes which
   * credential this worker will WAKE on, and the alternative — replacing the `Entry` object — would
   * leave `watchEntry`'s state listener, `views`'s memoised handle and `handle.closed`'s callback
   * all closed over the previous one. One field, one writer (`credentialBindingFor`).
   */
  m2: WorkerViewRows;
  /**
   * M3-WP1's per-worker binding, or undefined when no credential layer is wired (M2).
   *
   * The registry holds it as well as the worker because two callers outside `worker.ts` need it:
   * the wake path, which has to read the store before a spawn (`ensure`), and `CredentialStore`'s
   * `linked()` hook, which answers "which live workers read this credential".
   */
  readonly credentials: BoundCredential | undefined;
  /**
   * Why this worker may NOT be resumed, or null (§23.1, review finding V2/V8).
   *
   * A wake has to reproduce the environment the worker was created in. When it cannot — the
   * owning token is gone, a policy preset was removed, the ceiling is now narrower than the
   * worker's own rules, an MCP preset vanished from config — the honest answer is to CLOSE the
   * worker with `acl_revoked` rather than to wake it unenforced. Set once, at rehydration.
   */
  readonly revoked: string | null;
}

/**
 * The registry's view of a worker's credential binding: the protocol's shape plus the one method
 * only this file needs (§14.8's lazy rehydration, applied to the credential).
 */
type BoundCredential = WorkerCredentialBinding & { ensure(): Promise<void> };

/** What `reviveM2` rebuilt for a rehydrated worker, or why it could not. */
interface RevivedM2 {
  readonly engine: PolicyEngine | null;
  readonly mcpServers: readonly unknown[];
  readonly revoked: string | null;
}

/** The registry-owned half of a `WorkerSnapshot`, exactly the §5.8.4 rows `worker.ts` cannot fill. */
interface WorkerViewRows {
  readonly onUnresolved: "park" | "deny" | "fail";
  readonly parkTimeoutMs: number | null;
  readonly parkTimeoutAction: "deny" | "fail";
  readonly policy: WorkerSnapshot["policy"];
  /** `PolicyEngine.id` — the ENGINE's identity, for `WorkerRow.policyRef`'s audit trail. */
  readonly policyId: string | null;
  /**
   * `CreateWorkerRequest.policy`, verbatim — the input the engine was BUILT from (V2/V8).
   *
   * `policyId` identifies an engine; it cannot reconstruct one. This is what `rehydrate()` hands
   * back to `policyFor` so a woken worker enforces the rules it was created with instead of
   * `DEFAULT_VERDICT[onUnresolved]`.
   */
  readonly policySelection: ParsedCreateWorkerRequest["policy"];
  /** §20.6's watch list from the resolved engine, threaded to `worker.ts` for `idle._meta`. */
  readonly alertOnUnpoliced: readonly string[];
  readonly mcp: WorkerSnapshot["mcp"];
  readonly envKeys: readonly string[];
  readonly patchMode: "off" | "on_write" | "always";
  /** The RESOLVED budgets, for `WorkerRow.watchdog` — the snapshot's copy is the worker's own. */
  readonly watchdog: { silentMs: number; toolMs: number; cancelTimeoutMs: number } | null;
  /** `null` ⇒ `env.persist:false` was asked for, and the row must not carry the map (§23.3). */
  readonly env: Readonly<Record<string, string>> | null;
  readonly mcpNames: readonly string[];
  // ── M3-WP1 ──────────────────────────────────────────────────────────────────
  //
  // The NAME and the MODE, and deliberately not the binding: the worker reports
  // `credential` / `home` / `credentialStale` off its own injected binding, so decorating them
  // here would give one worker two answers about what it is running on. What the registry owns is
  // what the REQUEST asked for — which is what has to survive to the wake path and what
  // `CredentialStore.put` reads to answer `restartRequired`.
  /** `null` ⇒ `inherit`; `"none"`'s sentinel is carried as the literal name so a row round-trips. */
  readonly credentialName: string | null;
  readonly homeMode: "isolated" | "shared";
}

/** M1's rows for a worker created before any of this existed, and for a rehydrated one. */
const M1_VIEW: WorkerViewRows = Object.freeze({
  onUnresolved: "deny",
  parkTimeoutMs: null,
  parkTimeoutAction: "deny",
  policy: null,
  policyId: null,
  policySelection: undefined,
  alertOnUnpoliced: [],
  mcp: { requested: [], applied: [], dropped: [] },
  envKeys: [],
  patchMode: "on_write",
  watchdog: null,
  env: null,
  mcpNames: [],
  // An M1/M2 worker was created before any of this existed: it inherited the daemon's
  // environment and had no home, which is what these two say.
  credentialName: null,
  homeMode: "shared",
});

/**
 * The PARSED request — `CreateWorkerRequest`'s exported alias is the `z.input` shape (§5.8.7,
 * Land note S4), so on it `onUnresolved` still reads optional even though `parse` always fills it
 * with `"deny"`. Every default this file depends on is a default `parse` applied, so it reads the
 * output type and the fallbacks stay where the schema put them.
 */
type ParsedCreateWorkerRequest = ReturnType<typeof CreateWorkerRequest.parse>;

/** The states that occupy a `maxWorkers` slot: a worker with a process, or on its way to one. */
const OCCUPIES_A_SLOT: readonly WorkerState[] = ["starting", "ready", "running", "requires_action"];

/**
 * One worker's idle budget: the request's override, else the daemon-wide setting.
 *
 * `0` in either place is "hibernation is off", and it must come back as `null` — a
 * zero-millisecond timer fires immediately, which would hibernate every worker the instant it
 * became ready (`HibernateConfig.idleMs`, `CreateWorkerRequest.idleTimeoutMs`).
 */
function idleBudgetOf(requested: number | undefined, daemonWide: number): number | null {
  const ms = requested ?? daemonWide;
  return ms > 0 ? ms : null;
}

/**
 * M3-WP1's `inherit`, as a value: M2's behaviour, named.
 *
 * `home: null` and an empty `env` mean `toSpawnSpec` composes exactly what it composed before this
 * work package existed, which is the backward-compatibility bar for the whole of it.
 */
const INHERIT_BINDING: CredentialBinding = Object.freeze({
  name: null,
  method: "inherit" as const,
  fingerprint: null,
  home: null,
  env: Object.freeze({}),
});

/** How long `closeAll` waits for the whole fleet before returning anyway (best effort). */
const DEFAULT_CLOSE_ALL_MS = 30_000;

/**
 * A zod failure, as an `OmniError` an in-process caller can catch (D15's library path has no
 * HTTP mapper in front of it). The wire path formats the same failure in `http/errors.ts`; both
 * produce `bad_request`, which is the part §9 fixes.
 */
function badRequest(e: unknown, what: string): OmniError {
  const issues = (e as { issues?: { path?: PropertyKey[]; message?: string }[] } | null)?.issues;
  const first = Array.isArray(issues) ? issues[0] : undefined;
  if (first === undefined) return OmniError.from(e, "bad_request");
  const where = (first.path ?? []).join(".");
  return new OmniError(
    "bad_request",
    `${what}${where === "" ? "" : ` (${where})`}: ${first.message ?? "invalid"}`,
    { cause: e },
  );
}

/**
 * Create / get / list / delete, plus the two counters that make this daemon safe to expose:
 * per-token and global `maxWorkers`, decremented on EVERY close including a crash-close.
 *
 * `get()` throws `worker_not_found` both when the worker is absent and when it is invisible to
 * this token (D13) — a `403` would leak that the id exists.
 *
 * `snapshot` / `prompt` / `cancel` / `turn` / `logFor` are the result-returning façade (review
 * R11): each is `get(id, auth)` plus one call on the handle, and they exist so that an HTTP
 * route is one daemon call rather than a get-then-act orchestration in the adapter — the one
 * place D15 constraint 1 otherwise leaks. In-process callers keep using `get()`.
 */
export function createWorkerRegistry(o: WorkerRegistryOptions): WorkerRegistry {
  const entries = new Map<WorkerId, Entry>();
  const perToken = new Map<TokenId, number>();
  let liveTotal = 0;

  const notFound = (id: WorkerId): never => {
    // The SAME error whether the worker is absent or merely invisible: a 403 here would confirm
    // that the id exists, which is exactly what D13 forbids.
    throw new OmniError("worker_not_found", `worker ${id} not found`);
  };

  /**
   * Check-and-reserve, in ONE synchronous block. Nothing may `await` between the comparison and
   * the increment, or fifty concurrent creates all read the same "one slot left" and spawn fifty
   * agents (H14).
   */
  const reserve = (auth: AuthContext): void => {
    if (liveTotal >= o.config.maxWorkers) {
      throw new OmniError(
        "worker_limit",
        `daemon worker limit reached (${o.config.maxWorkers} live workers)`,
      );
    }
    const mine = perToken.get(auth.tokenId) ?? 0;
    if (mine >= auth.maxWorkers) {
      throw new OmniError(
        "worker_limit",
        `token worker limit reached (${auth.maxWorkers} live workers)`,
      );
    }
    liveTotal += 1;
    perToken.set(auth.tokenId, mine + 1);
  };

  const release = (tokenId: TokenId, entry: Entry | null): void => {
    if (entry !== null) {
      if (!entry.live) return;
      entry.live = false;
    }
    liveTotal = Math.max(0, liveTotal - 1);
    const mine = perToken.get(tokenId) ?? 0;
    if (mine <= 1) perToken.delete(tokenId);
    else perToken.set(tokenId, mine - 1);
  };

  /**
   * Retake a slot a hibernation gave back, WITHOUT re-running the limit check.
   *
   * The check belongs to `wake()`, which must be able to answer `429` before a 7-second `npx`
   * cold start rather than after it. By the time the state actually flips to `starting` the
   * decision is made, and re-checking here would be a second verdict on the same question — the
   * one that fires half-way through a wake and leaves the counters disagreeing with the states.
   */
  const reacquire = (entry: Entry): void => {
    if (entry.live) return;
    entry.live = true;
    liveTotal += 1;
    perToken.set(entry.ownerTokenId, (perToken.get(entry.ownerTokenId) ?? 0) + 1);
  };

  /**
   * Check-and-reserve for a WAKE, in one synchronous block for `reserve()`'s reason: nothing may
   * `await` between the comparison and the increment, or N concurrent wakes all read the same
   * "one slot left" (H14). `Worker.wake()` is single-flight, so this runs once per genuine wake.
   *
   * The per-token quota is charged to the worker's OWNER, not to the caller — a worker belongs
   * to the token that created it, and an admin waking somebody else's worker must not spend
   * their own quota on it or hand the owner an uncounted slot. The owner's `maxWorkers` is not
   * knowable from another token's `AuthContext`, so their quota is only CHECKED when they are
   * the one asking; an admin's wake is bounded by the daemon-wide limit, which is the honest
   * reading of "admin sees and does all" (D13).
   */
  const reserveForWake = (entry: Entry, auth: AuthContext): void => {
    if (entry.live) return;
    if (liveTotal >= o.config.maxWorkers) {
      throw new OmniError(
        "worker_limit",
        `daemon worker limit reached (${o.config.maxWorkers} live workers)`,
      );
    }
    const mine = perToken.get(entry.ownerTokenId) ?? 0;
    if (auth.tokenId === entry.ownerTokenId && mine >= auth.maxWorkers) {
      throw new OmniError(
        "worker_limit",
        `token worker limit reached (${auth.maxWorkers} live workers)`,
      );
    }
    entry.live = true;
    liveTotal += 1;
    perToken.set(entry.ownerTokenId, mine + 1);
  };

  // ── the durable half (§14.8) ──────────────────────────────────────────────

  const store = o.persistence;

  /** This daemon's idle budget for one worker; see `idleBudgetOf`. */
  const idleBudget = (requested: number | undefined): number | null =>
    idleBudgetOf(requested, o.config.hibernate.idleMs);

  /**
   * `WorkerRow` for a live handle. The snapshot is the client-facing half; the rest is what a
   * snapshot does not carry because it is not client-facing (§5.1 `WorkerRow`).
   */
  const rowOf = (entry: Entry, previous?: WorkerRow | null): WorkerRow => {
    // The DECORATED snapshot: a row is what `?since=` and a restart read back, and a persisted
    // snapshot missing the rows a live one carries would make a rehydrated worker look like a
    // different worker (§5.8.4).
    const snapshot = snapshotOf(entry);
    const closeResult = previous?.closeResult ?? null;
    return {
      snapshot,
      agentId: entry.agentId,
      bootId: store?.bootId ?? "",
      closeResult,
      lastActiveMs: o.clock.now(),
      closedAtMs: snapshot.state === "closed" ? (previous?.closedAtMs ?? o.clock.now()) : null,
      // `0` disables hibernation daemon-wide, and it must survive as `null` rather than as a
      // zero-millisecond idle timer that fires immediately on the next boot. The ENTRY's budget
      // wins over the persisted one: `CreateWorkerRequest.idleTimeoutMs` is a per-worker
      // override, and a row written before it was read would pin the daemon-wide value forever.
      hibernateIdleMs: entry.hibernateIdleMs ?? previous?.hibernateIdleMs ?? null,

      // ── M2 (§5.8.8), persisted BECAUSE OF THE WAKE PATH ─────────────────────
      //
      // A `park` worker that hibernated and woke must RE-DECLARE
      // `clientCapabilities.elicitation` or F28 says the agent silently degrades to prose and the
      // park never happens again; `env` / `mcpNames` / `policyRef` are what stop a woken worker
      // from being a different worker wearing the same id. Interactions are deliberately NOT
      // persisted (ruling M2-R10).
      onUnresolved: entry.m2.onUnresolved,
      parkTimeoutMs: entry.m2.parkTimeoutMs,
      parkTimeoutAction: entry.m2.parkTimeoutAction,
      mcpNames: entry.m2.mcpNames,
      policyRef: entry.m2.policyId,
      // The SELECTION, not just the engine id: `policyRef` is an audit trail and cannot rebuild
      // an engine, and a wake that cannot rebuild one runs unenforced (review finding V2/V8).
      policy: entry.m2.policySelection ?? null,
      env: entry.m2.env,
      ...(entry.m2.watchdog === null ? {} : { watchdog: entry.m2.watchdog }),
      patchMode: entry.m2.patchMode,

      // ── M3-WP1, persisted FOR THE SAME REASON the M2 rows above are ──────────
      //
      // A worker that hibernated on a stored credential must WAKE on that credential, and E7 says
      // it must wake into the same home. Neither is derivable: the name is the request's and the
      // home mode decides whether `credentials.homeEnv` is set at all, so a row that carried
      // neither would wake the worker on the daemon's own login with a fresh empty directory —
      // which is the `env` / `mcpNames` failure again, one layer down.
      credentialName: entry.m2.credentialName,
      homeMode: entry.m2.homeMode,
    };
  };

  /**
   * Write the row through, if there is anywhere to write it.
   *
   * NEVER throws: a durable write that fails must not fail the operation that triggered it.
   * §14.3's rule is that the log stays correct in RAM and the failure is REPORTED
   * (`WorkerSnapshot.persistence: "degraded"`, `GET /v1/info.persistence.writeFailures`) rather
   * than turning a working daemon into a broken one.
   */
  const persistRow = (entry: Entry): void => {
    if (store === null || store === undefined) return;
    try {
      const previous = store.workers.get(entry.id);
      store.workers.upsert(rowOf(entry, previous));
    } catch (e) {
      o.logger.warn("persisting a worker row failed", { workerId: entry.id, error: String(e) });
    }
  };

  /**
   * The final row, carrying the `CloseResult` §15.6 level 3 replays byte-for-byte.
   *
   * Recomputing it after a restart would report `treeGone: true` for a tree we never proved gone,
   * which is exactly the optimism §6.6 forbids — so the ONE authoritative result, the one the
   * worker actually produced, is what goes to disk.
   */
  const persistClose = (entry: Entry): void => {
    if (store === null || store === undefined) return;
    void entry.handle.closed.then(
      (closeResult) => {
        try {
          const previous = store.workers.get(entry.id);
          store.workers.upsert({ ...rowOf(entry, previous), closeResult });
        } catch (e) {
          o.logger.warn("persisting a close result failed", {
            workerId: entry.id,
            error: String(e),
          });
        }
      },
      () => {
        // `closed` is documented never to reject; if one ever does, the row from the state
        // listener still stands and DELETE falls back to the pessimistic body.
      },
    );
  };

  /**
   * The event log for one worker: memory, or write-through behind the same ring (ruling M1-R1).
   *
   * `startSeq` seeds `head` on a REHYDRATED worker so `seq` never restarts at 1 after a restart
   * (§14.4, ruling M1-R2) — the bug that quietly forks one worker's history into two.
   */
  const logFor = (workerId: WorkerId, startSeq?: Seq): EventLog => {
    const base = {
      workerId,
      daemonId: o.daemonId,
      clock: o.clock,
      maxEvents: o.config.eventLog.maxEventsPerWorker,
      subscriberQueueSize: o.config.eventLog.subscriberQueueSize,
    };
    if (store === null || store === undefined) return createMemoryEventLog(base);
    return createPersistedEventLog({
      ...base,
      queueSize: o.config.eventLog.subscriberQueueSize,
      store: store.events,
      config: o.config.eventLog,
      logger: o.logger.child({ workerId }),
      ...(startSeq === undefined ? {} : { startSeq }),
    });
  };

  /**
   * ── review finding V2/V8: a WAKE reproduces `create()`'s M2 resolution ──────────────────────
   *
   * The rehydrate path used to build its interaction strategy with `onUnresolved`, the park
   * budgets and `toSubject` — and no `decide` at all, and no `mcpServers`. So a worker adopted
   * from a previous boot and then woken ran on `verdictFor`'s `DEFAULT_VERDICT[onUnresolved]`
   * fallback: no rules, no `clampVerdict`, and §20.5 layer 2 — the per-subject ceiling clamp,
   * which is the half documented as recovering the precision the static check provably cannot —
   * stopped running entirely. Meanwhile `viewRowsOf` kept reporting `{sources, default,
   * ruleCount, ceiling}` for an engine that no longer existed. Concretely: a worker whose policy
   * denies `edit`/`delete` had those requests auto-denied before the restart, and after it every
   * one of them PARKED instead — offering a human the chance to allow exactly what the policy was
   * written to refuse.
   *
   * So both are rebuilt from the CURRENT config, exactly as `create()` builds them, out of the
   * `PolicySelection` and the preset names the row persists. Rebuilding from the current config
   * rather than from a frozen snapshot is the same rule the descriptor, the timeouts and the
   * quirk table already follow on this path (M1-WP-C's `RehydrateDeps` header).
   *
   * FAIL CLOSED, never degrade: a preset that has vanished, a ceiling that is now narrower, or a
   * token that has been removed makes this return `revoked`, and `assertMayResume` then closes
   * the worker with `acl_revoked` — §23.1's answer, and §15.5's 403 row (review R6).
   *
   * An M1-written row (no `onUnresolved` at all) is left exactly as it was: it never had an
   * engine and inventing one would give it a policy it was not created with.
   */
  const reviveM2 = (
    row: WorkerRow,
    rows: WorkerViewRows,
    runtime: Parameters<typeof resolveMcpForWorker>[0]["descriptor"],
    caps: Parameters<typeof resolveMcpForWorker>[0]["caps"],
  ): RevivedM2 => {
    const none: RevivedM2 = { engine: null, mcpServers: [], revoked: null };
    // An M1 row, or a registry with no auth wired (a unit test that builds one directly): there
    // is nothing to rebuild, and both readings are M1 exactly.
    if (row.onUnresolved === undefined) return none;
    const tokens = o.tokens;
    if (tokens === undefined || o.policyFor === undefined) return none;

    try {
      const auth = tokens.contextFor(row.snapshot.ownerTokenId, null);
      const engine = o.policyFor(rows.policySelection, auth, rows.onUnresolved);
      const mcp = resolveMcpForWorker({
        names: rows.mcpNames,
        config: o.config,
        allow: o.config.tokens.find((tk) => tk.id === auth.tokenId)?.mcpPresets ?? [],
        descriptor: runtime,
        caps,
      });
      return { engine, mcpServers: mcp.servers, revoked: null };
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      o.logger.warn("a persisted worker's policy or MCP presets no longer resolve", {
        workerId: row.snapshot.workerId,
        error: why,
      });
      return { engine: null, mcpServers: [], revoked: why };
    }
  };

  /**
   * §14.8: a handle for a worker THIS PROCESS never created, built lazily and memoised.
   *
   * Lazily, because reconstructing every row at startup would make a daemon with 10 000 retained
   * workers take minutes to bind a port, and 99 % of them are closed and will never be asked for.
   * Memoised, because a second construction would give one worker two handles, two logs and two
   * `close()` promises — and the second `close()` is where "DELETE after a restart returns a
   * different body" lives.
   */
  const rehydrate = (row: WorkerRow): Entry | null => {
    if (store === null || store === undefined) return null;
    const workerId = row.snapshot.workerId;
    const existing = entries.get(workerId);
    if (existing !== undefined) return existing;

    const log = logFor(workerId, store.events.headOf(workerId));
    const owner: ClientRef = { tokenId: row.snapshot.ownerTokenId, clientId: null };
    // The ROW's M2 rows, not this boot's defaults: a worker created under `park` must WAKE under
    // `park`, or F28 says the agent silently degrades to prose and the park never happens again
    // (§5.8.8's "persisted BECAUSE OF THE WAKE PATH").
    const rows = viewRowsOf(row);
    const ref: { current: WorkerHandle | null } = { current: null };
    let revived: RevivedM2 = { engine: null, mcpServers: [], revoked: null };
    let handle: WorkerHandle;
    // Hoisted out of the `try` for the `Entry` literal below, on `revived`'s reasoning: a row we
    // could not reconstruct returns no entry at all, and a row we could carries its binding.
    let credentials: BoundCredential | undefined;
    try {
      // From the CURRENT config, never from the row (M1-WP-C's `RehydrateDeps` header): a
      // `cwdRoots`, timeout or quirk-table change between boots must take effect on the worker
      // this boot wakes. `catalog.get` THROWS for an agent the operator has since removed, which
      // the catch below turns into "no handle" rather than a 500 — the same answer the row gets
      // when its log belongs to somebody else.
      const descriptor = o.catalog.get(row.agentId);
      const runtime = o.catalog.descriptor(row.agentId);
      const catalogEntry = o.catalog.list().find((e) => e.id === row.agentId);
      const runtimeId = catalogEntry?.runtimeId;
      // Both of `create()`'s M2 resolutions, redone from THIS boot's config (review V2/V8).
      revived = reviveM2(row, rows, runtime, catalogEntry?.probed?.capabilities ?? null);
      // The ROW's per-worker env, re-applied over THIS boot's composition (§23.3): a woken worker
      // that lost the variables it was created with is a different worker wearing the same id,
      // which is the whole reason `WorkerRow.env` is persisted. `null` there means the request
      // asked for `persist:false`, and then the honest answer is to reproduce nothing.
      /**
       * M3-WP1 on the wake path. The binding is seeded from the PERSISTED view and the store is
       * read once, lazily, by `ensure()` before the wake that needs it — `rehydrate()` is
       * synchronous (§14.8) and resolving a credential is not.
       *
       * The seed is exact rather than a guess: `snapshot.credential` is what this worker was
       * running on when the row was written, and `homeMode` says whether its home exists. What it
       * cannot carry is a token/apiKey SECRET, which is precisely what `ensure()` goes and reads.
       */
      const persistedHome =
        rows.homeMode === "isolated" ? homeDir(o.config.dataDir, row.snapshot.workerId) : null;
      const seeded: CredentialBinding = {
        name: row.snapshot.credential?.name ?? rows.credentialName,
        method: row.snapshot.credential?.method ?? "inherit",
        fingerprint: row.snapshot.credential?.fingerprint ?? null,
        home: persistedHome,
        env: {},
      };
      credentials = credentialBindingFor({
        workerId,
        agentId: row.agentId,
        tokenId: row.snapshot.ownerTokenId,
        homeMode: rows.homeMode,
        initial: seeded,
        name: rows.credentialName,
        // The store has NOT been read: `ensure()` is what does that, before the wake.
        needsBind: o.credentials !== undefined,
        entryOf: () => entries.get(workerId),
      });
      const toSpawnSpec = (d: AgentDescriptor, opts: { cwd: string }): SpawnSpec =>
        o.catalog.toSpawnSpec(d, {
          ...opts,
          home: credentials?.current().home ?? null,
          credentialEnv: credentials?.current().env ?? {},
        });
      const spec = toSpawnSpec(descriptor, { cwd: row.snapshot.cwd });
      handle = createRehydratedWorker(row, log, {
        descriptor: { ...descriptor, env: { ...spec.env, ...(rows.env ?? {}) } },
        supervisor: o.supervisor,
        // `session` is required by `RehydrateDeps`; without an injected strategy the rehydrated
        // worker uses the same inline handshake `worker.ts` falls back to, and M1-WP-C's
        // `createRehydratedWorker` is the one that knows how to say that.
        session: o.session as SessionStrategy,
        // Unheld, per ruling M1-R8 — but resuming the row's EPOCH, so rule L7's counter stays
        // monotonic across the restart. See `leaseFor`.
        lease: leaseFor(null, workerId, log, row.snapshot.lease.epoch),
        clock: o.clock,
        ids: o.ids,
        logger: o.logger.child({ workerId, agent: row.agentId, rehydrated: true }),
        // The same four `create()` builds, for the same reasons: a woken worker maps its updates
        // through the resolved descriptor, answers permissions through the daemon's one wired
        // responder, and takes its budgets from this boot's config.
        normalizer: createNormalizer({
          quietMs: o.config.turn.quietMs,
          hardMs: o.config.turn.hardMs,
          drainGraceMs: o.config.turn.drainGraceMs,
          cancelGraceMs: o.config.turn.cancelGraceMs,
          descriptor: runtime,
          ids: { synth: (prefix: string) => `${prefix}_${o.ids.request()}` },
          // The row's `capabilities` are the PERSISTED ones until this worker wakes and
          // handshakes again, at which point the handle carries the fresh catalogue. Reading
          // through the entry each time is what makes both true without a second thunk.
          modes: () => entries.get(workerId)?.handle.snapshot().capabilities?.modes ?? null,
          cwd: row.snapshot.cwd,
        }),
        responder: o.responder,
        limits: {
          handshakeTimeoutMs: o.config.handshakeTimeoutMs,
          cancelGraceMs: o.config.turn.cancelGraceMs,
          exitGraceMs: o.config.supervisor.exitGraceMs,
          gracefulMs: o.config.supervisor.gracefulMs,
          wakeTimeoutMs: o.config.hibernate.wakeTimeoutMs,
          maxWakeFailures: o.config.hibernate.maxWakeFailures,
          ...(rows.parkTimeoutMs === null ? {} : { parkTimeoutMs: rows.parkTimeoutMs }),
          diffTimeoutMs: o.config.diff.timeoutMs,
        },
        runtime,
        ...(runtimeId === undefined ? {} : { runtimeId }),
        toSpawnSpec,
        ...(credentials === undefined ? {} : { credentials }),
        owner,
        // ── M2's seams, rebuilt from the ROW (M2-WP-J) ───────────────────────
        ...(() => {
          // Narrowed ONCE, out of the mutable holder, so `decide` closes over a non-null engine.
          const engine = revived.engine;
          const strategy = o.interactions?.({
            workerId,
            clock: o.clock,
            ids: o.ids,
            logger: o.logger.child({ workerId, agent: row.agentId, rehydrated: true }),
            config: o.config.interaction,
            onUnresolved: rows.onUnresolved,
            parkTimeoutMs: rows.parkTimeoutMs,
            parkTimeoutAction: rows.parkTimeoutAction,
            responder: o.responder,
            // The half that was missing: without it a woken worker enforced nothing at all
            // (review finding V2/V8). Same line as the create path, same engine, same clamp.
            ...(engine === null
              ? {}
              : { decide: (subject: PolicySubject) => engine.decide(subject) }),
            log,
            workerState: () => ref.current?.snapshot().state ?? "hibernated",
            toSubject: (r) =>
              toPolicySubject(r, {
                cwd: row.snapshot.cwd,
                agentId: row.agentId,
                realpath,
              }),
          });
          const budgets = rows.watchdog === null ? null : watchdogBudgets(o.config, rows.watchdog);
          // The same holder trick the create path uses: §21.5's audit line reports how many tool
          // calls were open when the budget was spent, and the watchdog is the only thing that
          // knows — so it has to be readable from inside the callback it was built with.
          const armed: { current: Watchdog | null } = { current: null };
          const watchdog =
            o.watchdog === undefined || budgets === null || !budgets.enabled
              ? undefined
              : o.watchdog({
                  workerId,
                  clock: o.clock,
                  config: budgets,
                  onFire: (budget) => {
                    fireWatchdog({
                      budget,
                      log,
                      config: budgets,
                      handle: ref.current,
                      openToolCalls: armed.current?.verdict.openToolCalls.length ?? 0,
                      logger: o.logger.child({ workerId }),
                    });
                  },
                });
          armed.current = watchdog ?? null;
          return {
            ...(strategy === undefined
              ? {}
              : { interactions: strategy, clientCapabilities: strategy.clientCapabilities }),
            ...(watchdog === undefined ? {} : { watchdog }),
            ...(rows.patchMode === "off" || o.diff === undefined ? {} : { diff: o.diff }),
            // §23.1: a woken worker reopens its session with the SAME presets it was created
            // with, resolved against the current config. It used to reopen with `mcpServers: []`.
            ...(revived.mcpServers.length === 0 ? {} : { mcpServers: revived.mcpServers }),
            ...(engine === null || engine.alertOnUnpoliced.length === 0
              ? {}
              : { alertOnUnpoliced: engine.alertOnUnpoliced }),
            // §26.2's gate, on the wake path too: a woken worker takes prompts, and a prompt is
            // exactly where an out-of-root `resource_link` would arrive.
            validateContent: async (content: readonly unknown[]) => {
              await assertPromptContent({
                content,
                cwd: row.snapshot.cwd,
                cwdRoots: cwdRootsOf(o, row.snapshot.ownerTokenId),
                promptCapabilities:
                  ref.current?.snapshot().capabilities?.promptCapabilities ?? null,
                realpath,
              });
            },
          };
        })(),
      });
      ref.current = handle;
    } catch (e) {
      // A row we cannot reconstruct is not a 500 on `GET /v1/workers`: the row is still visible
      // through `list()` (which reads the store directly and needs no handle), and the honest
      // answer to "give me a handle for it" is that we could not build one.
      o.logger.warn("rehydrating a persisted worker failed", { workerId, error: String(e) });
      log.close();
      return null;
    }

    const entry: Entry = {
      id: workerId,
      handle,
      ownerTokenId: row.snapshot.ownerTokenId,
      subscription: subscribeFanOut(workerId, log),
      // A `closed` row pre-resolves its close with the PERSISTED `CloseResult` inside `Worker`
      // (§15.6), so re-using `entry.closing` keeps DELETE byte-for-byte idempotent across a
      // restart without a second implementation.
      closing: null,
      // A rehydrated worker holds a slot only if its state says it has a process. A `hibernated`
      // or `closed` row does not, which is what makes hibernated workers bounded separately (H14).
      live: false,
      agentId: row.agentId,
      offStateChange: null,
      // The budget the row was created with, so a per-worker `idleTimeoutMs` survives a restart.
      // A row from a boot that never recorded one falls back to this boot's daemon-wide value.
      hibernateIdleMs: row.hibernateIdleMs ?? idleBudget(undefined),
      // From the ROW, so a worker that hibernated under `park` wakes under `park` (F28/F42). A
      // row written by an M1 boot carries none of them and reads as M1, which is the honest
      // answer for a worker that was created before any of this existed.
      //
      // `policy` and `alertOnUnpoliced` come from the REBUILT engine and not from the persisted
      // snapshot: a snapshot that advertises `{sources, default, ruleCount, ceiling}` for an
      // engine nothing rebuilt is exactly the lie review finding V2/V8 names, so a worker with no
      // `decide` reports no policy.
      m2: {
        ...rows,
        policy: revived.engine?.snapshot ?? null,
        policyId: revived.engine?.id ?? rows.policyId,
        alertOnUnpoliced: revived.engine?.alertOnUnpoliced ?? [],
      },
      revoked: revived.revoked,
      credentials,
      idleTimer: null,
    };
    if (OCCUPIES_A_SLOT.includes(row.snapshot.state)) reacquire(entry);
    entries.set(workerId, entry);
    watchEntry(entry);

    /**
     * The same close bookkeeping `create()` attaches, because a rehydrated worker has no
     * `create()` frame to have attached it in.
     *
     * Without this, closing a worker adopted from a previous boot would leak its `maxWorkers`
     * slot for the life of the daemon, and its fan-out subscription with it. On the PROMISE
     * rather than on the state transition, so the `omni.worker_state{closed}` envelope reaches
     * every subscriber first (§8.4).
     */
    const onClosed = (): void => {
      release(entry.ownerTokenId, entry);
      entry.subscription?.close();
      // The lease owns a TTL expiry timer (`lease.ttlMs`, 15 min by default). Nothing else
      // cancels it once the worker is gone, and a live `setTimeout` keeps an embedded daemon's
      // process alive for the rest of the TTL after `stop()` has returned.
      entry.handle.lease.close();
      persistClose(entry);
    };
    void handle.closed.then(onClosed, onClosed);

    return entry;
  };

  const subscribeFanOut = (workerId: WorkerId, log: EventLog): Subscription | null =>
    o.onEnvelope === undefined
      ? null
      : log.subscribe(0, (envelope) => {
          try {
            o.onEnvelope?.(workerId, envelope);
          } catch (e) {
            o.logger.warn("daemon event listener threw", { workerId, error: String(e) });
          }
        });

  /**
   * Keep the counters and the durable row in step with the worker's own state machine.
   *
   * The registry does not DECIDE any of these transitions — `Worker` does — it only observes
   * them, which is what keeps hibernation's ordering argument (§15.2) inside the one class that
   * can make it.
   */
  /**
   * §15.2's idle timer, armed HERE because this is the only place that knows both the worker's
   * budget and its state transitions.
   *
   * `createHibernateTimer` is M1-WP-C's and is pure over an injected clock; the registry supplies
   * the three things it cannot know — whether this worker's agent advertises a resume spelling
   * (read at FIRE TIME, because the handshake may not have happened when the timer was built),
   * what `hibernate.whenNotResumable` says, and what "hibernate" actually does.
   *
   * The transition itself is `Worker.hibernate()`'s, so every ordering rule in §15.2 stays inside
   * the one class that can make it. A refusal here is not an error: a turn that started between
   * the timer firing and the call landing answers `worker_busy`, and the next `turn_end` re-arms.
   */
  const armIdleTimer = (entry: Entry): void => {
    const idleMs = entry.hibernateIdleMs;
    if (idleMs === null || idleMs <= 0) return;
    const logger = o.logger.child({ workerId: entry.id, component: "hibernate-timer" });
    entry.idleTimer = createHibernateTimer({
      clock: o.clock,
      idleMs,
      logger,
      // Ruling M1-R15's gate. `resume.method === null` is an agent that told us it cannot resume;
      // hibernating it would turn a healthy worker into a guaranteed 422 on a timer.
      resumable: () => entry.handle.snapshot().capabilities?.resume.method !== null,
      whenNotResumable: o.config.hibernate.whenNotResumable,
      onNotResumable: () => {
        void entry.handle.close("idle_timeout").catch((e: unknown) => {
          logger.warn("closing an idle non-resumable worker failed", { error: String(e) });
        });
      },
      onFire: () => {
        // `maxHibernated` is the registry's bound, not the worker's, so it is checked here for
        // the same reason `hibernate(id, auth)` checks it: the transition reclaims a process tree
        // and there is no undo.
        if (countHibernated() >= o.config.hibernate.maxHibernated) {
          logger.info("idle timer fired but the hibernated-worker limit is reached", {
            maxHibernated: o.config.hibernate.maxHibernated,
          });
          return;
        }
        void entry.handle.hibernate("idle_timeout").catch((e: unknown) => {
          // Every refusal edge is legitimate: `worker_busy` (a turn started first),
          // `not_resumable` (the agent advertises no spelling), `worker_closed` (it went away).
          // None of them is worth failing anything over — the next turn boundary re-arms.
          logger.debug("idle hibernation was refused", { error: String(e) });
        });
      },
    });
    entry.idleTimer.touch();
  };

  const watchEntry = (entry: Entry): void => {
    armIdleTimer(entry);
    entry.offStateChange = entry.handle.onStateChange((state) => {
      // The idle countdown NEVER runs across a live turn (§15.2): `pause()` while the worker is
      // busy or asleep, `touch()` on every return to `ready`, `cancel()` once it is gone.
      if (state === "ready") entry.idleTimer?.touch();
      else if (state === "closed") entry.idleTimer?.cancel();
      else entry.idleTimer?.pause();

      if (state === "hibernated") {
        // A hibernated worker owns NO process, so it must not hold a `maxWorkers` slot (H14).
        // It is bounded by `hibernate.maxHibernated` instead, enforced in `wake`/`hibernate`.
        //
        // `closed` is deliberately NOT handled here: the slot comes back on the `handle.closed`
        // PROMISE, which resolves after the `omni.worker_state{closed}` envelope has been
        // appended and fanned out. Releasing on the state transition would be a few
        // microseconds earlier and would tempt a future edit to close the subscription here
        // too — which is exactly how §8.4's closing envelope gets dropped.
        release(entry.ownerTokenId, entry);
      } else if (OCCUPIES_A_SLOT.includes(state)) {
        reacquire(entry);
      }
      persistRow(entry);
    });
  };

  /** Live hibernated workers, plus persisted hibernated rows this process has not rehydrated. */
  const countHibernated = (): number => {
    let count = 0;
    const seen = new Set<WorkerId>();
    for (const entry of entries.values()) {
      seen.add(entry.id);
      if (entry.handle.snapshot().state === "hibernated") count += 1;
    }
    if (store === null || store === undefined) return count;
    try {
      for (const row of store.workers.list()) {
        if (seen.has(row.snapshot.workerId)) continue;
        if (row.snapshot.state === "hibernated") count += 1;
      }
    } catch (e) {
      o.logger.warn("counting hibernated rows failed", { error: String(e) });
    }
    return count;
  };

  /**
   * `get()`, plus §14.8's lazy rehydration.
   *
   * The visibility check runs against the SNAPSHOT in both paths, so a persisted worker is
   * exactly as invisible to a foreign token as a live one — and answers the same
   * `worker_not_found`, never a `403` that would confirm the id exists (D13).
   */
  /**
   * The snapshot as everything OUTSIDE this file sees it: the worker's own rows, plus the M2 rows
   * only the registry knows (§5.8.4).
   */
  const snapshotOf = (entry: Entry): WorkerSnapshot => decorate(entry.handle.snapshot(), entry.m2);

  /**
   * ONE decorated handle per entry, memoised — so `create()` and `get()` hand back the same
   * object and an identity comparison between them still holds.
   */
  const views = new Map<WorkerId, WorkerHandle>();
  const viewOf = (entry: Entry): WorkerHandle => {
    const existing = views.get(entry.id);
    if (existing !== undefined) return existing;
    const view = decorateHandle(entry.handle, () => snapshotOf(entry));
    views.set(entry.id, view);
    return view;
  };

  const get = (id: WorkerId, auth: AuthContext): WorkerHandle => {
    const entry = lookup(id, auth);
    if (entry === null) return notFound(id);
    return viewOf(entry);
  };

  const lookup = (id: WorkerId, auth: AuthContext): Entry | null => {
    const live = entries.get(id);
    if (live !== undefined) return auth.canSee(live.handle.snapshot()) ? live : null;

    if (store === null || store === undefined) return null;
    let row: WorkerRow | null;
    try {
      row = store.workers.get(id);
    } catch (e) {
      o.logger.warn("reading a persisted worker row failed", { workerId: id, error: String(e) });
      return null;
    }
    if (row === null) return null;
    // The ACL is checked BEFORE anything is constructed: a foreign token must not be able to make
    // this daemon build a handle (and open an event log) for a worker it cannot see.
    if (!auth.canSee(row.snapshot)) return null;
    return rehydrate(row);
  };

  /**
   * H14's second sentence: "A wake also re-runs the full ACL check against the current config —
   * a restart must not resurrect a worker the present ACL forbids (§15.7)."
   *
   * `create()` is not the only door a process comes through. A hibernated worker (or one adopted
   * by boot recovery) is resurrected by `wake` — and by `prompt`, which auto-wakes inside
   * `Worker.prompt` — with the descriptor taken from the CURRENT config but the agent id and cwd
   * taken from the ROW. `lookup()` only answers D13's visibility question ("is this the token's
   * own worker"), which a narrowed allowlist does not change: the operator who removes
   * `claude-acp` from token `t`'s `agents`, or drops `/srv/a` from its `cwdRoots`, and reloads,
   * would otherwise still see `t` spawn that exact agent in that exact directory.
   *
   * `assertCwd` re-`realpath`s, so a cwd that has since been deleted or symlinked out of the
   * roots fails closed too — §15.7's intended answer, and the reason this is not a cached check.
   *
   * It runs BEFORE `reserveForWake`, so a 403 costs neither a slot nor an `npx` cold start.
   */
  const assertMayResume = async (entry: Entry, auth: AuthContext): Promise<void> => {
    /**
     * §23.1's row, implemented (review finding V2/V8): "a preset that vanished from config between
     * hibernate and wake ⇒ `acl_revoked`". It sits FIRST, above the agent and cwd checks, because
     * it is the same class of refusal — the current config forbids this worker — and because
     * waking it would be waking it UNENFORCED, which is the outcome the whole finding is about.
     *
     * The worker is CLOSED rather than left hibernated: it can never be resumed under this
     * config, and a row that answers 403 forever on every wake is a row an operator has to reap
     * by hand. `acl_revoked` maps to `forbidden` (§9's table), which is §15.5's own 403 row.
     */
    const revoked = entry.revoked;
    if (revoked !== null) {
      await closeEntry(entry, "acl_revoked").catch((e: unknown) => {
        o.logger.warn("closing a worker whose config no longer resolves failed", {
          workerId: entry.id,
          error: String(e),
        });
      });
      throw new OmniError(
        "forbidden",
        `worker ${entry.id} cannot be resumed under the current configuration: ${revoked}`,
      );
    }
    auth.assertAgent(entry.agentId);
    await auth.assertCwd(entry.handle.snapshot().cwd);
    /**
     * M3-WP1, and it sits with the other two re-checks for the same reason: a wake reproduces the
     * environment the worker was created in, and the credential is part of that environment.
     *
     * `ensure()` is what reads the store for a worker THIS BOOT DID NOT CREATE — `rehydrate()` is
     * synchronous and cannot — and it rebuilds the home links, so a worker that slept through a
     * credential rotation wakes on the CURRENT credential rather than on a fingerprint it
     * remembered. It runs before `reserveForWake`, so a `422 credential_expired` costs neither a
     * slot nor a cold start, exactly like the two checks above.
     */
    await entry.credentials?.ensure();
  };

  const closeEntry = (entry: Entry, reason: WorkerCloseReason): Promise<CloseResult> => {
    entry.closing ??= entry.handle.close(reason);
    return entry.closing;
  };

  /**
   * §15.6 level 3: `DELETE` on a worker that closed in a PREVIOUS boot.
   *
   * The row says `closed`, so there is nothing to close and no process to reclaim — and the
   * persisted `CloseResult` is returned VERBATIM rather than recomputed, because recomputing it
   * would report `treeGone: true` for a tree we never proved gone (§6.6). Returning `null` means
   * "not this case"; the caller falls through to the ordinary path.
   *
   * No handle is constructed at all, which is the point: constructing one to ask it for a body we
   * already have on disk is where the "DELETE after a restart returns a different body" bug
   * comes from.
   */
  const deleteAcrossRestart = (id: WorkerId, auth: AuthContext): CloseResult | null => {
    if (store === null || store === undefined) return null;
    if (entries.has(id)) return null;
    let row: WorkerRow | null;
    try {
      row = store.workers.get(id);
    } catch {
      return null;
    }
    if (row === null || row.snapshot.state !== "closed") return null;
    if (!auth.canSee(row.snapshot)) return notFound(id);
    if (row.closeResult !== null) return row.closeResult;

    // A boot that crashed mid-close left the row `closed` with no result. The fallback is
    // deliberately PESSIMISTIC on both ownership fields: we did not see the tree go, so we do
    // not claim it did.
    return {
      workerId: id,
      state: "closed",
      reason: row.snapshot.closeReason ?? "daemon_shutdown",
      leaderExited: false,
      treeGone: false,
      sessionClosed: false,
    };
  };

  /** Seam 3's one call site. The default IS M0: `alwaysGrantedLease` grants every `assertHolder`. */
  /**
   * `owner === null` means the worker is created lease-FREE, which is two things at once:
   * `CreateWorkerRequest.lease: "observe"`, and — the one that matters here — a worker
   * REHYDRATED from a previous boot.
   *
   * Ruling M1-R8: the lease is not persisted across a restart, because a lease over a process
   * that no longer exists is meaningless. Seeding a rehydrated worker's lease with the row's
   * owner instead would make it `{tokenId, clientId: null}` — the token's DEFAULT client — and
   * every SDK client mints a ULID per `connect()` (§16.1 rule L4), so no client could ever match
   * it: a restarted worker would answer `423` to its own owner forever. Starting unheld lets
   * rule L5's implicit acquire do exactly what it is for.
   *
   * The EPOCH is the half that DOES survive, and it is a fourth argument rather than a revived
   * holder: rule L7 makes the epoch monotonic per worker, and boot adoption has already written
   * `snapshot.lease.epoch + 1` both into the row and into the in-band
   * `omni.lease{op:"expired", how:"daemon_restart"}` envelope a reconnecting client reads at its
   * next `?since=` seq. Restarting the count at 0 would re-issue numbers this worker's own log
   * has already spent — a replay reading 1 → 2 → 1, and an `isStaleEpoch` (exact equality) that
   * accepts a fence minted before the crash.
   */
  /**
   * M3-WP1. The per-worker `WorkerCredentialBinding` handed to `createWorker`, and the ONE place
   * a credential is re-resolved for a live worker.
   *
   * It closes over the ENTRY rather than over a value, because `setCredential` has to make three
   * things agree: what the worker reports (the binding it returns), what the persisted row says
   * (so a wake reproduces it), and what a later `CredentialStore.put` counts as linked (so
   * `restartRequired` names this worker). A binding that only updated the first would leave a
   * woken worker on the credential it had before the swap.
   *
   * `auth` is rebuilt from the token store per call, because nobody holds an `AuthContext` across
   * a restart (ruling M1-R8) and a rotation is exactly the operation that may outlive the client
   * that started it.
   */
  const credentialBindingFor = (spec: {
    workerId: WorkerId;
    agentId: string;
    tokenId: TokenId;
    homeMode: "isolated" | "shared";
    initial: CredentialBinding;
    /** The NAME to re-resolve from, for a worker this boot did not create. */
    name: string | null;
    /** true ⇒ `initial` came off a persisted row and the store has not been read yet. */
    needsBind: boolean;
    entryOf: () => Entry | undefined;
  }): BoundCredential | undefined => {
    const layer = o.credentials;
    if (layer === undefined) return undefined;
    let current = spec.initial;
    let pending = spec.needsBind;
    const contextFor = (): AuthContext => {
      const auth = o.tokens?.contextFor(spec.tokenId, null);
      if (auth === undefined) {
        throw new OmniError(
          "bad_request",
          "this registry was built without a token store, so a credential cannot be resolved",
        );
      }
      return auth;
    };
    const bind = async (name: string | null): Promise<CredentialBinding> => {
      const next = await layer.bind({
        auth: contextFor(),
        agentId: spec.agentId,
        requested: name ?? undefined,
        workerId: spec.workerId,
        home: spec.homeMode,
      });
      current = next;
      pending = false;
      const entry = spec.entryOf();
      if (entry !== undefined && entry.m2.credentialName !== next.name) {
        // The ROW, so a wake reproduces the NEW credential — and the registry's own index, so the
        // next `CredentialStore.put` on that name counts this worker.
        entry.m2 = { ...entry.m2, credentialName: next.name };
        persistRow(entry);
      }
      return next;
    };
    return {
      /**
       * §14.8's lazy rehydration, applied to the credential.
       *
       * `rehydrate()` is SYNCHRONOUS — it is called from `lookup()`, which is — while resolving a
       * credential reads the store and relinking a home writes the filesystem. So a worker this
       * boot did not create starts on the PERSISTED view (name, method and fingerprint off
       * `snapshot.credential`, home off the row's `homeMode`), which is exactly what it was
       * running on when the row was written, and the store is read once, HERE, before the wake
       * that needs it. Every caller of this is already async and already ahead of a spawn.
       *
       * A no-op for a worker this boot created, and a no-op on every call after the first.
       */
      async ensure(): Promise<void> {
        if (!pending) return;
        await bind(spec.name);
      },
      // The descriptor's MEASURED answer. Absent contract ⇒ `"file"`, which is the harmless
      // reading: there is no credential to reload, so nothing needs a restart.
      reload: layer.contractFor(spec.agentId)?.reload ?? "file",
      current: () => current,
      relink: (name: string) => bind(name),
    };
  };

  const leaseFor = (
    owner: ClientRef | null,
    workerId: WorkerId,
    log: EventLog,
    initialEpoch?: number,
  ): Lease =>
    o.leaseFactory?.(owner, workerId, log, initialEpoch) ??
    alwaysGrantedLease(owner ?? { tokenId: "", clientId: null }, workerId);

  return {
    /** Live workers — the number `maxWorkers` is compared against. A closed worker holds no slot. */
    get size(): number {
      return liveTotal;
    },

    async create(request, auth, signal): Promise<WorkerHandle> {
      let req: ParsedCreateWorkerRequest;
      try {
        req = CreateWorkerRequest.parse(request);
      } catch (e) {
        throw badRequest(e, "invalid worker request");
      }

      // ACL before catalog: a token that may not use an agent learns nothing about whether that
      // agent exists on this machine. Both precede the limit check, so a forbidden request is
      // never reported as a quota problem.
      auth.assertAgent(req.agent);
      const descriptor = o.catalog.get(req.agent);
      const cwd = await auth.assertCwd(req.cwd);

      // The RESOLVED quirk table (§17.2) and the descriptor identity that goes on every envelope.
      // `runtimeId` is taken from the catalog ENTRY rather than recomputed, so the value in the
      // log is the same string `GET /v1/agents` publishes — two computations of one identity is
      // how a log and a catalog come to disagree about which quirk table ran.
      const runtime = o.catalog.descriptor(req.agent);
      const catalogEntry = o.catalog.list().find((e) => e.id === req.agent);
      const runtimeId = catalogEntry?.runtimeId;

      // ── M2's per-request resolution, ALL of it BEFORE a slot or a process ────
      //
      // Every line here can refuse the request, and each refusal is cheaper than the spawn it
      // precedes: a `403 policy_exceeds_ceiling` raised after `npx` has started is a ceiling
      // enforced after the agent was already running in the user's repository (§20.5). The same
      // argument is why the env gate rejects a blacklisted key by NAME rather than dropping it
      // (§23.3, ruling M2-R12), and why an unknown MCP preset is a `400` naming it (§23.1).
      const engine = o.policyFor?.(req.policy, auth, req.onUnresolved) ?? null;
      const env = auth.assertEnv(req.env);
      const mcp: McpResolution = resolveMcpForWorker({
        names: req.mcp,
        config: o.config,
        allow: o.config.tokens.find((t) => t.id === auth.tokenId)?.mcpPresets ?? [],
        descriptor: runtime,
        // The CACHED probe's capabilities when this agent has been probed, and `null` otherwise —
        // which is "we have not handshaken yet" and is a different fact from an agent that
        // declared an empty block. Only the descriptor decides what to do about it (§23.2).
        caps: catalogEntry?.probed?.capabilities ?? null,
      });

      /**
       * M3-WP1's CREATE-TIME VALIDATION (§Home 隔离: 创建时校验 … 不要等第一个 prompt).
       *
       * It sits with M2's per-request resolution above and BEFORE `reserve`, for that block's own
       * reason: every refusal here is cheaper than the spawn it precedes. A worker whose
       * credential is missing would otherwise handshake fine and fail on the first prompt —
       * `-32000 Authentication required` on claude-acp (measured) or a `session/new` failure on
       * codex-acp (measured) — which is a 502 from the agent for something the daemon already
       * knew, minus a ~7 s `npx` cold start and a `maxWorkers` slot.
       */
      await o.credentials?.validate({ auth, agentId: req.agent, requested: req.credential });

      reserve(auth);
      const workerId = o.ids.worker();
      const logger = o.logger.child({ workerId, agent: req.agent });

      const log = logFor(workerId);

      // Subscribed BEFORE the handshake, from seq 0, so `daemon.on(...)` sees a worker's whole
      // life — including the `starting` envelope and a handshake that fails.
      const subscription = subscribeFanOut(workerId, log);

      /**
       * M3-WP1. The home and the link, built AFTER the id exists and BEFORE the spawn.
       *
       * `<dataDir>/homes/<workerId>` is the worker's own, at 0700, and the credential file inside
       * it is a SYMLINK to the store's canonical copy — never a copy, because E3 says the agent
       * refreshes its own token and a copy would diverge from the source within hours while a
       * link writes through to the one file every other worker reads.
       *
       * With no layer wired this is `null` and everything below composes M2's environment exactly.
       */
      const credentialBinding =
        o.credentials === undefined
          ? null
          : await o.credentials.bind({
              auth,
              agentId: req.agent,
              requested: req.credential,
              workerId,
              home: req.home ?? "isolated",
            });
      const credentials = credentialBindingFor({
        workerId,
        agentId: req.agent,
        tokenId: auth.tokenId,
        homeMode: req.home ?? "isolated",
        initial: credentialBinding ?? INHERIT_BINDING,
        name: credentialBinding?.name ?? null,
        // This boot BUILT the home a moment ago, so there is nothing to read back.
        needsBind: false,
        entryOf: () => entries.get(workerId),
      });

      /**
       * `toSpawnSpec` composes the credential environment — the home env var and, for a token /
       * apiKey credential, the variable the descriptor declares — because `SpawnSpec.env` is
       * documented as COMPLETE and a second composer is how the create path and the wake path come
       * to spawn one worker with two different environments.
       *
       * This closure is what threads it onto BOTH: `worker.ts` calls `deps.toSpawnSpec` on create,
       * on wake and on restart, and it passes only a cwd.
       */
      const toSpawnSpec = (d: typeof descriptor, opts: { cwd: string }): SpawnSpec =>
        o.catalog.toSpawnSpec(d, {
          ...opts,
          home: credentialBinding?.home ?? null,
          credentialEnv: credentials?.current().env ?? {},
        });
      const spec = toSpawnSpec(descriptor, { cwd });

      /**
       * The handshake's `modes` catalogue, read LAZILY (M1-WP-B's `NormalizerOptions.modes`).
       *
       * §12.3 row 11 synthesizes the `mode` config option from it, and without it the map emits
       * `options: []` — honest, but empty. The catalogue only exists after `session/new`, which
       * is after the Normalizer is constructed, so the thunk closes over the handle this
       * `createWorker` is about to return. Every `mapUpdate` that could read a non-empty answer
       * runs after that assignment; the replay between a `session/load` request and its response
       * is the one window where it is still null, and `options: []` is the right answer there.
       */
      let built: WorkerHandle | null = null;
      const modesOf = (): Readonly<Record<string, unknown>> | null =>
        built?.snapshot().capabilities?.modes ?? null;

      // ── the four worker seams, composed from what the request asked for ──────
      const parkTimeoutMs = req.parkTimeoutMs ?? o.config.interaction.parkTimeoutMs;
      const parkTimeoutAction = req.parkTimeoutAction ?? o.config.interaction.parkTimeoutAction;
      const strategy = o.interactions?.({
        workerId,
        clock: o.clock,
        ids: o.ids,
        logger,
        config: o.config.interaction,
        onUnresolved: req.onUnresolved,
        parkTimeoutMs,
        parkTimeoutAction,
        responder: o.responder,
        // SEAM A's one difference from the baseline (M2-PLAN §1.3): with no engine the strategy
        // falls back to the request's own `onUnresolved`, which is M2-A shipping without M2-B.
        ...(engine === null ? {} : { decide: (subject: PolicySubject) => engine.decide(subject) }),
        log,
        workerState: () => built?.snapshot().state ?? "starting",
        // The subject is built HERE because it needs the worker's cwd and a realpath — §20.3's
        // "realpath FIRST, then match", so a rule for `src/**` cannot be evaded by a symlink.
        toSubject: (r) => toPolicySubject(r, { cwd, agentId: req.agent, realpath }),
      });

      // A holder, because §21.5's ladder has to read the watchdog's own verdict from INSIDE the
      // callback the watchdog is constructed with.
      const watchdogRef: { current: Watchdog | null } = { current: null };
      const budgets = watchdogBudgets(o.config, req.watchdog);
      // Built only when the RESOLVED budgets say so: `WorkerSnapshot.watchdog` is `null` both for
      // "nothing injected" and for "disabled", which is the one thing a client cannot tell apart
      // and does not need to — neither will ever cancel a turn (§5.8.4).
      const watchdog =
        o.watchdog === undefined || !budgets.enabled
          ? undefined
          : o.watchdog({
              workerId,
              clock: o.clock,
              config: budgets,
              // §21.5's ladder, and its ORDER is the contract: `omni.error{agent_timeout}` first,
              // because that is what makes `reduceTurn`'s verdict `failed` and what a `?since=`
              // reader sees; then the state envelope; and only then is the agent touched.
              onFire: (budget) => {
                fireWatchdog({
                  budget,
                  log,
                  config: budgets,
                  handle: built,
                  openToolCalls: watchdogRef.current?.verdict.openToolCalls.length ?? 0,
                  logger,
                });
              },
            });
      // A holder, because the ladder above has to read the watchdog's own verdict from inside the
      // callback the watchdog was constructed with.
      watchdogRef.current = watchdog ?? null;

      // D8: ONE provider per daemon, and `patch:"off"` is a worker opting out of it entirely —
      // expressed by not injecting it, which is the same code path as a daemon with no provider.
      const patchMode = req.patch ?? o.config.diff.mode;
      const diff = patchMode === "off" ? undefined : o.diff;

      const view: WorkerViewRows = {
        onUnresolved: req.onUnresolved,
        parkTimeoutMs: parkTimeoutMs === 0 ? null : parkTimeoutMs,
        parkTimeoutAction,
        policy: engine?.snapshot ?? null,
        policyId: engine?.id ?? null,
        policySelection: req.policy,
        alertOnUnpoliced: engine?.alertOnUnpoliced ?? [],
        mcp: { requested: req.mcp ?? [], applied: mcp.applied, dropped: mcp.dropped },
        envKeys: env.keys,
        patchMode,
        watchdog: budgets.enabled
          ? {
              silentMs: budgets.silentMs,
              toolMs: budgets.toolMs,
              cancelTimeoutMs: budgets.cancelTimeoutMs,
            }
          : null,
        // §23.3: `persist:false` trades hibernation for the exposure, and the way it does that is
        // by NOT writing the map — a woken worker must never inherit an environment silently.
        env: env.persist ? env.env : null,
        mcpNames: req.mcp ?? [],
        // M3-WP1: what the REQUEST resolved to, for the wake path and for `restartRequired`.
        credentialName: credentialBinding?.name ?? null,
        homeMode: credentialBinding?.home === null ? "shared" : (req.home ?? "isolated"),
      };

      try {
        const handle = await createWorker(
          {
            workerId,
            daemonId: o.daemonId,
            // The COMPLETE environment, composed by the catalog — the one producer of a
            // `SpawnSpec` (§5.4). It rides on the descriptor because `CreateWorkerDeps` has no
            // `spawnSpec` field; see the note in `docs/M0-PLAN.md` WP-5's hand-off.
            //
            // `env` is the RESOLVED per-worker environment (§23.3): the catalog's complete
            // composition, with the request's own keys applied over it — every one of which
            // survived the hard blacklist, `envDeny` and this token's `envAllow`.
            descriptor: { ...descriptor, env: { ...spec.env, ...env.env } },
            cwd,
            label: req.label ?? null,
            owner: auth.asClientRef(),
            supervisor: o.supervisor,
            log,
            normalizer: createNormalizer({
              quietMs: o.config.turn.quietMs,
              hardMs: o.config.turn.hardMs,
              drainGraceMs: o.config.turn.drainGraceMs,
              cancelGraceMs: o.config.turn.cancelGraceMs,
              descriptor: runtime,
              // Deterministic per worker: the map stays PURE by taking its ids from outside
              // (§5.7), and `IdGen.request()` is the daemon's one id source.
              ids: { synth: (prefix: string) => `${prefix}_${o.ids.request()}` },
              modes: modesOf,
              // §12.5: a reconstructed vendor patch names paths `git apply` accepts, which it
              // cannot do without the directory the agent's relative paths are relative to.
              cwd,
            }),
            responder: o.responder,
            lease: leaseFor(auth.asClientRef(), workerId, log),
            toSpawnSpec,
            ...(credentials === undefined ? {} : { credentials }),
            ...(o.session === undefined ? {} : { session: o.session }),
            runtime,
            ...(runtimeId === undefined ? {} : { runtimeId }),
            clock: o.clock,
            ids: o.ids,
            logger,
            limits: {
              handshakeTimeoutMs: req.timeoutMs ?? o.config.handshakeTimeoutMs,
              cancelGraceMs: o.config.turn.cancelGraceMs,
              exitGraceMs: o.config.supervisor.exitGraceMs,
              gracefulMs: spec.gracefulMs ?? o.config.supervisor.gracefulMs,
              // The wake half of §15.5, from the daemon-wide `hibernate` block. They live on the
              // worker because the counter and the budget are its private state (review R13).
              wakeTimeoutMs: o.config.hibernate.wakeTimeoutMs,
              maxWakeFailures: o.config.hibernate.maxWakeFailures,
              // M2: the park deadline and the bound on BOTH halves of the diff provider. Without
              // the second one a provider that hangs would hang the TURN — `end` runs immediately
              // before `prompt_result` is fed (§25.1, review R14).
              parkTimeoutMs,
              diffTimeoutMs: o.config.diff.timeoutMs,
            },
            // ── M2's six seams (M2-PLAN §1.2) ────────────────────────────────
            ...(strategy === undefined
              ? {}
              : {
                  interactions: strategy,
                  // D10's gate, computed ONCE by the strategy and threaded to BOTH `open` and
                  // `reopen` — F42 is what happens when two files hard-code `{}` instead.
                  clientCapabilities: strategy.clientCapabilities,
                }),
            ...(watchdog === undefined ? {} : { watchdog }),
            ...(diff === undefined ? {} : { diff }),
            ...(mcp.servers.length === 0 ? {} : { mcpServers: mcp.servers }),
            // §20.6, so `unpoliced_tool_call` can be folded off `idle._meta` (V9).
            ...(view.alertOnUnpoliced.length === 0
              ? {}
              : { alertOnUnpoliced: view.alertOnUnpoliced }),
            // §26.2, and the reason the guard is STRUCTURAL: this creation path MUST pass it,
            // bound to the token's `cwdRoots` and to the worker's own `promptCapabilities`. zod
            // holds neither, which is why the schema's text-only refine was deleted rather than
            // widened, and why `worker.ts`'s fallback is spelled differently on purpose.
            validateContent: async (content) => {
              await assertPromptContent({
                content,
                cwd,
                cwdRoots: auth.cwdRoots,
                promptCapabilities: built?.snapshot().capabilities?.promptCapabilities ?? null,
                realpath,
              });
            },
          },
          signal,
        );
        built = handle;

        const entry: Entry = {
          id: workerId,
          handle,
          ownerTokenId: auth.tokenId,
          subscription,
          closing: null,
          live: true,
          agentId: req.agent,
          offStateChange: null,
          // `CreateWorkerRequest.idleTimeoutMs` overrides the daemon-wide budget for THIS worker,
          // and `0` in either place means "never hibernate this one" (H5, §15.2).
          hibernateIdleMs: idleBudget(req.idleTimeoutMs),
          idleTimer: null,
          m2: view,
          credentials,
          // A worker this boot created resolved everything it needs a moment ago.
          revoked: null,
        };
        entries.set(workerId, entry);
        watchEntry(entry);
        // The row exists from the first moment the worker does, so a daemon killed one
        // millisecond later still leaves something for the next boot's adoption to find (§15.7).
        persistRow(entry);

        // The slot comes back on EVERY close — client_request, daemon_shutdown or a crash the
        // registry never asked for (H14). `closed` never rejects; the catch is belt and braces.
        const onClosed = (): void => {
          release(auth.tokenId, entry);
          entry.subscription?.close();
          // The lease's TTL timer (`lease.ttlMs`, 15 min by default) has no other owner once
          // the worker is gone; left armed it keeps an embedded daemon's process alive after
          // `stop()` returned. Same line on the rehydrate path.
          handle.lease.close();
          // The LAST write, and the one §15.6 level 3 reads back: the persisted `CloseResult` is
          // what a `DELETE` after a restart replays byte-for-byte instead of recomputing.
          persistClose(entry);
        };
        void handle.closed.then(onClosed, onClosed);

        // The DECORATED handle, so the `201` body carries the same M2 rows `GET /v1/workers/{wid}`
        // does: `http/routes/workers.ts` is frozen and serializes `handle.snapshot()` directly.
        return viewOf(entry);
      } catch (e) {
        // The worker reclaimed its own process tree before rejecting (§5.3); the registry's job
        // is to give the slot back and to stop feeding a log nobody can reach any more.
        release(auth.tokenId, null);
        subscription?.close();
        log.close();
        // `agent_error` rather than `internal` for an unclassified failure: everything reachable
        // here is the agent's process or its handshake (§9). An abort still maps to
        // `agent_timeout` through `OmniError.from`.
        throw OmniError.from(e, "agent_error");
      }
    },

    get,

    /**
     * §14.8: straight from the store — a synchronous indexed query, no handle construction —
     * with IN-MEMORY entries overriding the row, because a live snapshot is fresher than a
     * debounced one.
     *
     * Constructing a handle per row would make listing a daemon with 10 000 retained workers
     * spawn 10 000 event logs, and `list()` is the one call a dashboard polls.
     */
    list(auth): readonly WorkerSnapshot[] {
      const out: WorkerSnapshot[] = [];
      const live = new Set<WorkerId>();
      for (const entry of entries.values()) {
        live.add(entry.id);
        const snapshot = snapshotOf(entry);
        if (auth.canSee(snapshot)) out.push(snapshot);
      }
      if (store !== null && store !== undefined) {
        try {
          for (const row of store.workers.list()) {
            if (live.has(row.snapshot.workerId)) continue;
            if (auth.canSee(row.snapshot)) out.push(row.snapshot);
          }
        } catch (e) {
          // A store read that fails must not empty a listing that already has the live half:
          // reporting fewer workers than exist is worse than reporting the ones we are sure of.
          o.logger.warn("listing persisted workers failed", { error: String(e) });
        }
      }
      return out;
    },

    async delete(id, auth): Promise<CloseResult> {
      const persisted = deleteAcrossRestart(id, auth);
      if (persisted !== null) return persisted;

      const entry = lookup(id, auth);
      if (entry === null) return notFound(id);
      // D5: a DELETE is a controlling operation, so a non-holder is `423` with the holder named
      // (M1-PLAN WP-D acceptance 2). `WorkerHandle.close()` takes no `ClientRef`, so this is the
      // enforcement point, and it is Land-written for the same reason the rest of seam 3 is:
      // under the default `alwaysGrantedLease` it always grants, which is M0 unchanged.
      //
      // §16.1 rule L3 is "the lease **or** `role:"admin"`", and the admin half has to be HERE:
      // the lease does not know who is asking with what authority, which is why `lease(...)`
      // below passes `admin` into `steal` rather than letting the lease infer it. Without this
      // line an admin who does not hold the lease would start getting `423` on DELETE the moment
      // WP-E flips `leaseFactory` to WP-D's enforcing lease — a behaviour change arriving through
      // a Land-written line, invisible under the default `alwaysGrantedLease`.
      if (auth.role !== "admin") entry.handle.lease.assertHolder(auth.asClientRef());
      // Idempotent by construction: the second DELETE awaits the FIRST close and returns its
      // body, rather than asking a closed worker to close again (H12).
      return await closeEntry(entry, "client_request");
    },

    async closeAll(reason, opts): Promise<void> {
      const budget = opts?.timeoutMs ?? DEFAULT_CLOSE_ALL_MS;
      /**
       * A HIBERNATED worker is skipped, and that is §15.2's whole point rather than an
       * optimisation: it owns no process, so there is nothing here to reclaim, and closing it
       * would discard the session pointer hibernation exists to preserve. Before this, a graceful
       * `stop()` closed every sleeping worker on the way out and the next boot adopted a fleet of
       * `closed` rows — which makes "a hibernated worker survives a restart" (§14.8, §15.6) false
       * for the only shutdown path anybody uses. `closed` is skipped for the plainer reason.
       */
      const reclaimable = [...entries.values()].filter((entry) => {
        const state = entry.handle.snapshot().state;
        return state !== "hibernated" && state !== "closed";
      });
      const all = reclaimable.map((entry) =>
        closeEntry(entry, reason).catch((e: unknown) => {
          o.logger.warn("worker close failed during shutdown", {
            workerId: entry.id,
            error: String(e),
          });
          return null;
        }),
      );
      if (all.length > 0) {
        // Bounded: a shutdown that hangs on one wedged agent is a daemon that never exits. The
        // Supervisor's own `shutdown()` is the backstop that force-kills whatever is left.
        await new Promise<void>((resolve) => {
          const timer = o.clock.setTimer(budget, resolve);
          void Promise.all(all).then(() => {
            timer.cancel();
            resolve();
          });
        });
      }

      // THEN the logs, which is what closes every remaining SSE subscription.
      //
      // CONTRACTS.md §5.4 words `stop()` as "SSE subs -> workers -> socket"; the order here is
      // deliberately the other way round for one reason: §8.4 requires a subscriber to receive
      // the `omni.worker_state{closed}` envelope and then `omni.stream_end`. Closing the
      // subscriptions first would drop exactly that frame and turn every clean shutdown into
      // what §8.4 defines as a network drop, sending every client back to reconnect against a
      // daemon that is going away. Closing the workers first gets both: the stream ends the way
      // the contract says it must, and this sweep guarantees the END STATE that ordering was
      // written for — `subscriberCount === 0` on every log, with nothing left to leak.
      for (const entry of entries.values()) {
        entry.subscription?.close();
        entry.handle.log.close();
        // A live `setTimer` keeps the event loop referenced, so a daemon that stopped would not
        // exit until every idle budget elapsed. `cancel()` is terminal by design.
        entry.idleTimer?.cancel();
        entry.idleTimer = null;
        // Shutdown means every timer this registry owns dies HERE, not on whatever microtask the
        // worker's `closed` promise settles on — a hibernated entry never reaches `onClosed` at all,
        // and its lease's TTL timer would otherwise outlive `stop()`.
        entry.handle.lease.close();
      }
    },

    // ── result-returning façade (review R11) ──────────────────────────────────

    snapshot(id, auth): WorkerSnapshot {
      return get(id, auth).snapshot();
    },

    async prompt(id, auth, body): Promise<PromptAccepted> {
      let parsed: PromptRequestBody;
      try {
        // SHAPE only, since H28: the text-only `.refine` was DELETED, not widened, so this schema
        // now decides that `content` is a non-empty array of at most 64 objects that each carry a
        // `type` string — and nothing about which types are allowed. The SEMANTIC gate is
        // `Worker.prompt`'s `deps.validateContent` (§26.2), which this creation path MUST inject
        // bound to the token's `cwdRoots` and the worker's `promptCapabilities`: zod holds
        // neither, and a schema that silently stopped enforcing containment looks exactly like a
        // schema that got more capable (review R2). M2-B-WP-S owns the injection and its guard.
        parsed = PromptRequestBody.parse(body);
      } catch (e) {
        throw badRequest(e, "invalid prompt");
      }
      const entry = lookup(id, auth);
      if (entry === null) return notFound(id);
      // `Worker.prompt` auto-wakes a hibernated worker internally, so the ACL that `wake()`
      // re-runs has to be re-run here too — otherwise the check is one HTTP route wide (H14).
      if (entry.handle.snapshot().state === "hibernated") await assertMayResume(entry, auth);
      return await entry.handle.prompt(parsed.content, auth.asClientRef());
    },

    async cancel(id, auth): Promise<void> {
      await get(id, auth).cancel(auth.asClientRef());
    },

    turn(id, auth, turnId: TurnId): TurnStatus {
      return get(id, auth).turn(turnId);
    },

    logFor(id, auth): EventLog {
      return get(id, auth).log;
    },

    // ── M1 façade rows (H17-H19, §5.4) ────────────────────────────────────────
    //
    // Same shape as the M0 rows above and for the same reason (review R11): an HTTP route is
    // "parse -> call ONE daemon method -> serialize", so `POST …/lease/steal` must not become a
    // get-then-act orchestration in the adapter.
    //
    // Owned by M1-WP-E (daemon wiring), which lands the persisted worker store, lazy
    // rehydration and the hibernated counter behind them — so the two throwing bodies below are
    // tagged M1-WP-E, the owner of this file, and not the feature's work package (review R18).
    // M1-WP-D swaps in the enforcing `Lease` FACTORY without touching this file — seam 3.

    // ── M2 façade rows (H22-H24, §5.8.8) ──────────────────────────────────────
    //
    // Land-written and then TRANSFERRED to M2-WP-J, which owns all daemon wiring (M2-PLAN §1.1).
    // Same shape and same reason as M1's rows above (review R11): an HTTP route is "parse -> call
    // ONE daemon method -> serialize", so `POST …/interactions/{reqId}` must not become a
    // get-then-act orchestration in the adapter.
    //
    // Each is `get(id, auth)` — which is where VISIBILITY is checked, before anything else, so a
    // worker this token cannot see is a 404 and not a 423 — followed by ONE call on the handle.
    // The handle's own body is where the state and lease checks live (hunks 5 and 6), so an
    // un-configured daemon answers `interaction_not_found` and `-32601` here rather than a 500.

    /**
     * H22: `200 InteractionAnswerResult`. Lease-gated INSIDE the handle, exactly as `prompt` is.
     *
     * VISIBILITY FIRST (§19.6: visibility → state → existence → lease → shape → semantics), and
     * then ONE call. The body is passed through UNPARSED — review finding V10: parsing it here
     * made a malformed body from a non-holder a `400` where the table says `423`, and there is no
     * way to check the shape after the lease from a caller that is above the lease.
     */
    answer(id, auth, reqId, body): InteractionAnswerResult {
      const handle = get(id, auth);
      return handle.answerInteraction(assertInteractionId(reqId), body, {
        ...auth.asClientRef(),
        tokenId: auth.tokenId,
      });
    },

    /** H23: `200 InteractionListResponse`. UNGATED (rule L2) — reading is an observer's right. */
    interactions(id, auth): InteractionListResponse {
      return { interactions: get(id, auth).interactions };
    },

    /** H24: `200 SetConfigResponse`. */
    async setConfig(id, auth, body): Promise<SetConfigResponse> {
      let parsed: SetConfigBody;
      try {
        parsed = SetConfigBody.parse(body);
      } catch (e) {
        throw badRequest(e, "invalid config request");
      }
      const entry = lookup(id, auth);
      if (entry === null) return notFound(id);
      // `Worker.setConfig` auto-wakes a hibernated worker internally, so the ACL that `wake()`
      // re-runs has to be re-run here too — otherwise the check is one HTTP route wide (H14).
      // The same line `prompt` carries, for the same reason.
      if (entry.handle.snapshot().state === "hibernated") await assertMayResume(entry, auth);
      return await entry.handle.setConfig(parsed, auth.asClientRef());
    },

    // ── M3-WP1 façade rows (§线上协议), same rule: parse -> ONE call -> serialize ───

    /**
     * `PUT /v1/workers/{wid}/credential`.
     *
     * VISIBILITY FIRST (`get`), then ONE call on the handle — where the lease gate and the state
     * checks live, exactly as `answer` and `setConfig` do it. The BODY is parsed here as well as
     * in the handle, because `WorkerRegistry` is also D15's in-process entry point and an
     * embedder's typo must be a `bad_request` rather than a path join over `undefined`.
     */
    async setCredential(id, auth, body): Promise<CredentialApplied> {
      let parsed: SetCredentialBody;
      try {
        parsed = SetCredentialBody.parse(body);
      } catch (e) {
        throw badRequest(e, "invalid credential request");
      }
      return await get(id, auth).setCredential(parsed, auth.asClientRef());
    },

    /**
     * `POST /v1/workers/{wid}/restart`.
     *
     * A hibernated worker's restart IS a wake, so the ACL is re-run here for `wake`'s own reason
     * (H14): otherwise the check is one HTTP route wide. A LIVE worker's restart is not a
     * resurrection and needs no re-check — it already passed one when it was created and the
     * config has not been consulted since.
     */
    async restart(id, auth, body): Promise<RestartResult> {
      let parsed: RestartRequestBody;
      try {
        parsed = RestartRequestBody.parse(body);
      } catch (e) {
        throw badRequest(e, "invalid restart request");
      }
      const entry = lookup(id, auth);
      if (entry === null) return notFound(id);
      if (entry.handle.snapshot().state === "hibernated") await assertMayResume(entry, auth);
      return await entry.handle.restart(parsed, auth.asClientRef());
    },

    /**
     * §19.8 / §24.4 rule 5's FIRST rung, so `daemon.stop()` can run it before anything else
     * (review finding V11).
     *
     * Best effort over the fleet and never a throw: one worker that cannot settle must not hold a
     * shutdown open, and `Worker.settleInteractions` already swallows its own failures. Only LIVE
     * entries are visited — a hibernated or closed worker holds no JSON-RPC promise by definition.
     */
    async settleAllInteractions(): Promise<void> {
      await Promise.all(
        [...entries.values()].map(async (entry) => {
          if (entry.handle.snapshot().state === "closed") return;
          await entry.handle.settleInteractions("shutdown");
        }),
      );
    },

    /** A hibernated worker owns no process, so it is bounded separately from `maxWorkers` (H14). */
    get hibernatedSize(): number {
      return countHibernated();
    },

    /**
     * Seam 3's façade row, Land-written: parse, then ONE call on the injected lease. Under the
     * default `alwaysGrantedLease` every mutating verb answers `bad_request` naming M1-WP-D,
     * which is D29's honest "not implemented yet" rather than a 500.
     */
    lease(id, auth, op, body): LeaseSnapshot {
      let parsed: LeaseRequestBody;
      try {
        parsed = LeaseRequestBody.parse(body);
      } catch (e) {
        throw badRequest(e, "invalid lease request");
      }
      const handle = get(id, auth);
      const who = auth.asClientRef();
      switch (op) {
        case "acquire":
          return handle.lease.acquire(
            who,
            parsed.ttlMs === undefined ? {} : { ttlMs: parsed.ttlMs },
          );
        case "release":
          return handle.lease.release(who);
        case "steal":
          // D13: an admin never waits; a same-token peer waits `stealAfterIdleMs`. The lease owns
          // that rule — the registry only says who is asking and with which authority.
          return handle.lease.steal(who, {
            reason: parsed.reason ?? null,
            admin: auth.role === "admin",
          });
      }
    },

    /**
     * H18. The lease gate is `Worker.hibernate()`'s caller's job here rather than the worker's:
     * `hibernate(reason)` takes no `ClientRef` (it is also the idle timer's entry point), so this
     * is the one place that knows WHO asked. §16.1 rule L2 lists hibernate among the gated verbs.
     *
     * `maxHibernated` is checked BEFORE the transition, because the transition reclaims a process
     * tree and there is no undo.
     */
    async hibernate(id, auth): Promise<WorkerSnapshot> {
      const handle = get(id, auth);
      // NO admin bypass, unlike `delete()` below. Rule L3 grants one for `DELETE` and for
      // nothing else, and H18 says only "Lease-gated" — D13 gives an admin the power to STEAL
      // the lease, which is audited, rather than to reach past a holder mid-session in silence.
      handle.lease.assertHolder(auth.asClientRef());
      if (
        handle.snapshot().state !== "hibernated" &&
        countHibernated() >= o.config.hibernate.maxHibernated
      ) {
        throw new OmniError(
          "worker_limit",
          `hibernated worker limit reached (${o.config.hibernate.maxHibernated})`,
        );
      }
      return await handle.hibernate("client_request");
    },

    /**
     * H19. A wake takes a `maxWorkers` slot back, so the capacity question is answered BEFORE the
     * ~7 s cold start rather than after it — a `429` that arrives after the spawn has already
     * happened is a limit that does not limit anything (H14).
     */
    async wake(id, auth): Promise<WorkerSnapshot> {
      const entry = lookup(id, auth);
      if (entry === null) return notFound(id);
      await assertMayResume(entry, auth);
      const before = entry.handle.snapshot();
      if (before.state === "hibernated") {
        reserveForWake(entry, auth);
        try {
          return await entry.handle.wake(auth.asClientRef());
        } catch (e) {
          // Only give the slot back if the worker did not actually come up: a wake that failed
          // and left the worker `hibernated` must not keep a slot, and one that reached `ready`
          // legitimately holds the one we just took.
          if (entry.handle.snapshot().state === "hibernated") release(entry.ownerTokenId, entry);
          throw e;
        }
      }
      return await entry.handle.wake(auth.asClientRef());
    },

    /**
     * Boot adoption (§15.7), run once by `createDaemon()` and idempotent thereafter.
     *
     * The narrow `{hibernated, closed, orphans}` shape is what `WorkerRegistry` declares;
     * `onBootAdoption` carries the `{found, reaped, skipped}` half `GET /v1/info` needs, from the
     * SAME pass — running adoption twice to answer two questions would append two sets of
     * envelopes to every abandoned worker's log.
     */
    async adopt(): Promise<{
      hibernated: number;
      closed: number;
      orphans: readonly OrphanRecord[];
    }> {
      if (store === null || store === undefined) {
        // Nothing was persisted, so nothing survived the last boot to adopt. Reporting zeroes is
        // the truth for `eventLog.driver: "memory"`, which is still the default (M1-R17).
        const empty: BootRecoveryResult = {
          found: 0,
          reaped: 0,
          skipped: 0,
          hibernated: 0,
          closed: 0,
          orphans: [],
        };
        o.onBootAdoption?.(empty);
        return { hibernated: 0, closed: 0, orphans: [] };
      }

      const result = await recoverFromPreviousBoot({
        persistence: store,
        supervisor: o.supervisor,
        config: o.config,
        clock: o.clock,
        logger: o.logger,
        // Adoption writes to the worker's OWN log, continuing the same seq space (§14.4). Going
        // through `logFor` with the store's head is what makes those envelopes land at the next
        // seq a reconnecting client expects, rather than restarting the worker's history at 1.
        logFor: (workerId) => logFor(workerId, store.events.headOf(workerId)),
      });
      o.onBootAdoption?.(result);
      return { hibernated: result.hibernated, closed: result.closed, orphans: result.orphans };
    },
  };
}

// ── M2's registry-owned rows, and the ladder they arm ─────────────────────────

/**
 * The worker's snapshot plus the rows only the registry can fill (§5.8.4).
 *
 * `worker.ts` is frozen after the Land step and holds none of these: they are facts about the
 * REQUEST — the disposition it asked for, the presets it named, the env keys it set, the policy
 * it resolved to — and the registry is what resolved them. Everything that leaves this file goes
 * through here, including the `201` body (`create()` returns a decorated handle) and the
 * persisted row, so a client cannot see two different answers depending on which route it asked.
 */
function decorate(snapshot: WorkerSnapshot, rows: WorkerViewRows): WorkerSnapshot {
  return {
    ...snapshot,
    onUnresolved: rows.onUnresolved,
    parkTimeoutMs: rows.parkTimeoutMs,
    parkTimeoutAction: rows.parkTimeoutAction,
    policy: rows.policy,
    mcp: rows.mcp,
    envKeys: rows.envKeys,
    patchMode: rows.patchMode,
  };
}

/**
 * A `WorkerHandle` whose `snapshot()` (and `hibernate()` / `wake()`, which both return one) is
 * decorated, and which delegates everything else verbatim.
 *
 * Written out member by member rather than through a `Proxy`: a `Proxy` would silently forward a
 * member added to `WorkerHandle` in a later milestone, and "silently forwarded" is exactly how a
 * snapshot would come back undecorated from a verb nobody thought about.
 */
function decorateHandle(handle: WorkerHandle, snapshot: () => WorkerSnapshot): WorkerHandle {
  return {
    get id() {
      return handle.id;
    },
    get log() {
      return handle.log;
    },
    get lease() {
      return handle.lease;
    },
    get generation() {
      return handle.generation;
    },
    get closed() {
      return handle.closed;
    },
    get interactions() {
      return handle.interactions;
    },
    snapshot,
    prompt: (content, who) => handle.prompt(content, who),
    cancel: (who) => handle.cancel(who),
    close: (reason) => handle.close(reason),
    turn: (turnId) => handle.turn(turnId),
    onStateChange: (cb) => handle.onStateChange(cb),
    hibernate: async (reason) => {
      await handle.hibernate(reason);
      return snapshot();
    },
    wake: async (who, opts) => {
      await handle.wake(who, opts);
      return snapshot();
    },
    answerInteraction: (id, a, who) => handle.answerInteraction(id, a, who),
    settleInteractions: (reason) => handle.settleInteractions(reason),
    setConfig: (body, who) => handle.setConfig(body, who),
    cancelInternal: (reason) => handle.cancelInternal(reason),
    // M3-WP1. Delegated verbatim, like every other verb: neither answer is a snapshot, so there
    // is nothing to decorate. Written out rather than proxied for the reason at the top of this
    // function — a `Proxy` would silently forward the next member nobody thought about.
    setCredential: (body, who) => handle.setCredential(body, who),
    restart: (body, who) => handle.restart(body, who),
  };
}

/**
 * A persisted row's M2 rows, read back for a REHYDRATED worker.
 *
 * A row written by an M1 boot carries none of them, and every fallback here is that boot's own
 * behaviour rather than this boot's config — a worker created under `deny` must not wake under a
 * `park` default somebody set afterwards.
 */
function viewRowsOf(row: WorkerRow): WorkerViewRows {
  return {
    onUnresolved: row.onUnresolved ?? M1_VIEW.onUnresolved,
    parkTimeoutMs: row.parkTimeoutMs ?? null,
    parkTimeoutAction: row.parkTimeoutAction ?? M1_VIEW.parkTimeoutAction,
    policy: row.snapshot.policy ?? null,
    policyId: row.policyRef ?? null,
    // The INPUT the engine was built from, so `reviveM2` can rebuild it. `undefined` on an M1 row
    // and on a worker that asked for no policy are the same call to `policyFor`, which is what
    // `create()` does with `req.policy` too.
    policySelection: row.policy ?? undefined,
    alertOnUnpoliced: [],
    mcp: row.snapshot.mcp ?? { requested: row.mcpNames ?? [], applied: [], dropped: [] },
    envKeys: row.snapshot.envKeys ?? Object.keys(row.env ?? {}),
    patchMode: row.patchMode ?? M1_VIEW.patchMode,
    watchdog: row.watchdog ?? null,
    env: row.env ?? null,
    mcpNames: row.mcpNames ?? [],
    // A row from an M1/M2 boot carries neither, and both fallbacks are that boot's own behaviour:
    // the daemon's environment, and no home.
    credentialName: row.credentialName ?? null,
    homeMode: row.homeMode ?? "shared",
  };
}

/**
 * The daemon-wide budgets with the request's own overrides applied, field by field.
 *
 * `WatchdogOverride` is a `strictObject` of optionals rather than a `.partial()` for exactly this
 * merge: `{}` must mean "change nothing", and a schema whose inner defaults still fired would
 * have `{}` silently beat the operator's configuration on every field the caller never wrote.
 *
 * `cancelTimeoutMs > turn.cancelGraceMs` is a config LOAD error daemon-wide (§21.5), so a
 * per-worker override that broke it would be the one way to reach the state the load check
 * exists to forbid: a watchdog that closes the worker before the turn it cancelled can settle.
 */
function watchdogBudgets(
  config: ResolvedDaemonConfig,
  override: WorkerViewOverride,
): ResolvedWatchdogConfig {
  const resolved: ResolvedWatchdogConfig = { ...config.watchdog, ...(override ?? {}) };
  if (resolved.cancelTimeoutMs <= config.turn.cancelGraceMs) {
    throw new OmniError(
      "bad_request",
      `watchdog.cancelTimeoutMs (${String(resolved.cancelTimeoutMs)}ms) must exceed ` +
        `turn.cancelGraceMs (${String(config.turn.cancelGraceMs)}ms)`,
      { detail: { field: "watchdog.cancelTimeoutMs" } },
    );
  }
  return resolved;
}

type WorkerViewOverride =
  | {
      silentMs?: number;
      toolMs?: number;
      cancelTimeoutMs?: number;
      enabled?: boolean;
    }
  | undefined;

/**
 * §21.5's ladder, in the ORDER that is the contract.
 *
 * `omni.error{agent_timeout}` FIRST, because that is what makes `reduceTurn`'s verdict `failed`
 * and what a `?since=` reader sees; then `worker_state{reason:"watchdog_idle"}`; and only then is
 * the agent touched. `action:"close"` skips straight to M1's existing `cancel_timeout` close
 * WITHOUT waiting out `cancelTimeoutMs`; `"cancel"` goes through `cancelInternal`, which is not
 * lease-gated — the lease governs CLIENTS and the idle watchdog is not one.
 *
 * It never throws: a watchdog that fails must not take the worker with it.
 */
function fireWatchdog(o: {
  budget: "silent" | "tool";
  log: EventLog;
  config: ResolvedWatchdogConfig;
  handle: WorkerHandle | null;
  openToolCalls: number;
  logger: Logger;
}): void {
  const idleMs = o.budget === "tool" ? o.config.toolMs : o.config.silentMs;
  const turnId = o.handle?.snapshot().currentTurnId ?? null;
  try {
    o.log.appendAll([
      {
        kind: "omni.error",
        payloadVersion: 2,
        turnId,
        payload: {
          code: "agent_timeout",
          message:
            `idle watchdog: no activity for ${String(idleMs)}ms ` +
            `(budget ${String(idleMs)}ms, ${String(o.openToolCalls)} tool call(s) open)`,
        },
      },
      {
        kind: "omni.worker_state",
        payloadVersion: 2,
        turnId,
        payload: {
          state: "running",
          previous: "running",
          reason: "watchdog_idle",
          watchdog: { budget: o.budget, idleMs, openToolCalls: o.openToolCalls },
        },
      },
    ]);
  } catch (e) {
    // A log that cannot take the two envelopes is still a stall we have to act on.
    o.logger.warn("appending the watchdog envelopes failed", { error: String(e) });
  }

  const handle = o.handle;
  if (handle === null) return;
  const done =
    o.config.action === "close"
      ? handle.close("cancel_timeout")
      : handle.cancelInternal(o.budget === "tool" ? "watchdog_tool" : "watchdog_silent");
  void done.catch((e: unknown) => {
    o.logger.warn("the watchdog's escalation failed", { error: String(e) });
  });
}

/**
 * The token's `cwdRoots`, RESOLVED — the same list the create path binds the gate to.
 *
 * A rehydrated worker has no `AuthContext` (nobody holds one across a restart, ruling M1-R8) and
 * §26.2 binds the content gate to the token's roots, so this used to read `config.tokens.find(…)
 * ?.cwdRoots ?? []` directly. Review finding V3 is what that cost: `TokenConfig.cwdRoots` is
 * `z.array(z.string()).default([])` — UNEXPANDED and UNRESOLVED — while the authoritative
 * resolution lives in `auth.ts`'s `toEntry`, which turns `[]` into `[homedir()]` and `resolvePath`s
 * every entry. So the one containment root list in the daemon had two spellings: with the common
 * `cwdRoots: []` a woken worker's gate got `[]` and `assertPromptContent` threw `internal`
 * ("prompt containment is mis-bound: no cwdRoots") — a 500 on every path-bearing prompt block —
 * and with `["~/work"]` the unexpanded `~` failed the cwd-inside-roots assertion instead.
 *
 * Both directions failed CLOSED, which is why this is a correctness bug rather than a hole; the
 * fix is to delete the second spelling. A token the operator has since removed throws
 * `unauthorized` out of `contextFor` and resolves to `[]` here, which refuses every
 * `resource_link` and is still the fail-closed answer.
 */
function cwdRootsOf(o: WorkerRegistryOptions, tokenId: TokenId): readonly string[] {
  const tokens = o.tokens;
  if (tokens === undefined) return [];
  try {
    return tokens.contextFor(tokenId, null).cwdRoots;
  } catch {
    return [];
  }
}
