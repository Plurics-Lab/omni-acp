import { readFileSync } from "node:fs";
import { resolve4, resolve6 } from "node:dns/promises";
import {
  createRunRegistry,
  createWebhookDispatcher,
  openPersistence,
  recoverDeliveries,
} from "@omni-acp/core";
import { OmniError } from "@omni-acp/protocol";
import type {
  Clock,
  DaemonId,
  DeliveryId,
  DeliveryRecord,
  DeliveryStore,
  IdGen,
  Logger,
  PersistenceHandle,
  ResolvedDaemonConfig,
  Resolver,
  RunId,
  RunRegistry,
  TokenId,
  WebhookDispatcher,
  WebhookPayload,
  WorkerRegistry,
} from "@omni-acp/protocol";

/**
 * What `openPersistence` returns from M2 on: `PersistenceHandle` plus the two v2 stores and the
 * transaction that spans them.
 *
 * Named through `Awaited<ReturnType<…>>` rather than by importing the interface, because
 * `packages/core/src/index.ts` is frozen and does not re-export it. The type is still exact — it
 * is the function's own return type — and the indirection is what keeps this wiring from
 * requiring a cross-owner edit to a barrel.
 */
type DurableHandle = Awaited<ReturnType<typeof openPersistence>>;

/** The two v2 stores' own types, likewise recovered from the handle rather than from a barrel. */
type DeliveryStoreV2 = DurableHandle["deliveries"];
type RunStoreV2 = DurableHandle["runs"];
/** The widened run row: `RunRow` plus the seq of the run's last `omni.run` envelope (§24.3). */
type RunRowV2 = NonNullable<ReturnType<RunStoreV2["get"]>>;

export interface RunSubsystem {
  readonly runs: RunRegistry;
  readonly deliveries: DeliveryStore;
  readonly dispatcher: WebhookDispatcher | null;
}

/**
 * The daemon's Run wiring: stores, dispatcher, registry, and the boot order they must follow.
 *
 * §24.4's boot order is not a preference —
 * `persistence → worker adopt → run recover → delivery requeue → dispatcher.start → listen` — and
 * every arrow is load-bearing: recovering runs before workers are adopted would abandon runs
 * whose workers were about to be rehydrated, and starting the dispatcher before requeueing would
 * let it claim rows a previous boot still owns.
 *
 * This function is the middle of that order. It builds the pieces and **does not start anything**:
 * `runs.recover()`, `recoverDeliveries` and `dispatcher.start()` are exposed on the returned
 * object and called by `create-daemon.ts`, which is the only file that knows where `workers.adopt`
 * sits relative to them.
 *
 * `stop()` runs the mirror: `interactions.settleAll → dispatcher.drain(bounded) → workers closed →
 * dispatcher.drain(bounded) → dispatcher.stop → socket`. Settling first is §19.8 — an agent blocked
 * on our answer may never read the shutdown; the SECOND drain is because closing the workers is
 * what enqueues each run's own terminal `run.*` delivery (review round 2, finding V11).
 *
 * Owned by M2-B-WP-R.
 */
