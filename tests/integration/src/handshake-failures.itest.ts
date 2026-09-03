import type { OmniErrorBody, WorkerListResponse } from "@omni-acp/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { curl, fixtureAgent, startHarness, until, type Harness } from "./support/harness.js";

/**
 * WP-6. Both failure edges reclaim the process tree BEFORE responding (CONTRACTS.md H5).
 *
 * That ordering is the whole test. A daemon that answered 502 and reaped afterwards would pass
 * a naive assertion and still leak a process per failed create — the failure mode that only
 * shows up in production, as a machine slowly filling with agents nobody asked for.
 */
describe("handshake failures", () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.dispose();
    harness = undefined;
  });

  it("returns 502 agent_error when the agent dies before answering initialize, with no orphan", async () => {
    harness = await startHarness({
      roots: 1,
      agents: [
        // A "shim-free" launch of a program that simply leaves. It never speaks ACP, so the
        // handshake cannot complete and the transport EOFs (§6.7).
        { id: "quitter", command: process.execPath, args: ["-e", "process.exit(7)"] },
      ],
    });
    const http = curl(harness.daemon.url ?? "", harness.token);

    const res = await http("/v1/workers", {
      method: "POST",
      body: JSON.stringify({ agent: "quitter", cwd: harness.roots[0] }),
    });

    expect(res.status).toBe(502);
    const body = (await res.json()) as OmniErrorBody;
    expect(body.code).toBe("agent_error");
    expect(
      Object.keys(body)
        .filter((k) => k !== "acp")
        .sort(),
    ).toEqual(["code", "message"]);

    // Reclaimed BEFORE the response, so this is true the instant the caller is answered.
    expect(harness.daemon.supervisor.live.size).toBe(0);
    // And no half-created worker is left visible.
    const list = (await (await http("/v1/workers")).json()) as WorkerListResponse;
    expect(list.workers.filter((w) => w.state !== "closed")).toEqual([]);
  }, 45_000);

  it("returns 502 agent_error when the command does not exist, with no orphan", async () => {
    harness = await startHarness({
      roots: 1,
      agents: [{ id: "missing", command: "omni-acp-no-such-binary", args: [] }],
    });
    const http = curl(harness.daemon.url ?? "", harness.token);

    const res = await http("/v1/workers", {
      method: "POST",
      body: JSON.stringify({ agent: "missing", cwd: harness.roots[0] }),
    });

    // A spawn failure is `agent_error` too (§9): the daemon could not get an agent, and the
    // caller does not need to learn a second code to find that out.
    expect(res.status).toBe(502);
    expect(((await res.json()) as OmniErrorBody).code).toBe("agent_error");
    expect(harness.daemon.supervisor.live.size).toBe(0);
  }, 45_000);

  it("returns 504 agent_timeout when timeoutMs elapses, with no orphan process", async () => {
    // `SLOW_HANDSHAKE=1` withholds the `initialize` response forever — the handshake-budget mode
    // the fixture exists for.
    harness = await startHarness({
      roots: 1,
      agents: [fixtureAgent("slow", "slow", { SLOW_HANDSHAKE: "1" })],
      handshakeTimeoutMs: 1_500,
    });
    const http = curl(harness.daemon.url ?? "", harness.token);

    const started = Date.now();
    const res = await http("/v1/workers", {
      method: "POST",
      body: JSON.stringify({ agent: "slow", cwd: harness.roots[0], timeoutMs: 1_000 }),
    });
    const elapsed = Date.now() - started;

    expect(res.status).toBe(504);
    expect(((await res.json()) as OmniErrorBody).code).toBe("agent_timeout");
    // The PER-REQUEST budget won, not the daemon default: 1 s, not 1.5 s.
    expect(elapsed).toBeLessThan(1_400);

    // The tree is reclaimed before the response — a hung agent is exactly the case where
    // leaking is easiest and least visible.
    expect(harness.daemon.supervisor.live.size).toBe(0);
    expect(await until(() => harness?.daemon.supervisor.live.size === 0, 2_000)).toBe(true);
  }, 45_000);

  it("rejects a handshake budget outside the documented 1 s – 600 s range", async () => {
    harness = await startHarness({ roots: 1 });
    const http = curl(harness.daemon.url ?? "", harness.token);

    for (const timeoutMs of [10, 10_000_000]) {
      const res = await http("/v1/workers", {
        method: "POST",
        body: JSON.stringify({ agent: "example", cwd: harness.roots[0], timeoutMs }),
      });
      expect(`${String(timeoutMs)} -> ${String(res.status)}`).toBe(`${String(timeoutMs)} -> 400`);
      expect(((await res.json()) as OmniErrorBody).code).toBe("bad_request");
    }
  }, 45_000);
});
