import { OmniError, type Clock } from "@omni-acp/protocol";

export interface FakeClock extends Clock {
  advance(ms: number): void;
  readonly pendingTimers: number;
  set(epochMs: number): void;
}

export function fakeClock(startEpochMs?: number): FakeClock {
  throw new OmniError("internal", "unimplemented: WP-1 (testkit.fakeClock)");
}
