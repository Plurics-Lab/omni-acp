import { readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  OmniError,
  ProbeConfig,
  type ResolvedProbeConfig,
  type SpawnSpec,
} from "@omni-acp/protocol";
import {
  fakeSupervisor,
  nullLogger,
  type FakeSupervisor,
  type ScriptedAgent,
} from "@omni-acp/testkit";
import { BUILTIN_RUNTIMES, DEFAULT_V1_PROFILE } from "../../src/runtime/known.js";
import { probeAgent } from "../../src/runtime/probe.js";
import { probeFixtureAgent, type ProbeFixtureOptions } from "./probe-agent.js";

const CLAUDE = BUILTIN_RUNTIMES[0]!.descriptor;

const SPEC: SpawnSpec = {
  command: process.execPath,
  args: ["--version"],
  cwd: tmpdir(),
  env: {},
  label: "claude",
};

const config = (o: Partial<ResolvedProbeConfig> = {}): ResolvedProbeConfig =>
  ProbeConfig.parse({ ...o });

/**
 * A real `Clock`. The probe's deadline is a real timer over a real event loop, and a fake clock
 * would make "the battery finished inside the budget" a statement about the fake.
 */
const clock = {
  now: () => Date.now(),
  iso: () => new Date().toISOString(),
  setTimer: (delayMs: number, fn: () => void) => {
    const handle = setTimeout(fn, delayMs);
    handle.unref?.();
    return { cancel: () => clearTimeout(handle) };
  },
};

/** Wire a probe fixture into `fakeSupervisor()`, which consumes `.stream` and `.die()`. */
function withAgent(o: ProbeFixtureOptions = {}): {
  supervisor: FakeSupervisor;
  agent: ReturnType<typeof probeFixtureAgent>;
} {
  const supervisor = fakeSupervisor();
  const agent = probeFixtureAgent(o);
  supervisor.enqueue(agent as unknown as ScriptedAgent);
  return { supervisor, agent };
}

const run = (
  supervisor: FakeSupervisor,
  o: { config?: ResolvedProbeConfig; signal?: AbortSignal; fingerprint?: string } = {},
) =>
  probeAgent({
    agentId: "claude",
    spec: SPEC,
    descriptor: CLAUDE,
    config: o.config ?? config(),
    supervisor,
    clock,
    logger: nullLogger(),
    ...(o.signal === undefined ? {} : { signal: o.signal }),
    ...(o.fingerprint === undefined ? {} : { fingerprint: o.fingerprint }),
  });

/** Temp directories this test could have leaked, by the prefix `probeAgent` uses. */
async function probeTempDirs(): Promise<string[]> {
  const entries = await readdir(tmpdir());
  return entries.filter((e) => e.startsWith("omni-probe-"));
}

describe("probeAgent — ONE throwaway process, ≈0 tokens (§17.4, corpus 08)", () => {
  it("spawns EXACTLY ONE process and learns the whole battery from it", async () => {
    const { supervisor, agent } = withAgent();
    const summary = await run(supervisor);

    expect(supervisor.spawnCalls).toHaveLength(1);
    expect(agent.seen).toEqual([
      "initialize",
      "session/new",
      "session/set_model",
      "session/set_options",
      "session/set_mode",
      "session/set_config_option",
      "session/list",
      "session/resume",
      "session/load",
      "session/close",
    ]);
    expect(summary.agentId).toBe("claude");
    expect(summary.protocolVersion).toBe(1);
  });

  it("NEVER sends session/prompt — that is the ≈0-token claim, made falsifiable", async () => {
    const { supervisor, agent } = withAgent();
    await run(supervisor);
    expect(agent.seen).not.toContain("session/prompt");
  });

  it("records the agentInfo and capability block verbatim, never reshaped", async () => {
    const { supervisor } = withAgent();
    const summary = await run(supervisor);
    expect(summary.agentInfo).toEqual({
      name: "@agentclientprotocol/claude-agent-acp",
      title: "Claude Agent",
      version: "0.73.0",
    });
    expect(summary.capabilities["loadSession"]).toBe(true);
    expect(summary.capabilities["sessionCapabilities"]).toEqual({
      close: {},
      list: {},
      resume: {},
    });
  });

  it("splits supported from unsupported the way corpus 08 did", async () => {
    const { supervisor } = withAgent();
    const summary = await run(supervisor);
    expect([...summary.unsupportedMethods].sort()).toEqual([
      "session/set_model",
      "session/set_options",
    ]);
    expect([...summary.supportedMethods].sort()).toEqual([
      "session/close",
      "session/list",
      "session/load",
      "session/resume",
      "session/set_config_option",
      "session/set_mode",
    ]);
  });

  it("LEARNS `configId` from -32602 data.configId._errors, end to end (§17.4, F17)", async () => {
    const { supervisor } = withAgent();
    const summary = await run(supervisor);
    expect(summary.learnedParams["session/set_config_option"]).toBe("configId");
  });

  it("keeps the control method out of BOTH lists — it is an instrument, not a capability", async () => {
    const { supervisor } = withAgent();
    const summary = await run(supervisor);
    for (const list of [summary.supportedMethods, summary.unsupportedMethods]) {
      expect(list).not.toContain("omni/definitely_unknown_method");
    }
  });

  it("resolves resumeMethod by the descriptor's preference order, from what it PROVED", async () => {
    const { supervisor } = withAgent();
    expect((await run(supervisor)).resumeMethod).toBe("session/resume");

    const second = withAgent({ notImplemented: ["session/resume"] });
    expect((await run(second.supervisor)).resumeMethod).toBe("session/load");

    const third = withAgent({ notImplemented: ["session/resume", "session/load"] });
    expect((await run(third.supervisor)).resumeMethod).toBeNull();
  });

  it("records per-method timings and a total", async () => {
    const { supervisor } = withAgent();
    const summary = await run(supervisor);
    expect(Object.keys(summary.timings)).toContain("initialize");
    expect(Object.keys(summary.timings)).toContain("session/set_config_option");
    expect(summary.timings["total"]).toBeGreaterThanOrEqual(0);
  });

  it("carries the fingerprint it was given, and the `unresolved` sentinel when given none", async () => {
    const withFingerprint = withAgent();
    expect(
      (await run(withFingerprint.supervisor, { fingerprint: "abc" })).descriptorFingerprint,
    ).toBe("abc");

    const without = withAgent();
    expect((await run(without.supervisor)).descriptorFingerprint).toBe("unresolved");
  });
});

