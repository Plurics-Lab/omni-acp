/**
 * Per-OS liveness probes.
 *
 * `process.kill(pid, 0)` sends no signal: on POSIX it is the classic existence check, and on
 * Windows libuv implements signal 0 as a health check over the process handle, so ONE
 * implementation is honest on all three OSes.
 *
 * CONTRACTS.md §5.2 sketches `tasklist` for the Windows branch. That would put a
 * `node:child_process` import inside `packages/testkit/src/**`, which §6.1's `no-direct-spawn`
 * guard forbids everywhere but `core/src/process/spawn.ts` — and the guard is right: a second
 * spawn site is exactly multica's GH #7522. `tasklist` stays where it belongs, in
 * `platform-windows.ts`, reached through the injected `runUtility` (review R8).
 */

/** True when a process with this pid exists. EPERM means it exists and is not ours. */
export function isAlive(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve(false);
  try {
    process.kill(pid, 0);
    return Promise.resolve(true);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return Promise.resolve(code === "EPERM");
  }
}

/** Polls until the pid is gone. Returns false on timeout — never throws, never hangs. */
export async function waitGone(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    if (!(await isAlive(pid))) return true;
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25).unref?.();
    });
  }
}
