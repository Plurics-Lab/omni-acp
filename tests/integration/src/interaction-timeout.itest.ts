import { afterEach, describe, expect, it } from "vitest";
import type { InteractionPayload, PolicyDecisionPayload } from "@omni-acp/protocol";
import { tempRoot } from "./support/harness.js";
import {
  OWNER,
  startInteractionWorker,
  until,
  WHO,
  type InteractionWorker,
} from "./support/interaction-worker.js";

/**
 * `parkTimeoutAction`, against `elicit-never-answers.mjs` — the only way to test it, because the
 * corpus answered both real elicitations in about a millisecond (§11.9's first risk).
 *
 * The deadlines here are REAL and short (400 ms) rather than faked: the point of this file is a
 * real process holding a real JSON-RPC id open while our own timer decides the answer, and a fake
 * clock would take the process out of the loop entirely. `parkTimeoutMs` under `fakeClock()` — the
 * table of `deny` and `fail`, `0` and `n` — is `core/test/worker/interaction/lifecycle.test.ts`.
 *
 * Owned by M2-A-WP-I.
 */

let live: InteractionWorker | null = null;
afterEach(async () => {
  await live?.dispose();
  live = null;
});

const ip = (w: InteractionWorker, n: number): InteractionPayload =>
  w.interactions()[n]?.payload as InteractionPayload;
const dp = (w: InteractionWorker, n: number): PolicyDecisionPayload =>
  w.decisions()[n]?.payload as PolicyDecisionPayload;

