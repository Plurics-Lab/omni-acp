import { OmniError } from "@omni-acp/protocol";
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
export function resolveWorkerEnv(_o: {
  base: Readonly<Record<string, string>>;
  descriptor: Readonly<Record<string, string>>;
  request: Readonly<Record<string, string>> | undefined;
  extraDeny: readonly string[];
  allow: readonly string[];
  platform: NodeJS.Platform;
}): EnvResolution {
  throw new OmniError("internal", "unimplemented: M2-B-WP-S");
}
