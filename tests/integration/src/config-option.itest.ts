import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { OmniACP, type Server, type Worker } from "@omni-acp/client";
import { createDaemon } from "@omni-acp/daemon";
import {
  HEADER,
  type Daemon,
  type EventEnvelope,
  type SetConfigResponse,
} from "@omni-acp/protocol";
import { curl, readEnvelopes, scaled, tempRoot, until } from "./support/harness.js";

/**
 * `POST /v1/workers/{wid}/config` end to end (H24, §22) — a real process, a real socket, real
 * ndJSON.
 *
 * Tier 3, and it needs an agent that ANSWERS `session/set_config_option`: no fixture in
 * `packages/testkit/fixtures/agents/` does (`mode.mjs` answers `session/set_mode`, `hybrid.mjs`
 * only EMITS `config_option_update`), and that package's `FixtureAgentName` union is Land-frozen.
 * So this suite writes its own one-file agent into its temp tree and launches it as
 * `process.execPath <path>` — the shim-free launch form (§6.3, F8) — importing the SDK through
 * an ABSOLUTE file URL, because a module in `os.tmpdir()` has no `node_modules` to resolve from.
 *
 * The catalogue it serves is claude `15`'s, shrink and all: four entries from `session/new`, two
 * from the set (F34's `effort` and `fast` dropped because Haiku exposes no effort levels), and a
 * THIRD, different list from `session/resume` — which is what makes §22.2's "a wake re-seeds the
 * live list" observable rather than asserted.
 *
 * It also builds its own daemon rather than using `startHarness`: this is the one suite that
 * needs a per-agent `runtime` overlay (`prefer.setConfig.spellings`), because the generic v1
 * profile advertises NO spelling — the honest "we have proved nothing about this agent" — and
 * the harness's `agents` option carries only `{id, command, args, env}`.
 *
 * Owned by M2-A-WP-C.
 */

const FOUR = ["mode", "model", "effort", "fast"];
const TWO = ["mode", "model"];
const RESUMED = ["mode", "model", "effort"];

/** The one-file agent, written into the harness's own temp tree at run time. */
function agentSource(sdkUrl: string): string {
  return `
import * as acp from ${JSON.stringify(sdkUrl)};
import { Readable, Writable } from "node:stream";

const NEVER_ANSWER = process.env.CFG_NEVER_ANSWER === "1";

const select = (id, currentValue) => ({
  id,
  name: id,
  description: id,
  category: id,
  type: "select",
  currentValue,
  options: [
    { value: currentValue, name: currentValue },
    { value: "haiku", name: "Haiku" },
    { value: "plan", name: "Plan" },
  ],
});

// claude \`15\`'s three catalogues: \`session/new\`'s four, the set's two, and a resume that
// reports a DIFFERENT list — a resumed session may offer a different catalogue (§22.2).
const FOUR = ${JSON.stringify(FOUR)}.map((id) => select(id, "default"));
const TWO = [select("mode", "default"), select("model", "haiku")];
const RESUMED = ${JSON.stringify(RESUMED)}.map((id) => select(id, "default"));

let sessions = 0;
let current = FOUR;

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));

acp
  .agent({ name: "config-fixture" })
  .onRequest("initialize", () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: {
      loadSession: true,
      sessionCapabilities: { close: {}, list: {}, resume: {} },
    },
  }))
  .onRequest("session/new", () => {
    current = FOUR;
    return { sessionId: \`cfg-\${String(process.pid)}-\${++sessions}\`, configOptions: current };
  })
  // A resumed session reports its own catalogue, contrary to the v1 schema (F18) and exactly as
  // \`session/new\` does — which is what \`withSessionBody\` reads on the wake path.
  .onRequest("session/resume", (ctx) => {
    current = RESUMED;
    return { sessionId: ctx.params.sessionId, configOptions: current };
  })
  // The identity parser, so the request reaches this handler with whatever spelling the
  // descriptor's quirk put on the wire.
  .onRequest(
    "session/set_config_option",
    (p) => p,
    (ctx) => {
      const value = ctx.params.value;
      if (value === "no-such-model-xyz") {
        // F44's shape, verbatim: a wrong VALUE and a genuine internal error share -32603 and are
        // separated only by \`data.details\`.
        throw new acp.RequestError(-32603, "Internal error", {
          details: "Invalid value for config option model: no-such-model-xyz",
        });
      }
      if (value === "no-list") return {};
      current = TWO;
      return { configOptions: current };
    },
  )
  .onRequest("session/prompt", async (ctx) => {
    const sessionId = ctx.params.sessionId;
    // The PLANTED spurious notification (§22.1 trap 1): the shape a notifying agent would send,
    // carrying a list that differs from the live one. Consuming it would move the snapshot.
    await ctx.client.notify("session/update", {
      sessionId,
      update: { sessionUpdate: "config_option_update", configOptions: TWO },
    });
    await ctx.client.notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "cfg-msg-1",
        content: { type: "text", text: "ok" },
      },
    });
    if (NEVER_ANSWER) return new Promise(() => {});
    return { stopReason: "end_turn" };
  })
  .onNotification("session/cancel", () => {})
  .connect(stream);
`;
}

