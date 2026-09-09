import { describe, expect, it } from "vitest";
import { OmniError } from "@omni-acp/protocol";
import type {
  DaemonId,
  EventEnvelope,
  InteractionAnswerResult,
  InteractionId,
  InteractionPayload,
  InteractionSnapshot,
  Seq,
  SessionId,
  TokenId,
  TurnId,
  WorkerId,
} from "@omni-acp/protocol";
import { createInteractionChannel, type InteractionRequestHandle } from "../src/interactions.js";
import type { Transport } from "../src/transport.js";

/**
 * The SDK half of D10: `worker.on("interaction", ...)` and the handle's four verbs.
 *
 * Neither `createInteractionChannel` nor `Transport` is on the frozen barrel — only the
 * `InteractionRequestHandle` TYPE is — so they are reached the way `worker.ts` reaches them, by
 * module path, exactly as `lease.test.ts` does.
 *
 * Owned by M2-A-WP-I.
 */

const WID = "w_00000000000000000000000001" as WorkerId;
const DID = "d_00000000000000000000000001" as DaemonId;
const TID = "t_00000000000000000000000001" as TurnId;
const REQ = "x_00000000000000000000000001" as InteractionId;

interface Recorded {
  method: string;
  path: string;
  body: unknown;
}

function recordingTransport(answers: unknown[] = []): {
  transport: Transport;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const transport: Transport = {
    clientId: "cli_a",
    leaseEpoch: null,
    adoptLeaseEpoch: () => {},
    request: <R>(method: string, path: string, body?: unknown): Promise<R> => {
      calls.push({ method, path, body });
      const next = answers.shift();
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve(
        (next ?? {
          interaction: { requestId: REQ, status: "answered" },
          state: "running",
          seq: 9 as Seq,
        }) as R,
      );
    },
    open: () => Promise.reject(new Error("not used")),
  };
  return { transport, calls };
}

let seq = 0;
function envelope(payload: InteractionPayload, over?: Partial<EventEnvelope>): EventEnvelope {
  seq += 1;
  return {
    seq: seq as Seq,
    ts: `2026-01-01T00:00:0${String(seq % 10)}.000Z`,
    daemonId: DID,
    workerId: WID,
    sessionId: "sess-1" as SessionId,
    turnId: TID,
    payloadVersion: 2,
    kind: "acp.interaction",
    payload,
    ...over,
  } as EventEnvelope;
}

const PERMISSION_MENU = [
  { optionId: "allow-once", name: "Yes", kind: "allow_once" },
  { optionId: "allow-with-updates", name: "Yes, always", kind: "allow_always" },
  { optionId: "reject", name: "No", kind: "reject_once" },
] as never;

const FIELDS = [
  {
    id: "question_0",
    title: "File name",
    type: "string",
    options: [{ value: "notes.md", title: "notes.md", description: null }],
    required: false,
    customField: "question_0_custom",
    isCustomFor: null,
    constraints: {},
  },
] as never;

const parkedPermission = (over?: Partial<InteractionPayload>): InteractionPayload => ({
  requestId: REQ,
  kind: "permission",
  method: "session/request_permission",
  request: { title: "Write hello.txt", subject: null, options: PERMISSION_MENU },
  raw: {},
  status: "pending",
  park: { parkedAt: "2026-01-01T00:00:00.000Z", expiresAt: null, onTimeout: "deny" },
  toolCallId: "call_1",
  ...over,
});

const parkedElicitation = (over?: Partial<InteractionPayload>): InteractionPayload => ({
  requestId: REQ,
  kind: "elicitation",
  method: "elicitation/create",
  request: { message: "What should the new file be named?", fields: FIELDS },
  raw: {},
  status: "pending",
  park: { parkedAt: "2026-01-01T00:00:00.000Z", expiresAt: null, onTimeout: "deny" },
  toolCallId: "toolu_ask_1",
  ...over,
});

const settled = (over?: Partial<InteractionPayload>): InteractionPayload => ({
  requestId: REQ,
  kind: "permission",
  method: "session/request_permission",
  request: { title: "Write hello.txt", subject: null, options: PERMISSION_MENU },
  raw: {},
  status: "answered",
  toolCallId: "call_1",
  answer: { optionId: "reject", by: "baseline", parkedMs: 0 },
  ...over,
});

