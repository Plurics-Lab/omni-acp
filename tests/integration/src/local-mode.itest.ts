import { rm } from "node:fs/promises";
import { OmniACP, type Server } from "@omni-acp/client";
import { sdkExampleAgentPath, waitGone } from "@omni-acp/testkit";
import { afterEach, describe, expect, it } from "vitest";
import { tempRoot } from "./support/harness.js";

/**
 * D14 end-to-end. The bad-token 401 is the point: it proves `local()` is real loopback HTTP and
 * not an in-memory shortcut, which is what makes D14 and D15 one code path. WP-6 owns this file.
 *
 * If `local()` were allowed a private in-memory transport, every property this suite checks
 * would be true of a mock, and the first person to run `omni-acp start` would be the first
 * person to exercise the HTTP layer.
 */
describe("OmniACP.local()", () => {
  const scratch: string[] = [];
  let server: Server | undefined;

  afterEach(async () => {
    await server?.close().catch(() => {});
    server = undefined;
    while (scratch.length > 0) {
      const dir = scratch.pop();
      if (dir !== undefined) await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  async function localServer(): Promise<{ server: Server; cwd: string }> {
    const cwd = await tempRoot("omni-acp-local-");
    const dataDir = await tempRoot("omni-acp-local-data-");
    scratch.push(cwd, dataDir);
    const started = await OmniACP.local({
      adopt: "never",
      dataDir,
      config: {
        // The ACL is the caller's to set; the secret and the admin role are `local()`'s.
        tokens: [{ id: "local", cwdRoots: [cwd] }],
        agents: [{ id: "example", command: process.execPath, args: [sdkExampleAgentPath()] }],
      },
    });
    server = started;
    return { server: started, cwd };
  }

  it("starts an embedded daemon on 127.0.0.1:0 and drives the SDK example agent end to end", async () => {
    const { server: local, cwd } = await localServer();

    // An ephemeral loopback port, never a fixed one.
    expect(local.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(local.me.role).toBe("admin");
    expect(local.daemonId).toMatch(/^d_[0-9A-HJKMNP-TV-Z]{26}$/);

    const worker = await local.createAgent("example", { cwd });
    expect(worker.state).toBe("ready");
    const pid = worker.snapshot.process?.pid ?? 0;

    const result = await worker.prompt("who are you?");
    expect(result.stopReason).toBe("end_turn");
    expect(result.text).toContain("I'll skip the configuration update");
    // `rule` is the PRESET that decided, since M2-WP-J wired the engine into `createDaemon`
    // (`policy.default` defaults to `deny-all`). The decision is M1's, unchanged.
    expect(result.interactions[0]).toMatchObject({ decision: "deny", rule: "deny-all#default" });

    const closed = await worker.close();
    expect(closed.leaderExited).toBe(true);
    expect(await waitGone(pid, 10_000)).toBe(true);
  }, 60_000);

  it("returns 401 to a raw fetch with a bad token — real loopback HTTP, not a shortcut", async () => {
    const { server: local } = await localServer();

    const unauthorized = await fetch(`${local.url}/v1/whoami`, {
      headers: { authorization: "Bearer definitely-not-the-generated-token" },
    });
    expect(unauthorized.status).toBe(401);

    const missing = await fetch(`${local.url}/v1/whoami`);
    expect(missing.status).toBe(401);

    // Health is unauthenticated on the embedded daemon too, because it is the SAME daemon.
    const health = await fetch(`${local.url}/v1/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });
  }, 45_000);

  it("stops the daemon and reclaims the trees on server.close()", async () => {
    const { server: local, cwd } = await localServer();
    const worker = await local.createAgent("example", { cwd });
    const pid = worker.snapshot.process?.pid ?? 0;
    const url = local.url;

    await local.close();
    server = undefined;

    // The agent tree is gone…
    expect(await waitGone(pid, 15_000)).toBe(true);
    // …and so is the socket. `fetch` against a closed loopback port fails to connect; that
    // rejection is the assertion.
    await expect(
      fetch(`${url}/v1/health`, { signal: AbortSignal.timeout(2_000) }),
    ).rejects.toBeTruthy();
  }, 60_000);

  it("throws a message naming M3 for adopt:'prefer' | 'require' and detach:true", async () => {
    for (const options of [
      { adopt: "prefer" as const },
      { adopt: "require" as const },
      { detach: true },
    ]) {
      const failure = await OmniACP.local(options).then(
        () => null,
        (e: unknown) => e,
      );
      expect(failure).toMatchObject({ name: "OmniError", code: "bad_request" });
      expect((failure as Error).message).toContain("M3");
    }
  }, 20_000);

  it("keeps two local() daemons independent", async () => {
    // `adopt:"never"` means never: two calls are two daemons, on two ports, with two ids.
    const first = await localServer();
    const firstUrl = first.server.url;
    const firstId = first.server.daemonId;
    await first.server.close();
    server = undefined;

    const second = await localServer();
    expect(second.server.url).not.toBe(firstUrl);
    expect(second.server.daemonId).not.toBe(firstId);
  }, 60_000);
});
