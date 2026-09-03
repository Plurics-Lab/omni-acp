import { OmniError } from "@omni-acp/protocol";

/** Per-OS liveness probes: kill(pid,0) on POSIX, tasklist on Windows. */
export function isAlive(pid: number): Promise<boolean> {
  throw new OmniError("internal", "unimplemented: WP-1 (testkit.isAlive)");
}

export function waitGone(pid: number, timeoutMs?: number): Promise<boolean> {
  throw new OmniError("internal", "unimplemented: WP-1 (testkit.waitGone)");
}
