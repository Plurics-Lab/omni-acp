import { ENV_DENY_EXACT, ENV_DENY_PREFIX, OmniError } from "@omni-acp/protocol";
import type { EnvResolution } from "@omni-acp/protocol";

/**
 * Per-worker env, against DESIGN §8's hard blacklist ⊕ `envDeny` ⊕ the token's `envAllow`.
 *
 * A blacklisted key is REJECTED with a `400` naming it (ruling M2-R12), never silently dropped:
 * a client that set `NODE_OPTIONS` and got a worker anyway would reasonably believe it took
 * effect, and the whole point of the list is that it did not.
 *
 * `platform` is INJECTED so BOTH branches are tested rather than one being skipped on CI.
 * Windows environment variable names are case-INSENSITIVE, so comparing case-sensitively there
 * lets `{"path": "…"}` sail straight past a deny list that only knows `PATH` (§23.3).
 *
 * The result carries KEY NAMES for the snapshot and the values for the spawn. An env VALUE never
 * reaches a snapshot, a log line or an HTTP body, and there is a grep test over a full
 * create-prompt-close cycle that says so.
 *
 * Owned by M2-B-WP-S.
 */

/**
 * THE DENY TABLES ARE IMPORTED, NEVER RESTATED.
 *
 * `ENV_DENY_EXACT` / `ENV_DENY_PREFIX` live in `packages/protocol/src/config.ts` beside
 * `hashSecret` and `redactArgs`, for the reason those do: a second copy is how one of two callers
 * quietly stops enforcing it. The `env-deny-is-one-table` guard asserts that exactly one module
 * in the repository declares them, so this line is the only shape this file may take.
 */
const HARD_EXACT: readonly string[] = ENV_DENY_EXACT;
const HARD_PREFIX: readonly string[] = ENV_DENY_PREFIX;

/**
 * A boundary, not a suggestion (§23.3).
 *
 * zod already caps one key at 256 characters and one value at 8 KiB on
 * `CreateWorkerRequest.env`, and caps nothing about the map as a whole; an in-process caller is
 * bound by neither. 64 entries is far more than any real agent reads and small enough that the
 * whole map fits in a log line's worth of key names.
 */
export const MAX_ENV_KEYS = 64;
/** Sum of `key.length + value.length` over the REQUEST. 256 KiB is a `spawn` argument list. */
export const MAX_ENV_BYTES = 256 * 1024;

/** POSIX's own rule for a name `sh` can export, and the only shape any agent will read. */
const VALID_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A key in an error message came from the wire, so it is quoted and clamped like every echo. */
function quoted(key: string): string {
  return JSON.stringify(key.length <= 64 ? key : `${key.slice(0, 64)}…`);
}

const badRequest = (message: string, key: string): OmniError =>
  // `detail` carries the KEY and never the VALUE. DESIGN §8: an env value does not reach a
  // snapshot, a log line or an HTTP body, and `detail` is the half of an OmniError that IS
  // logged.
  new OmniError("bad_request", message, { detail: { envKey: key } });

/**
 * The comparison key. Case-folded on win32 and NOWHERE else, and `platform` is a parameter so
 * both branches run on one machine.
 *
 * Windows environment variable names are case-insensitive: `set path=…` replaces `PATH` for
 * real. A deny list that only knows `PATH`, compared case-sensitively, therefore denies nothing
 * at all on the one platform where the attack is a single keystroke.
 */
function fold(key: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? key.toUpperCase() : key;
}

