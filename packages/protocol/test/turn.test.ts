import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { beforeEach, describe, expect, it } from "vitest";
import {
  reduceTurn,
  turnStatus,
  type DaemonId,
  type EventEnvelope,
  type EventInput,
  type TurnId,
  type WorkerId,
} from "@omni-acp/protocol";

const D = `d_${"0".repeat(26)}` as DaemonId;
const W = `w_${"0".repeat(26)}` as WorkerId;
const T = `t_${"0".repeat(26)}` as TurnId;
const OTHER = `t_${"0".repeat(25)}2` as TurnId;

let seq = 0;
function env(body: EventInput, turnId: TurnId | null = T): EventEnvelope {
  seq += 1;
  return {
    ...body,
    seq,
    ts: `2026-09-03T12:00:00.${String(seq).padStart(3, "0")}Z`,
    daemonId: D,
    workerId: W,
    sessionId: "sess",
    turnId,
  } as EventEnvelope;
}

const running = (turnId: TurnId = T) =>
  env(
    {
      kind: "acp.session_update",
      payloadVersion: 2,
      payload: { sessionUpdate: "state_update", state: "running" },
    },
    turnId,
  );
const chunk = (text: string, turnId: TurnId = T) =>
  env(
    {
      kind: "acp.session_update",
      payloadVersion: 1,
      payload: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    },
    turnId,
  );
const idle = (stopReason: string | null, turnId: TurnId = T) =>
  env(
    {
      kind: "acp.session_update",
      payloadVersion: 2,
      payload: {
        sessionUpdate: "state_update",
        state: "idle",
        ...(stopReason === null ? {} : { stopReason }),
      },
    },
    turnId,
  );

beforeEach(() => {
  seq = 0;
});