describe("park timeout (M2-A, §19.7, ruling M2-R7)", () => {
  it('expiry produces by:"timeout" and applies parkTimeoutAction "deny"', async () => {
    const cwd = await tempRoot("omni-acp-timeout-deny-");
    const w = await startInteractionWorker({
      fixture: "elicit-never-answers",
      cwd,
      onUnresolved: "park",
      parkTimeoutMs: 400,
      parkTimeoutAction: "deny",
    });
    live = w;

    const accepted = await w.worker.prompt([{ type: "text", text: "ask me" }], OWNER);
    await until(() => w.worker.interactions.length > 0, { what: "the park" });

    const parked = w.worker.interactions[0];
    if (parked === undefined) throw new Error("nothing is parked");
    // The deadline is REAL and it is published, because a park that expires must say when.
    expect(parked.expiresAt).not.toBeNull();
    expect(ip(w, 0).park?.onTimeout).toBe("deny");

    // Nobody answers. This is the whole experiment: our own timer is the only thing that can end
    // the wait, and §11.9 says it must fire FIRST by construction.
    await until(() => w.worker.interactions.length === 0, {
      what: "the park deadline to fire",
      timeoutMs: 10_000,
    });

    expect(ip(w, 1)).toMatchObject({ status: "expired" });
    expect(ip(w, 1).answer).toMatchObject({ by: "timeout", action: "decline" });
    expect(ip(w, 1).answer?.parkedMs).toBeGreaterThanOrEqual(300);
    expect(dp(w, 0)).toMatchObject({
      decision: "deny",
      by: "timeout",
      rule: "m2:parkTimeout:deny",
    });
    // A REAL answer reached the agent — the whole of §19.8 — so the turn completes rather than
    // hanging on a JSON-RPC id nobody will ever resolve.
    await until(() => w.worker.turn(accepted.turnId).state === "completed", {
      what: "the turn to end",
    });
    expect(w.worker.turn(accepted.turnId).result?.stopReason).toBe("end_turn");
    // The settled row's deadline is cleared, never left counting down (§5.8.4).
    expect(w.strategy.get(parked.requestId)?.expiresAt).toBeNull();
  }, 60_000);

  it('applies parkTimeoutAction "fail": the turn is cancelled and the worker STAYS OPEN (M2-R24)', async () => {
    const cwd = await tempRoot("omni-acp-timeout-fail-");
    const w = await startInteractionWorker({
      fixture: "elicit-never-answers",
      cwd,
      onUnresolved: "park",
      parkTimeoutMs: 400,
      parkTimeoutAction: "fail",
    });
    live = w;

    await w.worker.prompt([{ type: "text", text: "ask me" }], OWNER);
    await until(() => w.worker.interactions.length > 0, { what: "the park" });
    expect(ip(w, 0).park?.onTimeout).toBe("fail");

    await until(() => w.worker.interactions.length === 0, {
      what: "the park deadline to fire",
      timeoutMs: 10_000,
    });
    expect(ip(w, 1)).toMatchObject({ status: "expired" });
    expect(dp(w, 0).by).toBe("timeout");

    // Ruling M2-R24: `fail` answers the request and cancels the TURN. The WORKER stays open —
    // a `fail` is a verdict about ONE request, and closing the worker over it destroys a session
    // the caller may still want. DESIGN §3.2's `任意 → closed` row is amended accordingly.
    await until(() => w.worker.snapshot().state !== "requires_action", { what: "the unpark" });
    expect(w.worker.snapshot().state).not.toBe("closed");
    expect(w.worker.snapshot().closeReason).toBeNull();
  }, 60_000);

  it("parkTimeoutMs: 0 never expires, and expiresAt is null rather than a deadline nothing counts", async () => {
    const cwd = await tempRoot("omni-acp-timeout-zero-");
    const w = await startInteractionWorker({
      fixture: "elicit-never-answers",
      cwd,
      onUnresolved: "park",
      parkTimeoutMs: 0,
    });
    live = w;

    const accepted = await w.worker.prompt([{ type: "text", text: "ask me" }], OWNER);
    await until(() => w.worker.interactions.length > 0, { what: "the park" });
    const parked = w.worker.interactions[0];
    if (parked === undefined) throw new Error("nothing is parked");

    // A park that waits forever is a REAL configuration — a human is genuinely expected — and
    // `expiresAt: null` is what says so. A deadline nothing is counting down to would be a lie.
    expect(parked.expiresAt).toBeNull();
    expect(ip(w, 0).park?.expiresAt).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(w.worker.interactions).toHaveLength(1);
    expect(w.worker.snapshot().state).toBe("requires_action");

    // …and a human can still end it whenever they arrive.
    w.worker.answerInteraction(parked.requestId, { action: "deny" }, WHO);
    await until(() => w.worker.turn(accepted.turnId).state === "completed", {
      what: "the turn to end",
    });
    expect(dp(w, 0).by).toBe("human");
  }, 60_000);

  it("a human who arrives one tick before the deadline WINS, and the timer settles nothing", async () => {
    const cwd = await tempRoot("omni-acp-timeout-race-");
    const w = await startInteractionWorker({
      fixture: "elicit-never-answers",
      cwd,
      onUnresolved: "park",
      parkTimeoutMs: 5_000,
      parkTimeoutAction: "fail",
    });
    live = w;

    const accepted = await w.worker.prompt([{ type: "text", text: "ask me" }], OWNER);
    await until(() => w.worker.interactions.length > 0, { what: "the park" });
    const parked = w.worker.interactions[0];
    if (parked === undefined) throw new Error("nothing is parked");

    w.worker.answerInteraction(
      parked.requestId,
      { action: "answer", content: { question_0: "notes.md" } },
      WHO,
    );
    await until(() => w.worker.turn(accepted.turnId).state === "completed", {
      what: "the turn to end",
    });

    // ONE settlement, by the human, and the timer that was still armed settles nothing after it —
    // failing the turn on a park that was answered would cancel the very turn the answer just
    // unblocked (M2-R21's argument, one level down).
    expect(w.decisions()).toHaveLength(1);
    expect(dp(w, 0)).toMatchObject({ by: "human", decision: "answer" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(w.decisions()).toHaveLength(1);
    expect(w.worker.snapshot().state).not.toBe("closed");
  }, 60_000);
});
