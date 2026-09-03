import { client as acpClient, ndJsonStream } from "@agentclientprotocol/sdk";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { fixtureAgentPath, waitGone, type FixtureAgentName } from "@omni-acp/testkit";

/**
 * TEST SUPPORT ONLY: launches one of the fixture agents as a real process and drives it with a
 * real ACP client over real pipes.
 *
 * `node:child_process` here is fine — §6.1's single-spawn rule scopes to the packages' `src`
 * directories,
 * and this is the Tier-2 proof that the fixtures are working agents rather than files. The
 * production spawn path is WP-2's `core/src/process/spawn.ts`.
 */
export interface LaunchedFixture {
  readonly child: ChildProcessWithoutNullStreams;
  readonly cx: ReturnType<ReturnType<typeof acpClient>["connect"]>["agent"];
  readonly updates: Record<string, unknown>[];
  stderrText(): string;
  handshake(): Promise<string>;
  kill(): Promise<void>;
}

const POSIX = process.platform !== "win32";

export function launchFixture(
  name: FixtureAgentName,
  env: Record<string, string> = {},
): LaunchedFixture {
  const child = spawn(process.execPath, [fixtureAgentPath(name)], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
    // Own process group on POSIX so the whole tree can be reclaimed after the test, which is
    // exactly what `orphan` needs.
    detached: POSIX,
    windowsHide: true,
  }) as ChildProcessWithoutNullStreams;

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d: string) => {
    stderr += d;
  });
  child.on("error", () => {});

  // F6: ndJsonStream(output, input) — output is what WE write (the agent's stdin).
  const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
  const updates: Record<string, unknown>[] = [];
  const connection = acpClient({ name: "fixture-driver" })
    .onNotification("session/update", (ctx) => {
      updates.push(ctx.params.update as unknown as Record<string, unknown>);
    })
    .onRequest("session/request_permission", () => ({ outcome: { outcome: "cancelled" } }))
    .connect(stream);

  return {
    child,
    cx: connection.agent,
    updates,
    stderrText: () => stderr,
    async handshake() {
      await connection.agent.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {},
      });
      const session = await connection.agent.request("session/new", {
        cwd: process.cwd(),
        mcpServers: [],
      });
      return session.sessionId;
    },
    async kill() {
      connection.close();
      const pid = child.pid;
      if (pid !== undefined && child.exitCode === null) {
        try {
          if (POSIX) process.kill(-pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        await waitGone(pid, 2_000);
      }
    },
  };
}