describe("reduceTurn edge cases", () => {
  it("returns an empty aggregate for an empty log rather than throwing", () => {
    const r = reduceTurn(T, []);
    expect(r.text).toBe("");
    expect(r.toolCalls).toEqual([]);
    expect(r.error).toBeNull();
    expect(r.patch).toBeNull();
    expect("usage" in r).toBe(false);
    expect(turnStatus(T, []).state).toBe("unknown");
  });

  it("ignores a worker close that precedes the turn entirely", () => {
    const before = env(
      {
        kind: "omni.worker_state",
        payloadVersion: 2,
        payload: { state: "closed", previous: "ready", reason: "client_request" },
      },
      null,
    );
    // A different worker's log, replayed into the same client buffer, must not end this turn.
    const envelopes = [before, running(), chunk("still fine"), idle("end_turn")];
    const status = turnStatus(T, envelopes);
    expect(status.state).toBe("completed");
    expect(status.result?.text).toBe("still fine");
    expect(status.result?.error).toBeNull();
  });

  it("ignores a mid-turn close belonging to a DIFFERENT worker", () => {
    const OTHER_W = `w_${"1".repeat(26)}` as WorkerId;
    // Built in seq order: the close must land INSIDE the turn, not before its first envelope.
    const start = running();
    const foreignClose = {
      ...env(
        {
          kind: "omni.worker_state",
          payloadVersion: 2,
          payload: { state: "closed", previous: "running", reason: "agent_crashed" },
        },
        null,
      ),
      workerId: OTHER_W,
    } as EventEnvelope;
    // The close is stamped with another worker's id: it ends THAT worker's turns, not this one.
    const envelopes = [start, foreignClose, chunk("after"), idle("end_turn")];
    const status = turnStatus(T, envelopes);
    expect(status.state).toBe("completed");
    expect(status.result?.text).toBe("after");
    expect(status.result?.error).toBeNull();
    expect(status.stopReason).toBe("end_turn");
  });

  it("stops at the FIRST terminal envelope and ignores everything after it", () => {
    const envelopes = [
      running(),
      chunk("answer"),
      idle("end_turn"),
      chunk(" trailing chatter after idle"),
      env({
        kind: "omni.error",
        payloadVersion: 2,
        payload: { code: "internal", message: "later, unrelated" },
      }),
    ];
    const r = reduceTurn(T, envelopes);
    expect(r.text).toBe("answer");
    expect(r.error).toBeNull();
    expect(turnStatus(T, envelopes).endSeq).toBe(3);
  });

  it("synthesizes an honest error when a close ends the turn and no omni.error was logged", () => {
    const envelopes = [
      running(),
      chunk("half"),
      env(
        {
          kind: "omni.worker_state",
          payloadVersion: 2,
          payload: {
            state: "closed",
            previous: "running",
            reason: "agent_crashed",
            exit: { code: 139, signal: null },
            leaderExited: true,
            treeGone: true,
          },
        },
        null,
      ),
    ];
    const r = reduceTurn(T, envelopes);
    expect(r.stopReason).toBeNull();
    expect(r.error).toStrictEqual({
      code: "agent_error",
      message: "worker closed during turn (agent_crashed)",
    });
    expect(turnStatus(T, envelopes).state).toBe("failed");
  });

  it("maps a requested close to worker_closed and a timeout to agent_timeout", () => {
    for (const [reason, code] of [
      ["client_request", "worker_closed"],
      ["daemon_shutdown", "worker_closed"],
      ["cancel_timeout", "agent_timeout"],
      ["handshake_timeout", "agent_timeout"],
      ["protocol_error", "agent_error"],
    ] as const) {
      const envelopes = [
        running(),
        env(
          {
            kind: "omni.worker_state",
            payloadVersion: 2,
            payload: { state: "closed", previous: "running", reason },
          },
          null,
        ),
      ];
      expect(reduceTurn(T, envelopes).error?.code, reason).toBe(code);
    }
  });

  it("prefers the turn's own omni.error over the synthesized close error", () => {
    const envelopes = [
      running(),
      env({
        kind: "omni.error",
        payloadVersion: 2,
        payload: { code: "agent_error", message: "agent exited mid-turn", stderrTail: "boom\n" },
      }),
      env(
        {
          kind: "omni.worker_state",
          payloadVersion: 2,
          payload: { state: "closed", previous: "running", reason: "agent_crashed" },
        },
        null,
      ),
    ];
    // `stderrTail` stays on the envelope; TurnResult.error is exactly an OmniErrorBody (§9).
    expect(reduceTurn(T, envelopes).error).toStrictEqual({
      code: "agent_error",
      message: "agent exited mid-turn",
    });
  });

  it("keeps two concurrent turns' aggregates disjoint", () => {
    const envelopes = [
      running(T),
      running(OTHER),
      chunk("mine ", T),
      chunk("theirs ", OTHER),
      chunk("only", T),
      idle("end_turn", OTHER),
      idle("max_tokens", T),
    ];
    expect(reduceTurn(T, envelopes).text).toBe("mine only");
    expect(reduceTurn(OTHER, envelopes).text).toBe("theirs ");
    expect(turnStatus(T, envelopes).stopReason).toBe("max_tokens");
    expect(turnStatus(OTHER, envelopes).stopReason).toBe("end_turn");
  });

  it("treats a turn with no terminal envelope as running, with the partial aggregate", () => {
    const envelopes = [running(), chunk("so far")];
    const status = turnStatus(T, envelopes);
    expect(status.state).toBe("running");
    expect(status.endSeq).toBeNull();
    expect(status.result?.text).toBe("so far");
    expect(status.result?.stopReason).toBeNull();
  });

  it("ignores an idle whose stopReason is absent, keeping it null rather than inventing one", () => {
    const envelopes = [running(), idle(null)];
    expect(reduceTurn(T, envelopes).stopReason).toBeNull();
    expect(turnStatus(T, envelopes).state).toBe("completed");
  });

  it("survives payload shapes it has never seen", () => {
    const envelopes = [
      running(),
      env({
        kind: "acp.session_update",
        payloadVersion: 1,
        payload: { sessionUpdate: "plan", entries: [] },
      }),
      env({
        kind: "acp.session_update",
        payloadVersion: 2,
        payload: { sessionUpdate: "_vendor_thing", anything: { deeply: [1, 2] } },
      }),
      env({
        kind: "acp.session_update",
        payloadVersion: 1,
        payload: { sessionUpdate: "agent_message_chunk", content: { type: "image", data: "…" } },
      }),
      env({
        kind: "acp.session_update",
        payloadVersion: 1,
        payload: { sessionUpdate: "tool_call_update", locations: [{ path: 42 }] },
      }),
      env({
        kind: "acp.session_update",
        payloadVersion: 1,
        payload: { sessionUpdate: "usage_update", used: "lots" },
      }),
      idle("end_turn"),
    ];
    const r = reduceTurn(T, envelopes);
    expect(r.text).toBe("");
    expect(r.toolCalls).toEqual([]);
    expect("usage" in r).toBe(false);
    expect(r.stopReason).toBe("end_turn");
  });

  it("keeps a tool call's locations and drops the ones without a path", () => {
    const envelopes = [
      running(),
      env({
        kind: "acp.session_update",
        payloadVersion: 1,
        payload: {
          sessionUpdate: "tool_call",
          toolCallId: "call_1",
          title: "Reading",
          locations: [{ path: "/a", line: 12 }, { path: "/b" }, { line: 3 }, "nope"],
        },
      }),
      idle("end_turn"),
    ];
    expect(reduceTurn(T, envelopes).toolCalls[0]?.locations).toStrictEqual([
      { path: "/a", line: 12 },
      { path: "/b" },
    ]);
  });

  it("records rawInput/rawOutput only once the agent has sent them", () => {
    const first = [
      running(),
      env({
        kind: "acp.session_update",
        payloadVersion: 1,
        payload: { sessionUpdate: "tool_call", toolCallId: "c" },
      }),
      idle("end_turn"),
    ];
    expect("rawInput" in (reduceTurn(T, first).toolCalls[0] ?? {})).toBe(false);

    const second = [
      running(),
      env({
        kind: "acp.session_update",
        payloadVersion: 1,
        payload: { sessionUpdate: "tool_call", toolCallId: "c", rawInput: null },
      }),
      idle("end_turn"),
    ];
    const view = reduceTurn(T, second).toolCalls[0];
    expect("rawInput" in (view ?? {})).toBe(true);
    expect(view?.rawInput).toBeNull();
  });
});