describe('Worker.on("interaction") and InteractionRequestHandle', () => {
  it("fires ONLY for a parked interaction — an auto-resolved one never wakes a listener", () => {
    const { transport } = recordingTransport();
    const channel = createInteractionChannel(transport, WID);
    const asked: InteractionRequestHandle[] = [];
    const done: InteractionSnapshot[] = [];
    channel.onInteraction((r) => asked.push(r));
    channel.onSettled((s) => done.push(s));

    // An auto-resolved interaction is emitted ONCE, already terminal (ruling M2-R5). Waking a UI
    // for it would train people to ignore the event.
    channel.handleEnvelope(envelope(settled()));
    expect(asked).toEqual([]);
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ status: "answered", settledBy: "baseline" });
    expect(channel.pending).toEqual([]);

    channel.handleEnvelope(envelope(parkedPermission()));
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      requestId: REQ,
      method: "session/request_permission",
      title: "Write hello.txt",
      // `""` and not null: a permission has no message, and D10's one lifecycle means a caller
      // should not have to know which arm arrived.
      message: "",
      expiresAt: null,
      settled: false,
    });
    expect(asked[0]?.options).toEqual(PERMISSION_MENU);
    expect(asked[0]?.fields).toEqual([]);
  });

  it("ignores every envelope kind but acp.interaction", () => {
    const { transport } = recordingTransport();
    const channel = createInteractionChannel(transport, WID);
    let fired = 0;
    channel.onInteraction(() => fired++);
    channel.handleEnvelope(envelope(parkedPermission(), { kind: "omni.policy_decision" } as never));
    channel.handleEnvelope(envelope(parkedPermission(), { kind: "acp.session_update" } as never));
    expect(fired).toBe(0);
    expect(channel.pending).toEqual([]);
  });

  it("worker.interactions tracks the pending set from the envelope tail with no extra round trip", () => {
    const { transport, calls } = recordingTransport();
    const channel = createInteractionChannel(transport, WID);

    channel.handleEnvelope(envelope(parkedPermission()));
    expect(channel.pending).toHaveLength(1);
    expect(channel.pending[0]).toMatchObject({
      requestId: REQ,
      workerId: WID,
      kind: "permission",
      status: "pending",
      turnId: TID,
      toolCallId: "call_1",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    channel.handleEnvelope(envelope(settled()));
    expect(channel.pending).toEqual([]);
    // Not one HTTP call: the pending set lives on the stream the handle already consumes, and a
    // poll could only ever disagree with it.
    expect(calls).toEqual([]);
  });

  it("keys on requestId and never counts frames — a replayed `pending` fires once (§19.10)", () => {
    const { transport } = recordingTransport();
    const channel = createInteractionChannel(transport, WID);
    let fired = 0;
    channel.onInteraction(() => fired++);
    // An SSE reconnect replays the tail with `?since=`; the same park arrives twice.
    channel.handleEnvelope(envelope(parkedPermission()));
    channel.handleEnvelope(envelope(parkedPermission()));
    expect(fired).toBe(1);
    expect(channel.pending).toHaveLength(1);
  });

  it("allow() posts H22 — with and without an optionId (D4 rule 2's ordering)", async () => {
    const { transport, calls } = recordingTransport();
    const channel = createInteractionChannel(transport, WID);
    let handle: InteractionRequestHandle | null = null;
    channel.onInteraction((r) => (handle = r));
    channel.handleEnvelope(envelope(parkedPermission()));

    const req = handle as unknown as InteractionRequestHandle;
    await req.allow();
    await req.allow("allow-once");
    expect(calls).toEqual([
      { method: "POST", path: `/v1/workers/${WID}/interactions/${REQ}`, body: { action: "allow" } },
      {
        method: "POST",
        path: `/v1/workers/${WID}/interactions/${REQ}`,
        body: { action: "allow", optionId: "allow-once" },
      },
    ]);
  });

  it("deny() is one verb for both arms: reject_once for a permission, decline for an elicitation", async () => {
    for (const payload of [parkedPermission(), parkedElicitation()]) {
      const { transport, calls } = recordingTransport();
      const channel = createInteractionChannel(transport, WID);
      let handle: InteractionRequestHandle | null = null;
      channel.onInteraction((r) => (handle = r));
      channel.handleEnvelope(envelope(payload));

      await (handle as unknown as InteractionRequestHandle).deny();
      // ONE body for both, because D10 says one lifecycle: the DAEMON knows whether that means
      // the offered `reject_once` or `{action:"decline"}`, and a caller should not have to.
      expect(calls).toEqual([
        {
          method: "POST",
          path: `/v1/workers/${WID}/interactions/${REQ}`,
          body: { action: "deny" },
        },
      ]);
    }
  });

  it("answer() is keyed by QUESTION id and never sends both a selection and its _custom twin (F30)", async () => {
    const { transport, calls } = recordingTransport();
    const channel = createInteractionChannel(transport, WID);
    let handle: InteractionRequestHandle | null = null;
    channel.onInteraction((r) => (handle = r));
    channel.handleEnvelope(envelope(parkedElicitation()));
    const req = handle as unknown as InteractionRequestHandle;

    expect(req.message).toBe("What should the new file be named?");
    expect(req.fields).toEqual(FIELDS);
    expect(req.options).toEqual([]);

    await req.answer({ question_0: "notes.md" });
    expect(calls).toEqual([
      {
        method: "POST",
        path: `/v1/workers/${WID}/interactions/${REQ}`,
        body: { action: "answer", content: { question_0: "notes.md" } },
      },
    ]);

    // The regression is NAMED after the file transcript `12` wrongly created: filling both
    // members of a group made the agent use the CUSTOM value and write `omni-choice.txt`
    // instead of the selected `notes.md`. The SDK refuses BEFORE the round trip; the daemon
    // re-checks, because three independent checks is what D4 rule 1 costs.
    let thrown: unknown;
    try {
      await req.answer({ question_0: "notes.md", question_0_custom: "omni-choice.txt" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(OmniError);
    expect((thrown as OmniError).code).toBe("bad_request");
    expect((thrown as OmniError).message).toContain("question_0_custom");
    // Nothing left the process.
    expect(calls).toHaveLength(1);
  });

  it("cancel() cancels the INTERACTION and never the turn", async () => {
    const { transport, calls } = recordingTransport();
    const channel = createInteractionChannel(transport, WID);
    let handle: InteractionRequestHandle | null = null;
    channel.onInteraction((r) => (handle = r));
    channel.handleEnvelope(envelope(parkedElicitation()));

    await (handle as unknown as InteractionRequestHandle).cancel();
    expect(calls[0]?.path).toBe(`/v1/workers/${WID}/interactions/${REQ}`);
    expect(calls[0]?.body).toEqual({ action: "cancel" });
    // `worker.cancel()` is the turn cancel and it is a DIFFERENT route.
    expect(calls[0]?.path).not.toContain("/cancel");
  });

  it("`settled` flips the moment the terminal frame lands, without a round trip", () => {
    const { transport, calls } = recordingTransport();
    const channel = createInteractionChannel(transport, WID);
    let handle: InteractionRequestHandle | null = null;
    channel.onInteraction((r) => (handle = r));
    channel.handleEnvelope(envelope(parkedPermission()));
    const req = handle as unknown as InteractionRequestHandle;
    expect(req.settled).toBe(false);
    channel.handleEnvelope(
      envelope(settled({ answer: { optionId: "reject", by: "human", parkedMs: 41230 } })),
    );
    expect(req.settled).toBe(true);
    expect(calls).toEqual([]);
  });

  it("the settled snapshot keeps the PARK's createdAt and clears the deadline", () => {
    const { transport } = recordingTransport();
    const channel = createInteractionChannel(transport, WID);
    const done: InteractionSnapshot[] = [];
    channel.onSettled((s) => done.push(s));
    channel.handleEnvelope(
      envelope(
        parkedPermission({
          park: {
            parkedAt: "2026-01-01T00:00:00.000Z",
            expiresAt: "2026-01-01T00:10:00.000Z",
            onTimeout: "deny",
          },
        }),
      ),
    );
    expect(channel.pending[0]?.expiresAt).toBe("2026-01-01T00:10:00.000Z");

    channel.handleEnvelope(
      envelope(settled({ answer: { optionId: "reject", by: "human", parkedMs: 41230 } })),
    );
    expect(done).toHaveLength(1);
    expect(done[0]?.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(done[0]?.settledBy).toBe("human");
    expect(done[0]?.answer).toEqual({ optionId: "reject", by: "human", parkedMs: 41230 });
    // NEVER a lie: a settled row must not advertise a countdown nothing is running.
    expect(done[0]?.expiresAt).toBeNull();
  });

  it("a listener that throws does not take the stream down with it", () => {
    const { transport } = recordingTransport();
    const channel = createInteractionChannel(transport, WID);
    const seen: string[] = [];
    channel.onInteraction(() => {
      throw new Error("a UI blew up");
    });
    channel.onInteraction(() => seen.push("second"));
    expect(() => channel.handleEnvelope(envelope(parkedPermission()))).not.toThrow();
    expect(seen).toEqual(["second"]);
  });

  it("unsubscribing stops delivery", () => {
    const { transport } = recordingTransport();
    const channel = createInteractionChannel(transport, WID);
    let fired = 0;
    const off = channel.onInteraction(() => fired++);
    channel.handleEnvelope(envelope(parkedPermission()));
    off();
    channel.handleEnvelope(envelope(parkedPermission({ requestId: "x_2" as InteractionId })));
    expect(fired).toBe(1);
  });

  it("returns the daemon's InteractionAnswerResult verbatim", async () => {
    const result: InteractionAnswerResult = {
      interaction: {
        requestId: REQ,
        workerId: WID,
        kind: "permission",
        method: "session/request_permission",
        status: "answered",
        title: "Write hello.txt",
        message: null,
        turnId: TID,
        toolCallId: "call_1",
        createdAt: "2026-01-01T00:00:00.000Z",
        options: PERMISSION_MENU,
        fields: [],
        expiresAt: null,
        settledAt: "2026-01-01T00:00:41.230Z",
        settledBy: "human",
        answer: {
          optionId: "allow-once",
          by: "human",
          byToken: "tok_a" as TokenId,
          parkedMs: 41230,
        },
      },
      state: "running",
      seq: 42 as Seq,
    };
    const { transport } = recordingTransport([result]);
    const channel = createInteractionChannel(transport, WID);
    let handle: InteractionRequestHandle | null = null;
    channel.onInteraction((r) => (handle = r));
    channel.handleEnvelope(envelope(parkedPermission()));
    expect(await (handle as unknown as InteractionRequestHandle).allow()).toEqual(result);
  });
});
