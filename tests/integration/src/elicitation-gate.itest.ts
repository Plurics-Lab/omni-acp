import { afterEach, describe, expect, it } from "vitest";
import { InteractionConfig, type EventEnvelope } from "@omni-acp/protocol";
import { clientCapabilitiesFor } from "@omni-acp/core";
import { tempRoot } from "./support/harness.js";
import {
  OWNER,
  startInteractionWorker,
  until,
  type InteractionWorker,
} from "./support/interaction-worker.js";

/**
 * D10's gate, observed rather than asserted.
 *
 * Transcript `14` is the CONTROL: the same prompt with elicitation NOT declared produced no
 * `elicitation/create` at all, and the agent asked in prose instead (F28). A fixture cannot
 * reproduce the model's choice, so what is asserted here is the half that IS ours — the bytes we
 * put on `initialize`, on create and on wake (F42) — plus ruling M2-R15's other half: an
 * `elicitation/create` that arrives without having been offered is answered `{action:"decline"}`.
 *
 * The fixture deliberately IGNORES the gate, which is what makes that arm reachable at all; a
 * real claude-acp honours it, and `tests/compat/src/cases/elicitation.ts` is where the live
 * observation belongs.
 *
 * Owned by M2-A-WP-I.
 */

let live: InteractionWorker | null = null;
afterEach(async () => {
  await live?.dispose();
  live = null;
});

/**
 * What the agent SAW us declare, echoed back into the log by the fixture.
 *
 * Read off the chunk's own `content.text` rather than out of a stringified envelope: the value is
 * JSON inside a JSON string, and a text search would be asserting against its own escaping.
 */
function declaredIn(envelopes: readonly EventEnvelope[]): unknown[] {
  const out: unknown[] = [];
  const PREFIX = "omni-declared:";
  for (const e of envelopes) {
    if (e.kind !== "acp.session_update") continue;
    const payload = e.payload as { sessionUpdate?: string; content?: { text?: string } };
    if (payload.sessionUpdate !== "agent_message_chunk") continue;
    const text = payload.content?.text;
    if (typeof text !== "string" || !text.startsWith(PREFIX)) continue;
    // The ONE key D10's gate owns. The SDK's own `initialize` schema fills `fs` / `terminal` /
    // `auth` defaults on the agent side — transcript `12`'s recorded params carry exactly those
    // beside `elicitation` — so asserting the whole object would assert the SDK's defaults.
    const parsed = JSON.parse(text.slice(PREFIX.length)) as Record<string, unknown> | null;
    out.push(parsed === null ? null : (parsed["elicitation"] ?? null));
  }
  return out;
}