// ── M1: the projection (CONTRACTS.md §12.5, §13.4, ruling M1-R5) ────────────

const policyDecision = (
  o: { decision: "allow" | "deny" | "error"; toolCallId: string | null; title?: string },
  turnId: TurnId = T,
) =>
  env(
    {
      kind: "omni.policy_decision",
      payloadVersion: 2,
      payload: {
        requestId: `req_${o.toolCallId ?? "none"}`,
        title: o.title ?? "a tool call",
        decision: o.decision,
        rule: "m0:auto-deny",
        optionId: o.decision === "deny" ? "reject" : "allow-once",
        offered: [],
        toolCallId: o.toolCallId,
      },
    },
    turnId,
  );

const toolCall = (o: { id: string; status?: string; content?: unknown[] }, turnId: TurnId = T) =>
  env(
    {
      kind: "acp.session_update",
      payloadVersion: 2,
      payload: {
        sessionUpdate: "tool_call_update",
        toolCallId: o.id,
        ...(o.status === undefined ? {} : { status: o.status }),
        ...(o.content === undefined ? {} : { content: o.content }),
      } as never,
    },
    turnId,
  );

/** A v2 diff block carrying §12.5's `omni/v1Diff`, which is where the text lives. */
const v2Diff = (o: {
  path: string;
  operation: string;
  oldText: string | null;
  newText: string;
  fragment: boolean;
}) => ({
  type: "diff",
  changes: [{ operation: o.operation, path: o.path }],
  _meta: { "omni/v1Diff": { oldText: o.oldText, newText: o.newText, fragment: o.fragment } },
});

const idleWithMeta = (meta: Record<string, unknown>, turnId: TurnId = T) =>
  env(
    {
      kind: "acp.session_update",
      payloadVersion: 2,
      payload: {
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "end_turn",
        _meta: meta,
      } as never,
    },
    turnId,
  );

describe("reduceTurn skips `replay: true` envelopes (ruling M1-R5)", () => {
  it("does not fold a replayed chunk into `text`", () => {
    const replayed = { ...chunk("REPLAYED "), replay: true as const };
    const result = reduceTurn(T, [running(), replayed, chunk("live"), idle("end_turn")]);
    expect(result.text).toBe("live");
  });

  it("does not count a replayed tool call or policy decision", () => {
    const events = [
      running(),
      { ...toolCall({ id: "ghost", status: "failed" }), replay: true as const },
      { ...policyDecision({ decision: "deny", toolCallId: "ghost" }), replay: true as const },
      idle("end_turn"),
    ];
    const result = reduceTurn(T, events);
    expect(result.toolCalls).toEqual([]);
    expect(result.failedToolCalls).toEqual([]);
    expect(result.deniedToolCalls).toEqual([]);
    expect(result.verdict).toBe("ok");
  });

  it("a replayed `worker_state{closed}` does not end the turn", () => {
    // The one that matters most: a replayed history that happened to contain a close would end
    // every turn folded beside it, and the daemon's own log is the authority (README finding 8).
    const closed = {
      ...env(
        {
          kind: "omni.worker_state",
          payloadVersion: 2,
          payload: { state: "closed", previous: "running", reason: "client_request" },
        },
        null,
      ),
      replay: true as const,
    };
    const events = [running(), closed, chunk("still here"), idle("end_turn")];
    const result = reduceTurn(T, events);
    expect(result.error).toBeNull();
    expect(result.text).toBe("still here");
    expect(turnStatus(T, events).state).toBe("completed");
  });

  it("is still de-duplicated by `(workerId, seq)`, still order-independent, still pure", () => {
    const events = [running(), chunk("a"), chunk("b"), idle("end_turn")];
    const once = reduceTurn(T, events);
    expect(reduceTurn(T, [...events, ...events.map((e) => ({ ...e }))])).toStrictEqual(once);
    expect(reduceTurn(T, [...events].reverse())).toStrictEqual(once);
    expect(reduceTurn(T, events)).toStrictEqual(once);
  });
});

