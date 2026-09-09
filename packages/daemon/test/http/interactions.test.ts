import { describe, expect, it } from "vitest";
import {
  DaemonConfig,
  HEADER,
  OmniError,
  hashSecret,
  type ClientRef,
  type Daemon,
  type DaemonId,
  type InteractionAnswerBody,
  type InteractionAnswerResult,
  type InteractionId,
  type InteractionSnapshot,
  type ResolvedDaemonConfig,
  type Seq,
  type TokenId,
  type WorkerId,
  type WorkerRegistry,
} from "@omni-acp/protocol";
import { stubDaemon } from "@omni-acp/testkit";
import { createTokenStore } from "../../src/auth.js";
import { createHttpApp } from "../../src/http/app.js";

/**
 * H22 / H23 over the WIRE, against a recording `stubDaemon()`.
 *
 * The route is `parse -> ONE registry call -> serialize`, and §19.6's whole status table arrives
 * here through the one error mapper — which is exactly why the CHECK ORDER lives in the registry
 * and the handle and not in this file. What is asserted here is that the route adds nothing: one
 * call per request, the parsed body forwarded verbatim, and every `OmniError` code reaching its
 * documented status with its documented body extra.
 *
 * Owned by M2-A-WP-I.
 */

const WID = "w_00000000000000000000000001" as WorkerId;
const DID = "d_00000000000000000000000001" as DaemonId;
const REQ = "x_00000000000000000000000001" as InteractionId;

const SECRETS: Record<string, string> = {
  tok_user: "user-secret-0123456789abcdef",
  tok_admin: "admin-secret-0123456789abcdef",
};

const USER: ClientRef = { tokenId: "tok_user" as TokenId, clientId: "cli_a" };
const ADMIN: ClientRef = { tokenId: "tok_admin" as TokenId, clientId: "cli_admin" };

function daemonConfig(): ResolvedDaemonConfig {
  return DaemonConfig.parse({
    daemonId: DID,
    tokens: [
      { id: "tok_user", secretSha256: hashSecret(SECRETS["tok_user"] ?? "") },
      { id: "tok_admin", secretSha256: hashSecret(SECRETS["tok_admin"] ?? ""), role: "admin" },
    ],
  });
}

const snapshotOf = (over?: Partial<InteractionSnapshot>): InteractionSnapshot => ({
  requestId: REQ,
  workerId: WID,
  kind: "permission",
  method: "session/request_permission",
  status: "pending",
  title: "Write hello.txt",
  message: null,
  turnId: null,
  toolCallId: "call_1",
  createdAt: new Date(0).toISOString(),
  options: [{ optionId: "allow-once", name: "Yes", kind: "allow_once" }] as never,
  fields: [],
  expiresAt: null,
  settledAt: null,
  settledBy: null,
  answer: null,
  ...over,
});

interface Call {
  readonly method: string;
  readonly args: readonly unknown[];
}

interface Fixture {
  readonly daemon: Daemon;
  readonly calls: readonly Call[];
  request(who: ClientRef | null, method: string, path: string, body?: unknown): Promise<Response>;
}

/**
 * A registry that RECORDS and then answers, so "exactly one registry call" is a count and not a
 * reading. Each verb's failure is injected as the `OmniError` the real registry would throw, in
 * the position §19.6 puts it.
 */
function recordingRegistry(o: {
  calls: Call[];
  answer?: () => InteractionAnswerResult;
  interactions?: () => readonly InteractionSnapshot[];
}): WorkerRegistry {
  const unimplemented = (name: string) => (): never => {
    throw new OmniError("internal", `${name} is not part of this suite`);
  };
  return {
    size: 1,
    hibernatedSize: 0,
    create: unimplemented("create"),
    get: unimplemented("get"),
    list: () => [],
    closeAll: () => Promise.resolve(),
    turn: unimplemented("turn"),
    adopt: () => Promise.resolve({ hibernated: 0, closed: 0, orphans: [] }),
    hibernate: unimplemented("hibernate"),
    wake: unimplemented("wake"),
    snapshot: unimplemented("snapshot"),
    logFor: unimplemented("logFor"),
    prompt: unimplemented("prompt"),
    cancel: unimplemented("cancel"),
    delete: unimplemented("delete"),
    lease: unimplemented("lease"),
    setConfig: unimplemented("setConfig"),

    answer: (id, auth, reqId, body): InteractionAnswerResult => {
      o.calls.push({ method: "answer", args: [id, auth.tokenId, reqId, body] });
      return (
        o.answer?.() ?? {
          interaction: snapshotOf({ status: "answered", settledBy: "human" }),
          state: "running",
          seq: 12 as Seq,
        }
      );
    },

    interactions: (id, auth) => {
      o.calls.push({ method: "interactions", args: [id, auth.tokenId] });
      return { interactions: o.interactions?.() ?? [snapshotOf()] };
    },
  } as unknown as WorkerRegistry;
}

