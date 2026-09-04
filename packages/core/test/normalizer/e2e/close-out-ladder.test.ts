import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fakeRuntime } from "@omni-acp/testkit";
import { reduceTurn, type TurnId } from "@omni-acp/protocol";
import { claudeAcpDescriptor } from "../support/claude-acp.js";
import { startE2eWorker, tags, until, type E2eWorker } from "./support.js";

/**
 * M1-WP-B acceptance bullet 7: **the ladder runs END-TO-END through a REAL `Worker`**, not only
 * through the reducer.
 *
 * The reducer's own unit tests (`ladder.test.ts`) drive rungs 1→5 with a fake clock and no
 * process. That proves the DECISIONS are right and proves nothing about whether they can be
 * carried out — seam 1's input side is Land-written (`close_requested` from `#doClose` /
 * `#doHibernate` / the cancel escalation, `drained` from `#watchProcess`, `stderr_line` from
 * `StderrTail.onLine`), and a ladder that unit-tests and cannot run in a Worker is a failure of
 * THIS bullet, not of the Land step.
 *
 * So every assertion below is observed from OUTSIDE the reducer:
 *
 *   rung 2 (`close_stdin`)  the fixture writes `eof` to a marker file when ITS stdin ends
 *   rung 3 (`drain`)        the fixture's own process exits, and `stdoutEnded` feeds `drained`
 *   rung 4 (`cancel`)       the fixture writes `cancel` when `session/cancel` reaches it
 *   §13.4's stderr signal   an `omni.error` appears in the log, before `idle`
 */

const TURN_OF = (worker: E2eWorker): TurnId => {
  const running = worker
    .events()
    .find(
      (e) =>
        e.kind === "acp.session_update" &&
        (e.payload as { sessionUpdate?: string; state?: string }).state === "running",
    );
  if (running?.turnId == null) throw new Error("no turn started");
  return running.turnId;
};

/** The claude-acp table, plus the `fatalStderr` pattern the hybrid fixture writes. */
function descriptorWithFatalStderr() {
  const base = claudeAcpDescriptor();
  return fakeRuntime({
    ...base,
    errorRules: [
      ...base.errorRules,
      { id: "fatalStderr:e2e", messageMatches: "^FATAL: ", classify: "agent_error" },
    ],
  });
}

let running: E2eWorker[] = [];
let markers: string[] = [];

afterEach(async () => {
  const all = running;
  running = [];
  await Promise.all(all.map((w) => w.dispose()));
  for (const dir of markers) rmSync(dir, { recursive: true, force: true });
  markers = [];
});

function markerFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "omni-ladder-"));
  markers.push(dir);
  return join(dir, "rungs.txt");
}

const rungs = (file: string): string[] =>
  existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((l) => l !== "") : [];

async function start(env: Record<string, string>): Promise<E2eWorker> {
  const w = await startE2eWorker({
    agent: "hybrid",
    env,
    descriptor: descriptorWithFatalStderr(),
    quietMs: 60,
    drainGraceMs: 300,
    cancelGraceMs: 400,
  });
  running.push(w);
  return w;
}