describe("elicitation capability gate (D10, F28, F42)", () => {
  it('declares elicitation.form iff onUnresolved === "park", on OUR OWN outbound initialize', async () => {
    for (const [onUnresolved, expected] of [
      ["park", { elicitation: { form: {} } }],
      ["deny", {}],
      ["fail", {}],
    ] as const) {
      const cwd = await tempRoot(`omni-acp-gate-${onUnresolved}-`);
      const w = await startInteractionWorker({
        fixture: "elicit-oneof",
        cwd,
        onUnresolved,
        parkTimeoutMs: 400,
        parkTimeoutAction: "deny",
      });
      live = w;

      // §5.8.4: recorded AS SENT, because `initialize`'s `agentCapabilities` never mentions
      // elicitation either way (F28) and without this the gate is unauditable.
      expect(w.worker.snapshot().capabilities?.clientCapabilities).toEqual(expected);
      // …and it is the ONE producer's value, not a second literal.
      expect(expected).toEqual(
        clientCapabilitiesFor({ onUnresolved, config: InteractionConfig.parse({}) }),
      );
      // `url` is never declared: there is no browser here and `elicitation/complete` is
      // unobserved on both real agents (§19.2, §11.9).
      expect(JSON.stringify(w.worker.snapshot().capabilities?.clientCapabilities)).not.toContain(
        "url",
      );

      await w.dispose();
      live = null;
    }
  }, 60_000);

  it('an elicitation/create that arrives WITHOUT having been offered is answered {action:"decline"} (M2-R15)', async () => {
    const cwd = await tempRoot("omni-acp-gate-uninvited-");
    const w = await startInteractionWorker({
      fixture: "elicit-oneof",
      cwd,
      // `deny` declares NOTHING, so this request is an answer to a question nobody asked.
      onUnresolved: "deny",
    });
    live = w;

    const accepted = await w.worker.prompt([{ type: "text", text: "ask me" }], OWNER);
    await until(() => w.worker.turn(accepted.turnId).state === "completed", {
      what: "the turn to end",
    });

    // NOT `-32601`: a method the spec defines deserves a better answer than "no such method",
    // and D10's literal text is "仍发来则回 decline / cancel".
    expect(w.interactions()).toHaveLength(1);
    expect(w.interactions()[0]?.payload).toMatchObject({
      kind: "elicitation",
      method: "elicitation/create",
      status: "answered",
      answer: { action: "decline", by: "policy" },
    });
    expect(w.decisions()).toHaveLength(1);
    expect(w.decisions()[0]?.payload).toMatchObject({
      decision: "deny",
      rule: "m2:onUnresolved",
      ruleSource: "default",
    });
    // It was never parked: nothing was being asked of a human, so no `requires_action`.
    expect(
      w.states().some((e) => (e.payload as { reason: string }).reason === "interaction_parked"),
    ).toBe(false);
    // F31: the tool call still COMPLETED, so a consumer that read the stream alone could not tell
    // this from an accept — which is exactly why the daemon records the outcome itself.
    const turn = w.worker.turn(accepted.turnId).result;
    expect(turn?.toolCalls[0]?.status).toBe("completed");
    expect(turn?.interactions[0]?.decision).toBe("deny");
    expect(turn?.deniedToolCalls).toEqual([]);
  }, 60_000);

  /**
   * BOTH halves of F42, end to end: the agent sees what we declared, on create AND on wake.
   *
   * The wake half was the one that survived the Land step twice over — `session-open.ts`'s reopen
   * path hard-coded `clientCapabilities: {}` (fixed by this package, with a named regression test
   * in `core/test/worker/interaction/capability.test.ts`), and the frozen `worker.ts` then built
   * its `SessionReopenOptions` without threading the value at all, so a `park` worker that
   * hibernated woke unable to be asked anything even after the strategy was right. The merge
   * applied WP-I's note N1, so the second declaration below is asserted by VALUE rather than by
   * count: a wake that silently dropped the capability would make the second entry `null`.
   */
  it("the agent SEES the declaration, and the worker survives a wake", async () => {
    const cwd = await tempRoot("omni-acp-gate-wake-");
    const w = await startInteractionWorker({
      fixture: "elicit-oneof",
      cwd,
      onUnresolved: "park",
      parkTimeoutMs: 400,
      parkTimeoutAction: "deny",
      resumable: true,
    });
    live = w;

    const first = await w.worker.prompt([{ type: "text", text: "ask me" }], OWNER);
    await until(() => w.worker.turn(first.turnId).state === "completed", {
      what: "the first turn to end",
    });
    expect(declaredIn(w.envelopes())).toEqual([{ form: {} }]);

    await until(() => w.worker.snapshot().state === "ready", { what: "idle" });
    await w.worker.hibernate("client_request");
    expect(w.worker.snapshot().state).toBe("hibernated");

    // A prompt on a hibernated worker AUTO-WAKES it (§15.3), which is the path F42 is about.
    const second = await w.worker.prompt([{ type: "text", text: "ask me again" }], OWNER);
    await until(() => w.worker.turn(second.turnId).state === "completed", {
      what: "the second turn to end",
    });
    // The wake really happened — a second generation, a real resume, a real second turn.
    expect(w.worker.snapshot().generation).toBe(2);
    expect(w.worker.snapshot().wakeCount).toBe(1);
    expect(w.worker.turn(second.turnId).result?.stopReason).toBe("end_turn");
    // F42's second half, by value: the woken process was told the SAME thing the first one was.
    expect(declaredIn(w.envelopes())).toEqual([{ form: {} }, { form: {} }]);
  }, 60_000);
});
