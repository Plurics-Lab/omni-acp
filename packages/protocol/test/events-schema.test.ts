import { describe, expect, it } from "vitest";
import { EVENT_KINDS, eventEnvelopeSchema, type EventEnvelope } from "@omni-acp/protocol";

const meta = {
  seq: 7,
  ts: "2026-09-03T12:00:00.700Z",
  daemonId: `d_${"0".repeat(26)}`,
  workerId: `w_${"0".repeat(26)}`,
  sessionId: "sess-abc",
  turnId: `t_${"0".repeat(26)}`,
  payloadVersion: 1 as const,
};

describe("eventEnvelopeSchema", () => {
  it("parses one envelope of every kind", () => {
    const envelopes: unknown[] = [
      {
        ...meta,
        kind: "acp.session_update",
        payload: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } },
      },
      {
        ...meta,
        payloadVersion: 2,
        kind: "acp.interaction",
        payload: {
          requestId: "req-1",
          method: "session/request_permission",
          request: { sessionId: "sess-abc", options: [] },
          status: "answered",
          answer: { optionId: "reject", by: "baseline" },
        },
      },
      {
        ...meta,
        payloadVersion: 2,
        kind: "omni.policy_decision",
        payload: {
          requestId: "req-1",
          title: "Modifying critical configuration file",
          decision: "deny",
          rule: "m0:auto-deny",
          optionId: "reject",
          offered: [{ kind: "reject_once", name: "Skip", optionId: "reject" }],
          // §13.4: we are the party that denied, so the join back to the tool call is OURS to
          // record — `reduceTurn` reports it as `deniedToolCalls` instead of parsing the agent's
          // English ("User refused permission to run tool").
          toolCallId: "call_1",
        },
      },
      {
        ...meta,
        payloadVersion: 2,
        turnId: null,
        sessionId: null,
        kind: "omni.worker_state",
        payload: {
          state: "closed",
          previous: "running",
          reason: "agent_crashed",
          exit: { code: 1, signal: null },
          leaderExited: true,
          treeGone: false,
        },
      },
      {
        ...meta,
        payloadVersion: 2,
        turnId: null,
        kind: "omni.lease",
        payload: {
          op: "stolen",
          lease: {
            workerId: `w_${"0".repeat(26)}`,
            holder: { tokenId: "tok_b", clientId: "cli_b" },
            // The FENCING token: +1 on every acquire / steal / expiry, which is what stops a
            // client that cached "I hold it" from acting after a steal (§16.1 rule L7).
            epoch: 4,
            expiresAt: null,
            acquiredAt: "2026-09-03T12:00:00.700Z",
            pinned: false,
          },
          previous: { tokenId: "tok_a", clientId: "cli_a" },
          by: { tokenId: "tok_b", clientId: "cli_b" },
          how: "steal",
          // D5: 带审计 — the operator's reason is recorded VERBATIM.
          reason: "the holder went home",
        },
      },
      {
        ...meta,
        payloadVersion: 2,
        kind: "omni.error",
        payload: { code: "agent_error", message: "boom", stderrTail: "Error: boom\n" },
      },
    ];
    const kinds = envelopes.map((e) => {
      const parsed: EventEnvelope = eventEnvelopeSchema.parse(e);
      return parsed.kind;
    });
    expect(kinds).toEqual([...EVENT_KINDS]);
  });

  it("forwards an agent payload by identity, so `_meta` and unknown fields survive", () => {
    // CONTRACTS.md §7.5: agent payloads are forwarded byte-for-byte. A `z.object` here would
    // rebuild the payload and silently drop every field M0 has not enumerated.
    const payload = {
      sessionUpdate: "tool_call",
      toolCallId: "call_1",
      title: "t",
      somethingM2Invents: { nested: true },
      _meta: { trace: "abc" },
    };
    const parsed = eventEnvelopeSchema.parse({ ...meta, kind: "acp.session_update", payload });
    expect(parsed.payload).toBe(payload);
  });

  it("rejects a malformed envelope", () => {
    const bad: [string, unknown][] = [
      [
        "seq 0",
        { ...meta, seq: 0, kind: "omni.error", payload: { code: "internal", message: "x" } },
      ],
      [
        "fractional seq",
        { ...meta, seq: 1.5, kind: "omni.error", payload: { code: "internal", message: "x" } },
      ],
      [
        "unprefixed workerId",
        {
          ...meta,
          workerId: "not-a-worker",
          kind: "omni.error",
          payload: { code: "internal", message: "x" },
        },
      ],
      [
        "daemonId in the workerId slot",
        {
          ...meta,
          workerId: meta.daemonId,
          kind: "omni.error",
          payload: { code: "internal", message: "x" },
        },
      ],
      [
        "turnId of the wrong prefix",
        {
          ...meta,
          turnId: meta.workerId,
          kind: "omni.error",
          payload: { code: "internal", message: "x" },
        },
      ],
      [
        "payloadVersion 3",
        {
          ...meta,
          payloadVersion: 3,
          kind: "omni.error",
          payload: { code: "internal", message: "x" },
        },
      ],
      ["unknown kind", { ...meta, kind: "omni.something_new", payload: {} }],
      ["missing kind", { ...meta, payload: {} }],
      [
        "unknown error code",
        { ...meta, kind: "omni.error", payload: { code: "kaboom", message: "x" } },
      ],
      [
        "session update without sessionUpdate",
        { ...meta, kind: "acp.session_update", payload: { text: "hi" } },
      ],
      [
        "replay: false",
        { ...meta, replay: false, kind: "omni.error", payload: { code: "internal", message: "x" } },
      ],
      ["not an object", 42],
    ];
    for (const [name, value] of bad) {
      expect(eventEnvelopeSchema.safeParse(value).success, name).toBe(false);
    }
  });

  it("accepts the pre-handshake prefix: sessionId null, turnId null, replay absent", () => {
    const parsed = eventEnvelopeSchema.parse({
      ...meta,
      seq: 1,
      sessionId: null,
      turnId: null,
      payloadVersion: 2,
      kind: "omni.worker_state",
      payload: { state: "starting", previous: null, reason: "created" },
    });
    expect(parsed.sessionId).toBeNull();
    expect(parsed.turnId).toBeNull();
    expect("replay" in parsed).toBe(false);
  });

  it("keeps an unknown permission-option kind, which D4 rule 6 depends on", () => {
    const parsed = eventEnvelopeSchema.parse({
      ...meta,
      payloadVersion: 2,
      kind: "omni.policy_decision",
      payload: {
        requestId: "req-1",
        title: "",
        decision: "deny",
        rule: "m0:auto-deny",
        optionId: null,
        offered: [{ kind: "allow_when_the_moon_is_full", name: "?", optionId: "x" }],
        toolCallId: null,
      },
    });
    expect(parsed.kind).toBe("omni.policy_decision");
    if (parsed.kind !== "omni.policy_decision") return;
    expect(parsed.payload.offered[0]?.kind).toBe("allow_when_the_moon_is_full");
  });
});