describe("§13.2 CLOSE_OUT, end to end through a real Worker", () => {
  it("a DELETE mid-turn closes stdin, and the FIXTURE sees the EOF", async () => {
    const marker = markerFile();
    const w = await start({ HYBRID_EOF_MARKER: marker, HYBRID_NEVER_ANSWER: "1" });

    // A live turn the agent will never answer: the ladder only runs when there is output to
    // protect, and this is that case.
    await w.worker.prompt([{ type: "text", text: "go" }], { tokenId: w.worker.snapshot().ref.tokenId });
    await until("the agent to start talking", () => w.events().length >= 3);
    expect(rungs(marker)).toEqual([]);

    await w.worker.close("client_request");

    // Rung 2, observed by the agent itself. Nothing in our own reducer is consulted here.
    expect(rungs(marker)[0]).toBe("eof");
    expect(w.worker.snapshot().state).toBe("closed");
  }, 30_000);

  it("`drained` from the process's OWN stdout EOF short-circuits rung 4", async () => {
    // The hybrid fixture exits on stdin EOF, like every ACP agent. Its stdout therefore ends,
    // `#watchProcess` feeds `drained`, and §13.2 says nothing more can arrive — so
    // `session/cancel` is never sent, and the fixture never records a `cancel`.
    const marker = markerFile();
    const w = await start({ HYBRID_EOF_MARKER: marker, HYBRID_NEVER_ANSWER: "1" });
    await w.worker.prompt([{ type: "text", text: "go" }], { tokenId: w.worker.snapshot().ref.tokenId });
    await until("the agent to start talking", () => w.events().length >= 3);

    await w.worker.close("client_request");
    expect(rungs(marker)).toEqual(["eof"]);
  }, 30_000);

  it("an agent that IGNORES stdin EOF is walked past the drain rung, and rung 4 CANNOT reach it", async () => {
    // The uncooperative case: stdout never ends, so the drain grace expires and the reducer asks
    // the Worker to send `session/cancel`.
    //
    // AND IT CANNOT ARRIVE — which is a fact about §13.2's ORDER, not about this code. Rung 2
    // sends stdin EOF ("no more requests are coming") and rung 4 sends `session/cancel`, which
    // travels on the same stdin. After rung 2 there is no channel left to carry it. The Worker
    // still performs the rung (`link.notify` is attempted and the failure is swallowed, exactly
    // as `cancel()`'s own "a failed send is not a failed cancel" rule says), and the agent
    // records nothing, because nothing reached it.
    //
    // The rung is not useless: it is the only path for a runtime whose transport is not the
    // stdin pipe (DESIGN §1.4's remote transports). On stdio it is a no-op after rung 2, and
    // saying so here is cheaper than discovering it in production. Recorded in M1-WP-B's
    // hand-off notes as a §13.2 observation.
    const marker = markerFile();
    const w = await start({
      HYBRID_EOF_MARKER: marker,
      HYBRID_NEVER_ANSWER: "1",
      HYBRID_IGNORE_EOF: "1",
    });
    await w.worker.prompt([{ type: "text", text: "go" }], { tokenId: w.worker.snapshot().ref.tokenId });
    await until("the agent to start talking", () => w.events().length >= 3);

    await w.worker.close("client_request");

    expect(rungs(marker)).toEqual(["eof"]);
    // Rung 5 still ran: the process is gone and the worker is closed, on an agent that answered
    // neither the prompt nor the cancel and did not exit on EOF.
    expect(w.worker.snapshot().state).toBe("closed");
  }, 30_000);

  it("a hibernate on an idle worker reclaims the process and keeps the RECORD", async () => {
    // Bullet 7 asks for a hibernate that walks the ladder. It cannot: `hibernate()` refuses
    // while a turn is running (`worker_busy`), and with no turn live the ladder deliberately
    // does not run (§13.3's latency rule). What IS asserted is the half that matters here — the
    // ladder does not turn a hibernate into a close, which is exactly what would happen if rung
    // 5 requested `"terminate"` (see `terminate()`'s note in `turn-lifecycle.ts`).
    const marker = markerFile();
    const w = await start({ HYBRID_EOF_MARKER: marker, HYBRID_IGNORE_EOF: "1" });
    const who = { tokenId: w.worker.snapshot().ref.tokenId };
    const accepted = await w.worker.prompt([{ type: "text", text: "go" }], who);
    await until("the turn to settle", () => tags(w.events()).some((t) => t.startsWith("idle")));
    void accepted;

    await w.worker.hibernate("client_request");

    // §15.2: the process is reclaimed and the record is kept.
    expect(w.worker.snapshot().state).toBe("hibernated");
    expect(w.worker.snapshot().process).toBeNull();
    expect(rungs(marker)).toEqual(["eof"]);
  }, 30_000);

  it("a DELETE of an IDLE worker does not walk the ladder, and reclaims the tree", async () => {
    // §13.3's latency rule, and §6.7's zombie: with no turn open there is nothing to protect,
    // and closing stdin first would let the leader exit before §6.5's ladder could reclaim its
    // process GROUP.
    const marker = markerFile();
    const w = await start({ HYBRID_EOF_MARKER: marker, HYBRID_IGNORE_EOF: "1" });
    const before = Date.now();
    const result = await w.worker.close("client_request");
    expect(Date.now() - before).toBeLessThan(3_000);
    expect(result.leaderExited).toBe(true);
    // §6.5's own rung 1 closed stdin, so the fixture still saw an EOF — from `terminate()`,
    // which is the ONLY place §6.5 allows it outside the forced ladder.
    expect(rungs(marker)).toEqual(["eof"]);
  }, 30_000);
});

describe("§13.4 end to end — a fatal stderr line promotes to `omni.error` before `idle`", () => {
  it("appends the error, then `idle`, in that seq order", async () => {
    const w = await start({ HYBRID_FATAL_STDERR: "1" });
    const who = { tokenId: w.worker.snapshot().ref.tokenId };
    const accepted = await w.worker.prompt([{ type: "text", text: "go" }], who);

    await until("the turn to settle", () =>
      tags(w.events()).some((t) => t.startsWith("idle")),
    );

    const order = tags(w.events());
    const errorAt = order.findIndex((t) => t === "error(agent_error)");
    const idleAt = order.findIndex((t) => t.startsWith("idle"));
    expect(errorAt).toBeGreaterThanOrEqual(0);
    expect(errorAt).toBeLessThan(idleAt);

    // …and the promotion is visible in the projection, with no agent prose anywhere.
    const result = reduceTurn(accepted.turnId, w.events());
    expect(result.verdict).toBe("failed");
    expect(result.error?.code).toBe("agent_error");
    expect(result.error?.message).toContain("fatalStderr:e2e");
    expect(result.error?.message).not.toContain("hybrid fixture cannot continue");
  }, 30_000);

  it("a descriptor with NO fatalStderr rule leaves the same line alone", async () => {
    const w = await startE2eWorker({
      agent: "hybrid",
      env: { HYBRID_FATAL_STDERR: "1" },
      descriptor: claudeAcpDescriptor(),
      quietMs: 60,
    });
    running.push(w);
    const who = { tokenId: w.worker.snapshot().ref.tokenId };
    const accepted = await w.worker.prompt([{ type: "text", text: "go" }], who);
    await until("the turn to settle", () => tags(w.events()).some((t) => t.startsWith("idle")));

    const result = reduceTurn(accepted.turnId, w.events());
    expect(result.error).toBeNull();
    // The turn is still `partial`, because the TOOL failed on its own merits — a schema'd enum,
    // which is a signal we trust totally and stderr text is not (§13.4).
    expect(result.verdict).toBe("partial");
    expect(result.failedToolCalls).toEqual(["hybrid-call-1"]);
  }, 30_000);
});

