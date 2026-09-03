import { mkdir, mkdtemp, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HEADER, SSE_CONTROL, type CloseResult, type WorkerSnapshot } from "@omni-acp/protocol";
import {
  collectSse,
  fakeSupervisor,
  nullLogger,
  seqIds,
  type FakeSupervisor,
} from "@omni-acp/testkit";
import { createDaemon } from "../../src/create-daemon.js";
import type { Daemon } from "../../src/types.js";
import { coreScript, someWorkerId } from "../fake-core.js";

vi.mock("@omni-acp/core", async (importOriginal) => {
  const { fakeCoreModule } = await import("./../fake-core.js");
  return await fakeCoreModule(importOriginal as never);
});

const USER = "user-secret-0123456789abcdef";
const OTHER = "other-secret-0123456789abcdef";
const ADMIN = "admin-secret-0123456789abcdef";

interface Fixture {
  readonly daemon: Daemon;
  readonly supervisor: FakeSupervisor;
  readonly root: string;
  readonly outside: string;
  call(method: string, path: string, opts?: { body?: unknown; token?: string }): Promise<Response>;
  json<T>(res: Response): Promise<T>;
}

async function fixture(over?: { maxWorkers?: number; tokenMaxWorkers?: number }): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "omni-http-")));
  const outside = await realpath(await mkdtemp(join(tmpdir(), "omni-outside-")));
  const supervisor = fakeSupervisor();
  const daemon = await createDaemon(
    {
      dataDir: join(root, "data"),
      listen: null,
      maxWorkers: over?.maxWorkers ?? 64,
      tokens: [
        {
          id: "user",
          secret: USER,
          cwdRoots: [root],
          maxWorkers: over?.tokenMaxWorkers ?? 16,
          agents: ["example"],
        },
        { id: "other", secret: OTHER, cwdRoots: [root] },
        { id: "admin", secret: ADMIN, role: "admin", cwdRoots: [root] },
      ],
      agents: [{ id: "example", command: process.execPath, args: ["agent.js"] }],
      logLevel: "silent",
      eventLog: { sseHeartbeatMs: 60_000 },
    },
    { supervisor, ids: seqIds(), logger: nullLogger() },
  );

  return {
    daemon,
    supervisor,
    root,
    outside,
    call: (method, path, opts) =>
      daemon.fetch(
        new Request(`http://daemon.invalid${path}`, {
          method,
          headers: {
            [HEADER.auth]: `Bearer ${opts?.token ?? USER}`,
            ...(opts?.body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(opts?.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
        }),
      ),
    json: async <T>(res: Response) => (await res.json()) as T,
  };
}

async function createWorker(f: Fixture, token = USER): Promise<WorkerSnapshot> {
  const res = await f.call("POST", "/v1/workers", {
    body: { agent: "example", cwd: f.root },
    token,
  });
  expect(res.status).toBe(201);
  return await f.json<WorkerSnapshot>(res);
}

beforeEach(() => {
  coreScript.reset();
});

describe("the whole lifecycle over daemon.fetch — zero listen, zero ports (acceptance 3)", () => {
  it("creates, prompts, streams, polls the turn and deletes", async () => {
    const f = await fixture();
    const worker = await createWorker(f);
    expect(worker.state).toBe("ready");
    expect(worker.sessionId).not.toBeNull();

    // H6 / H7
    const list = await f.json<{ workers: WorkerSnapshot[] }>(await f.call("GET", "/v1/workers"));
    expect(list.workers.map((w) => w.workerId)).toEqual([worker.workerId]);
    expect((await f.call("GET", `/v1/workers/${worker.workerId}`)).status).toBe(200);

    // H8
    const prompt = await f.call("POST", `/v1/workers/${worker.workerId}/prompt`, {
      body: { content: [{ type: "text", text: "who are you?" }] },
    });
    expect(prompt.status).toBe(202);
    const accepted = await f.json<{ turnId: string; seq: number }>(prompt);

    // H10 — subscribing at `accepted.seq - 1` is GUARANTEED to hold the whole turn.
    const stream = await f.call(
      "GET",
      `/v1/workers/${worker.workerId}/events?since=${accepted.seq - 1}`,
    );
    expect(stream.status).toBe(200);
    const collected = collectSse(stream, {
      until: (e) =>
        e.kind === "acp.session_update" &&
        e.payload.sessionUpdate === "state_update" &&
        (e.payload as { state?: string }).state === "idle",
      timeoutMs: 2_000,
    });
    coreScript.workers.at(-1)?.chunk("I am a fake");
    coreScript.workers.at(-1)?.finishTurn("end_turn");
    const { envelopes } = await collected;
    expect(envelopes[0]?.seq).toBe(accepted.seq);
    expect(envelopes.every((e) => e.workerId === worker.workerId)).toBe(true);
    expect(envelopes.every((e) => e.turnId === accepted.turnId)).toBe(true);

    // H11
    const status = await f.json<{ state: string; result: { text: string } | null }>(
      await f.call("GET", `/v1/workers/${worker.workerId}/turns/${accepted.turnId}`),
    );
    expect(status.state).toBe("completed");
    expect(status.result?.text).toBe("I am a fake");

    // H11 for a turn nobody ever ran: 200 `unknown`, not a 404 (D29).
    const unknown = await f.call(
      "GET",
      `/v1/workers/${worker.workerId}/turns/t_${"0".repeat(25)}9`,
    );
    expect(unknown.status).toBe(200);
    expect(await f.json(unknown)).toMatchObject({ state: "unknown", result: null });

    // H12
    const deleted = await f.call("DELETE", `/v1/workers/${worker.workerId}`);
    expect(deleted.status).toBe(200);
    expect(f.supervisor.allTreesReclaimed()).toBe(true);
    await f.daemon.stop();
  });

  it("DELETE is idempotent and carries the ownership honesty fields (acceptance 11, §6.6)", async () => {
    const f = await fixture();
    const worker = await createWorker(f);
    const first = await f.json<CloseResult>(
      await f.call("DELETE", `/v1/workers/${worker.workerId}`),
    );
    const second = await f.json<CloseResult>(
      await f.call("DELETE", `/v1/workers/${worker.workerId}`),
    );
    expect(second).toEqual(first);
    expect(first).toMatchObject({ state: "closed", reason: "client_request" });
    expect(typeof first.leaderExited).toBe("boolean");
    expect(first.treeGone).toBe(f.supervisor.platform.ownership.confirmsTreeGone);

    // The same two facts on the state envelope…
    const closedEnvelope = f.daemon.workers
      .logFor(worker.workerId, f.daemon.authContextFor("user"))
      .read(0)
      .find((e) => e.kind === "omni.worker_state" && e.payload.state === "closed");
    expect(closedEnvelope?.payload).toMatchObject({
      leaderExited: first.leaderExited,
      treeGone: first.treeGone,
    });

    // …and on GET /v1/info, which is where an operator reads them BEFORE anything goes wrong.
    const info = await f.json<{ ownership: { confirmsTreeGone: boolean; caveat: string | null } }>(
      await f.call("GET", "/v1/info"),
    );
    expect(info.ownership.confirmsTreeGone).toBe(f.supervisor.platform.ownership.confirmsTreeGone);
    expect(info.ownership).toEqual(f.supervisor.platform.ownership);
    await f.daemon.stop();
  });

  it("a closed worker answers 410 on prompt and stays visible", async () => {
    const f = await fixture();
    const worker = await createWorker(f);
    await f.call("DELETE", `/v1/workers/${worker.workerId}`);
    const res = await f.call("POST", `/v1/workers/${worker.workerId}/prompt`, {
      body: { content: [{ type: "text", text: "hi" }] },
    });
    expect(res.status).toBe(410);
    expect(await f.json(res)).toMatchObject({ code: "worker_closed" });
    await f.daemon.stop();
  });

  it("409 worker_busy while a turn is live (H8)", async () => {
    const f = await fixture();
    const worker = await createWorker(f);
    const body = { content: [{ type: "text", text: "hi" }] };
    await f.call("POST", `/v1/workers/${worker.workerId}/prompt`, { body });
    const second = await f.call("POST", `/v1/workers/${worker.workerId}/prompt`, { body });
    expect(second.status).toBe(409);
    expect(await f.json(second)).toMatchObject({ code: "worker_busy" });

    // H9 frees it again, and the process is still alive.
    const cancelled = await f.call("POST", `/v1/workers/${worker.workerId}/cancel`);
    expect(cancelled.status).toBe(202);
    expect(await f.json(cancelled)).toEqual({});
    expect((await f.call("POST", `/v1/workers/${worker.workerId}/prompt`, { body })).status).toBe(
      202,
    );
    await f.daemon.stop();
  });
});

describe("ACL over HTTP (acceptance 6, 7)", () => {
  it("403 for an agent outside the token's allowlist", async () => {
    const f = await fixture();
    const res = await f.call("POST", "/v1/workers", {
      body: { agent: "other-agent", cwd: f.root },
    });
    expect(res.status).toBe(403);
    expect(await f.json(res)).toMatchObject({ code: "forbidden" });
    await f.daemon.stop();
  });

  it("400 for an unknown agent id — a request parameter, not a new code (D29)", async () => {
    const f = await fixture();
    const res = await f.call("POST", "/v1/workers", {
      body: { agent: "ghost", cwd: f.root },
      token: ADMIN,
    });
    expect(res.status).toBe(400);
    await f.daemon.stop();
  });

  it("403 for a cwd outside cwdRoots", async () => {
    const f = await fixture();
    const res = await f.call("POST", "/v1/workers", {
      body: { agent: "example", cwd: f.outside },
    });
    expect(res.status).toBe(403);
    await f.daemon.stop();
  });

  it.skipIf(process.platform === "win32")(
    "403 for a SYMLINK inside a root that escapes it (D18)",
    async () => {
      const f = await fixture();
      const escape = join(f.root, "escape");
      await symlink(f.outside, escape, "dir");
      const res = await f.call("POST", "/v1/workers", { body: { agent: "example", cwd: escape } });
      expect(res.status).toBe(403);
      expect(f.supervisor.spawnCalls).toHaveLength(0);
      await f.daemon.stop();
    },
  );

  it("allows a nested directory inside a root", async () => {
    const f = await fixture();
    const nested = join(f.root, "project", "src");
    await mkdir(nested, { recursive: true });
    const res = await f.call("POST", "/v1/workers", { body: { agent: "example", cwd: nested } });
    expect(res.status).toBe(201);
    expect((await f.json<WorkerSnapshot>(res)).cwd).toBe(await realpath(nested));
    await f.daemon.stop();
  });

  it("429 worker_limit per token and globally, with the slot returned on close", async () => {
    const f = await fixture({ tokenMaxWorkers: 1 });
    const first = await createWorker(f);
    const denied = await f.call("POST", "/v1/workers", {
      body: { agent: "example", cwd: f.root },
    });
    expect(denied.status).toBe(429);
    expect(await f.json(denied)).toMatchObject({ code: "worker_limit" });

    await f.call("DELETE", `/v1/workers/${first.workerId}`);
    expect(
      (await f.call("POST", "/v1/workers", { body: { agent: "example", cwd: f.root } })).status,
    ).toBe(201);
    await f.daemon.stop();
  });

  it("hides another token's worker as 404, never 403 (D13)", async () => {
    const f = await fixture();
    const mine = await createWorker(f);
    for (const [method, path] of [
      ["GET", `/v1/workers/${mine.workerId}`],
      ["GET", `/v1/workers/${mine.workerId}/events`],
      ["GET", `/v1/workers/${mine.workerId}/turns/t_${"0".repeat(25)}1`],
      ["DELETE", `/v1/workers/${mine.workerId}`],
    ] as const) {
      const res = await f.call(method, path, { token: OTHER });
      expect({ path, status: res.status }).toEqual({ path, status: 404 });
      expect(await f.json(res)).toMatchObject({ code: "worker_not_found" });
    }
    const theirList = await f.json<{ workers: WorkerSnapshot[] }>(
      await f.call("GET", "/v1/workers", { token: OTHER }),
    );
    expect(theirList.workers).toEqual([]);

    // An admin sees the whole machine.
    expect((await f.call("GET", `/v1/workers/${mine.workerId}`, { token: ADMIN })).status).toBe(
      200,
    );
    const adminList = await f.json<{ workers: WorkerSnapshot[] }>(
      await f.call("GET", "/v1/workers", { token: ADMIN }),
    );
    expect(adminList.workers).toHaveLength(1);
    await f.daemon.stop();
  });

  it("404s a well-formed worker id that never existed", async () => {
    const f = await fixture();
    const res = await f.call("GET", `/v1/workers/${someWorkerId(42)}`);
    expect(res.status).toBe(404);
    await f.daemon.stop();
  });
});

describe("handshake failures over HTTP (acceptance 8)", () => {
  it("502 on a handshake JSON-RPC error, with the tree reclaimed and `acp` passed through", async () => {
    const f = await fixture();
    coreScript.handshake = "jsonrpc_error";
    const res = await f.call("POST", "/v1/workers", { body: { agent: "example", cwd: f.root } });
    expect(res.status).toBe(502);
    expect(await f.json(res)).toMatchObject({
      code: "agent_error",
      acp: { code: -32603, message: "handshake failed" },
    });
    expect(f.supervisor.allTreesReclaimed()).toBe(true);
    await f.daemon.stop();
  });

  it("504 when the handshake budget elapses, with the tree reclaimed", async () => {
    const f = await fixture();
    coreScript.handshake = "timeout";
    const res = await f.call("POST", "/v1/workers", {
      body: { agent: "example", cwd: f.root, timeoutMs: 1_000 },
    });
    expect(res.status).toBe(504);
    expect(await f.json(res)).toMatchObject({ code: "agent_timeout" });
    expect(f.supervisor.allTreesReclaimed()).toBe(true);
    expect(f.supervisor.live.size).toBe(0);
    await f.daemon.stop();
  });
});

describe("SSE over HTTP (acceptance 10)", () => {
  it("replays from scratch by default and ends the stream when the worker closes", async () => {
    const f = await fixture();
    const worker = await createWorker(f);
    const stream = await f.call("GET", `/v1/workers/${worker.workerId}/events`);
    const collected = collectSse(stream, { timeoutMs: 2_000 });
    await f.call("DELETE", `/v1/workers/${worker.workerId}`);
    const { envelopes, control } = await collected;

    expect(envelopes.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(envelopes[0]?.payload).toMatchObject({ state: "starting" });
    expect(control.at(-1)).toEqual({
      event: SSE_CONTROL.end,
      data: { reason: "worker_closed", lastSeq: 3 },
    });
    await f.daemon.stop();
  });

  it("prefers ?since= over Last-Event-ID, and falls back to the header (§8.4)", async () => {
    const f = await fixture();
    const worker = await createWorker(f);
    const url = `http://daemon.invalid/v1/workers/${worker.workerId}/events`;

    const explicit = await f.daemon.fetch(
      new Request(`${url}?since=1`, {
        headers: { [HEADER.auth]: `Bearer ${USER}`, [HEADER.lastEventId]: "0" },
      }),
    );
    expect((await collectSse(explicit, { count: 1, timeoutMs: 2_000 })).envelopes[0]?.seq).toBe(2);

    const header = await f.daemon.fetch(
      new Request(url, {
        headers: { [HEADER.auth]: `Bearer ${USER}`, [HEADER.lastEventId]: "1" },
      }),
    );
    expect((await collectSse(header, { count: 1, timeoutMs: 2_000 })).envelopes[0]?.seq).toBe(2);

    // A garbage Last-Event-ID is ignored rather than fatal: the browser sends it unprompted.
    const garbage = await f.daemon.fetch(
      new Request(url, {
        headers: { [HEADER.auth]: `Bearer ${USER}`, [HEADER.lastEventId]: "not-a-number" },
      }),
    );
    expect((await collectSse(garbage, { count: 1, timeoutMs: 2_000 })).envelopes[0]?.seq).toBe(1);
    await f.daemon.stop();
  });

  it("400s an explicit ?since= that is not a number", async () => {
    const f = await fixture();
    const worker = await createWorker(f);
    const res = await f.call("GET", `/v1/workers/${worker.workerId}/events?since=abc`);
    expect(res.status).toBe(400);
    await f.daemon.stop();
  });

  it("returns log.subscriberCount to 0 when the client aborts mid-stream", async () => {
    const f = await fixture();
    const worker = await createWorker(f);
    const log = f.daemon.workers.logFor(worker.workerId, f.daemon.authContextFor("user"));
    // The daemon holds ONE long-lived subscription per worker of its own — the fan-out behind
    // `daemon.on(...)` — so the leak assertion is about the DELTA a request adds. The absolute
    // "back to zero" form is asserted against a bare log in `sse.test.ts`.
    const baseline = log.subscriberCount;
    const controller = new AbortController();
    const stream = await f.daemon.fetch(
      new Request(`http://daemon.invalid/v1/workers/${worker.workerId}/events`, {
        headers: { [HEADER.auth]: `Bearer ${USER}` },
        signal: controller.signal,
      }),
    );
    const reader = stream.body?.getReader();
    await reader?.read();
    expect(log.subscriberCount).toBe(baseline + 1);

    controller.abort();
    expect(log.subscriberCount).toBe(baseline);

    // …and after shutdown nothing is subscribed to anything at all.
    await f.daemon.stop();
    expect(log.subscriberCount).toBe(0);
  });

  it("serves two observers of ONE worker the same envelopes (D5)", async () => {
    const f = await fixture();
    const worker = await createWorker(f);
    const a = await f.call("GET", `/v1/workers/${worker.workerId}/events?since=0`);
    const b = await f.call("GET", `/v1/workers/${worker.workerId}/events?since=1`, {
      token: ADMIN,
    });
    const collectedA = collectSse(a, { count: 3, timeoutMs: 2_000 });
    const collectedB = collectSse(b, { count: 2, timeoutMs: 2_000 });
    await f.call("POST", `/v1/workers/${worker.workerId}/prompt`, {
      body: { content: [{ type: "text", text: "hi" }] },
    });

    const [seenA, seenB] = await Promise.all([collectedA, collectedB]);
    expect(seenA.envelopes.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(seenB.envelopes.map((e) => e.seq)).toEqual([2, 3]);
    expect(seenA.envelopes.slice(1)).toEqual(seenB.envelopes);
    await f.daemon.stop();
  });
});

describe("daemon.stop with live streams (acceptance 12)", () => {
  it("ends every stream and leaves no subscription behind", async () => {
    const f = await fixture();
    const worker = await createWorker(f);
    const log = f.daemon.workers.logFor(worker.workerId, f.daemon.authContextFor("user"));
    const stream = await f.call("GET", `/v1/workers/${worker.workerId}/events`);
    const collected = collectSse(stream, { timeoutMs: 2_000 });

    await f.daemon.stop({ graceful: true });

    const { control } = await collected;
    // The subscriber saw the close and got `stream_end` — a clean end, not a network drop.
    expect(control.at(-1)?.event).toBe(SSE_CONTROL.end);
    expect(log.subscriberCount).toBe(0);
    expect(f.supervisor.live.size).toBe(0);
  });
});
