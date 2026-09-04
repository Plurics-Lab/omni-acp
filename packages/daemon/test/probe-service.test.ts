import { readdir } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DaemonConfig,
  OmniError,
  type AuthContext,
  type ProbeSummary,
  type ResolvedDaemonConfig,
} from "@omni-acp/protocol";
import { fakeSupervisor, nullLogger, type FakeSupervisor } from "@omni-acp/testkit";
import { createCatalog } from "../src/catalog.js";
import { systemClock } from "../src/clock.js";
import { createProbeCache } from "../src/probe-cache.js";
import { createProbeService, type ProbeService } from "../src/probe-service.js";
import { asScriptedAgent, probeFixtureAgent } from "./probe-agent.js";

const clock = systemClock();

/** An `AuthContext` that permits everything, or exactly the agents named. */
function auth(agents: readonly string[] | "*" = "*"): AuthContext {
  return {
    tokenId: "t",
    role: "user",
    clientId: null,
    leaseEpoch: null,
    agents,
    cwdRoots: [],
    maxWorkers: 8,
    assertAgent(agentId: string): void {
      if (agents === "*") return;
      if (!agents.includes(agentId)) {
        throw new OmniError("forbidden", `token may not use agent "${agentId}"`);
      }
    },
    assertCwd: (cwd: string) => Promise.resolve(cwd),
    canSee: () => true,
    asClientRef: () => ({ tokenId: "t", clientId: null }),
  } as AuthContext;
}

interface Fixture {
  readonly service: ProbeService;
  readonly supervisor: FakeSupervisor;
  readonly dataDir: string;
  readonly config: ResolvedDaemonConfig;
  /** Enqueue N more fixture agents, so a second probe has a process to talk to. */
  enqueue(n?: number): void;
  readonly agents: readonly ReturnType<typeof probeFixtureAgent>[];
}

async function fixture(o?: {
  agents?: unknown[];
  probe?: Record<string, unknown>;
  dataDir?: string;
}): Promise<Fixture> {
  const dataDir = o?.dataDir ?? (await mkdtemp(join(tmpdir(), "omni-probe-svc-")));
  const config = DaemonConfig.parse({
    dataDir,
    tokens: [{ id: "t", secretSha256: "a".repeat(64) }],
    agents: o?.agents ?? [
      { id: "claude", command: process.execPath, args: ["-e", "0"] },
      { id: "other", command: process.execPath, args: ["-e", "1"] },
    ],
    ...(o?.probe === undefined ? {} : { probe: o.probe }),
  } as Parameters<typeof DaemonConfig.parse>[0]) as ResolvedDaemonConfig;

  const supervisor = fakeSupervisor();
  const created: ReturnType<typeof probeFixtureAgent>[] = [];
  const enqueue = (n = 1): void => {
    for (let i = 0; i < n; i += 1) {
      const a = probeFixtureAgent();
      created.push(a);
      supervisor.enqueue(asScriptedAgent(a));
    }
  };
  enqueue(4);

  let service: ProbeService | null = null;
  const catalog = createCatalog(config, {
    hooks: {
      cached: (id) => service?.cached(id) ?? null,
      run: (id, body, a) => service!.probe(id, body, a),
    },
  });
  service = createProbeService({
    config,
    catalog,
    supervisor,
    cache: createProbeCache({ dataDir, logger: nullLogger() }),
    clock,
    logger: nullLogger(),
  });

  return {
    service: service as ProbeService,
    supervisor,
    dataDir,
    config,
    enqueue,
    agents: created,
  };
}

/**
 * WP-E acceptance 2 and 3, minus the HTTP half (`test/http/probe.test.ts`): one process, a
 * shared in-flight probe, an ACL that fires before anything spawns, and a cache keyed by the
 * descriptor fingerprint.
 */