describe("reduceTurn reads the v2 diff shape first and the v1 shape second (§12.5)", () => {
  it('builds a FileChange from `changes` + `_meta["omni/v1Diff"]`', () => {
    const result = reduceTurn(T, [
      running(),
      toolCall({
        id: "c1",
        status: "completed",
        content: [
          v2Diff({
            path: "/repo/a.ts",
            operation: "modify",
            oldText: "old",
            newText: "new",
            fragment: true,
          }),
        ],
      }),
      idle("end_turn"),
    ]);
    expect(result.changes).toEqual([
      {
        path: "/repo/a.ts",
        operation: "modify",
        oldText: "old",
        newText: "new",
        // From the DESCRIPTOR, stamped by the normalizer — never derived here (F19).
        fragment: true,
      },
    ]);
  });

  it("still reads a v1 block, because a persisted log can hold both", () => {
    const result = reduceTurn(T, [
      running(),
      toolCall({
        id: "c1",
        content: [{ type: "diff", path: "/repo/b.ts", oldText: null, newText: "created" }],
      }),
      idle("end_turn"),
    ]);
    expect(result.changes).toEqual([
      { path: "/repo/b.ts", operation: "add", oldText: null, newText: "created", fragment: false },
    ]);
  });

  it("contributes NO FileChange for a v2 diff with no recoverable text", () => {
    // v2's `Diff` has no `oldText`/`newText` at all, and `FileChange.newText` is a string.
    // Inventing `""` would tell a consumer the file is now empty; skipping is what M0 already
    // did for a v1 block with no `newText`.
    const result = reduceTurn(T, [
      running(),
      toolCall({
        id: "c1",
        content: [{ type: "diff", changes: [{ operation: "add", path: "/repo/c.ts" }] }],
      }),
      idle("end_turn"),
    ]);
    expect(result.changes).toEqual([]);
  });
});

describe("reduceTurn computes §13.4's verdict with NO agent prose", () => {
  it("`ok` when nothing failed and nothing was denied", () => {
    const result = reduceTurn(T, [
      running(),
      toolCall({ id: "c1", status: "completed" }),
      idle("end_turn"),
    ]);
    expect(result.verdict).toBe("ok");
    expect(result.warnings).toEqual([]);
  });

  it("`partial` from the STATUS ENUM alone", () => {
    const result = reduceTurn(T, [
      running(),
      toolCall({ id: "c1", status: "in_progress" }),
      toolCall({ id: "c1", status: "failed" }),
      idle("end_turn"),
    ]);
    expect(result.verdict).toBe("partial");
    expect(result.failedToolCalls).toEqual(["c1"]);
    expect(result.deniedToolCalls).toEqual([]);
    expect(result.warnings).toEqual([
      {
        code: "tool_failed",
        message: "tool call c1 ended with status failed",
        source: "tool_status",
        detail: { toolCallId: "c1" },
      },
    ]);
  });

  it("`partial` from OUR OWN denial, joined by toolCallId", () => {
    const result = reduceTurn(T, [
      running(),
      toolCall({ id: "c1", status: "pending" }),
      policyDecision({ decision: "deny", toolCallId: "c1", title: "Write hello.txt" }),
      idle("end_turn"),
    ]);
    expect(result.verdict).toBe("partial");
    expect(result.deniedToolCalls).toEqual(["c1"]);
    // Deny is invisible in `stopReason` (corpus finding 7), which is the whole point.
    expect(result.stopReason).toBe("end_turn");
  });

  it("a denial with a NULL toolCallId is recorded but joins to nothing", () => {
    const result = reduceTurn(T, [
      running(),
      policyDecision({ decision: "deny", toolCallId: null }),
      idle("end_turn"),
    ]);
    expect(result.deniedToolCalls).toEqual([]);
    expect(result.interactions).toHaveLength(1);
    expect(result.verdict).toBe("ok");
  });

  it("D4 rule 4's `decision: error` is an ADVISORY, not a failure", () => {
    const result = reduceTurn(T, [
      running(),
      policyDecision({ decision: "error", toolCallId: "c1" }),
      idle("end_turn"),
    ]);
    expect(result.verdict).toBe("ok");
    expect(result.warnings.map((w) => w.code)).toEqual(["permission_not_offered"]);
  });

  it("`failed` outranks `partial` when the turn also carries an error", () => {
    const result = reduceTurn(T, [
      running(),
      toolCall({ id: "c1", status: "failed" }),
      env({
        kind: "omni.error",
        payloadVersion: 2,
        payload: { code: "agent_error", message: "the agent's stderr matched fatalStderr:oom" },
      }),
      idle("end_turn"),
    ]);
    expect(result.verdict).toBe("failed");
    expect(result.failedToolCalls).toEqual(["c1"]);
  });

  it("de-duplicates a denial reported twice for one tool call", () => {
    const result = reduceTurn(T, [
      running(),
      policyDecision({ decision: "deny", toolCallId: "c1" }),
      policyDecision({ decision: "deny", toolCallId: "c1" }),
      idle("end_turn"),
    ]);
    expect(result.deniedToolCalls).toEqual(["c1"]);
  });
});

