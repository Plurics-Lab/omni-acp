import { describe, expect, it } from "vitest";
import {
  OmniError,
  type EventEnvelope,
  type WorkerState,
  type WorkerStatePayload,
} from "@omni-acp/protocol";
import { scriptedAgent } from "@omni-acp/testkit";
import { flush, harness, OWNER, TEXT } from "./support/harness.js";
import { asScriptedAgent, rawAgent } from "./support/raw-agent.js";

const stateOf = (e: EventEnvelope): WorkerStatePayload => e.payload as WorkerStatePayload;

/**
 * DESIGN §3.2's table, restricted to the four states M0 can reach (`M0_WORKER_STATES`).
 * `hibernated` and `requires_action` are wire-stable but unreachable until M1/M2, and a run that
 * produced one would mean the state machine had grown a transition nobody designed.
 */
const LEGAL: ReadonlySet<string> = new Set([
  "null->starting",
  "starting->ready",
  "starting->closed",
  "ready->running",
  "running->ready",
  "ready->closed",
  "running->closed",
]);

const REASON_FOR: Readonly<Record<string, string>> = {
  "null->starting": "created",
  "starting->ready": "handshake_ok",
  "ready->running": "prompt",
  "running->ready": "turn_end",
};

/** A tiny deterministic PRNG, so a failing seed is a reproducible bug report. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1_664_525 + 1_013_904_223) >>> 0;
    return s / 2 ** 32;
  };
}

const OPERATIONS = [
  "prompt",
  "prompt_bad",
  "cancel",
  "close",
  "resolve",
  "chunk",
  "permission",
  "advance",
  "kill",
] as const;

/** The ones that go through `WorkerHandle`; the rest poke the fixture on the other end. */
const WORKER_CALLS: ReadonlySet<string> = new Set(["prompt", "prompt_bad", "cancel", "close"]);

describe("the worker state machine (WP-4 acceptance 12)", () => {
  it("only ever takes DESIGN §3.2's transitions, under 40 random operation sequences", async () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const random = rng(seed);
      const h = harness();
      const agent = scriptedAgent();
      h.supervisor.enqueue(agent);

      const observed: [WorkerState, WorkerState | null][] = [];
      const w = await h.create();
      w.onStateChange((s, prev) => observed.push([s, prev]));

      for (let step = 0; step < 12; step += 1) {
        const op = OPERATIONS[Math.floor(random() * OPERATIONS.length)]!;
        try {
          switch (op) {
            case "prompt":
              await w.prompt([TEXT(`s${String(seed)}-${String(step)}`)], OWNER);
              break;
            case "prompt_bad":
              await w.prompt([{ type: "image" }], OWNER);
              break;
            case "cancel":
              await w.cancel(OWNER);
              break;
            case "close":
              await w.close("client_request");
              break;
            case "resolve":
              agent.resolvePrompt("end_turn");
              break;
            case "chunk":
              await agent.emitChunk("x");
              break;
            case "permission":
              void agent
                .requestPermission([
                  { optionId: "reject", name: "n", kind: "reject_once" },
                ] as never)
                .catch(() => {});
              break;
            case "advance":
              h.clock.advance(300);
              break;
            case "kill":
              if (h.supervisor.live.size > 0) h.process().simulateExit(1, null);
              break;
          }
        } catch (e) {
          // The public API is allowed to REFUSE (worker_busy / worker_closed / bad_request);
          // what it may not do is take an illegal transition to satisfy the caller. Errors from
          // the FIXTURE — poking a scripted agent that has already died — are not the subject.
          if (WORKER_CALLS.has(op)) {
            expect(OmniError.is(e), `seed ${String(seed)}: ${op} threw ${String(e)}`).toBe(true);
            expect(["worker_busy", "worker_closed", "bad_request"]).toContain(
              (e as OmniError).code,
            );
          }
        }
        await flush(2);
      }
      await flush();

      // 1. Every transition the listener saw is on the table.
      for (const [next, prev] of observed) {
        expect(LEGAL, `seed ${String(seed)}: ${String(prev)}->${next}`).toContain(
          `${String(prev)}->${next}`,
        );
      }

      // 2. The LOG says the same thing — the listener and the canonical record cannot disagree.
      const chain = h.log.all.filter((e) => e.kind === "omni.worker_state").map(stateOf);
      for (const p of chain) {
        const edge = `${String(p.previous)}->${p.state}`;
        expect(LEGAL, `seed ${String(seed)}: ${edge}`).toContain(edge);
        const expectedReason = REASON_FOR[edge];
        if (expectedReason !== undefined) expect(p.reason).toBe(expectedReason);
      }

      // 3. `closed` is terminal: it appears at most once, and only as the last state.
      const closedAt = chain.findIndex((p) => p.state === "closed");
      if (closedAt !== -1) {
        expect(closedAt).toBe(chain.length - 1);
        expect(w.snapshot().state).toBe("closed");
        await expect(w.prompt([TEXT("after")], OWNER)).rejects.toMatchObject({
          code: "worker_closed",
        });
      }

      // 4. `previous` is exactly the state the previous envelope announced.
      for (let i = 1; i < chain.length; i += 1) {
        expect(chain[i]?.previous).toBe(chain[i - 1]?.state);
      }
      expect(chain[0]?.previous).toBeNull();
      expect(chain[0]?.state).toBe("starting");

      // 5. The seq is 1..n with no gaps, whatever happened.
      expect(h.log.all.map((e) => e.seq)).toEqual(h.log.all.map((_, i) => i + 1));
    }
  });

  it("never reaches a state M0 does not implement", async () => {
    const h = harness();
    h.supervisor.enqueue(scriptedAgent());
    const w = await h.create();
    const seen = new Set<WorkerState>();
    w.onStateChange((s) => seen.add(s));

    await w.prompt([TEXT("hi")], OWNER);
    await w.cancel(OWNER);
    await w.close("client_request");

    for (const s of seen) expect(["starting", "ready", "running", "closed"]).toContain(s);
    const logged = h.log.all
      .filter((e) => e.kind === "omni.worker_state")
      .map((e) => stateOf(e).state);
    expect(logged).not.toContain("hibernated");
    expect(logged).not.toContain("requires_action");
  });

  it("unsubscribing an onStateChange listener actually stops it", async () => {
    const h = harness();
    const agent = scriptedAgent();
    h.supervisor.enqueue(agent);
    const w = await h.create();

    const seen: WorkerState[] = [];
    const off = w.onStateChange((s) => seen.push(s));
    await w.prompt([TEXT("hi")], OWNER);
    off();
    agent.resolvePrompt("end_turn");
    await flush();
    h.clock.advance(250);
    await flush();
    expect(seen).toEqual(["running"]);
  });

  it("survives a listener that throws, and still records the transition", async () => {
    const h = harness();
    h.supervisor.enqueue(scriptedAgent());
    const w = await h.create();
    w.onStateChange(() => {
      throw new Error("listener blew up");
    });

    await expect(w.prompt([TEXT("hi")], OWNER)).resolves.toBeDefined();
    expect(w.snapshot().state).toBe("running");
  });

  it("reports an unknown turn as state 'unknown' rather than throwing (D29)", async () => {
    const h = harness();
    h.supervisor.enqueue(asScriptedAgent(rawAgent()));
    const w = await h.create();
    const status = w.turn("t_00000000000000000000000099");
    expect(status).toEqual({
      turnId: "t_00000000000000000000000099",
      state: "unknown",
      startSeq: null,
      endSeq: null,
      stopReason: null,
      result: null,
    });
  });
});