export function createRunSubsystem(o: {
  config: ResolvedDaemonConfig;
  persistence: PersistenceHandle | null;
  workers: WorkerRegistry;
  clock: Clock;
  ids: IdGen;
  logger: Logger;
  /**
   * The STABLE daemon id, minted (or read back) by `create-daemon.ts` — not the boot id.
   *
   * It is a parameter rather than a config read because `DaemonConfig.daemonId` is optional and
   * the resolved one lives on `Daemon.id`; a subsystem that re-derived it could stamp a different
   * value into a webhook payload than the one every other response carries, which is the single
   * field D11 uses to address a daemon.
   */
  daemonId: DaemonId;
  /**
   * `DaemonDeps.webhooks`, when an embedder or a test injected one (M2-WP-J).
   *
   * It replaces the dispatcher this function would build, and it must be the SAME object the
   * daemon's `stop()` drains — a seam that received the lifecycle calls while the run registry
   * dispatched to a different dispatcher would be worse than no seam at all.
   */
  dispatcher?: WebhookDispatcher | null;
  /** Injected by the delivery tests so they need no network. */
  fetch?: typeof globalThis.fetch;
  /** Injected by the SSRF tests so they need no DNS. */
  resolve?: Resolver;
}): RunSubsystem & {
  /** §24.4's boot half, in the order the daemon must call it. Safe to call on every boot. */
  recover(): { abandoned: number; requeued: number };
} {
  const logger = o.logger.child({ mod: "runs" });
  // A durable handle carries the v2 stores; a memory-driver daemon has none and gets in-memory
  // ones, because ruling M2-R14 says a run under the memory driver is ALLOWED — it just says so
  // in `RunSnapshot.persistence` rather than pretending to survive a restart.
  const durable = o.persistence as DurableHandle | null;
  const runStore: RunStoreV2 = durable?.runs ?? memoryRunStore();
  const deliveryStore: DeliveryStoreV2 = durable?.deliveries ?? memoryDeliveryStore();
  const transaction = durable?.transaction.bind(durable);

  const tokenSecrets = resolveTokenSecrets(o.config, logger);
  const dispatcher =
    o.dispatcher ??
    (o.config.webhooks.enabled
      ? createWebhookDispatcher({
          store: deliveryStore,
          config: o.config.webhooks,
          secrets: o.config.webhooks.secrets,
          tokenSecrets,
          // A delivery outlives its boot and `webhook_deliveries` has no column for a secret NAME,
          // so the name is recovered from the RUN row — which is on disk (§24.3). `null` means "the
          // run named none", and the dispatcher then falls back to the token's own key.
          secretRefFor: ({ runId }) => runStore.get(runId)?.webhook?.secret ?? null,
          bootId: durable?.bootId ?? "boot_memory",
          clock: o.clock,
          ids: o.ids,
          logger: logger.child({ mod: "webhooks" }),
          resolve: o.resolve ?? systemResolver,
          ...(o.fetch === undefined ? {} : { fetch: o.fetch }),
        })
      : null);

  const runs = createRunRegistry({
    daemonId: o.daemonId,
    bootId: durable?.bootId ?? "boot_memory",
    workers: o.workers,
    store: runStore,
    deliveries: deliveryStore,
    dispatcher,
    config: o.config.run,
    clock: o.clock,
    ids: o.ids,
    logger,
    webhooks: o.config.webhooks,
    resolve: o.resolve ?? systemResolver,
    tokenSecrets,
    persistence: durable === null ? "memory" : "durable",
    ...(transaction === undefined ? {} : { transaction }),
  });

  return {
    runs,
    deliveries: deliveryStore,
    dispatcher,
    recover(): { abandoned: number; requeued: number } {
      // ORDER: runs first, then deliveries. `runs.recover()` ENQUEUES the terminal `run.failed`
      // rows for abandoned runs, and those rows are `pending` — so requeueing stale `delivering`
      // rows afterwards catches them together in one pass instead of leaving the newest ones for
      // the poll timer.
      const { abandoned } = runs.recover();
      const requeued = recoverDeliveries(
        deliveryStore,
        durable?.bootId ?? "boot_memory",
        o.clock.now(),
      );
      if (requeued > 0) logger.info("re-queued deliveries from a previous boot", { requeued });
      return { abandoned, requeued };
    },
  };
}

/**
 * Each token's own signing key, by token id (§5.8.7's `webhookSecret` / `webhookSecretFile`).
 *
 * `webhookSecretFile` is read HERE, once, at construction: the contract calls it "0600, read at
 * load", and a per-delivery read would put a disk failure on the retry ladder.
 *
 * A file that cannot be read is a WARNING and no entry, never a throw. A daemon that refused to
 * start because one token's optional signing key was missing would be a daemon a typo takes down;
 * a token with no key simply cannot create webhook runs, and `POST /v1/runs` says so at create.
 */
