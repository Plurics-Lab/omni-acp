import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { HEADER, type AgentListResponse, type ProbeResponse } from "@omni-acp/protocol";
import { fakeSupervisor, nullLogger, seqIds, type FakeSupervisor } from "@omni-acp/testkit";
import { createDaemon } from "../../src/create-daemon.js";
import type { Daemon } from "../../src/types.js";
import { asScriptedAgent, probeFixtureAgent } from "../probe-agent.js";

vi.mock("@omni-acp/core", async (importOriginal) => {
  const { fakeCoreModule } = await import("./../fake-core.js");
  return await fakeCoreModule(importOriginal as never);
});

const ADMIN = "the-only-valid-secret-0123456789";
const LOW = "another-perfectly-fine-secret-01";

/**
 * H16, end to end: `POST /v1/agents/{id}/probe`.
 *
 * Driven through `daemon.fetch(new Request(...))` — zero `listen`, zero ports — so the suite
 * exercises the entry point a caller actually uses.
 */
async function build(o?: { agents?: unknown[] }): Promise<{
  daemon: Daemon;
  supervisor: FakeSupervisor;
  dataDir: string;
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "omni-http-probe-")));
  const dataDir = join(root, "data");
  const supervisor = fakeSupervisor();
  for (let i = 0; i < 4; i += 1) supervisor.enqueue(asScriptedAgent(probeFixtureAgent()));

  const daemon = await createDaemon(
    {
      dataDir,
      listen: null,
      tokens: [
        { id: "admin", secret: ADMIN, role: "admin", cwdRoots: [root] },
        // Lowest privilege: may use NO agent at all, but may still read `GET /v1/agents`.
        { id: "low", secret: LOW, role: "user", agents: [], cwdRoots: [root] },
      ],
      agents: o?.agents ?? [
        {
          id: "claude",
          command: process.execPath,
          args: ["--api-key", "sk-ant-SUPER-SECRET", "-e", "0"],
        },
      ],
      logLevel: "silent",
    },
    { supervisor, ids: seqIds(), logger: nullLogger() },
  );
  return { daemon, supervisor, dataDir };
}

