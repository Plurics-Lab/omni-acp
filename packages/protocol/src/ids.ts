import { OmniError } from "./errors.js";
import type { IdGen } from "./contracts.js";

/** Template-literal ids: a DaemonId is not assignable to a WorkerId, with no brand ceremony (D12). */
export type DaemonId = `d_${string}`;
export type WorkerId = `w_${string}`;
export type TurnId = `t_${string}`;
/**
 * One InteractionRequest (M2).
 *
 * DAEMON-MINTED, and that is the whole point: F33 — `elicitation/create` and
 * `session/request_permission` share ONE agent→client JSON-RPC id counter, so the transport id
 * is not an identity a route may address. The `interaction-id-is-daemon-minted` guard forbids
 * reading a JSON-RPC id as one.
 */
export type InteractionId = `x_${string}`;
export type RunId = `r_${string}`;
export type DeliveryId = `dl_${string}`;
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
  readonly interaction: RegExp;
  readonly run: RegExp;
  readonly delivery: RegExp;
} = {
  daemon: /^d_[0-9A-HJKMNP-TV-Z]{26}$/,
  worker: /^w_[0-9A-HJKMNP-TV-Z]{26}$/,
  turn: /^t_[0-9A-HJKMNP-TV-Z]{26}$/,
  interaction: /^x_[0-9A-HJKMNP-TV-Z]{26}$/,
  run: /^r_[0-9A-HJKMNP-TV-Z]{26}$/,
  delivery: /^dl_[0-9A-HJKMNP-TV-Z]{26}$/,
};

export function isDaemonId(s: string): s is DaemonId {
  return ID_PATTERN.daemon.test(s);
}

export function isWorkerId(s: string): s is WorkerId {
  return ID_PATTERN.worker.test(s);
}

export function isTurnId(s: string): s is TurnId {
  return ID_PATTERN.turn.test(s);
}

export function isInteractionId(s: string): s is InteractionId {
  return ID_PATTERN.interaction.test(s);
}

export function isRunId(s: string): s is RunId {
  return ID_PATTERN.run.test(s);
}

export function isDeliveryId(s: string): s is DeliveryId {
  return ID_PATTERN.delivery.test(s);
}

/**
 * Throws OmniError("bad_request") with the offending value ELIDED from the message: the id
 * arrives from the wire, and echoing it back is how a reflected-value log line is born. The
 * value is kept in `detail`, which never crosses the wire (CONTRACTS.md §5.1 errors.ts).
 */
export function assertWorkerId(s: string): WorkerId {
  if (isWorkerId(s)) return s;
  throw new OmniError("bad_request", "malformed worker id", { detail: { value: s } });
}

export function assertTurnId(s: string): TurnId {
  if (isTurnId(s)) return s;
  throw new OmniError("bad_request", "malformed turn id", { detail: { value: s } });
}

/**
 * M2. Same elision rule as `assertWorkerId`: the value arrives from the wire and is kept in
 * `detail`, which never crosses it.
 *
 * MIGRATION. `InteractionPayload.requestId` becomes an `InteractionId` at the TYPE level, but
 * `eventEnvelopeSchema` keeps `z.string()` for that field so an M1-era persisted envelope
 * carrying `perm_1757…_3` still parses. Only NEWLY minted ids are `x_<ULID>` (§5.8.1).
 */
export function assertInteractionId(s: string): InteractionId {
  if (isInteractionId(s)) return s;
  throw new OmniError("bad_request", "malformed interaction id", { detail: { value: s } });
}

export function assertRunId(s: string): RunId {
  if (isRunId(s)) return s;
  throw new OmniError("bad_request", "malformed run id", { detail: { value: s } });
}

export function assertDeliveryId(s: string): DeliveryId {
  if (isDeliveryId(s)) return s;
  throw new OmniError("bad_request", "malformed delivery id", { detail: { value: s } });
}

export function workerRef(d: DaemonId, w: WorkerId): WorkerRef {
  return `${d}:${w}`;
}

export function parseWorkerRef(ref: string): { daemonId: DaemonId; workerId: WorkerId } {
  const at = ref.indexOf(":");
  const daemonId = at === -1 ? "" : ref.slice(0, at);
  const workerId = at === -1 ? "" : ref.slice(at + 1);
  if (!isDaemonId(daemonId) || !isWorkerId(workerId)) {
    throw new OmniError("bad_request", "malformed worker ref", { detail: { value: ref } });
  }
  return { daemonId, workerId };
}

// ── ULID ─────────────────────────────────────────────────────────────────────
//
// Crockford base32, 26 characters: 10 of millisecond timestamp, 16 of randomness. Monotonic
// within a millisecond by incrementing the random field, which is what makes ids sort in
// creation order inside one process.

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LEN = 10;
const RANDOM_LEN = 16;

function encodeTime(ms: number): string {
  let n = Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : 0;
  const out = new Array<string>(TIME_LEN);
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    const mod = n % 32;
    out[i] = CROCKFORD[mod] ?? "0";
    n = (n - mod) / 32;
  }
  return out.join("");
}

/** Uniform in [0, 1). Web Crypto is in Node's global scope from 19 onward, so no import. */
function defaultRandom(): number {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return (buf[0] ?? 0) / 2 ** 32;
}

function randomIndex(random: () => number): number {
  const v = Math.floor(random() * 32);
  return v < 0 ? 0 : v > 31 ? 31 : v;
}

/** Base-32 +1 with carry, in place. A full overflow wraps to all zeros; it needs 2^80 ids/ms. */
function incrementRandom(digits: number[]): void {
  for (let i = digits.length - 1; i >= 0; i--) {
    const d = digits[i] ?? 0;
    if (d < 31) {
      digits[i] = d + 1;
      return;
    }
    digits[i] = 0;
  }
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
  const now = opts?.now ?? Date.now;
  const random = opts?.random ?? defaultRandom;

  let lastTime = -1;
  let lastRandom: number[] = [];

  const next = (): string => {
    const t = Math.max(0, Math.floor(now()));
    if (t <= lastTime && lastRandom.length === RANDOM_LEN) {
      // Same millisecond (or a clock that stepped backwards): keep the timestamp and bump the
      // random field, so ids stay strictly increasing as strings.
      incrementRandom(lastRandom);
    } else {
      lastTime = t;
      lastRandom = Array.from({ length: RANDOM_LEN }, () => randomIndex(random));
    }
    let body = encodeTime(lastTime);
    for (const d of lastRandom) body += CROCKFORD[d] ?? "0";
    return body;
  };

  return {
    daemon: () => `d_${next()}`,
    worker: () => `w_${next()}`,
    turn: () => `t_${next()}`,
    request: () => next(),
    // M2 (§5.8.1). Same monotonic body, three more prefixes — a `DeliveryId` is not assignable
    // to a `RunId` with no brand ceremony (D12).
    interaction: () => `x_${next()}`,
    run: () => `r_${next()}`,
    delivery: () => `dl_${next()}`,
  };
}