interface Rig {
  readonly daemon: Daemon;
  readonly url: string;
  readonly token: string;
  readonly cwd: string;
  connect(clientId?: string): Promise<Server>;
  dispose(): Promise<void>;
}

let rig: Rig | null = null;
afterEach(async () => {
  await rig?.dispose();
  rig = null;
});

async function start(o?: {
  /** Absent ⇒ the generic v1 profile, whose `setConfig.spellings` is `[]` (D29's honest answer). */
  spellings?: readonly string[];
  env?: Record<string, string>;
}): Promise<Rig> {
  const cwd = await tempRoot("omni-cfg-cwd-");
  const dataDir = await tempRoot("omni-cfg-data-");
  const agentDir = await tempRoot("omni-cfg-agent-");
  const agentPath = join(agentDir, "config-agent.mjs");

  const require = createRequire(import.meta.url);
  await writeFile(
    agentPath,
    agentSource(pathToFileURL(require.resolve("@agentclientprotocol/sdk")).href),
    "utf8",
  );

  const token = randomBytes(32).toString("hex");
  const daemon = await createDaemon({
    dataDir,
    listen: { host: "127.0.0.1", port: 0 },
    tokens: [{ id: "local", secret: token, role: "admin", cwdRoots: [cwd], maxWorkers: 8 }],
    agents: [
      {
        id: "cfg",
        command: process.execPath,
        args: [agentPath],
        ...(o?.env === undefined ? {} : { env: o.env }),
        // The operator overlay §17.2 describes: the generic v1 profile names no `setConfig`
        // spelling at all, so a runtime with no builtin descriptor gets one from config — which
        // is exactly the path an operator adding a new agent takes, with zero code changes.
        ...(o?.spellings === undefined
          ? {}
          : { runtime: { prefer: { setConfig: { spellings: [...o.spellings] } } } }),
        // Deterministic: the probe's method battery would otherwise send its own
        // `session/set_config_option` before the test does.
        probe: { onStart: "never" },
      },
    ],
    // Long, and explicit: the hibernate/wake case drives `POST …/hibernate` itself, so an idle
    // timer firing mid-test would be a second, invisible cause for the same state change.
    hibernate: { idleMs: 600_000 },
    // Shortened on purpose: the `409` case leaves a LIVE turn behind on a fixture that ignores
    // `session/cancel`, so teardown walks §13.2's whole close-out ladder. The defaults make that
    // twelve seconds of waiting for an answer this fixture has promised never to give.
    turn: { quietMs: scaled(100), hardMs: scaled(1_000), drainGraceMs: 200, cancelGraceMs: 500 },
    eventLog: { driver: "sqlite" },
    logLevel: "silent",
  });
  await daemon.start();

  const url = daemon.url ?? "";
  let disposed = false;
  rig = {
    daemon,
    url,
    token,
    cwd,
    connect: (clientId?: string) =>
      OmniACP.connect({ url, token, ...(clientId === undefined ? {} : { clientId }) }),
    async dispose() {
      if (disposed) return;
      disposed = true;
      await daemon.stop({ graceful: true }).catch(() => {});
      for (const dir of [cwd, dataDir, agentDir]) {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
  return rig;
}

const idsOf = (w: Worker): readonly string[] => (w.snapshot.configOptions ?? []).map((o) => o.id);

/**
 * A raw `POST …/config`, with no SDK in the loop.
 *
 * `Omni-Client-Id` is not decoration: D5's lease is held by a CLIENT, and a bare `fetch` that
 * omitted it would be a different client and would earn a `423` on every call — which is exactly
 * what the lease is for, and exactly not what these tests are about. `CLIENT_ID` is the id every
 * `connect()` in this file is given, so the raw request is the SAME client as the SDK handle.
 */
const CLIENT_ID = "cli_holder";

const post = (
  r: Rig,
  workerId: string,
  body: unknown,
  clientId: string = CLIENT_ID,
): Promise<Response> =>
  curl(r.url, r.token)(`/v1/workers/${workerId}/config`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { [HEADER.clientId]: clientId },
  });

const configUpdates = (envelopes: readonly EventEnvelope[]): readonly EventEnvelope[] =>
  envelopes.filter(
    (e) =>
      e.kind === "acp.session_update" &&
      (e.payload as { sessionUpdate?: string }).sessionUpdate === "config_option_update",
  );

describe("config option (M2-A, H24) — the live catalogue over the real socket", () => {
  it("is seeded from session/new, REPLACED WHOLESALE by the method result, and leaves the handshake record alone", async () => {
    const r = await start({ spellings: ["session/set_config_option"] });
    const server = await r.connect(CLIENT_ID);
    const worker = await server.createAgent("cfg", { cwd: r.cwd });

    expect(idsOf(worker)).toEqual(FOUR);
    const atHandshake = worker.snapshot.capabilities?.configOptions ?? [];
    expect(atHandshake).toHaveLength(4);

    const res = await post(r, worker.id, { configId: "model", value: "haiku" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SetConfigResponse;

    expect(body.configOptions.map((o) => o.id)).toEqual(TWO);
    expect(body.removed).toEqual(["effort", "fast"]);
    expect(body.added).toEqual([]);
    expect(body.stale).toBe(false);
    expect(body.configOptions.find((o) => o.id === "model")?.currentValue).toBe("haiku");

    // The LIVE list moved, read back over HTTP by a client that did not make the call.
    const snapshot = await (await curl(r.url, r.token)(`/v1/workers/${worker.id}`)).json();
    const live = (snapshot as { configOptions?: { id: string }[] }).configOptions ?? [];
    expect(live.map((o) => o.id)).toEqual(TWO);
    // …and `AgentCapabilitiesSnapshot.configOptions` is the historical record, unchanged.
    expect(
      (snapshot as { capabilities: { configOptions: unknown[] } }).capabilities.configOptions,
    ).toHaveLength(4);
  });

  it("the daemon SYNTHESIZES the notification neither agent sends, stamped so it is distinguishable", async () => {
    const r = await start({ spellings: ["session/set_config_option"] });
    const server = await r.connect(CLIENT_ID);
    const worker = await server.createAgent("cfg", { cwd: r.cwd });
    const before = worker.snapshot.headSeq;

    await post(r, worker.id, { configId: "model", value: "haiku" });

    const envelopes = await readEnvelopes(r.url, r.token, worker.id, {
      since: before,
      quietMs: scaled(200),
      timeoutMs: scaled(10_000),
    });
    const updates = configUpdates(envelopes);
    expect(updates).toHaveLength(1);
    // M2-R23: `_meta["omni/source"]` is what tells a streaming client this came from a set rather
    // than from the agent.
    expect((updates[0]?.payload as { _meta: Record<string, unknown> })._meta["omni/source"]).toBe(
      "set_config_option",
    );
    expect((updates[0]?.payload as { configOptions: unknown[] }).configOptions).toHaveLength(2);
  });

  it("a spurious agent-emitted config_option_update is streamed but NEVER consumed (§22.1 trap 1)", async () => {
    const r = await start({ spellings: ["session/set_config_option"] });
    const server = await r.connect(CLIENT_ID);
    const worker = await server.createAgent("cfg", { cwd: r.cwd });
    const before = worker.snapshot.headSeq;

    // The fixture emits a two-entry `config_option_update` inside every turn. A reader that
    // consumed it would show the same 4 -> 2 shrink the METHOD produces.
    await worker.prompt("hello");

    const envelopes = await readEnvelopes(r.url, r.token, worker.id, {
      since: before,
      quietMs: scaled(200),
      timeoutMs: scaled(10_000),
    });
    const updates = configUpdates(envelopes);
    expect(updates).toHaveLength(1);
    expect((updates[0]?.payload as { _meta?: unknown })._meta).toBeUndefined();

    const snapshot = await (await curl(r.url, r.token)(`/v1/workers/${worker.id}`)).json();
    expect(
      ((snapshot as { configOptions?: { id: string }[] }).configOptions ?? []).map((o) => o.id),
    ).toEqual(FOUR);
  });

  it("`stale: true` KEEPS the previous list when the method returns none, and reports no churn", async () => {
    const r = await start({ spellings: ["session/set_config_option"] });
    const server = await r.connect(CLIENT_ID);
    const worker = await server.createAgent("cfg", { cwd: r.cwd });

    const res = await post(r, worker.id, { configId: "mode", value: "no-list" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SetConfigResponse;

    expect(body.stale).toBe(true);
    expect(body.configOptions.map((o) => o.id)).toEqual(FOUR);
    expect(body.removed).toEqual([]);
    expect(body.added).toEqual([]);
    expect(idsOf(await server.attach(worker.id))).toEqual(FOUR);
  });
});

describe("config option (M2-A, H24) — the status table end to end (§22.2)", () => {
  it("409 while a turn is live, and nothing reached the agent", async () => {
    const r = await start({
      spellings: ["session/set_config_option"],
      env: { CFG_NEVER_ANSWER: "1" },
    });
    const server = await r.connect(CLIENT_ID);
    const worker = await server.createAgent("cfg", { cwd: r.cwd });

    // `prompt()` is not awaited: this fixture never answers `session/prompt` under
    // `CFG_NEVER_ANSWER`, which is precisely the live turn the gate is about.
    void worker.prompt("hello").catch(() => undefined);
    const running = await until(
      async () =>
        (
          (await (await curl(r.url, r.token)(`/v1/workers/${worker.id}`)).json()) as {
            state: string;
          }
        ).state === "running",
      scaled(10_000),
      25,
    );
    expect(running).toBe(true);

    const res = await post(r, worker.id, { configId: "model", value: "haiku" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("worker_busy");

    await worker.cancel().catch(() => undefined);
  });

  it("423 without the lease, and 200 for the holder — the same request, two clients", async () => {
    const r = await start({ spellings: ["session/set_config_option"] });
    const holder = await r.connect(CLIENT_ID);
    const observer = await r.connect("cli_observer");
    const worker = await holder.createAgent("cfg", { cwd: r.cwd });

    const attached = await observer.attach(worker.id);
    await expect(attached.setConfig("model", "haiku")).rejects.toMatchObject({
      code: "lease_held",
      status: 423,
    });
    // Nothing moved for the loser…
    expect(idsOf(await holder.attach(worker.id))).toEqual(FOUR);
    // …and the holder's identical call succeeds.
    await expect(worker.setConfig("model", "haiku")).resolves.toHaveLength(2);
  });

  it("a bad value is 502 carrying the agent's -32603 and its data.details verbatim (F44)", async () => {
    const r = await start({ spellings: ["session/set_config_option"] });
    const server = await r.connect(CLIENT_ID);
    const worker = await server.createAgent("cfg", { cwd: r.cwd });

    const res = await post(r, worker.id, { configId: "model", value: "no-such-model-xyz" });

    expect(res.status).toBe(502);
    const body = (await res.json()) as { code: string; acp: { code: number; data: unknown } };
    expect(body.code).toBe("agent_error");
    expect(body.acp.code).toBe(-32603);
    expect(body.acp.data).toEqual({
      details: "Invalid value for config option model: no-such-model-xyz",
    });
    // A refused value changes nothing.
    expect(idsOf(await server.attach(worker.id))).toEqual(FOUR);
  });

  it("an agent whose descriptor advertises NO spelling is 502 carrying -32601 (D29)", async () => {
    // No `runtime` overlay ⇒ the generic v1 profile, whose `setConfig.spellings` is `[]`.
    const r = await start();
    const server = await r.connect(CLIENT_ID);
    const worker = await server.createAgent("cfg", { cwd: r.cwd });

    const res = await post(r, worker.id, { configId: "model", value: "haiku" });

    expect(res.status).toBe(502);
    const body = (await res.json()) as { code: string; acp: { code: number } };
    expect(body.code).toBe("agent_error");
    expect(body.acp.code).toBe(-32601);
  });

  it("400 on a body the route cannot parse, before any of it reaches a worker", async () => {
    const r = await start({ spellings: ["session/set_config_option"] });
    const server = await r.connect(CLIENT_ID);
    const worker = await server.createAgent("cfg", { cwd: r.cwd });

    for (const body of [
      { value: "haiku" },
      { configId: "model" },
      { configId: "model", value: {} },
    ]) {
      const res = await post(r, worker.id, body);
      expect(res.status).toBe(400);
    }
    expect(idsOf(await server.attach(worker.id))).toEqual(FOUR);
  });
});

describe("config option (M2-A, H24) — the hibernate / wake round trip (§22.2)", () => {
  it("auto-wakes a hibernated worker and RE-SEEDS the catalogue from the resume body", async () => {
    const r = await start({ spellings: ["session/set_config_option"] });
    const server = await r.connect(CLIENT_ID);
    const worker = await server.createAgent("cfg", { cwd: r.cwd });
    expect(idsOf(worker)).toEqual(FOUR);

    const asleep = await worker.hibernate();
    expect(asleep.state).toBe("hibernated");

    // The set auto-wakes exactly as `prompt` does — and the WOKEN process answers
    // `session/resume` with a THIRD catalogue, which is what "a resumed session may report a
    // different one" means on the wire.
    const res = await post(r, worker.id, { configId: "mode", value: "no-list" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SetConfigResponse;

    expect(body.stale).toBe(true);
    // Re-seeded BEFORE the set, so the KEPT list is the RESUMED one and not the pre-sleep one.
    expect(body.configOptions.map((o) => o.id)).toEqual(RESUMED);

    const after = await server.attach(worker.id);
    expect(after.state).toBe("ready");
    expect(idsOf(after)).toEqual(RESUMED);
  });

  it("the SDK's `worker.config` moves with the promise and survives a wake", async () => {
    const r = await start({ spellings: ["session/set_config_option"] });
    const server = await r.connect(CLIENT_ID);
    const worker = await server.createAgent("cfg", { cwd: r.cwd });

    expect((worker.config ?? []).map((o) => o.id)).toEqual(FOUR);

    const returned = await worker.setConfig("model", "haiku");
    expect(returned.map((o) => o.id)).toEqual(TWO);
    // SYNCHRONOUS with the resolution — no notification wait (§22.2's SDK row).
    expect((worker.config ?? []).map((o) => o.id)).toEqual(TWO);

    // A failed set leaves it exactly where it was.
    await expect(worker.setConfig("model", "no-such-model-xyz")).rejects.toMatchObject({
      code: "agent_error",
    });
    expect((worker.config ?? []).map((o) => o.id)).toEqual(TWO);

    // A fresh handle re-reads the daemon's live list rather than this handle's cache.
    expect(idsOf(await server.attach(worker.id))).toEqual(TWO);
  });
});
