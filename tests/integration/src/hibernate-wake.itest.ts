import { waitGone, type FixtureAgentName } from "@omni-acp/testkit";
import type { EventEnvelope, WorkerSnapshot } from "@omni-acp/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  curl,
  fixtureAgent,
  readEnvelopes,
  scaled,
  startHarness,
  until,
  type Harness,
} from "./support/harness.js";

/**
 * DESIGN §11's M1 acceptance, half two: **hibernated workers wake** (M1-PLAN §2, WP-F 6).
 *
 * Tier 3: a real process, a real socket, and `idleTimeoutMs: 200` so the idle timer fires inside
 * a test rather than in thirty minutes.
 *
 * **Not the SDK example agent, and that is a correction rather than a shortcut.** M1-PLAN §2
 * writes "the SDK example agent (`loadSession: true`)"; on the pinned `@agentclientprotocol/sdk`
 * 1.4.0 that fixture answers `initialize` with `agentCapabilities: {loadSession: false}` — checked
 * on this machine, 2026-09-04 — so it can never hibernate at all under ruling M1-R15's
 * `whenNotResumable: "keep"`. `hybrid.mjs` is the fixture that advertises `loadSession` AND
 * `sessionCapabilities.resume` and now implements both, which is what makes §15.3 reachable
 * without a login.
 *
 * Owned by M1-WP-F.
 */

const HIBERNATE_AGENT: FixtureAgentName = "hybrid";

let harness: Harness | null = null;
afterEach(async () => {
  await harness?.dispose();
  harness = null;
});

async function start(config?: { maxWorkers?: number; maxHibernated?: number }): Promise<Harness> {
  harness = await startHarness({
    agents: [fixtureAgent("hybrid", HIBERNATE_AGENT)],
    config: {
      // Durable, because a hibernated worker is a row that has to survive being the only thing
      // left of a worker (§14.8). The idle budget itself is per-worker below.
      eventLog: { driver: "sqlite" },
      hibernate: {
        idleMs: 600_000,
        ...(config?.maxHibernated === undefined ? {} : { maxHibernated: config.maxHibernated }),
      },
      ...(config?.maxWorkers === undefined ? {} : { maxWorkers: config.maxWorkers }),
    },
  });
  return harness;
}

/** Every envelope of a worker's life, read once over the real socket. */
function envelopesOf(h: Harness, workerId: string, since = 0): Promise<EventEnvelope[]> {
  return readEnvelopes(h.daemon.url ?? "", h.token, workerId, {
    since,
    quietMs: scaled(200),
    timeoutMs: scaled(10_000),
  });
}

async function snapshotOf(h: Harness, workerId: string): Promise<WorkerSnapshot> {
  const request = curl(h.daemon.url ?? "", h.token);
  return (await request(`/v1/workers/${workerId}`)).json() as Promise<WorkerSnapshot>;
}