describe("reduceTurn reads §13.2's `idle` additions", () => {
  it("`tokens` comes from `idle.usage` and `usage` from `usage_update` — two shapes, two fields", () => {
    const result = reduceTurn(T, [
      running(),
      env({
        kind: "acp.session_update",
        payloadVersion: 2,
        payload: { sessionUpdate: "usage_update", used: 42, size: 200 } as never,
      }),
      env({
        kind: "acp.session_update",
        payloadVersion: 2,
        payload: {
          sessionUpdate: "state_update",
          state: "idle",
          stopReason: "end_turn",
          usage: { totalTokens: 999, inputTokens: 900, outputTokens: 99, cachedReadTokens: 5 },
        } as never,
      }),
    ]);
    expect(result.usage).toEqual({ used: 42, size: 200 });
    expect(result.tokens).toEqual({
      totalTokens: 999,
      inputTokens: 900,
      outputTokens: 99,
      cachedReadTokens: 5,
    });
  });

  it("omits `tokens` when `idle.usage` is not the v2 `Usage` shape", () => {
    expect(reduceTurn(T, [running(), idleWithMeta({})]).tokens).toBeUndefined();
  });

  it("reads `warnings` and `vendorPatch` off `idle._meta`, and validates both", () => {
    const result = reduceTurn(T, [
      running(),
      idleWithMeta({
        "omni/warnings": [
          {
            code: "rate_limit",
            message: "rate-limit status allowed_warning",
            source: "usage_meta",
          },
          { code: "bogus", message: "no source" },
          { code: "bogus2", message: "bad source", source: "telepathy" },
          7,
        ],
        "omni/vendorPatch": {
          format: "git_patch",
          text: "diff --git a/x b/x\\n",
          source: "vendor",
        },
      }),
    ]);
    expect(result.warnings).toEqual([
      { code: "rate_limit", message: "rate-limit status allowed_warning", source: "usage_meta" },
    ]);
    expect(result.vendorPatch).toEqual({
      format: "git_patch",
      text: "diff --git a/x b/x\\n",
      source: "vendor",
    });
    // D8 / M1-R11: `patch` is null even when a vendor patch is present and valid.
    expect(result.patch).toBeNull();
  });

  it("rejects a vendorPatch in a shape it cannot vouch for", () => {
    for (const bad of [
      { format: "unified", text: "x", source: "v" },
      { format: "git_patch", source: "v" },
      { format: "git_patch", text: "x" },
      "a patch",
      null,
    ]) {
      const result = reduceTurn(T, [running(), idleWithMeta({ "omni/vendorPatch": bad })]);
      expect(result.vendorPatch, JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("the v1/v2 `=` rows are structurally equal AT COMPILE TIME (§12.7)", () => {
  it("type-checks the identity fixture with zero diagnostics", () => {
    const fixture = join(dirname(fileURLToPath(import.meta.url)), "types", "v1-v2-identity.ts");
    const program = ts.createProgram([fixture], {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: [],
    });
    const diagnostics = ts.getPreEmitDiagnostics(program).map((d) => {
      const where =
        d.file && d.start !== undefined
          ? `${d.file.fileName}:${d.file.getLineAndCharacterOfPosition(d.start).line + 1}`
          : "<no file>";
      return `${where} TS${String(d.code)}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`;
    });
    expect(diagnostics).toEqual([]);
  });
});

/**
 * M2-A-WP-W. §21.5 and ruling M2-R8's half of the fold: the calls a finished turn was never told
 * about, and the honest nulls D8 attaches an explanation to.
 */
describe("reduceTurn reports stranded tool calls rather than synthesizing one (M2-R8)", () => {
  const call = (id: string, extra: Record<string, unknown> = {}, turnId: TurnId = T) =>
    env(
      {
        kind: "acp.session_update",
        payloadVersion: 2,
        payload: { sessionUpdate: "tool_call_update", toolCallId: id, ...extra } as never,
      },
      turnId,
    );

  it("is empty on a turn where every call reached a terminal status", () => {
    const r = reduceTurn(T, [
      running(),
      call("a", { status: "pending" }),
      call("a", { status: "completed" }),
      call("b", { status: "failed" }),
      idle("end_turn"),
    ]);
    expect(r.strandedToolCalls).toEqual([]);
    expect(r.failedToolCalls).toEqual(["b"]);
  });

  it("reports every non-terminal LAST status, in stream order", () => {
    const r = reduceTurn(T, [
      running(),
      call("first", { status: "in_progress" }),
      call("second", { status: "completed" }),
      call("third", { status: "pending" }),
      idle("cancelled"),
    ]);
    expect(r.strandedToolCalls).toEqual(["first", "third"]);
    expect(r.verdict).toBe("partial");
  });

  it("counts a call whose status was NEVER sent — `null` is exactly the condition it reports", () => {
    const r = reduceTurn(T, [running(), call("ghost", { title: "Terminal" }), idle("end_turn")]);
    expect(r.toolCalls[0]?.status).toBeNull();
    expect(r.strandedToolCalls).toEqual(["ghost"]);
  });

  it("does not treat `cancelled` as terminal — the agent said it stopped, not that it finished", () => {
    // F36: neither real agent EVER sends this for a stranded call. An agent that volunteered it
    // would still not be telling us the tool completed.
    const r = reduceTurn(T, [running(), call("a", { status: "cancelled" }), idle("cancelled")]);
    expect(r.strandedToolCalls).toEqual(["a"]);
  });

  it("strands nothing on a RUNNING turn, and everything the moment it ends", () => {
    const live = [running(), call("a", { status: "pending" })];
    expect(reduceTurn(T, live).strandedToolCalls).toEqual([]);
    expect(reduceTurn(T, live).verdict).toBe("ok");
    expect(turnStatus(T, live).state).toBe("running");

    const ended = [...live, idle("end_turn")];
    expect(reduceTurn(T, ended).strandedToolCalls).toEqual(["a"]);
    expect(reduceTurn(T, ended).verdict).toBe("partial");
  });

  it("also strands on a turn ended by a worker close rather than by idle", () => {
    const r = reduceTurn(T, [
      running(),
      call("a", { status: "pending" }),
      env(
        {
          kind: "omni.worker_state",
          payloadVersion: 2,
          payload: { state: "closed", previous: "running", reason: "cancel_timeout" },
        },
        null,
      ),
    ]);
    expect(r.strandedToolCalls).toEqual(["a"]);
    // `failed` still outranks `partial`: the close carried an error.
    expect(r.verdict).toBe("failed");
  });

  it("is stable under re-delivery, re-ordering and replay, like every other field", () => {
    const envelopes = [
      running(),
      call("a", { status: "pending" }),
      call("b", { status: "completed" }),
      idle("cancelled"),
    ];
    const first = reduceTurn(T, envelopes);
    expect(first.strandedToolCalls).toEqual(["a"]);
    expect(reduceTurn(T, [...envelopes, ...structuredClone(envelopes)])).toStrictEqual(first);
    expect(reduceTurn(T, [...envelopes].reverse())).toStrictEqual(first);
  });

  it("ignores another turn's open call", () => {
    const r = reduceTurn(T, [
      running(),
      call("mine", { status: "completed" }),
      call("theirs", { status: "pending" }, OTHER),
      idle("end_turn"),
    ]);
    expect(r.strandedToolCalls).toEqual([]);
  });
});

describe("reduceTurn explains every patch null (D8, §25.3)", () => {
  const PATCH_TEXT = ["diff --", "git a/x b/x\n"].join("");

  it("reads the provider's own warnings out of the `omni/patch` block", () => {
    // §25.1: the warning "has to reach `idle._meta` through this same channel — it is the only
    // one a pure fold can read it from". `omni/warnings` is the REDUCER's key; a provider writes
    // into its own `PatchResult` and this is what surfaces it.
    const r = reduceTurn(T, [
      running(),
      idleWithMeta({
        "omni/patch": {
          text: null,
          source: null,
          truncated: false,
          quality: "unavailable",
          warnings: [
            { code: "patch_timeout", message: "the provider did not answer", source: "patch" },
            { code: "bogus", message: "no source" },
          ],
        },
      }),
    ]);
    expect(r.patch).toBeNull();
    expect(r.patchInfo).toEqual({ source: null, truncated: false, quality: "unavailable" });
    expect(r.warnings).toEqual([
      { code: "patch_timeout", message: "the provider did not answer", source: "patch" },
    ]);
  });

  it("keeps a well-formed patch and its quality", () => {
    const r = reduceTurn(T, [
      running(),
      idleWithMeta({
        "omni/patch": {
          text: PATCH_TEXT,
          source: "git",
          truncated: true,
          quality: "shared_worktree",
          warnings: [],
        },
      }),
    ]);
    expect(r.patch).toBe(PATCH_TEXT);
    expect(r.patchInfo).toEqual({ source: "git", truncated: true, quality: "shared_worktree" });
  });

  it("a malformed block is null, never a throw and never a half-built patchInfo", () => {
    for (const bad of [{ quality: "excellent" }, "a patch", null, 7, { text: "x" }]) {
      const r = reduceTurn(T, [running(), idleWithMeta({ "omni/patch": bad })]);
      expect(r.patch, JSON.stringify(bad)).toBeNull();
      expect(r.patchInfo, JSON.stringify(bad)).toBeNull();
    }
  });

  it("an absent key is M1: `patch` and `patchInfo` are both null and no warning is invented", () => {
    const r = reduceTurn(T, [running(), idle("end_turn")]);
    expect(r.patch).toBeNull();
    expect(r.patchInfo).toBeNull();
    expect(r.warnings).toEqual([]);
  });
});

/**
 * The five M2 advisories that were SPECIFIED and never produced (review finding V9).
 *
 * `policyClampWarning` (§20.5) and `unpolicedToolCalls` (§20.6) had unit tests and ZERO production
 * callers; §19.9's `interaction_declined` / `interaction_expired` existed nowhere in the
 * repository outside CONTRACTS.md; and M2-R19's `policy_blinded` — one of the three announcements
 * that are the PRICE of allowing `interaction.allowAlways:"human"` — was never built either. So
 * `alertOnUnpoliced` was a config key that did nothing and several "it is never silent"
 * guarantees were silent.
 *
 * All five are derived HERE, from envelopes, for one reason: D7 says the SDK's local
 * `reduceTurn()` and the daemon's `GET /turns/{id}` must not be able to disagree, and a
 * daemon-side post-pass could not keep that. `worker.ts` puts the one input the fold cannot
 * derive — the resolved `alertOnUnpoliced` — on `state_update{idle}._meta["omni/policy"]`.
 */
describe("reduceTurn derives M2's policy advisories from the envelopes (review finding V9)", () => {
  const decision = (payload: Record<string, unknown>) =>
    env({
      kind: "omni.policy_decision",
      payloadVersion: 2,
      payload: {
        requestId: "x_00000000000000000000000001",
        kind: "permission",
        method: "session/request_permission",
        title: "Write hello.txt",
        decision: "allow",
        by: "policy",
        rule: "p#r1",
        optionId: "allow-once",
        offered: [],
        toolCallId: "call_1",
        ...payload,
      } as never,
    });

  const interaction = (payload: Record<string, unknown>) =>
    env({
      kind: "acp.interaction",
      payloadVersion: 2,
      payload: {
        requestId: "x_00000000000000000000000001",
        kind: "elicitation",
        method: "elicitation/create",
        request: {},
        status: "answered",
        toolCallId: null,
        ...payload,
      } as never,
    });

  const toolCall = (toolCallId: string, kind: string) =>
    env({
      kind: "acp.session_update",
      payloadVersion: 2,
      payload: {
        sessionUpdate: "tool_call",
        toolCallId,
        title: "run it",
        kind,
        status: "completed",
      },
    });

  const codes = (envelopes: readonly EventEnvelope[]): string[] =>
    reduceTurn(T, envelopes).warnings.map((w) => w.code);

  it("`policy_clamped` — §20.5's clamp is announced on the TURN as well as on the decision", () => {
    const result = reduceTurn(T, [
      running(),
      decision({ clamped: { from: "allow", by: "policyCeiling:pathRoots" } }),
      idle("end_turn"),
    ]);
    const clamp = result.warnings.find((w) => w.code === "policy_clamped");
    expect(clamp).toBeDefined();
    expect(clamp?.source).toBe("policy");
    expect(clamp?.detail).toEqual({
      from: "allow",
      to: "allow",
      by: "policyCeiling:pathRoots",
      rule: "p#r1",
    });
    // Nothing clamped, nothing said.
    expect(codes([running(), decision({}), idle("end_turn")])).not.toContain("policy_clamped");
  });

  it("`policy_blinded` — F26's session-wide grant, which nothing on the wire announces", () => {
    const result = reduceTurn(T, [
      running(),
      decision({ blindsPolicy: true, optionId: "allow-always" }),
      idle("end_turn"),
    ]);
    const blinded = result.warnings.find((w) => w.code === "policy_blinded");
    expect(blinded).toBeDefined();
    expect(blinded?.detail).toMatchObject({ optionId: "allow-always" });
    expect(codes([running(), decision({}), idle("end_turn")])).not.toContain("policy_blinded");
  });

  it("`interaction_declined` — F31 says this record is the outcome's ONLY trace", () => {
    expect(
      codes([
        running(),
        interaction({ answer: { optionId: null, by: "human", action: "decline" } }),
        idle("end_turn"),
      ]),
    ).toContain("interaction_declined");
    expect(
      codes([
        running(),
        interaction({ answer: { optionId: null, by: "human", action: "cancel" } }),
        idle("end_turn"),
      ]),
    ).toContain("interaction_declined");
    // An ACCEPTED elicitation is not a declined one.
    expect(
      codes([
        running(),
        interaction({ answer: { optionId: null, by: "human", action: "accept" } }),
        idle("end_turn"),
      ]),
    ).not.toContain("interaction_declined");
  });

  it("`interaction_expired` — a park that reached its deadline with no human", () => {
    expect(codes([running(), interaction({ status: "expired" }), idle("end_turn")])).toContain(
      "interaction_expired",
    );
    expect(codes([running(), interaction({}), idle("end_turn")])).not.toContain(
      "interaction_expired",
    );
  });

  it("a PENDING interaction produces neither — it has not settled at all", () => {
    const pending = interaction({
      status: "pending",
      park: { parkedAt: "x", expiresAt: null, onTimeout: "deny" },
    });
    expect(codes([running(), pending, idle("end_turn")])).not.toContain("interaction_expired");
    expect(codes([running(), pending, idle("end_turn")])).not.toContain("interaction_declined");
  });

  it("`unpoliced_tool_call` — §20.6/F40, off `idle._meta['omni/policy']`", () => {
    const withMeta = (meta: Record<string, unknown> | null) =>
      env({
        kind: "acp.session_update",
        payloadVersion: 2,
        payload: {
          sessionUpdate: "state_update",
          state: "idle",
          stopReason: "end_turn",
          ...(meta === null ? {} : { _meta: meta }),
        },
      });

    // The watch list is present and a WATCHED kind ran with no decision to its name.
    const flagged = reduceTurn(T, [
      running(),
      toolCall("call_ls", "execute"),
      withMeta({ "omni/policy": { alertOnUnpoliced: ["execute"] } }),
    ]);
    const warning = flagged.warnings.find((w) => w.code === "unpoliced_tool_call");
    expect(warning).toBeDefined();
    expect(warning?.detail).toEqual({ toolCallId: "call_ls", kind: "execute" });

    // A tool call the engine DID see is not unpoliced.
    expect(
      codes([
        running(),
        toolCall("call_1", "execute"),
        decision({ toolCallId: "call_1" }),
        withMeta({ "omni/policy": { alertOnUnpoliced: ["execute"] } }),
      ]),
    ).not.toContain("unpoliced_tool_call");

    // No watch list on the turn ⇒ no warning, which is every M1 turn and the default.
    expect(codes([running(), toolCall("call_ls", "execute"), withMeta(null)])).not.toContain(
      "unpoliced_tool_call",
    );
  });
});