describe("the hybrid fixture, end to end — F24 and the last corpus gap", () => {
  it("produces a turn whose verdict is `partial` from the STATUS ENUM alone", async () => {
    const w = await start({});
    const who = { tokenId: w.worker.snapshot().ref.tokenId };
    const accepted = await w.worker.prompt([{ type: "text", text: "go" }], who);
    await until("the turn to settle", () => tags(w.events()).some((t) => t.startsWith("idle")));

    const events = w.events();
    const kinds = tags(events);
    // `tool_call` was RENAMED on the wire, and no `tool_call` survives.
    expect(kinds).toContain("tool_call_update");
    expect(kinds).not.toContain("tool_call");
    // …and the already-v2 kinds were carried unchanged.
    expect(kinds).toContain("config_option_update");
    expect(kinds).toContain("usage_update");

    const result = reduceTurn(accepted.turnId, events);
    expect(result.stopReason).toBe("end_turn");
    expect(result.verdict).toBe("partial");
    expect(result.failedToolCalls).toEqual(["hybrid-call-1"]);
    expect(result.deniedToolCalls).toEqual([]);
    expect(result.warnings).toEqual([
      {
        code: "tool_failed",
        message: "tool call hybrid-call-1 ended with status failed",
        source: "tool_status",
        detail: { toolCallId: "hybrid-call-1" },
      },
    ]);
    // F4: `TurnResult.usage` is the `usage_update` shape, and it arrives.
    expect(result.usage).toEqual({ used: 1_234, size: 200_000 });
    // F21's `tokens` does NOT, and the reason is a frozen file rather than the reducer: the
    // fixture really does return `usage` on its prompt response, and `TurnInput.prompt_result`
    // really does carry a `usage` field — but `worker.ts` builds that input with
    // `{type, stopReason, at}` and drops it. The reducer's own half is proven in
    // `ladder.test.ts` ("puts the prompt RESPONSE's v2 Usage block on `idle`"); the one-line
    // producer edit is in M1-WP-B's hand-off notes, and this asserts the CURRENT truth rather
    // than the intended one, so that landing the edit turns this red.
    expect(result.tokens).toBeUndefined();

    // The agent's English is CARRIED and never read: `rawOutput` is on the view, and the verdict
    // did not come from it.
    expect(result.toolCalls[0]?.rawOutput).toContain("ENOENT");
  }, 30_000);

  it("every agent update of the turn lands between `running` and `idle`, at payloadVersion 2", async () => {
    const w = await start({});
    const who = { tokenId: w.worker.snapshot().ref.tokenId };
    await w.worker.prompt([{ type: "text", text: "go" }], who);
    await until("the turn to settle", () => tags(w.events()).some((t) => t.startsWith("idle")));

    const events = w.events();
    const turnId = TURN_OF(w);
    const mine = events.filter((e) => e.turnId === turnId && e.kind === "acp.session_update");
    const isState = (e: (typeof mine)[number], state: string): boolean =>
      (e.payload as { sessionUpdate?: string; state?: string }).sessionUpdate === "state_update" &&
      (e.payload as { state?: string }).state === state;

    const start_ = mine.find((e) => isState(e, "running"))?.seq ?? 0;
    const end = mine.find((e) => isState(e, "idle"))?.seq ?? 0;
    const agentUpdates = mine.filter((e) => !isState(e, "running") && !isState(e, "idle"));
    expect(agentUpdates.length).toBeGreaterThan(0);
    for (const e of agentUpdates) {
      expect(e.seq).toBeGreaterThan(start_);
      expect(e.seq).toBeLessThan(end);
      // Ruling M1-R10's flip, over a real pipe: every kind this agent emits is a known v2 arm.
      expect(`${String((e.payload as { sessionUpdate: string }).sessionUpdate)}=${String(e.payloadVersion)}`)
        .toBe(`${String((e.payload as { sessionUpdate: string }).sessionUpdate)}=2`);
    }
  }, 30_000);
});