const post = (daemon: Daemon, path: string, secret: string, body?: unknown): Promise<Response> =>
  daemon.fetch(
    new Request(`http://daemon.invalid${path}`, {
      method: "POST",
      headers: {
        [HEADER.auth]: `Bearer ${secret}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

const get = (daemon: Daemon, path: string, secret: string): Promise<Response> =>
  daemon.fetch(
    new Request(`http://daemon.invalid${path}`, { headers: { [HEADER.auth]: `Bearer ${secret}` } }),
  );

describe("H16 POST /v1/agents/{id}/probe", () => {
  it("returns a ProbeSummary, and spawns exactly one process", async () => {
    const { daemon, supervisor } = await build();
    const res = await post(daemon, "/v1/agents/claude/probe", ADMIN);
    expect(res.status).toBe(200);

    const body = (await res.json()) as ProbeResponse;
    expect(body.cached).toBe(false);
    expect(body.probe.agentId).toBe("claude");
    expect(body.probe.protocolVersion).toBe(1);
    expect(body.probe.learnedParams["session/set_config_option"]).toBe("configId");
    expect(supervisor.spawnCalls).toHaveLength(1);
    expect(supervisor.allTreesReclaimed()).toBe(true);
    await daemon.stop();
  });

  it("`cached: true` on the second call, with no second process", async () => {
    const { daemon, supervisor } = await build();
    await post(daemon, "/v1/agents/claude/probe", ADMIN);
    const second = (await (
      await post(daemon, "/v1/agents/claude/probe", ADMIN)
    ).json()) as ProbeResponse;
    expect(second.cached).toBe(true);
    expect(supervisor.spawnCalls).toHaveLength(1);
    await daemon.stop();
  });

  it("`{force:true}` re-probes", async () => {
    const { daemon, supervisor } = await build();
    await post(daemon, "/v1/agents/claude/probe", ADMIN);
    const forced = (await (
      await post(daemon, "/v1/agents/claude/probe", ADMIN, { force: true })
    ).json()) as ProbeResponse;
    expect(forced.cached).toBe(false);
    expect(supervisor.spawnCalls).toHaveLength(2);
    await daemon.stop();
  });

  it("403s a forbidden agent BEFORE any process exists", async () => {
    const { daemon, supervisor } = await build();
    const res = await post(daemon, "/v1/agents/claude/probe", LOW);
    expect(res.status).toBe(403);
    expect(supervisor.spawnCalls).toHaveLength(0);
    await daemon.stop();
  });

  it("401s with no Authorization header, before the ACL and before the catalog", async () => {
    const { daemon, supervisor } = await build();
    const res = await daemon.fetch(
      new Request("http://daemon.invalid/v1/agents/claude/probe", { method: "POST" }),
    );
    expect(res.status).toBe(401);
    expect(supervisor.spawnCalls).toHaveLength(0);
    await daemon.stop();
  });

  it("400s an unknown agent id — a request parameter, not a new error code (D29)", async () => {
    const { daemon } = await build();
    const res = await post(daemon, "/v1/agents/nope/probe", ADMIN);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "bad_request" });
    await daemon.stop();
  });

  it("accepts a bare POST with NO body — every field of ProbeRequestBody is optional", async () => {
    const { daemon } = await build();
    expect((await post(daemon, "/v1/agents/claude/probe", ADMIN)).status).toBe(200);
    await daemon.stop();
  });

  it("400s an unknown body field, through the ONE error mapper (strictObject)", async () => {
    const { daemon } = await build();
    const res = await post(daemon, "/v1/agents/claude/probe", ADMIN, { forse: true });
    expect(res.status).toBe(400);
    await daemon.stop();
  });

  it("400s a body sent under the wrong content-type, never 500", async () => {
    const { daemon } = await build();
    const res = await daemon.fetch(
      new Request("http://daemon.invalid/v1/agents/claude/probe", {
        method: "POST",
        headers: { [HEADER.auth]: `Bearer ${ADMIN}`, "content-type": "text/plain" },
        body: JSON.stringify({ force: true }),
      }),
    );
    expect(res.status).toBe(400);
    await daemon.stop();
  });

  it("`{deep:false}` is honoured through the route", async () => {
    const { daemon } = await build();
    const body = (await (
      await post(daemon, "/v1/agents/claude/probe", ADMIN, { deep: false })
    ).json()) as ProbeResponse;
    expect(body.probe.supportedMethods).toEqual([]);
    await daemon.stop();
  });
});

describe("GET /v1/agents serves the probe result — with args STILL redacted (H4, acceptance 3)", () => {
  it("`probed` is null before, the summary after, and the api key never appears", async () => {
    const { daemon } = await build();

    const before = (await (await get(daemon, "/v1/agents", LOW)).json()) as AgentListResponse;
    expect(before.agents[0]?.probed).toBeNull();

    await post(daemon, "/v1/agents/claude/probe", ADMIN);

    // Read back as the LOWEST-privilege token: `GET /v1/agents` is readable by every bearer
    // token, including one that may not use this agent at all.
    const after = (await (await get(daemon, "/v1/agents", LOW)).json()) as AgentListResponse;
    const entry = after.agents[0];
    expect(entry?.probed?.agentId).toBe("claude");
    expect(entry?.args).toEqual(["--api-key", "<redacted>", "-e", "0"]);
    // Belt and braces on the BYTES: the probe result must not become the leak `catalog.ts` closed.
    expect(JSON.stringify(after)).not.toContain("sk-ant-SUPER-SECRET");
    await daemon.stop();
  });

  it("the runtimeId CHANGES once a probe has named the agent — a descriptor change is visible", async () => {
    const { daemon } = await build();
    const before = (await (await get(daemon, "/v1/agents", ADMIN)).json()) as AgentListResponse;
    await post(daemon, "/v1/agents/claude/probe", ADMIN);
    const after = (await (await get(daemon, "/v1/agents", ADMIN)).json()) as AgentListResponse;

    expect(before.agents[0]?.runtimeId).toMatch(/^claude@[0-9a-f]{12}$/);
    expect(after.agents[0]?.runtimeId).toMatch(/^claude@[0-9a-f]{12}$/);
    // §17.2: the fingerprint covers `agentInfo.name/version`, so learning them moves it.
    expect(after.agents[0]?.runtimeId).not.toBe(before.agents[0]?.runtimeId);
    await daemon.stop();
  });

  it("`probed` is never fabricated for an agent nobody probed", async () => {
    const { daemon } = await build({
      agents: [
        { id: "claude", command: process.execPath, args: ["-e", "0"] },
        { id: "other", command: process.execPath, args: ["-e", "1"] },
      ],
    });
    await post(daemon, "/v1/agents/claude/probe", ADMIN);
    const body = (await (await get(daemon, "/v1/agents", ADMIN)).json()) as AgentListResponse;
    expect(body.agents.find((a) => a.id === "claude")?.probed).not.toBeNull();
    expect(body.agents.find((a) => a.id === "other")?.probed).toBeNull();
    await daemon.stop();
  });

  it("the probe SHARPENS the descriptor: the resolved runtime becomes `merged`", async () => {
    const { daemon } = await build({
      agents: [
        // A config id the builtin claims, so `selectBuiltin` finds claude-acp with no probe.
        { id: "claude-acp", command: process.execPath, args: ["-e", "0"] },
      ],
    });
    expect(daemon.catalog.descriptor("claude-acp").source).toBe("builtin");
    await post(daemon, "/v1/agents/claude-acp/probe", ADMIN);
    const resolved = daemon.catalog.descriptor("claude-acp");
    expect(resolved.source).toBe("merged");
    expect(resolved.id).toBe("claude-acp");
    // The probe proved `session/set_config_option` and disproved `session/set_model`; the order
    // moves, and nothing is discarded (§17.3).
    expect(resolved.prefer["setConfig"]?.spellings).toContain("session/set_config_option");
    await daemon.stop();
  });
});
