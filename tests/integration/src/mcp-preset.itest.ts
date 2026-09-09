import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_V1_PROFILE,
  alwaysGrantedLease,
  resolveWorkerEnv,
  createBaselineResponder,
  createMemoryEventLog,
  createNormalizer,
  createSessionStrategy,
  createSupervisor,
  createWorker,
  type CreateWorkerDeps,
} from "@omni-acp/core";
import { resolveMcpForWorker } from "@omni-acp/daemon";
import { nullLogger, seqIds } from "@omni-acp/testkit";
import {
  AgentDescriptor,
  DaemonConfig,
  OmniError,
  type ClientRef,
  type Clock,
  type DaemonId,
  type EnvResolution,
  type McpResolution,
  type RuntimeDescriptor,
  type TokenId,
  type WorkerHandle,
  type WorkerId,
} from "@omni-acp/protocol";

/**
 * MCP presets end to end — the first time §12.3 row 22's `type` injection is exercised from the
 * wire, because M1 had no way to reach it (`mcpServers` was always `[]`, DESIGN §8).
 *
 * TIER 3: real processes, real ndJSON. The agent is
 * `packages/testkit/fixtures/mcp/wire-recorder.mjs`, which writes down every request it received,
 * so what `session/new` actually carried is read off the AGENT's record rather than off ours.
 *
 * The worker is built with `createWorker` and `resolveMcpForWorker` directly rather than through
 * `POST /v1/workers`, because `AuthContext.assertMcp` and the registry's creation path are
 * M2-WP-J's files and still carry their Land-step stubs. Everything either side of that wiring —
 * the resolution, the capability filter, the wire shape, the agent's record — is exercised here
 * exactly as it will be once the hunks in M2-B-WP-S's notes land.
 *
 * Owned by M2-B-WP-S.
 */

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "packages",
  "testkit",
  "fixtures",
  "mcp",
);
const RECORDER = join(FIXTURES, "wire-recorder.mjs");

const readFixture = async <T>(name: string): Promise<T> =>
  JSON.parse(await readFile(join(FIXTURES, name), "utf8")) as T;

const DAEMON_ID = "d_00000000000000000000000002" as DaemonId;
const OWNER: ClientRef = { tokenId: "tok_mcp" as TokenId, clientId: "cli_mcp" };

const clock: Clock = {
  now: () => Date.now(),
  iso: () => new Date().toISOString(),
  setTimer: (delayMs, fn) => {
    const timer = setTimeout(fn, delayMs);
    timer.unref?.();
    return { cancel: () => clearTimeout(timer) };
  },
};

/** `toleratesOmittedMcpCapabilities` is the ONLY thing that differs. No agent id anywhere. */
const TOLERANT: RuntimeDescriptor = {
  ...DEFAULT_V1_PROFILE,
  id: "tolerant-fixture",
  quirks: { ...DEFAULT_V1_PROFILE.quirks, toleratesOmittedMcpCapabilities: true },
};

/**
 * Two values a leak would carry VERBATIM: the operator's, injected through the descriptor, and
 * the client's, requested per worker. A hit on either is a hit and not a heuristic.
 */
const DESCRIPTOR_SECRET = "SENTINEL-DESCRIPTOR-VALUE-9d4f";
const REQUEST_SECRET = "SENTINEL-REQUEST-VALUE-0b17";

let config: ReturnType<typeof DaemonConfig.parse>;
let root: string;
let logDir: string;
let workers = 0;
const live: WorkerHandle[] = [];

interface Started {
  readonly worker: WorkerHandle;
  readonly resolution: McpResolution;
  /** The per-worker env this worker was composed with, `keys` and all (§23.3). */
  readonly env: EnvResolution;
  /** The `session/new` params this agent process actually received. */
  sessionNew(): Promise<Record<string, unknown>>;
}

