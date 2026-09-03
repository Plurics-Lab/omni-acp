import type { EventEnvelope, WorkerId } from "@omni-acp/protocol";
import { waitGone } from "@omni-acp/testkit";
import { afterEach, describe, expect, it } from "vitest";
import { fixtureAgent, startHarness, type Harness } from "./support/harness.js";

/**
 * `session/cancel` is a notification first and a kill only on close or timeout. The second
 * assertion is the one that matters: omni-acp Workers are long-lived across turns, so unlike
 * multica we must NOT close stdin at turn end (CONTRACTS.md §6.5). WP-6 owns this file.
 */
describe("cancel", () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.dispose();
    harness = undefined;
  });

  it("returns stopReason 'cancelled' with the process still alive, and accepts a second prompt", async () => {
    // The SDK example agent is COOPERATIVE: `session/cancel` aborts its simulated latency and
    // the prompt resolves `{stopReason:"cancelled"}`. No escalation, no dead process.
    harness = await startHarness({ roots: 1 });
    const server = await harness.connect();
    const worker = await server.createAgent("example", { cwd: harness.roots[0] ?? "" });
    const pid = worker.snapshot.process?.pid ?? 0;

    const turn = worker.prompt("start something long");
    // The fixture sleeps 1 000 ms between steps; cancel well inside the first one.
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    await worker.cancel();

    const result = await turn;
    expect(result.stopReason).toBe("cancelled");
    // Cancelled, not crashed: the turn ended cleanly and there is no error body.
    expect(result.error).toBeNull();

    // The process is STILL ALIVE, and the worker is back to `ready`. multica closes stdin at
    // turn end because its processes are one-shot; copying that here would kill a Worker that is
    // meant to outlive the turn (CONTRACTS.md §6.5, §11.3).
    //
    // The state is read from the daemon, not off the handle: `Worker.state` is the last state
    // THIS HANDLE OBSERVED, and `prompt()` stops reading at its own turn's `state_update{idle}`
    // — one seq before the `omni.worker_state{ready, turn_end}` the daemon appends next. The
    // handle therefore still holds `running`, by design (a property read must not become a
    // network call), so the fresh read is spelled out. It is not racy: the daemon appends both
    // envelopes in one synchronous step, so `idle` cannot reach a client before `ready` exists.
    const fresh = (await server.workers()).find((w) => w.workerId === worker.id);
    expect(fresh?.state).toBe("ready");
    expect(harness.daemon.supervisor.live.size).toBe(1);

    // And it takes another turn.
    const second = await worker.prompt("who are you?");
    expect(second.turnId).not.toBe(result.turnId);
    expect(second.stopReason).toBe("end_turn");
    expect(second.text).toContain("I'll skip the configuration update");

    const closed = await worker.close();
    expect(closed.leaderExited).toBe(true);
    expect(await waitGone(pid, 10_000)).toBe(true);
    await server.close();
  }, 60_000);

  it("is idempotent and a no-op when the worker is not running", async () => {
    harness = await startHarness({ roots: 1 });
    const server = await harness.connect();
    const worker = await server.createAgent("example", { cwd: harness.roots[0] ?? "" });

    await expect(worker.cancel()).resolves.toBeUndefined();
    await expect(worker.cancel()).resolves.toBeUndefined();
    expect(worker.state).toBe("ready");

    await server.close();
  }, 45_000);

  it("escalates to a tree kill and closes with cancel_timeout when cancelGraceMs elapses", async () => {
    // `slow.mjs` never answers `session/prompt` and deliberately IGNORES `session/cancel`, so
    // the cooperative rung cannot rescue this one and the escalation ladder has to run (§6.5).
    harness = await startHarness({
      roots: 1,
      agents: [fixtureAgent("slow", "slow")],
      config: { turn: { cancelGraceMs: 1_000 } },
    });
    const server = await harness.connect();
    const worker = await server.createAgent("slow", { cwd: harness.roots[0] ?? "" });
    const pid = worker.snapshot.process?.pid ?? 0;

    const turn = worker.prompt("this will never finish");
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    await worker.cancel();

    // The turn settles on `worker_state{closed}` rather than on an `idle` that never comes.
    const result = await turn;
    expect(result.stopReason).toBeNull();
    expect(result.error?.code).toBe("agent_timeout");

    const log = harness.daemon.workers
      .logFor(worker.id as WorkerId, harness.daemon.authContextFor("local"))
      .read(0);
    const closed = log.filter(
      (e: EventEnvelope) => e.kind === "omni.worker_state" && e.payload.state === "closed",
    );
    expect(closed).toHaveLength(1);
    const payload = closed[0]?.kind === "omni.worker_state" ? closed[0].payload : undefined;
    expect(payload?.reason).toBe("cancel_timeout");

    expect(await waitGone(pid, 10_000)).toBe(true);
    expect(harness.daemon.supervisor.live.size).toBe(0);
    await server.close();
  }, 60_000);
});
