import { OmniError } from "./errors.js";
import type { IdGen } from "./contracts.js";

/** Template-literal ids: a DaemonId is not assignable to a WorkerId, with no brand ceremony (D12). */
export type DaemonId = `d_${string}`;
export type WorkerId = `w_${string}`;
export type TurnId = `t_${string}`;
export type TokenId = string;
export type ClientId = string;
/** Agent-assigned. Opaque. NEVER parsed, NEVER pattern-matched. */
export type SessionId = string;
/** 1-based, strictly increasing, gap-free, per worker. Deliberately unbranded: arithmetic. */
export type Seq = number;

/** Global address across daemons (D11). */
export type WorkerRef = `${DaemonId}:${WorkerId}`;

/** ULID body: Crockford base32, 26 characters, no I/L/O/U. */
export const ULID_BODY = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export const ID_PATTERN: {
  readonly daemon: RegExp;
  readonly worker: RegExp;
  readonly turn: RegExp;
} = {
  daemon: /^d_[0-9A-HJKMNP-TV-Z]{26}$/,
  worker: /^w_[0-9A-HJKMNP-TV-Z]{26}$/,
  turn: /^t_[0-9A-HJKMNP-TV-Z]{26}$/,
};

export function isDaemonId(s: string): s is DaemonId {
  throw new OmniError("internal", "unimplemented: WP-1 (ids.isDaemonId)");
}

export function isWorkerId(s: string): s is WorkerId {
  throw new OmniError("internal", "unimplemented: WP-1 (ids.isWorkerId)");
}

export function isTurnId(s: string): s is TurnId {
  throw new OmniError("internal", "unimplemented: WP-1 (ids.isTurnId)");
}

/** Throws OmniError("bad_request") with the offending value elided from the message. */
export function assertWorkerId(s: string): WorkerId {
  throw new OmniError("internal", "unimplemented: WP-1 (ids.assertWorkerId)");
}

export function assertTurnId(s: string): TurnId {
  throw new OmniError("internal", "unimplemented: WP-1 (ids.assertTurnId)");
}

export function workerRef(d: DaemonId, w: WorkerId): WorkerRef {
  throw new OmniError("internal", "unimplemented: WP-1 (ids.workerRef)");
}

export function parseWorkerRef(ref: string): { daemonId: DaemonId; workerId: WorkerId } {
  throw new OmniError("internal", "unimplemented: WP-1 (ids.parseWorkerRef)");
}

/**
 * Monotonic ULID factory. Injected everywhere so tests are deterministic.
 *
 * Hand-rolled rather than taken from the `ulid` package precisely because of these two
 * injection points: the testkit's `seqIds()` and every clock-controlled suite depend on
 * `now`/`random` being replaceable (CONTRACTS.md §3.2 pins protocol's dependencies to the
 * SDK and zod, nothing else).
 */
export function createIdGen(opts?: { now?: () => number; random?: () => number }): IdGen {
  throw new OmniError("internal", "unimplemented: WP-1 (ids.createIdGen)");
}