describe("hibernate and wake, end to end", () => {
  it("idleTimeoutMs:200 drives ready -> hibernated, the process tree is reclaimed, and the session pointer and the log survive", async () => {
    const h = await start();
    const server = await h.connect();
    const worker = await server.createAgent("hybrid", {
      cwd: h.roots[0] ?? "",
      idleTimeoutMs: scaled(200),
    });

    // ONE prompt before the wait: a session opened by `session/new` and never prompted has
    // nothing to recall, and the whole value being preserved is the conversation (review R16).
    await worker.prompt("hello");
    const pid = worker.snapshot.process?.pid ?? 0;
    const sessionId = worker.snapshot.sessionId;
    expect(pid).toBeGreaterThan(0);
    expect(sessionId).not.toBeNull();

    const asleep = await until(
      async () => (await snapshotOf(h, worker.id)).state === "hibernated",
      scaled(20_000),
      50,
    );
    expect(asleep, "the idle timer never drove the worker to hibernated").toBe(true);

    const snapshot = await snapshotOf(h, worker.id);
    expect(snapshot.process, "a hibernated worker owns no process").toBeNull();
    // The pointer is the entire value being preserved (§15.2). Losing it would make the row a
    // record of a worker that can never come back.
    expect(snapshot.sessionId).toBe(sessionId);
    expect(snapshot.hibernatedAt).not.toBeNull();
    // §15.2 also releases the lease: a worker with no process has no turn to protect.
    expect(snapshot.lease.holder).toBeNull();
    // The process REALLY went away, not merely the daemon's reference to it.
    expect(await waitGone(pid, scaled(10_000)), `pid ${String(pid)} survived`).toBe(true);

    const envelopes = await envelopesOf(h, worker.id);
    const hibernations = envelopes.filter(
      (e) => e.kind === "omni.worker_state" && e.payload.state === "hibernated",
    );
    expect(hibernations).toHaveLength(1);
    // §15.1's `ready -> hibernated` row: the reason is `hibernate` whoever asked. `idle_timeout`
    // is a CLOSE reason — the opt-in `whenNotResumable: "close"` branch — and reusing it here
    // would make the log say a worker was closed when it went to sleep.
    expect(hibernations[0]?.kind === "omni.worker_state" && hibernations[0].payload.reason).toBe(
      "hibernate",
    );
    // The log SURVIVES: the whole turn is still readable from a worker with no process.
    expect(envelopes.some((e) => e.kind === "acp.session_update")).toBe(true);
  });

  it("the next prompt AUTO-WAKES: it blocks for the wake budget, then behaves normally, and the recorded ResumeReport's outcome is `landed`", async () => {
    const h = await start();
    const server = await h.connect();
    const worker = await server.createAgent("hybrid", {
      cwd: h.roots[0] ?? "",
      idleTimeoutMs: scaled(200),
    });
    await worker.prompt("first");
    expect(
      await until(
        async () => (await snapshotOf(h, worker.id)).state === "hibernated",
        scaled(20_000),
        50,
      ),
    ).toBe(true);
    const before = (await snapshotOf(h, worker.id)).headSeq;

    // §15.3's first box: no `POST /wake` — the prompt itself wakes it.
    const woken = await server.attach(worker.id);
    const result = await woken.prompt("second");
    expect(result.stopReason).not.toBeNull();

    const after = await envelopesOf(h, worker.id, before);
    const reasons = after
      .filter((e) => e.kind === "omni.worker_state")
      .map((e) => (e.kind === "omni.worker_state" ? e.payload.reason : ""));
    expect(reasons.slice(0, 2)).toEqual(["wake", "resumed"]);

    const resumed = after.find(
      (e) => e.kind === "omni.worker_state" && e.payload.reason === "resumed",
    );
    const report = resumed?.kind === "omni.worker_state" ? resumed.payload.resume : undefined;
    expect(report?.outcome).toBe("landed");
    expect(report?.rule).toBe("rule7:landed");
    expect(report?.method).toBe("session/resume");
    // `seq` CONTINUES: a woken worker must not restart its own history at 1 (§14.4).
    expect(after[0]?.seq).toBeGreaterThan(before);
    // Every envelope inside the replay window is marked, and nothing outside it is (D6, M1-R5).
    const wakeAt = after.findIndex(
      (e) => e.kind === "omni.worker_state" && e.payload.reason === "wake",
    );
    const resumedAt = after.findIndex(
      (e) => e.kind === "omni.worker_state" && e.payload.reason === "resumed",
    );
    expect(resumedAt).toBeGreaterThan(wakeAt);
    for (const [index, envelope] of after.entries()) {
      if (envelope.replay !== true) continue;
      expect(index, `seq ${String(envelope.seq)} is marked replay outside the window`).toBeLessThan(
        resumedAt,
      );
      expect(index).toBeGreaterThan(wakeAt);
    }
    expect(
      after.some((e) => e.replay === true),
      "nothing was replayed at all",
    ).toBe(true);

    const snapshot = await snapshotOf(h, worker.id);
    // "Processes this worker has had": the create, then the wake.
    expect(snapshot.generation).toBe(2);
    expect(snapshot.wakeCount).toBe(1);
    expect(snapshot.wakeFailures).toBe(0);
    expect(snapshot.resume?.outcome).toBe("landed");
  });

  it("POST /wake is idempotent and single-flight: five racing callers share ONE attempt", async () => {
    const h = await start();
    const server = await h.connect();
    // `idleTimeoutMs: 0` turns the idle timer OFF for this worker, and the hibernation is
    // explicit. Deliberate: with a 200 ms budget the worker re-hibernates the moment it wakes,
    // so `generation` would climb on a schedule and this test would be measuring the timer
    // instead of the single-flight property. The timer has its own test above.
    const worker = await server.createAgent("hybrid", { cwd: h.roots[0] ?? "", idleTimeoutMs: 0 });
    await worker.prompt("first");
    await worker.hibernate();
    expect((await snapshotOf(h, worker.id)).state).toBe("hibernated");
    const before = (await snapshotOf(h, worker.id)).headSeq;

    const request = curl(h.daemon.url ?? "", h.token);
    const racers = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(`/v1/workers/${worker.id}/wake`, { method: "POST", body: "{}" }),
      ),
    );
    for (const response of racers) expect(response.status).toBe(200);

    const after = await envelopesOf(h, worker.id, before);
    const wakes = after.filter(
      (e) => e.kind === "omni.worker_state" && e.payload.reason === "wake",
    );
    // ONE attempt, not five: five spawns of the same agent would be five processes, four of them
    // orphaned, and a session pointer resumed five times over (§15.3).
    expect(wakes, "five racing wakes produced more than one attempt").toHaveLength(1);
    expect((await snapshotOf(h, worker.id)).generation).toBe(2);
    // Idempotent: a sixth wake on an already-ready worker is a 200 and no new attempt.
    expect(
      (await request(`/v1/workers/${worker.id}/wake`, { method: "POST", body: "{}" })).status,
    ).toBe(200);
    expect((await snapshotOf(h, worker.id)).generation).toBe(2);
  });

  it("a hibernated worker holds no maxWorkers slot and one hibernate.maxHibernated slot instead", async () => {
    // H14: the two bounds are SEPARATE, because a hibernated worker owns no process and bounding
    // it by `maxWorkers` would make a fleet of sleeping sessions cost what running ones do.
    const h = await start({ maxWorkers: 1, maxHibernated: 1 });
    const server = await h.connect();
    const cwd = h.roots[0] ?? "";

    const first = await server.createAgent("hybrid", { cwd, idleTimeoutMs: scaled(200) });
    await first.prompt("hello");
    // The slot is taken.
    await expect(server.createAgent("hybrid", { cwd })).rejects.toMatchObject({
      code: "worker_limit",
    });

    expect(
      await until(
        async () => (await snapshotOf(h, first.id)).state === "hibernated",
        scaled(20_000),
        50,
      ),
    ).toBe(true);

    // …and now it is not: the hibernated worker gave the slot back.
    const second = await server.createAgent("hybrid", { cwd });
    expect(second.state).toBe("ready");

    // The other bound is real too: `maxHibernated: 1` is already spent, so hibernating the second
    // worker is a `429` rather than a silent overflow.
    // Through the SDK rather than raw `curl`, because hibernate is lease-gated and a bare `curl`
    // carries no `Omni-Client-Id`: it would be refused `423` by the fence before the limit was
    // ever consulted (§16.1 rule L2), which would prove the wrong rule.
    await expect(second.hibernate()).rejects.toMatchObject({ code: "worker_limit", status: 429 });
  });
});