async function start(o: {
  names?: readonly string[];
  allow?: readonly string[] | "*";
  /** The block this agent advertises. `undefined` ⇒ it declares none at all. */
  caps?: Record<string, unknown>;
  descriptor?: RuntimeDescriptor;
  /** Per-worker env the CLIENT asked for, resolved through `resolveWorkerEnv` (§23.3). */
  requestEnv?: Record<string, string>;
  envAllow?: readonly string[];
}): Promise<Started> {
  workers += 1;
  const logFile = join(logDir, `worker-${String(workers)}.jsonl`);
  const workerId = `w_0000000000000000000000000${String(workers)}` as WorkerId;

  // STEP 1 — names → resolved servers → capability filter. The client contributed only names.
  const resolution = resolveMcpForWorker({
    names: o.names,
    config,
    allow: o.allow ?? "*",
    descriptor: o.descriptor ?? DEFAULT_V1_PROFILE,
    caps: o.caps === undefined ? null : { mcpCapabilities: o.caps },
  });

  // The descriptor's own env — the daemon's injected credentials, in production — and then the
  // client's on top of it, through the one function that is allowed to compose the two.
  const descriptorEnv: Record<string, string> = {
    RECORDER_LOG: logFile,
    // The operator's half of DESIGN §5.1's layering — "daemon 密钥库注入的凭据" — stood in for by
    // a value a leak would carry verbatim. Every worker in this file gets it, so the grep case
    // below is asserting over the same environment every other case ran with.
    OMNI_FIXTURE_CREDENTIAL: DESCRIPTOR_SECRET,
    ...(o.caps === undefined ? {} : { RECORDER_MCP_CAPS: JSON.stringify(o.caps) }),
  };
  const env = resolveWorkerEnv({
    base: {},
    descriptor: descriptorEnv,
    request: o.requestEnv,
    extraDeny: config.envDeny,
    allow: o.envAllow ?? [],
    platform: process.platform,
  });

  const descriptor: AgentDescriptor = AgentDescriptor.parse({
    id: "wire-recorder",
    command: process.execPath,
    args: [RECORDER],
    env: env.env,
    protocolVersion: 1,
    shutdown: { signal: "SIGTERM", graceMs: 2_000 },
  });

  const deps: CreateWorkerDeps = {
    workerId,
    daemonId: DAEMON_ID,
    descriptor,
    cwd: root,
    label: null,
    owner: OWNER,
    supervisor: createSupervisor({ config: config.supervisor, clock, logger: nullLogger() }),
    log: createMemoryEventLog({
      workerId,
      daemonId: DAEMON_ID,
      clock,
      maxEvents: 500,
      subscriberQueueSize: 64,
    }),
    normalizer: createNormalizer({ quietMs: 200, hardMs: 10_000, cwd: root }),
    responder: createBaselineResponder("deny", clock),
    lease: alwaysGrantedLease(OWNER, workerId),
    session: createSessionStrategy({
      descriptor: o.descriptor ?? DEFAULT_V1_PROFILE,
      clock,
      logger: nullLogger(),
    }),
    runtime: o.descriptor ?? DEFAULT_V1_PROFILE,
    clock,
    ids: seqIds(),
    logger: nullLogger(),
    limits: {
      handshakeTimeoutMs: 30_000,
      cancelGraceMs: 5_000,
      exitGraceMs: 1_000,
      gracefulMs: 2_000,
    },
    // STEP 2 — the RESOLVED objects reach `session/new`. A `SessionStrategy` never sees a NAME,
    // and a client could not have put a command here if it tried: `CreateWorkerRequest.mcp` is
    // `string[]` (§23.1).
    mcpServers: resolution.servers,
  };

  const worker = await createWorker(deps);
  live.push(worker);

  return {
    worker,
    resolution,
    env,
    async sessionNew(): Promise<Record<string, unknown>> {
      const text = await readFile(logFile, "utf8").catch(() => "");
      const lines = text
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l) as { method: string; params: Record<string, unknown> });
      const call = lines.find((l) => l.method === "session/new");
      if (call === undefined) throw new Error("the agent recorded no session/new");
      return call.params;
    },
  };
}