describe("probeAgent — side-effect freedom (§17.4)", () => {
  it("sends `session/set_mode` WITHOUT a modeId, so a live implementation changes nothing", async () => {
    const { supervisor, agent } = withAgent();
    await run(supervisor);
    // The fixture answers -32602 for a missing modeId, which is what "the method exists" looks
    // like when you refuse to exercise it. Corpus 08 sent a real modeId; a probe must not.
    expect(agent.seen).toContain("session/set_mode");
  });

  it("sends `session/resume` WITHOUT a cwd, so it never triggers a full history replay", async () => {
    const { supervisor } = withAgent();
    const summary = await run(supervisor);
    // Existence is proven by the -32602, and no replay window was ever opened.
    expect(summary.supportedMethods).toContain("session/resume");
  });

  it("NEVER answers a permission request, and never grants one", async () => {
    const { supervisor, agent } = withAgent({ requestsPermission: true });
    await run(supervisor);
    // -32601: DESIGN §6.2's "do not leave the agent hanging", while granting nothing.
    await expect(agent.permissionOutcome).resolves.toEqual({ refusedWith: -32601 });
  });

  it("runs in a mkdtemp cwd, never the SpawnSpec's — a probe cannot mutate a workspace", async () => {
    const { supervisor } = withAgent();
    await run(supervisor);
    const spawned = supervisor.spawnCalls[0]!;
    expect(spawned.cwd).not.toBe(SPEC.cwd);
    expect(spawned.cwd.startsWith(tmpdir())).toBe(true);
  });

  it("uses the SAME mkdtemp for the process cwd and for session/new", async () => {
    const { supervisor } = withAgent();
    await run(supervisor);
    const cwd = supervisor.spawnCalls[0]!.cwd;
    // A `session/new` in a DIFFERENT directory is a session pointing at a path the probe never
    // owned, and §15's resume rules key on cwd.
    await expect(stat(cwd)).rejects.toThrow();
  });

  it("leaves NO temp directory behind, on success", async () => {
    const before = await probeTempDirs();
    const { supervisor } = withAgent();
    await run(supervisor);
    expect(await probeTempDirs()).toEqual(before);
  });

  it("leaves no temp directory behind when the probe FAILS", async () => {
    const before = await probeTempDirs();
    const supervisor = fakeSupervisor();
    supervisor.enqueue({ failWith: new Error("ENOENT: no such agent") });
    await expect(run(supervisor)).rejects.toThrow(/ENOENT/);
    expect(await probeTempDirs()).toEqual(before);
  });
});

