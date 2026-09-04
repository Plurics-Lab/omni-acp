/**
 * D5's single-controller lease — the wire shapes only (CONTRACTS.md §5.1 `src/lease.ts`, §16).
 *
 * TYPES ONLY. The behaviour is `@omni-acp/core`'s `createLease` (M1-WP-D); this file exists so
 * that `protocol` can name a holder and an epoch without importing anything that implements one.
 */

import type { ClientId, TokenId, WorkerId } from "./ids.js";

/** The wire form of `ClientRef`. `clientId: null` = "the token's default client" (§16.1 rule L4). */
export interface ClientRefWire {
  readonly tokenId: TokenId;
  readonly clientId: ClientId | null;
}

export interface LeaseSnapshot {
  readonly workerId: WorkerId;
  readonly holder: ClientRefWire | null;
  /**
   * FENCING TOKEN. Monotonic per worker, +1 on every acquire / steal / expiry. A client that
   * cached "I hold it" cannot act after a steal: it sends `Omni-Lease-Epoch` and a stale value
   * is a 423 rather than a silent hijack of somebody else's turn. This is the one thing that
   * makes a lease a lease rather than an advisory hint.
   */
  readonly epoch: number;
  /** null = no TTL configured, OR expiry is pinned because a turn is live (never a lie). */
  readonly expiresAt: string | null;
  readonly acquiredAt: string | null;
  readonly pinned: boolean;
}

export type LeaseOp = "acquired" | "released" | "stolen" | "expired";

/** How a lease changed hands. Recorded so a transfer is audited rather than inferred. */
export type LeaseHow =
  "explicit" | "implicit" | "create" | "steal" | "hibernate" | "timeout" | "daemon_restart";

export interface LeaseEventPayload {
  readonly op: LeaseOp;
  readonly lease: LeaseSnapshot;
  readonly previous: ClientRefWire | null;
  /** Who caused it. `null` for `expired` — the clock did, or a daemon restart did. */
  readonly by: ClientRefWire | null;
  /** "implicit" = the first gated call on an unheld lease claimed it (§16.1 rule L5). */
  readonly how: LeaseHow;
  readonly reason: string | null;
}
