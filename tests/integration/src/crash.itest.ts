import type { EventEnvelope, WorkerId } from "@omni-acp/protocol";
import { waitGone } from "@omni-acp/testkit";
import { afterEach, describe, expect, it } from "vitest";
import { fixtureAgent, startHarness, type Harness } from "./support/harness.js";

/**
 * The crash rule (CONTRACTS.md §7.3): a dead agent never produces a fabricated `idle`.
 * `prompt()` still cannot hang, because a turn is terminal on `idle` OR on
 * `worker_state{closed}` — and `stopReason` stays null rather than becoming a lie. WP-6 owns this.
 *
 * Fabricating `{state:"idle", stopReason:"cancelled"}` would put a falsehood into
 * `TurnResult.stopReason` and flow it into every downstream consumer — turn polling, Run
 * results, webhooks. The whole design of the terminal predicate exists to avoid that one lie.
 */
describe("agent crash mid-turn", () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.dispose();
    harness = undefined;
  });

  it("settles prompt(), never fabricates idle, and reclaims the tree", async () => {
    harness = await startHarness({ roots: 1, agents: [fixtureAgent("crash", "crash")] });
    const server = await harness.connect();
    const worker = await server.createAgent("crash", { cwd: harness.roots[0] ?? "" });
    const pid = worker.snapshot.process?.pid ?? 0;
    expect(pid).toBeGreaterThan(0);

    // Settles rather than hanging. If the terminal predicate lost its `worker_state{closed}`
    // arm, this line would wait for the suite's whole 60 s budget and then fail as a timeout.
    const result = await worker.prompt("say something then die");

    expect(result.stopReason).toBeNull();
    expect(result.text).toContain("about to crash");
    expect(result.error).not.toBeNull();
    expect(result.error?.code).toBe("agent_error");

    const log = await drain(harness, worker.id);

    // `omni.error` with a non-empty stderr tail, then `worker_state{closed, agent_crashed}`.
    const errors = log.filter((e) => e.kind === "omni.error");
    expect(errors).toHaveLength(1);
    const errorPayload = errors[0]?.kind === "omni.error" ? errors[0].payload : undefined;
    expect(errorPayload?.code).toBe("agent_error");
    expect(errorPayload?.stderrTail ?? "").toContain("simulated fault");

    const closed = log.filter(
      (e) => e.kind === "omni.worker_state" && e.payload.state === "closed",
    );
    expect(closed).toHaveLength(1);
    const closePayload = closed[0]?.kind === "omni.worker_state" ? closed[0].payload : undefined;
    expect(closePayload?.reason).toBe("agent_crashed");
    expect(closePayload?.exit?.code).toBe(1);
    // §6.6: the honest ownership fields ride on the close envelope too.
    expect(closePayload?.leaderExited).toBe(true);
    expect(closePayload?.treeGone).toBe(process.platform !== "win32");

    // NO state_update{idle}, anywhere in the log.
    expect(log.filter(isIdle)).toEqual([]);

    // The error envelope precedes the close, and both are inside the turn's bracket.
    expect((errors[0]?.seq ?? 0) < (closed[0]?.seq ?? 0)).toBe(true);

    expect(await waitGone(pid, 10_000)).toBe(true);
    expect(harness.daemon.supervisor.live.size).toBe(0);

    // The daemon's own aggregate agrees with the client's, on a failed turn as on a good one.
    const status = await worker.turn(result.turnId);
    expect(status.state).toBe("failed");
    expect(status.result).toEqual(result);

    await server.close();
  }, 60_000);

  it("reports the worker closed to a subsequent request rather than pretending it is ready", async () => {
    harness = await startHarness({ roots: 1, agents: [fixtureAgent("crash", "crash")] });
    const server = await harness.connect();
    const worker = await server.createAgent("crash", { cwd: harness.roots[0] ?? "" });

    await worker.prompt("die");

    await expect(worker.prompt("again")).rejects.toMatchObject({ code: "worker_closed" });
    expect(worker.state).toBe("closed");
    await server.close();
  }, 60_000);
});

function isIdle(e: EventEnvelope): boolean {
  if (e.kind !== "acp.session_update") return false;
  const payload = e.payload as unknown as Record<string, unknown>;
  return payload["sessionUpdate"] === "state_update" && payload["state"] === "idle";
}

/** The log read straight from the daemon's library surface — no SSE race to lose. */
async function drain(harness: Harness, workerId: WorkerId): Promise<readonly EventEnvelope[]> {
  const auth = harness.daemon.authContextFor("local");
  return harness.daemon.workers.logFor(workerId, auth).read(0);
}
