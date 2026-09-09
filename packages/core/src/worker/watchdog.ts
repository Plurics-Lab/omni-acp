import { OmniError } from "@omni-acp/protocol";
import type { Watchdog, WatchdogDeps } from "@omni-acp/protocol";

/**
 * `watchdogStep` plus ONE `Clock.setTimer`, and nothing else.
 *
 * When it fires it appends `omni.error{agent_timeout}` and then calls `cancelInternal` — the
 * daemon-initiated cancel that is deliberately NOT lease-gated, because the lease governs CLIENTS
 * and the idle watchdog is not one. The close, if the agent ignores the cancel, comes from M1's
 * EXISTING `cancelGraceMs` escalation and is `cancel_timeout`: M2 adds no `WorkerCloseReason`, so
 * `turn.ts`'s total `CLOSE_REASON_CODE` cannot silently rot (§5.8.3).
 *
 * It does not survive a restart, and that needs no code: an adopted row is never `running`, so
 * there is nothing to arm. WP-W asserts it anyway.
 *
 * Owned by M2-A-WP-W.
 */
export function createWatchdog(_o: WatchdogDeps): Watchdog {
  throw new OmniError("internal", "unimplemented: M2-A-WP-W");
}