function fixture(o?: {
  answer?: () => InteractionAnswerResult;
  interactions?: () => readonly InteractionSnapshot[];
}): Fixture {
  const config = daemonConfig();
  const tokens = createTokenStore(config);
  const calls: Call[] = [];
  let app: ReturnType<typeof createHttpApp> | null = null;
  const daemon = stubDaemon({
    config,
    authenticate: (headers: Headers) => tokens.verify(headers),
    workers: recordingRegistry({
      calls,
      ...(o?.answer === undefined ? {} : { answer: o.answer }),
      ...(o?.interactions === undefined ? {} : { interactions: o.interactions }),
    }),
    fetch: (req: Request) =>
      Promise.resolve(app?.fetch(req) ?? new Response(null, { status: 500 })),
  });
  app = createHttpApp(daemon);

  return {
    daemon,
    calls,
    request: (who, method, path, body) =>
      daemon.fetch(
        new Request(`http://daemon.invalid${path}`, {
          method,
          headers: {
            ...(who === null
              ? {}
              : {
                  [HEADER.auth]: `Bearer ${SECRETS[who.tokenId] ?? "no-such-token"}`,
                  [HEADER.clientId]: who.clientId ?? "cli",
                }),
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      ),
  };
}

const answerAt = (path = `/v1/workers/${WID}/interactions/${REQ}`): string => path;

describe("GET /v1/workers/{wid}/interactions (H23)", () => {
  it("is UNGATED (rule L2) and calls exactly one registry method", async () => {
    const f = fixture();
    const res = await f.request(USER, "GET", `/v1/workers/${WID}/interactions`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ interactions: [snapshotOf()] });
    // No lease header was sent, and no lease verb was reached: reading the pending set is an
    // observer's right, and the lease governs who may ANSWER (the whole of D5 applied to D10).
    expect(f.calls).toEqual([{ method: "interactions", args: [WID, USER.tokenId] }]);
  });

  it("serializes an empty pending set as [] and never as a 404", async () => {
    const f = fixture({ interactions: () => [] });
    const res = await f.request(USER, "GET", `/v1/workers/${WID}/interactions`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ interactions: [] });
  });

  it("still requires a token — ungated means lease-free, not auth-free", async () => {
    const f = fixture();
    expect((await f.request(null, "GET", `/v1/workers/${WID}/interactions`)).status).toBe(401);
    expect(f.calls).toEqual([]);
  });
});

describe("POST /v1/workers/{wid}/interactions/{reqId} (H22)", () => {
  it("parses InteractionAnswerBody and calls exactly one registry method", async () => {
    const f = fixture();
    const res = await f.request(USER, "POST", answerAt(), { action: "allow" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      interaction: { status: "answered", settledBy: "human" },
      state: "running",
      seq: 12,
    });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.method).toBe("answer");
    expect(f.calls[0]?.args[2]).toBe(REQ);
    expect(f.calls[0]?.args[3]).toEqual({ action: "allow" });
  });

  it("forwards every arm of the body verbatim — allow / deny / answer / cancel", async () => {
    const bodies: InteractionAnswerBody[] = [
      { action: "allow", optionId: "allow-once" },
      { action: "deny", note: "no" },
      { action: "answer", content: { question_0: "notes.md" } },
      { action: "cancel" },
    ];
    for (const body of bodies) {
      const f = fixture();
      expect((await f.request(USER, "POST", answerAt(), body)).status).toBe(200);
      expect(f.calls[0]?.args[3]).toEqual(body);
    }
  });

  it("a body the schema refuses is 400 and never reaches the registry", async () => {
    for (const body of [
      { action: "shrug" },
      { action: "allow", optionId: 7 },
      { action: "answer" },
      {},
      null,
    ]) {
      const f = fixture();
      const res = await f.request(USER, "POST", answerAt(), body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe("bad_request");
      expect(f.calls).toEqual([]);
    }
  });

  it("a malformed reqId is 400 with the value ELIDED from the message", async () => {
    const f = fixture();
    const res = await f.request(USER, "POST", answerAt(`/v1/workers/${WID}/interactions/nope`), {
      action: "deny",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("bad_request");
    expect(body.message).toBe("malformed interaction id");
    // The offending value is machine-readable `detail`, which never crosses the wire (§9).
    expect(JSON.stringify(body)).not.toContain("nope");
    expect(f.calls).toEqual([]);
  });

  it("requires a token", async () => {
    const f = fixture();
    expect((await f.request(null, "POST", answerAt(), { action: "deny" })).status).toBe(401);
    expect(f.calls).toEqual([]);
  });
});

describe("§19.6's status table, through the one error mapper", () => {
  const throwing = (e: OmniError): (() => InteractionAnswerResult) => {
    return () => {
      throw e;
    };
  };

  const rows: {
    name: string;
    error: OmniError;
    status: number;
    code: string;
    extra?: (body: Record<string, unknown>) => void;
  }[] = [
    {
      name: "the token cannot SEE the worker — 404 worker_not_found, never a leak",
      error: new OmniError("worker_not_found", `no worker ${WID}`),
      status: 404,
      code: "worker_not_found",
    },
    {
      name: "the reqId is unknown on this worker — 404 interaction_not_found (M2-R2)",
      error: new OmniError("interaction_not_found", `no interaction ${REQ}`),
      status: 404,
      code: "interaction_not_found",
    },
    {
      name: "already settled — 409 interaction_settled, carrying the snapshot that won",
      error: new OmniError("interaction_settled", `interaction ${REQ} is already answered`, {
        interaction: snapshotOf({ status: "answered", settledBy: "human" }),
      }),
      status: 409,
      code: "interaction_settled",
      extra: (body) => {
        expect(body["interaction"]).toMatchObject({ status: "answered", settledBy: "human" });
      },
    },
    {
      name: "the worker is closed — 410 worker_closed",
      error: new OmniError("worker_closed", `worker ${WID} is closed`),
      status: 410,
      code: "worker_closed",
    },
    {
      name: "not the holder — 423 lease_held, carrying the holder",
      error: new OmniError("lease_held", "another client holds the lease", {
        lease: {
          workerId: WID,
          holder: { tokenId: "tok_user" as TokenId, clientId: "cli_b" },
          epoch: 3,
          expiresAt: null,
          acquiredAt: null,
          pinned: true,
        },
      }),
      status: 423,
      code: "lease_held",
      extra: (body) => {
        expect(body["lease"]).toMatchObject({ epoch: 3, holder: { clientId: "cli_b" } });
      },
    },
    {
      name: "a body the STORED request cannot accept — 400 bad_request",
      error: new OmniError(
        "bad_request",
        '"invented" is not one of the options interaction offered (offered: "allow-once")',
      ),
      status: 400,
      code: "bad_request",
      extra: (body) => {
        expect(String(body["message"])).toContain("allow-once");
      },
    },
    {
      name: "the ACP link died between admission and the answer — 409 interaction_settled",
      error: new OmniError("interaction_settled", `interaction ${REQ} is already failed`, {
        interaction: snapshotOf({ status: "failed", settledBy: "daemon" }),
      }),
      status: 409,
      code: "interaction_settled",
      extra: (body) => {
        expect(body["interaction"]).toMatchObject({ status: "failed" });
      },
    },
  ];

  for (const row of rows) {
    it(row.name, async () => {
      const f = fixture({ answer: throwing(row.error) });
      const res = await f.request(USER, "POST", answerAt(), { action: "deny" });
      expect(res.status).toBe(row.status);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body["code"]).toBe(row.code);
      row.extra?.(body);
      // The route added nothing: one registry call, whatever the answer was.
      expect(f.calls).toHaveLength(1);
    });
  }

  it("two identical failures produce DEEP-EQUAL bodies", async () => {
    const make = (): OmniError =>
      new OmniError("interaction_not_found", `no interaction ${REQ} is awaiting an answer`);
    const bodies: unknown[] = [];
    for (const _ of [0, 1]) {
      const f = fixture({ answer: throwing(make()) });
      const res = await f.request(USER, "POST", answerAt(), { action: "deny" });
      bodies.push(await res.json());
    }
    expect(bodies[0]).toEqual(bodies[1]);
  });

  it('a role:"admin" caller without the lease is 423 — lease-only, admin included (M2-R6)', async () => {
    // L3's carve-out is for `DELETE`, which is a RESCUE; an answer mutates the agent's execution
    // exactly as `prompt` does. Admin already has a one-call audited path — `POST …/lease/steal`
    // then answer — which leaves an `omni.lease{op:"stolen"}` where a lease-free admin answer
    // would leave nothing.
    const f = fixture({
      answer: throwing(new OmniError("lease_held", "another client holds the lease")),
    });
    const res = await f.request(ADMIN, "POST", answerAt(), { action: "deny" });
    expect(res.status).toBe(423);
    expect(((await res.json()) as { code: string }).code).toBe("lease_held");
    expect(f.calls[0]?.args[1]).toBe(ADMIN.tokenId);
  });

  it("404 interaction_not_found and 409 interaction_settled are distinguishable from the worker's own", async () => {
    // Ruling M2-R2's whole reason: this path addresses TWO resources and a bare 404 cannot say
    // which is gone. A client that retried a worker 404 by recreating its worker would do so
    // over a stale reqId, and a double-submit folded into `worker_busy` sends an SDK into its
    // prompt queue.
    const codes: string[] = [];
    for (const error of [
      new OmniError("worker_not_found", "no worker"),
      new OmniError("interaction_not_found", "no interaction"),
      new OmniError("worker_busy", "busy"),
      new OmniError("interaction_settled", "settled"),
    ]) {
      const f = fixture({ answer: throwing(error) });
      const res = await f.request(USER, "POST", answerAt(), { action: "deny" });
      codes.push(`${String(res.status)}:${((await res.json()) as { code: string }).code}`);
    }
    expect(codes).toEqual([
      "404:worker_not_found",
      "404:interaction_not_found",
      "409:worker_busy",
      "409:interaction_settled",
    ]);
  });
});
