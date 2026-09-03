import type { EventEnvelope, TurnResult } from "@omni-acp/protocol";
import type { Server, Worker } from "@omni-acp/client";
import { waitGone } from "@omni-acp/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHarness, type Harness } from "./support/harness.js";

/**
 * DESIGN §11's M0 acceptance criterion, made mechanical (M0-PLAN.md §4). WP-6 owns this file.
 *
 * Fixture: the SDK's own unmodified `dist/examples/agent.js`, launched as
 * `process.execPath <sdkExampleAgentPath()>` so it is shim-free on all three OSes.
 *
 * The claim under test is non-interference, and it is proven on the LOGS, not on vibes: every
 * envelope in each worker's log carries that worker's id, `seq` is exactly `1..n` with no gaps,
 * and the two turns' aggregates are independent objects.
 */

const PROMPT = "who are you?";
/** The agent simulates 5 x 1 000 ms of model latency per turn; two in parallel ≈ 6 s. */
const TURN_BUDGET_MS = 45_000;

interface Run {
  readonly worker: Worker;
  readonly result: TurnResult;
  readonly log: readonly EventEnvelope[];
}

describe("two workers do not interfere", () => {
  let harness: Harness;
  let server: Server;
  let a: Run;
  let b: Run;

  beforeAll(async () => {
    harness = await startHarness({ roots: 2 });
    server = await harness.connect();

    const [rootA, rootB] = harness.roots;
    // Concurrently, on purpose: two spawns, two handshakes and two `session/new` calls racing
    // through one registry is exactly where a shared mutable "current worker" would show up.
    const [w1, w2] = await Promise.all([
      server.createAgent("example", { cwd: rootA ?? "", label: "a" }),
      server.createAgent("example", { cwd: rootB ?? "", label: "b" }),
    ]);

    const [r1, r2] = await Promise.all([w1.prompt(PROMPT), w2.prompt(PROMPT)]);

    a = { worker: w1, result: r1, log: await drain(w1) };
    b = { worker: w2, result: r2, log: await drain(w2) };
  }, TURN_BUDGET_MS);

  afterAll(async () => {
    await server?.close().catch(() => {});
    await harness?.dispose();
  });

  // ── identity and isolation ─────────────────────────────────────────────────

  it("gives the two workers different ids, sessionIds and pids", () => {
    expect(a.worker.id).not.toBe(b.worker.id);
    expect(a.worker.sessionId).not.toBeNull();
    expect(b.worker.sessionId).not.toBeNull();
    expect(a.worker.sessionId).not.toBe(b.worker.sessionId);
    expect(a.worker.snapshot.process?.pid).toBeGreaterThan(0);
    expect(a.worker.snapshot.process?.pid).not.toBe(b.worker.snapshot.process?.pid);
  });

  it("gives the two turns different turnIds", () => {
    expect(a.result.turnId).not.toBe(b.result.turnId);
  });

  it("puts only its own workerId and sessionId in each worker's log, seq exactly 1..n", () => {
    for (const run of [a, b]) {
      const seqs = run.log.map((e) => e.seq);
      expect(seqs).toEqual(seqs.map((_, i) => i + 1));

      for (const envelope of run.log) {
        expect(envelope.workerId).toBe(run.worker.id);
        // The pre-handshake prefix is frozen at `sessionId: null` and is NEVER back-filled
        // (§8.2 rule 3, review R16); every envelope that HAS a session id has this one's.
        if (envelope.sessionId !== null) expect(envelope.sessionId).toBe(run.worker.sessionId);
      }

      // Seq 1 is always `worker_state{starting}`, so `?since=0` replays a worker's whole life.
      const first = run.log[0];
      expect(first?.kind).toBe("omni.worker_state");
      expect(first?.sessionId).toBeNull();
      if (first?.kind === "omni.worker_state") expect(first.payload.state).toBe("starting");
    }

    // And nothing leaked sideways.
    expect(a.log.some((e) => e.workerId === b.worker.id)).toBe(false);
    expect(b.log.some((e) => e.workerId === a.worker.id)).toBe(false);
  });

  // ── the turn actually ran to completion ────────────────────────────────────

  it("returns stopReason 'end_turn' for both", () => {
    expect(a.result.stopReason).toBe("end_turn");
    expect(b.result.stopReason).toBe("end_turn");
    expect(a.result.error).toBeNull();
    expect(b.result.error).toBeNull();
  });

  it("returns text containing the reject-branch sentence, proving the permission was answered", () => {
    // The second string is produced ONLY by the agent's `reject` branch, which it can only reach
    // after an answer actually arrived. A stronger assertion than the allow branch, and the
    // reason M0's baseline responder is fixed auto-DENY (F1, D1, §7.4).
    for (const run of [a, b]) {
      expect(run.result.text).toContain("I'll help you with that");
      expect(run.result.text).toContain("I'll skip the configuration update");
      expect(run.result.text).not.toContain("successfully updated the configuration");
    }
  });

  it("returns toolCalls ['call_1','call_2'] with call_2 left pending by the reject branch", () => {
    for (const run of [a, b]) {
      expect(run.result.toolCalls.map((t) => t.toolCallId)).toEqual(["call_1", "call_2"]);
      expect(run.result.toolCalls[0]?.status).toBe("completed");
      // `call_2` is never terminalised: the fixture sends its
      // `tool_call_update{status:"completed"}` only on the allow branch, and §7.4's fixed
      // auto-DENY responder always takes reject. The pending status IS the proof (review R6).
      expect(run.result.toolCalls[1]?.status).toBe("pending");
    }
  });

  it("records exactly one interaction {decision:'deny', rule:'m0:auto-deny', optionId:'reject'}", () => {
    for (const run of [a, b]) {
      expect(run.result.interactions).toHaveLength(1);
      expect(run.result.interactions[0]).toMatchObject({
        decision: "deny",
        rule: "m0:auto-deny",
        optionId: "reject",
      });
      expect(run.result.interactions[0]?.title).toBe("Modifying critical configuration file");
    }
  });

  it("returns changes [] and patch null (M0, D8)", () => {
    for (const run of [a, b]) {
      // The example agent emits no `ToolCallContent{type:"diff"}`, and the git provider is M2.
      expect(run.result.changes).toEqual([]);
      expect(run.result.patch).toBeNull();
    }
  });

  it("orders seq(running) < every agent update of the turn < seq(idle)", () => {
    for (const run of [a, b]) {
      const mine = run.log.filter((e) => e.turnId === run.result.turnId);
      const running = mine.filter(isStateUpdate("running"));
      const idle = mine.filter(isStateUpdate("idle"));
      expect(running).toHaveLength(1);
      expect(idle).toHaveLength(1);

      const start = running[0]?.seq ?? 0;
      const end = idle[0]?.seq ?? 0;
      expect(start).toBeLessThan(end);

      // `state_update{running}` is appended before the prompt bytes reach stdin, which is what
      // makes `PromptAccepted.seq - 1` a sound subscription cursor (§7.1).
      const agentUpdates = mine.filter(
        (e) => e.kind === "acp.session_update" && e.payloadVersion === 1,
      );
      expect(agentUpdates.length).toBeGreaterThan(0);
      for (const update of agentUpdates) {
        expect(update.seq).toBeGreaterThan(start);
        expect(update.seq).toBeLessThan(end);
      }
    }
  });

  it("returns a turn() result deep-equal to prompt()'s (DESIGN §5.5, one aggregate)", async () => {
    for (const run of [a, b]) {
      const status = await run.worker.turn(run.result.turnId);
      expect(status.state).toBe("completed");
      expect(status.result).toEqual(run.result);
    }
  });

  // ── teardown ───────────────────────────────────────────────────────────────

  it("reports treeGone and leaderExited honestly, matching waitGone(pid)", async () => {
    const pids = [a.worker.snapshot.process?.pid ?? 0, b.worker.snapshot.process?.pid ?? 0];
    const results = [await a.worker.close(), await b.worker.close()];

    for (const result of results) {
      expect(result.state).toBe("closed");
      expect(result.leaderExited).toBe(true);
      // Never optimistic: on Windows `taskkill /T` cannot PROVE the tree is gone, so `treeGone`
      // is false there in M0 — the weaker fact lives in `leaderExited` (D10, §6.6).
      expect(result.treeGone).toBe(process.platform !== "win32");
    }

    // The REPORTED value is checked against reality rather than asserted as a guarantee.
    for (const pid of pids) expect(await waitGone(pid, 10_000)).toBe(true);

    // DELETE is idempotent: a second call returns the same body (H12).
    expect(await a.worker.close()).toEqual(results[0]);
  }, 30_000);

  it("leaves supervisor.live.size === 0 after daemon.stop()", async () => {
    await harness.daemon.stop({ graceful: true });
    expect(harness.daemon.supervisor.live.size).toBe(0);
  }, 30_000);
});

function isStateUpdate(state: "running" | "idle") {
  return (e: EventEnvelope): boolean => {
    if (e.kind !== "acp.session_update") return false;
    const payload = e.payload as unknown as Record<string, unknown>;
    return payload["sessionUpdate"] === "state_update" && payload["state"] === state;
  };
}

/** The worker's whole log, from seq 1, read through the SDK's own resumable tail. */
async function drain(worker: Worker): Promise<EventEnvelope[]> {
  const out: EventEnvelope[] = [];
  const head = worker.snapshot.headSeq;
  for await (const envelope of worker.events({ since: 0 })) {
    out.push(envelope);
    if (envelope.seq >= head) break;
  }
  return out;
}