export function resolveWorkerEnv(o: {
  base: Readonly<Record<string, string>>;
  descriptor: Readonly<Record<string, string>>;
  request: Readonly<Record<string, string>> | undefined;
  extraDeny: readonly string[];
  allow: readonly string[];
  platform: NodeJS.Platform;
  /**
   * §23.3's escape hatch, and the one field of `EnvResolution` this signature cannot otherwise
   * produce.
   *
   * `false` ⇒ `WorkerRow.env` is written as `null`, which forces `capabilities.resume.method` to
   * `null`, which means the worker can never hibernate (`hibernate.whenNotResumable` then
   * governs) — trading hibernation for the exposure rather than waking into a silently different
   * environment.
   *
   * OPTIONAL because `CreateWorkerRequest.env` is `z.record(string, string)` and has no wire
   * spelling for it: there is nowhere for a client to say `env.persist:false` today.
   * M2-B-WP-S's notes carry the exact `control-plane.ts` change; until it lands the only caller
   * is an in-process embedder, and the default is the M1-compatible `true`.
   */
  persist?: boolean;
}): EnvResolution {
  const persist = o.persist ?? true;
  const request = o.request;

  // An absent or empty map is a request that asked for NO env at all — which is every M1
  // request. It resolves to the descriptor's environment and nothing else, and it is the one
  // case that must not throw.
  if (request === undefined) {
    return { env: compose(o.base, o.descriptor, {}), keys: [], persist };
  }
  const requested = Object.keys(request);
  if (requested.length === 0) {
    return { env: compose(o.base, o.descriptor, {}), keys: [], persist };
  }

  if (requested.length > MAX_ENV_KEYS) {
    throw new OmniError(
      "bad_request",
      `env carries ${String(requested.length)} keys; the limit is ${String(MAX_ENV_KEYS)}`,
    );
  }

  let bytes = 0;
  const foldedSeen = new Map<string, string>();
  const denyExact = new Set(HARD_EXACT.map((k) => fold(k, o.platform)));
  // `envDeny` EXTENDS the hard list and can never shrink it: the hard names go into the set
  // first and nothing is ever removed from it. `env-deny-is-one-table` guards the table's
  // uniqueness; this line guards its monotonicity, and `resolveWorkerEnv`'s tests prove that an
  // `extraDeny` naming nothing still denies everything the hard list does.
  for (const extra of o.extraDeny) denyExact.add(fold(extra, o.platform));
  const denyPrefix = HARD_PREFIX.map((p) => fold(p, o.platform));
  const allow = new Set(o.allow.map((k) => fold(k, o.platform)));

  for (const key of requested) {
    const value = request[key] as string;

    // ── shape ────────────────────────────────────────────────────────────────
    if (!VALID_KEY.test(key)) {
      throw badRequest(`env key ${quoted(key)} is not a valid environment variable name`, key);
    }
    if (value.includes("\0")) {
      // NAMING THE KEY AND NEVER THE VALUE. A NUL in a value truncates the variable at the
      // execve boundary, so what the agent reads is a prefix of what the client sent.
      throw badRequest(`env value for ${quoted(key)} contains a NUL byte`, key);
    }
    bytes += key.length + value.length;
    if (bytes > MAX_ENV_BYTES) {
      throw new OmniError("bad_request", `env exceeds ${String(MAX_ENV_BYTES)} bytes`);
    }

    const folded = fold(key, o.platform);

    // Two spellings of ONE variable, on the platform where they ARE one variable. Left
    // unchecked, `{"Path": "a", "PATH": "b"}` resolves by object-key order — which is to say,
    // arbitrarily — and one of the two silently does nothing.
    const twin = foldedSeen.get(folded);
    if (twin !== undefined) {
      throw badRequest(
        `env keys ${quoted(twin)} and ${quoted(key)} are the same variable on ${o.platform}`,
        key,
      );
    }
    foldedSeen.set(folded, key);

    // ── deny, BEFORE allow ───────────────────────────────────────────────────
    //
    // The hard list is public — it is printed in DESIGN §5.1 and in CONTRACTS §23.3 — so
    // answering it first leaks nothing, and it gives the caller the message that actually
    // explains the refusal. It is also the order that keeps the rule absolute: a key on the hard
    // list is refused even for a token whose `envAllow` names it, which is what "nothing shrinks
    // it" means.
    if (denyExact.has(folded)) {
      throw badRequest(`env key ${quoted(key)} is on the daemon's env deny list`, key);
    }
    const prefix = denyPrefix.find((p) => folded.startsWith(p));
    if (prefix !== undefined) {
      throw badRequest(
        `env key ${quoted(key)} matches the denied prefix ${JSON.stringify(prefix)}`,
        key,
      );
    }

    // ── the token's ACL ──────────────────────────────────────────────────────
    //
    // `envAllow` defaults to `[]` and there is no wildcard: per-worker env is off until an
    // operator names the keys, the same fail-closed default `mcpPresets` has.
    if (!allow.has(folded)) {
      throw new OmniError("forbidden", `env key ${quoted(key)} is not allowed for this token`, {
        detail: { envKey: key },
      });
    }

    // ── the descriptor's env is not the client's to rewrite ──────────────────
    //
    // DESIGN §5.1: per-worker env 叠加在 daemon 密钥库注入的凭据之后 — it LAYERS ON TOP OF the
    // credentials the daemon injected. The descriptor's env is where an operator puts an agent's
    // API key, and a client that could overwrite it could point the agent at its own endpoint
    // with the operator's token. REJECTED rather than ignored, for M2-R12's reason: silently
    // keeping the descriptor's value would hand back a worker whose environment is not the one
    // the caller asked for, with nothing saying so.
    if (Object.hasOwn(o.descriptor, key)) {
      throw badRequest(
        `env key ${quoted(key)} is supplied by the agent descriptor and cannot be overridden`,
        key,
      );
    }
  }

  return {
    env: compose(o.base, o.descriptor, request),
    // KEY NAMES ONLY, sorted so two equal requests produce an equal snapshot. This is the list
    // that reaches `WorkerSnapshot.envKeys`; the values go only to `spawn`.
    keys: [...requested].sort(),
    persist,
  };
}

/**
 * The complete child environment, in ONE expression: the daemon's own environment, then the
 * descriptor's config-supplied variables, then the request's.
 *
 * The last layer cannot collide with the second — every colliding key was refused above — so the
 * spread order is documentation rather than a tie-breaker. It CAN and must override the first:
 * overriding an inherited variable is the entire purpose of per-worker env, and every inherited
 * variable dangerous enough to matter is on the deny list.
 */
function compose(
  base: Readonly<Record<string, string>>,
  descriptor: Readonly<Record<string, string>>,
  request: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  return { ...base, ...descriptor, ...request };
}
