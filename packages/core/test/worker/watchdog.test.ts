import { describe, it } from "vitest";

/**
 * `createWatchdog` — the pure fold plus ONE `Clock.setTimer`, and the escalation it hands back to
 * M1's existing `cancel_timeout` ladder.
 *
 * Owned by M2-A-WP-W.
 */

describe("createWatchdog and the escalation (§21)", () => {
  it.todo(
    "firing appends omni.error{agent_timeout} BEFORE cancelInternal, and the close comes only after cancelTimeoutMs and is cancel_timeout — M1's existing reason; cancel-and-close.test.ts passes unedited",
  );
  it.todo("cancelTimeoutMs <= turn.cancelGraceMs is a config LOAD error");
  it.todo(
    "the watchdog and the hibernate timer are NEVER both armed, for every state in §15.1's table",
  );
  it.todo(
    "the watchdog does not survive a restart: an adopted row is never `running`, so there is nothing to arm",
  );
  it.todo(
    "strandedToolCalls is exactly the one open id on claude 16 (pending) and codex 08 (in_progress), and EMPTY on every clean M1 turn, so no M1 golden changes its verdict",
  );
  it.todo(
    "TurnResult aggregation NEVER blocks: a turn whose only tool call stays pending still settles",
  );
  it.todo(
    'patch / patchInfo are read from state_update{idle}._meta["omni/patch"]; with no provider the key is absent and the value is null; a hung provider still yields idle with patch: null and a patch_timeout warning',
  );
  it.todo(
    "reduceTurn is still pure, deterministic, de-duplicating by (workerId, seq) and replay-skipping; M1's six generated goldens and eight named cases pass unchanged apart from the additive new keys",
  );
});