function thrown(fn: () => unknown): OmniError {
  try {
    fn();
  } catch (e) {
    if (e instanceof OmniError) return e;
    throw new Error(`expected an OmniError, got ${String(e)}`, { cause: e });
  }
  throw new Error("expected a throw, got a return");
}

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "omni-mcp-it-root-")));
  logDir = await realpath(await mkdtemp(join(tmpdir(), "omni-mcp-it-log-")));
  const presets = await readFixture<{ mcpServers: Record<string, unknown> }>("presets.json");
  config = DaemonConfig.parse({
    tokens: [{ id: "t", secret: "mcp-it-secret-mcp-it-secret" }],
    mcpServers: presets.mcpServers,
  });
});

afterAll(async () => {
  for (const worker of live) await worker.close("client_request").catch(() => {});
  for (const dir of [root, logDir]) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe("mcp presets (M2-B, §23)", () => {
  it("a client names a preset and gets it; an unknown name is 400 naming it and a disallowed one is 403", async () => {
    const started = await start({ names: ["files", "memory"], allow: ["files", "memory"] });
    expect(started.worker.snapshot().state).toBe("ready");
    expect(started.resolution.applied).toEqual(["files", "memory"]);

    // Read off the AGENT's own record of what it received.
    const params = await started.sessionNew();
    expect(params["cwd"]).toBe(root);
    const servers = params["mcpServers"] as Record<string, unknown>[];
    expect(servers.map((s) => s["name"])).toEqual(["files", "memory"]);
    expect(servers[0]).toStrictEqual({
      name: "files",
      command: "omni-acp-fixture-mcp-files",
      args: ["--root", "."],
      env: [{ name: "MCP_FILES_MODE", value: "ro" }],
    });

    // The two error statuses, from the same seam a route will call.
    const unknown = thrown(() =>
      resolveMcpForWorker({
        names: ["files", "no-such-preset"],
        config,
        allow: "*",
        descriptor: DEFAULT_V1_PROFILE,
        caps: null,
      }),
    );
    expect(unknown.status).toBe(400);
    expect(unknown.message).toContain('"no-such-preset"');

    const disallowed = thrown(() =>
      resolveMcpForWorker({
        names: ["files"],
        config,
        allow: ["memory"],
        descriptor: DEFAULT_V1_PROFILE,
        caps: null,
      }),
    );
    expect(disallowed.status).toBe(403);
  }, 45_000);

  it("a preset the agent cannot take is reported as dropped on the snapshot with a TurnWarning, and the worker still starts", async () => {
    // An agent that advertises NEITHER remote transport, which is the shape §23.2's table calls
    // "a capability the client did not get" rather than "a request it got wrong".
    const started = await start({
      names: ["files", "search", "feed"],
      caps: { http: false, sse: false },
    });

    // The worker STARTED. That is the acceptance: not an error.
    expect(started.worker.snapshot().state).toBe("ready");
    expect(started.resolution.applied).toEqual(["files"]);
    expect(started.resolution.dropped).toEqual([
      { name: "search", reason: "the agent does not advertise mcpCapabilities.http" },
      { name: "feed", reason: "the agent does not advertise mcpCapabilities.sse" },
    ]);
    expect(started.resolution.warnings.map((w) => w.code)).toEqual([
      "mcp_preset_dropped",
      "mcp_preset_dropped",
    ]);

    // …and only the stdio one reached the agent.
    const servers = (await started.sessionNew())["mcpServers"] as Record<string, unknown>[];
    expect(servers.map((s) => s["name"])).toEqual(["files"]);
  }, 45_000);

  it("keeps an http preset for an agent whose RECORDED block advertises it", async () => {
    const recorded =
      await readFixture<Record<string, { mcpCapabilities: Record<string, unknown> } | undefined>>(
        "capabilities.json",
      );
    const codex = recorded["codex-acp-1.8.0"]?.mcpCapabilities;
    expect(codex).toStrictEqual({ acp: false, http: true, sse: false });

    const started = await start({ names: ["files", "search", "feed"], caps: codex });
    expect(started.resolution.applied).toEqual(["files", "search"]);
    const servers = (await started.sessionNew())["mcpServers"] as Record<string, unknown>[];
    expect(servers.map((s) => s["name"])).toEqual(["files", "search"]);
    // stdio is never filtered even though codex advertises no bit for it — the rule that is
    // easiest to get backwards, proven against the block codex actually sends.
    expect(servers[1]).toMatchObject({ type: "http", url: "https://mcp.example.invalid/search" });
  }, 45_000);

  it("decides the ABSENT block from the descriptor, on a real handshake, in both directions", async () => {
    // The recorder omits `mcpCapabilities` entirely when `RECORDER_MCP_CAPS` is unset, which is
    // the case DESIGN §6.2 describes: a runtime that does not declare the block and takes stdio
    // anyway.
    const strict = await start({ names: ["files", "search"] });
    expect((await strict.sessionNew())["mcpServers"]).toHaveLength(1);
    expect(strict.resolution.dropped[0]?.reason).toContain("declared no mcpCapabilities block");

    const tolerant = await start({ names: ["files", "search"], descriptor: TOLERANT });
    expect((await tolerant.sessionNew())["mcpServers"]).toHaveLength(2);
    expect(tolerant.resolution.dropped).toEqual([]);
  }, 45_000);

  it("§12.3 row 22: the stdio server we emit is UNTAGGED, and the map is what gives it a type", async () => {
    // M1 could not reach this row at all: `mcpServers` was always `[]`, so `typedMcpServer` ran
    // over an empty array on every call it ever made. This is the first composition of the two
    // halves — a resolved preset, and the map that tags it.
    const started = await start({ names: ["files", "search"], caps: { http: true, sse: true } });
    const emitted = (await started.sessionNew())["mcpServers"] as Record<string, unknown>[];

    // v1's `McpServer` is an `anyOf` whose stdio arm is UNTAGGED; http and sse REQUIRE the tag.
    expect(emitted[0]).not.toHaveProperty("type");
    expect(emitted[1]).toHaveProperty("type", "http");

    // Through the map, the untagged one acquires v2's tag — `command` ⇒ stdio — and the tagged
    // one is left exactly as it is.
    const normalizer = createNormalizer({ quietMs: 200, hardMs: 10_000 });
    const call = normalizer.mapRequest("session/new", { cwd: root, mcpServers: emitted });
    const mapped = (call.params["mcpServers"] as Record<string, unknown>[]) ?? [];
    expect(mapped[0]).toMatchObject({ type: "stdio", name: "files" });
    expect(mapped[1]).toMatchObject({ type: "http", name: "search" });

    // …and it is IDEMPOTENT, which is what lets the row run on a params object that already
    // carries the tag (§12.2).
    const twice = normalizer.mapRequest("session/new", { cwd: root, mcpServers: mapped });
    expect(twice.params["mcpServers"]).toStrictEqual(mapped);
  }, 45_000);

  it("a request that names no preset sends `mcpServers: []`, which is M1 byte for byte", async () => {
    const started = await start({});
    expect(started.resolution).toStrictEqual({
      servers: [],
      applied: [],
      dropped: [],
      warnings: [],
    });
    expect((await started.sessionNew())["mcpServers"]).toEqual([]);
  }, 45_000);
});

/**
 * WP-S acceptance 6, the grep half: "no env VALUE appears in any snapshot, log line or HTTP body
 * across a full create-prompt-close cycle" (DESIGN §8, §23.3).
 *
 * It lives in this file rather than one of its own because M2-B-WP-S owns exactly two integration
 * files and the other one is about content blocks — and because this and the MCP cases are the
 * same question asked twice: what did the daemon compose, and what escaped from it. The two
 * sentinels below are values a leak would carry verbatim, so a hit is a hit and not a heuristic.
 */
describe("per-worker env (M2-B, §23.3) — key names travel, values do not", () => {
  it("leaks no env VALUE into a snapshot, an envelope or a close result, across a full cycle", async () => {
    const started = await start({
      requestEnv: { FIXTURE_CLIENT_FLAG: REQUEST_SECRET },
      envAllow: ["FIXTURE_CLIENT_FLAG"],
    });
    const { worker } = started;

    // The client's key was ACCEPTED and its value reached the child's environment — otherwise
    // this test would prove only that we never composed anything.
    expect(started.env.keys).toEqual(["FIXTURE_CLIENT_FLAG"]);
    expect(started.env.env["FIXTURE_CLIENT_FLAG"]).toBe(REQUEST_SECRET);
    expect(started.env.persist).toBe(true);
    // KEY NAMES ONLY, which is what `WorkerSnapshot.envKeys` carries.
    expect(JSON.stringify(started.env.keys)).not.toContain("SENTINEL");

    // A FULL CYCLE: create (done), prompt, settle, close.
    const created = JSON.stringify(worker.snapshot());
    await worker.prompt([{ type: "text", text: "hello" }], OWNER);
    const deadline = Date.now() + 15_000;
    while (worker.snapshot().state !== "ready" && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    const running = JSON.stringify(worker.snapshot());
    const envelopes = JSON.stringify(worker.log.read(0));
    const closed = JSON.stringify(await worker.close("client_request"));

    for (const [where, text] of Object.entries({ created, running, envelopes, closed })) {
      // Both sentinels: the operator's descriptor value and the client's requested one. A leak
      // of either is the same bug, and the descriptor half is the one M1 already had.
      expect(text, where).not.toContain(REQUEST_SECRET);
      expect(text, where).not.toContain(DESCRIPTOR_SECRET);
      expect(text, where).not.toContain("SENTINEL");
    }

    // TWO POSITIVE CONTROLS, so "no sentinel" is the absence of a value from a body that has
    // bodies in it rather than the absence of a body:
    //   - the snapshot carries SPAWN material (the command), which is where an env value would
    //     ride if `ProcessInfo` ever grew one;
    //   - the log carries a whole turn.
    expect(created).toContain(JSON.stringify(process.execPath).slice(1, -1));
    expect(worker.log.read(0).length).toBeGreaterThan(3);
  }, 45_000);

  it("refuses a denied key, a key outside envAllow and a NUL value — before any process starts", async () => {
    const started = live.length;
    const refusals: Record<string, { requestEnv: Record<string, string>; envAllow: string[] }> = {
      "a hard-denied key": { requestEnv: { PATH: "/evil" }, envAllow: ["PATH"] },
      "a denied prefix": { requestEnv: { LD_PRELOAD: "/evil.so" }, envAllow: ["LD_PRELOAD"] },
      "a key outside envAllow": { requestEnv: { MY_FLAG: "1" }, envAllow: [] },
      "a NUL value": { requestEnv: { MY_FLAG: "a\0b" }, envAllow: ["MY_FLAG"] },
      "an overriding descriptor key": {
        requestEnv: { RECORDER_LOG: "/tmp/hijacked" },
        envAllow: ["RECORDER_LOG"],
      },
    };
    for (const [what, o] of Object.entries(refusals)) {
      const e = await start(o).then(
        () => null,
        (err: unknown) => err,
      );
      expect(e instanceof OmniError, what).toBe(true);
      expect((e as OmniError).status, what).toBeGreaterThanOrEqual(400);
      // NOTHING WAS SPAWNED. `resolveWorkerEnv` runs while the environment is being composed,
      // which is before `createWorker` — so a refused env costs no process, and `live` (every
      // worker this file has actually created) has not grown.
      expect(live.length, what).toBe(started);
    }
  }, 45_000);
});
