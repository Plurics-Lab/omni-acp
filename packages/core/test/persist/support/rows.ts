import type {
  DaemonId,
  DeliveryId,
  RunId,
  RunRow,
  RunState,
  TokenId,
  WebhookEvent,
  WebhookPayload,
  WebhookTarget,
  WorkerId,
} from "@omni-acp/protocol";
import { DAEMON_ID, workerId } from "./harness.js";

/** Deterministic ids, so an ordering assertion reads as an ordering assertion. */
export const runId = (n: number): RunId => `r_${String(n).padStart(26, "0")}` as RunId;
export const deliveryId = (n: number): DeliveryId =>
  `dl_${String(n).padStart(26, "0")}` as DeliveryId;
export const tokenId = (name: string): TokenId => name as TokenId;

/** One epoch for every fixture, so `createdAt` ordering is a decision rather than a race. */
export const T0 = Date.UTC(2026, 0, 1);

export function runRow(o: {
  n: number;
  token?: string;
  boot?: string;
  state?: RunState;
  createdAtMs?: number;
  updatedAtMs?: number;
  idempotencyKey?: string | null;
  webhook?: WebhookTarget | null;
  worker?: WorkerId | null;
  deliveries?: number;
}): RunRow {
  const createdAtMs = o.createdAtMs ?? T0 + o.n * 1_000;
  const updatedAtMs = o.updatedAtMs ?? createdAtMs;
  const webhook = o.webhook ?? null;
  return {
    snapshot: {
      runId: runId(o.n),
      daemonId: DAEMON_ID as DaemonId,
      state: o.state ?? "queued",
      agentId: "fixture",
      cwd: "/tmp/fixture",
      workerId: o.worker === undefined ? workerId(o.n) : o.worker,
      turnId: null,
      createdAt: new Date(createdAtMs).toISOString(),
      updatedAt: new Date(updatedAtMs).toISOString(),
      result: null,
      error: null,
      persistence: "durable",
      webhook: webhook === null ? null : { url: webhook.url, deliveries: o.deliveries ?? 0 },
    },
    tokenId: tokenId(o.token ?? "alice"),
    bootId: o.boot ?? "boot_a",
    idempotencyKey: o.idempotencyKey ?? null,
    webhook,
    createdAtMs,
    updatedAtMs,
  };
}

export function payload(o: { n: number; event?: WebhookEvent; run?: number }): WebhookPayload {
  return {
    deliveryId: deliveryId(o.n),
    event: o.event ?? "run.completed",
    daemonId: DAEMON_ID as DaemonId,
    workerId: workerId(o.run ?? o.n),
    runId: runId(o.run ?? o.n),
    sessionId: null,
    seq: 1,
    ts: new Date(T0).toISOString(),
  };
}