describe("probeAgent — bounded, and it reclaims its tree on every edge (H5)", () => {
  it("reclaims the tree on success", async () => {
    const { supervisor } = withAgent();
    await run(supervisor);
    expect(supervisor.allTreesReclaimed()).toBe(true);
    expect(supervisor.live.size).toBe(0);
  });

  it("reclaims the tree when the deadline blows", async () => {
    const { supervisor } = withAgent({ hangOn: "session/list" });
    await expect(run(supervisor, { config: config({ timeoutMs: 1_000 }) })).rejects.toThrow(
      /probe exceeded/,
    );
    expect(supervisor.allTreesReclaimed()).toBe(true);
  });

  it("a blown deadline is agent_timeout (504), not an internal error", async () => {
    const { supervisor } = withAgent({ hangOn: "initialize" });
    try {
      await run(supervisor, { config: config({ timeoutMs: 1_000 }) });
      expect.unreachable();
    } catch (e) {
      expect(OmniError.is(e, "agent_timeout")).toBe(true);
    }
  });

  it("honours an AbortSignal, and reclaims the tree", async () => {
    const controller = new AbortController();
    const { supervisor } = withAgent({ hangOn: "session/new" });
    const pending = run(supervisor, { signal: controller.signal });
    // The spawn has to have happened before the abort, or this proves nothing about reclamation.
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/);
    expect(supervisor.allTreesReclaimed()).toBe(true);
  });

  it("an already-aborted signal fails before any battery call is sent", async () => {
    const { supervisor, agent } = withAgent();
    await expect(run(supervisor, { signal: AbortSignal.abort() })).rejects.toThrow(/aborted/);
    expect(agent.seen).toEqual([]);
  });

  it("leaves no temp directory behind after a blown deadline", async () => {
    const before = await probeTempDirs();
    const { supervisor } = withAgent({ hangOn: "session/close" });
    await expect(run(supervisor, { config: config({ timeoutMs: 500 }) })).rejects.toThrow();
    expect(await probeTempDirs()).toEqual(before);
  });
});

describe("probeAgent — `deep: false`, and the battery it cannot run", () => {
  it("stops after `initialize` and reports every battery row as SKIPPED, not absent", async () => {
    const { supervisor, agent } = withAgent();
    const summary = await run(supervisor, { config: config({ deep: false }) });
    expect(agent.seen).toEqual(["initialize"]);
    expect(summary.supportedMethods).toEqual([]);
    expect(summary.unsupportedMethods).toEqual([]);
    expect(summary.resumeMethod).toBeNull();
    // Still a real observation about the process: the version and the capability block.
    expect(summary.protocolVersion).toBe(1);
    expect(summary.agentInfo).not.toBeNull();
  });

  it("a session/new that returns no sessionId skips the battery instead of guessing", async () => {
    const { supervisor, agent } = withAgent({ sessionNewReturnsNothing: true });
    const summary = await run(supervisor);
    expect(agent.seen).toEqual(["initialize", "session/new"]);
    expect(summary.supportedMethods).toEqual([]);
  });
});

describe("probeAgent — an agent that talks while being probed", () => {
  it("ignores unprompted session/update notifications (corpus 08 saw three mid-battery)", async () => {
    const { supervisor } = withAgent({ chatter: 3 });
    const summary = await run(supervisor);
    expect(summary.supportedMethods).toContain("session/list");
  });

  it("a non-v1 protocolVersion is reported honestly rather than normalised away", async () => {
    const { supervisor } = withAgent({ protocolVersion: 2 });
    expect((await run(supervisor)).protocolVersion).toBe(2);
  });
});

describe("probeAgent — it is not a spawn back door (F10)", () => {
  it("goes through Supervisor.spawn with the SpawnSpec the Catalog produced", async () => {
    const { supervisor } = withAgent();
    await run(supervisor);
    const spawned = supervisor.spawnCalls[0]!;
    expect(spawned.command).toBe(SPEC.command);
    expect(spawned.args).toEqual(SPEC.args);
    expect(spawned.label).toBe("claude");
    // Only the cwd is replaced, and that replacement is the §17.4 guarantee.
    expect(spawned.cwd).not.toBe(SPEC.cwd);
  });

  it("a spawn failure surfaces as-is, so §6.3's Windows `.cmd` message reaches the caller", async () => {
    const supervisor = fakeSupervisor();
    supervisor.enqueue({
      failWith: new OmniError(
        "bad_request",
        'refusing to launch the .cmd shim "npx"; use process.execPath <module>',
      ),
    });
    await expect(run(supervisor)).rejects.toThrow(/process\.execPath <module>/);
  });

  it("works with the zero-quirk DEFAULT profile, which knows no resume spellings", async () => {
    const { supervisor } = withAgent();
    const summary = await probeAgent({
      agentId: "unknown-agent",
      spec: SPEC,
      descriptor: DEFAULT_V1_PROFILE,
      config: config(),
      supervisor,
      clock,
      logger: nullLogger(),
    });
    // The battery still tries both known resume spellings: "the descriptor did not say" is not
    // evidence that the agent cannot.
    expect(summary.resumeMethod).toBe("session/resume");
  });
});