describe("ProbeService — one throwaway process (§17.4, H16)", () => {
  it("spawns EXACTLY ONE process and returns a ProbeSummary", async () => {
    const f = await fixture();
    const { probe, cached } = await f.service.probe("claude", {}, auth());
    expect(f.supervisor.spawnCalls).toHaveLength(1);
    expect(cached).toBe(false);
    expect(probe.agentId).toBe("claude");
    expect(probe.protocolVersion).toBe(1);
    expect(probe.resumeMethod).toBe("session/resume");
  });

  it("reclaims the tree — a probe leaves nothing running", async () => {
    const f = await fixture();
    await f.service.probe("claude", {}, auth());
    expect(f.supervisor.allTreesReclaimed()).toBe(true);
    expect(f.supervisor.live.size).toBe(0);
  });

  it("leaves no temp directory behind", async () => {
    const before = (await readdir(tmpdir())).filter((e) => e.startsWith("omni-probe-claude"));
    const f = await fixture();
    await f.service.probe("claude", {}, auth());
    const after = (await readdir(tmpdir())).filter((e) => e.startsWith("omni-probe-claude"));
    expect(after).toEqual(before);
  });

  it("403s a forbidden agent BEFORE any process exists", async () => {
    const f = await fixture();
    await expect(f.service.probe("claude", {}, auth(["other"]))).rejects.toMatchObject({
      code: "forbidden",
    });
    // The whole point of ordering the ACL first: nothing was launched.
    expect(f.supervisor.spawnCalls).toHaveLength(0);
  });

  it("403s BEFORE the catalog, so a forbidden token learns nothing about what is configured", async () => {
    const f = await fixture();
    // "nope" is not a configured agent either. A `bad_request` here would tell a token that may
    // not use ANY agent which ids exist on this machine.
    await expect(f.service.probe("nope", {}, auth([]))).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("an unknown agent an allowed token asks for is bad_request, not a 500 (D29)", async () => {
    const f = await fixture();
    await expect(f.service.probe("nope", {}, auth())).rejects.toMatchObject({
      code: "bad_request",
    });
    expect(f.supervisor.spawnCalls).toHaveLength(0);
  });

  it("CONCURRENT probes of one agent share ONE process (§17.4 rule 6)", async () => {
    const f = await fixture();
    const [a, b, c] = await Promise.all([
      f.service.probe("claude", {}, auth()),
      f.service.probe("claude", {}, auth()),
      f.service.probe("claude", {}, auth()),
    ]);
    expect(f.supervisor.spawnCalls).toHaveLength(1);
    // The same summary object, not three equal ones: they shared one in-flight promise.
    expect(a.probe).toBe(b.probe);
    expect(b.probe).toBe(c.probe);
  });

  it("concurrent probes of DIFFERENT agents do not share a process", async () => {
    const f = await fixture();
    await Promise.all([
      f.service.probe("claude", {}, auth()),
      f.service.probe("other", {}, auth()),
    ]);
    expect(f.supervisor.spawnCalls).toHaveLength(2);
  });

  it("respects `probe.maxConcurrent`: two agents, a limit of 1, never overlap", async () => {
    const f = await fixture({ probe: { maxConcurrent: 1 } });
    let peak = 0;
    const watch = setInterval(() => {
      peak = Math.max(peak, f.supervisor.live.size);
    }, 1);
    await Promise.all([
      f.service.probe("claude", {}, auth()),
      f.service.probe("other", {}, auth()),
    ]);
    clearInterval(watch);
    expect(peak).toBeLessThanOrEqual(1);
  });
});

describe("ProbeService — the cache (acceptance 3)", () => {
  it("`cached: true` on the second call, with no second process", async () => {
    const f = await fixture();
    const first = await f.service.probe("claude", {}, auth());
    const second = await f.service.probe("claude", {}, auth());
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.probe).toEqual(first.probe);
    expect(f.supervisor.spawnCalls).toHaveLength(1);
  });

  it("round-trips through <dataDir>/probes/<id>.json — a NEW service reads it back", async () => {
    const f = await fixture();
    const first = await f.service.probe("claude", {}, auth());

    // A second service over the same data dir is what a daemon restart looks like.
    const restarted = await fixture({ dataDir: f.dataDir });
    const second = await restarted.service.probe("claude", {}, auth());
    expect(second.cached).toBe(true);
    expect(second.probe).toEqual(first.probe);
    expect(restarted.supervisor.spawnCalls).toHaveLength(0);
  });

  it("a FINGERPRINT change invalidates it — the cached claim is about a program that moved", async () => {
    const f = await fixture();
    await f.service.probe("claude", {}, auth());

    // Same agent id, different argv: the cached capabilities describe a different launch.
    const moved = await fixture({
      dataDir: f.dataDir,
      agents: [{ id: "claude", command: process.execPath, args: ["-e", "999"] }],
    });
    const after = await moved.service.probe("claude", {}, auth());
    expect(after.cached).toBe(false);
    expect(moved.supervisor.spawnCalls).toHaveLength(1);
  });

  it("`force: true` re-probes even with a valid cache", async () => {
    const f = await fixture();
    await f.service.probe("claude", {}, auth());
    const forced = await f.service.probe("claude", { force: true }, auth());
    expect(forced.cached).toBe(false);
    expect(f.supervisor.spawnCalls).toHaveLength(2);
  });

  it("`ttlHours` expiry re-probes: a capability table is not believed forever", async () => {
    const f = await fixture({ probe: { ttlHours: 1 } });
    const first = await f.service.probe("claude", {}, auth());

    // Rewrite the cache entry with an `at` from two hours ago, keeping its fingerprint valid.
    const cache = createProbeCache({ dataDir: f.dataDir });
    const stale: ProbeSummary = {
      ...first.probe,
      at: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    };
    await cache.write("claude", stale);

    const restarted = await fixture({ dataDir: f.dataDir, probe: { ttlHours: 1 } });
    expect((await restarted.service.probe("claude", {}, auth())).cached).toBe(false);
  });

  it("serves `cached()` to the catalog, so GET /v1/agents shows `probed` without re-probing", async () => {
    const f = await fixture();
    expect(f.service.cached("claude")).toBeNull();
    await f.service.probe("claude", {}, auth());
    expect(f.service.cached("claude")?.agentId).toBe("claude");
    expect(f.service.cached("other")).toBeNull();
  });
});

describe("ProbeService — warmup (`probe.onStart`)", () => {
  it('"never" does nothing at all', async () => {
    const f = await fixture({ probe: { onStart: "never" } });
    await f.service.warmup();
    expect(f.supervisor.spawnCalls).toHaveLength(0);
    expect(f.service.cached("claude")).toBeNull();
  });

  it('"cached" LOADS the cache and spawns nothing — a daemon start costs no npx', async () => {
    const seeded = await fixture();
    await seeded.service.probe("claude", {}, auth());

    const restarted = await fixture({ dataDir: seeded.dataDir, probe: { onStart: "cached" } });
    await restarted.service.warmup();
    expect(restarted.supervisor.spawnCalls).toHaveLength(0);
    expect(restarted.service.cached("claude")?.agentId).toBe("claude");
  });

  it('"cached" drops a STALE entry rather than serving it', async () => {
    const seeded = await fixture();
    await seeded.service.probe("claude", {}, auth());

    const moved = await fixture({
      dataDir: seeded.dataDir,
      probe: { onStart: "cached" },
      agents: [{ id: "claude", command: process.execPath, args: ["-e", "moved"] }],
    });
    await moved.service.warmup();
    expect(moved.service.cached("claude")).toBeNull();
    expect(moved.supervisor.spawnCalls).toHaveLength(0);
  });

  it('"always" probes every configured agent', async () => {
    const f = await fixture({ probe: { onStart: "always" } });
    await f.service.warmup();
    expect(f.supervisor.spawnCalls).toHaveLength(2);
    expect(f.service.cached("claude")).not.toBeNull();
    expect(f.service.cached("other")).not.toBeNull();
  });

  it('"always" survives one broken agent: the daemon still starts, the gap is honest', async () => {
    const supervisorFailsFirst = await fixture({ probe: { onStart: "always" } });
    // Drain the queue and enqueue a failure for the FIRST spawn only.
    const broken = fakeSupervisor();
    broken.enqueue({ failWith: new Error("ENOENT: no such agent") });
    broken.enqueue(asScriptedAgent(probeFixtureAgent()));
    const config = supervisorFailsFirst.config;
    let service: ProbeService | null = null;
    const catalog = createCatalog(config, {
      hooks: {
        cached: (id) => service?.cached(id) ?? null,
        run: (id, body, a) => service!.probe(id, body, a),
      },
    });
    service = createProbeService({
      config,
      catalog,
      supervisor: broken,
      cache: createProbeCache({ dataDir: supervisorFailsFirst.dataDir, logger: nullLogger() }),
      clock,
      logger: nullLogger(),
    });

    await expect(service!.warmup()).resolves.toBeUndefined();
    // `probed: null` is the honest "we do not know", never a fabricated summary (H4).
    expect(service!.cached("claude")).toBeNull();
    expect(service!.cached("other")).not.toBeNull();
  });

  it("a per-agent `probe.onStart` overrides the daemon-wide one", async () => {
    const f = await fixture({
      probe: { onStart: "always" },
      agents: [
        { id: "claude", command: process.execPath, args: ["-e", "0"] },
        { id: "other", command: process.execPath, args: ["-e", "1"], probe: { onStart: "never" } },
      ],
    });
    await f.service.warmup();
    expect(f.supervisor.spawnCalls).toHaveLength(1);
    expect(f.service.cached("other")).toBeNull();
  });
});

describe("ProbeService — per-request and per-agent config", () => {
  it("a per-request `deep:false` stops after initialize", async () => {
    const f = await fixture();
    const { probe } = await f.service.probe("claude", { deep: false }, auth());
    expect(f.agents[0]?.seen).toEqual(["initialize"]);
    expect(probe.supportedMethods).toEqual([]);
  });

  it("a per-agent `deep:false` does the same without a per-request flag", async () => {
    const f = await fixture({
      agents: [
        { id: "claude", command: process.execPath, args: ["-e", "0"], probe: { deep: false } },
      ],
    });
    await f.service.probe("claude", {}, auth());
    expect(f.agents[0]?.seen).toEqual(["initialize"]);
  });

  it("a per-request `timeoutMs` bounds the probe", async () => {
    const supervisor = fakeSupervisor();
    supervisor.enqueue(asScriptedAgent(probeFixtureAgent({ hangOn: "initialize" })));
    const dataDir = await mkdtemp(join(tmpdir(), "omni-probe-svc-"));
    const config = DaemonConfig.parse({
      dataDir,
      tokens: [{ id: "t", secretSha256: "a".repeat(64) }],
      agents: [{ id: "claude", command: process.execPath, args: ["-e", "0"] }],
    } as Parameters<typeof DaemonConfig.parse>[0]) as ResolvedDaemonConfig;
    let service: ProbeService | null = null;
    const catalog = createCatalog(config, {
      hooks: {
        cached: (id) => service?.cached(id) ?? null,
        run: (id, body, a) => service!.probe(id, body, a),
      },
    });
    service = createProbeService({
      config,
      catalog,
      supervisor,
      cache: createProbeCache({ dataDir, logger: nullLogger() }),
      clock,
      logger: nullLogger(),
    });

    await expect(service!.probe("claude", { timeoutMs: 1_000 }, auth())).rejects.toMatchObject({
      code: "agent_timeout",
    });
    expect(supervisor.allTreesReclaimed()).toBe(true);
  });
});