function resolveTokenSecrets(
  config: ResolvedDaemonConfig,
  logger: Logger,
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const token of config.tokens) {
    if (token.webhookSecret !== undefined) {
      out[token.id] = token.webhookSecret;
      continue;
    }
    if (token.webhookSecretFile === undefined) continue;
    try {
      const value = readFileSync(token.webhookSecretFile, "utf8").trim();
      if (value.length > 0) out[token.id] = value;
    } catch (e) {
      logger.warn("webhookSecretFile could not be read; this token cannot sign deliveries", {
        tokenId: token.id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return out;
}

/**
 * The real resolver: A and AAAA, both, and BOTH must clear `denyCidrs`.
 *
 * Asking for only one family is how a rebinding check gets bypassed by a name that answers `A`
 * with something harmless and `AAAA` with `::1`. A family that resolves to nothing is not an
 * error here — `assertWebhookUrl` refuses only when the UNION is empty.
 */
const systemResolver: Resolver = async (hostname: string) => {
  const settled = await Promise.allSettled([resolve4(hostname), resolve6(hostname)]);
  const found = settled.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  if (found.length > 0) return found;
  const reason = settled.find((r) => r.status === "rejected");
  throw reason?.status === "rejected" ? reason.reason : new Error(`cannot resolve ${hostname}`);
};

/**
 * The memory driver's `RunStore` (ruling M2-R14).
 *
 * It is a `Map` and it says so: nothing here survives a restart, which is exactly what
 * `RunSnapshot.persistence: "memory"` tells the caller. `liveFromOtherBoots` returns `[]` by
 * construction — there IS no other boot when the store dies with the process — and that is a
 * fact rather than an omission.
 */
function memoryRunStore(): RunStoreV2 {
  const rows = new Map<RunId, RunRowV2>();
  const ordered = (): RunRowV2[] =>
    [...rows.values()].sort((a, b) =>
      a.createdAtMs === b.createdAtMs
        ? b.snapshot.runId.localeCompare(a.snapshot.runId)
        : b.createdAtMs - a.createdAtMs,
    );

  return {
    put(row) {
      rows.set(row.snapshot.runId, row);
    },
    get(id) {
      return rows.get(id) ?? null;
    },
    byIdempotencyKey(tokenId, key) {
      for (const row of rows.values()) {
        if (row.tokenId === tokenId && row.idempotencyKey === key) return row;
      }
      return null;
    },
    list(o) {
      const all = ordered().filter((r) => o.tokenId === undefined || r.tokenId === o.tokenId);
      const from =
        o.cursor === undefined ? 0 : all.findIndex((r) => r.snapshot.runId === o.cursor) + 1;
      const page = all.slice(from, from + o.limit);
      const more = from + o.limit < all.length;
      return { rows: page, cursor: more ? (page.at(-1)?.snapshot.runId ?? null) : null };
    },
    liveFromOtherBoots() {
      return [];
    },
    sweep(o) {
      let dropped = 0;
      for (const [id, row] of rows) {
        if (row.snapshot.result === null && row.snapshot.error === null) continue;
        if (row.updatedAtMs < o.olderThanMs) {
          rows.delete(id);
          dropped += 1;
        }
      }
      return dropped;
    },
  };
}

/** The memory driver's `DeliveryStore`. Same contract, same claim/requeue semantics, no file. */
function memoryDeliveryStore(): DeliveryStoreV2 {
  /**
   * The mutable twin of `DeliveryRow`.
   *
   * Spelled out rather than `extends DeliveryRecord`, because every field of the wire record is
   * `readonly` and this store's whole job is to move rows between states in place. Structural
   * typing does the rest: a `Row` IS a `DeliveryRow`, and the two `nextAttemptMs` / `createdAtMs`
   * fields are the millisecond form the SQLite columns keep and the ISO strings above mirror.
   */
  interface Row {
    deliveryId: DeliveryId;
    runId: RunId;
    event: DeliveryRecord["event"];
    state: DeliveryRecord["state"];
    attempt: number;
    nextAttemptAt: string | null;
    lastStatus: number | null;
    lastError: string | null;
    responseMs: number | null;
    createdAt: string;
    updatedAt: string;
    url: string;
    tokenId: TokenId;
    payload: WebhookPayload;
    leaseBoot: string | null;
    nextAttemptMs: number | null;
    createdAtMs: number;
  }
  const rows = new Map<DeliveryId, Row>();

  /** The wire projection, spelled out so the two stores cannot disagree about what a record is. */
  const record = (r: Row): DeliveryRecord => ({
    deliveryId: r.deliveryId,
    runId: r.runId,
    event: r.event,
    state: r.state,
    attempt: r.attempt,
    nextAttemptAt: r.nextAttemptAt,
    lastStatus: r.lastStatus,
    lastError: r.lastError,
    responseMs: r.responseMs,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  });

  return {
    enqueue(r) {
      const iso = new Date(r.nowMs).toISOString();
      rows.set(r.deliveryId, {
        deliveryId: r.deliveryId,
        runId: r.runId,
        event: r.event,
        state: "pending",
        attempt: 0,
        nextAttemptAt: iso,
        lastStatus: null,
        lastError: null,
        responseMs: null,
        createdAt: iso,
        updatedAt: iso,
        url: r.url,
        tokenId: r.tokenId,
        payload: r.payload,
        leaseBoot: null,
        nextAttemptMs: r.nowMs,
        createdAtMs: r.nowMs,
      });
    },
    due(nowMs, limit) {
      return [...rows.values()]
        .filter(
          (r) => r.state === "pending" && r.nextAttemptMs !== null && r.nextAttemptMs <= nowMs,
        )
        .sort((a, b) => (a.nextAttemptMs ?? 0) - (b.nextAttemptMs ?? 0))
        .slice(0, limit)
        .map((r) => r);
    },
    claim(id, bootId, nowMs) {
      const row = rows.get(id);
      // The same compare-and-set the SQL statement is, and single-threaded JavaScript makes it
      // atomic for free — which is why the SQLite version has to say `where state = 'pending'`
      // out loud and this one does not.
      if (row === undefined || row.state !== "pending") return false;
      row.state = "delivering";
      row.leaseBoot = bootId;
      row.updatedAt = new Date(nowMs).toISOString();
      return true;
    },
    settle(r) {
      const row = rows.get(r.deliveryId);
      if (row === undefined) return;
      row.state = r.state;
      row.attempt += 1;
      row.nextAttemptMs = r.nextAttemptMs;
      row.nextAttemptAt = r.nextAttemptMs === null ? null : new Date(r.nextAttemptMs).toISOString();
      row.leaseBoot = null;
      row.lastStatus = r.status;
      row.lastError = r.error;
      row.responseMs = r.responseMs;
      row.updatedAt = new Date(r.nowMs).toISOString();
    },
    requeueStale(bootId, nowMs) {
      let moved = 0;
      for (const row of rows.values()) {
        if (row.state !== "delivering") continue;
        if (row.leaseBoot === bootId) continue;
        row.state = "pending";
        row.leaseBoot = null;
        row.nextAttemptMs = nowMs;
        row.nextAttemptAt = new Date(nowMs).toISOString();
        row.updatedAt = new Date(nowMs).toISOString();
        moved += 1;
      }
      return moved;
    },
    list(o) {
      const all = [...rows.values()]
        .filter((r) => o.runId === undefined || r.runId === o.runId)
        .filter((r) => o.state === undefined || r.state === o.state)
        .filter((r) => o.tokenId === undefined || r.tokenId === o.tokenId)
        .sort((a, b) =>
          a.createdAtMs === b.createdAtMs
            ? b.deliveryId.localeCompare(a.deliveryId)
            : b.createdAtMs - a.createdAtMs,
        );
      const from = o.cursor === undefined ? 0 : all.findIndex((r) => r.deliveryId === o.cursor) + 1;
      const page = all.slice(from, from + o.limit);
      const more = from + o.limit < all.length;
      // `record`, not the row: this is the dead-letter LISTING, and its route serializes whatever
      // it is handed — a url, a token id or a payload must not reach it (§24.5).
      return { rows: page.map(record), cursor: more ? (page.at(-1)?.deliveryId ?? null) : null };
    },
    get(id) {
      const row = rows.get(id);
      return row ?? null;
    },
    redeliver(id, nowMs, tokenId) {
      const row = rows.get(id);
      // One answer for "no such delivery" and for "not yours" — the second must not confirm that
      // the id is real (D13's rule, applied to a delivery).
      if (row === undefined || (tokenId !== undefined && row.tokenId !== tokenId)) {
        throw new OmniError("worker_not_found", `no delivery ${id}`);
      }
      row.state = "pending";
      row.attempt = 0;
      row.nextAttemptMs = nowMs;
      row.nextAttemptAt = new Date(nowMs).toISOString();
      row.leaseBoot = null;
      row.lastStatus = null;
      row.lastError = null;
      row.responseMs = null;
      row.updatedAt = new Date(nowMs).toISOString();
      return record(row);
    },
    sweep(o) {
      let dropped = 0;
      for (const [id, row] of rows) {
        if (row.createdAtMs < o.olderThanMs) {
          rows.delete(id);
          dropped += 1;
        }
      }
      return dropped;
    },
  };
}
