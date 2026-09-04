import { describe, expect, it } from "vitest";
import {
  AgentDescriptor,
  DaemonConfig,
  type ProbeSummary,
  type ResolvedDaemonConfig,
} from "@omni-acp/protocol";
import {
  BUILTIN_VERSION_WINDOWS,
  createCatalog,
  runtimeIdFor,
  selectBuiltin,
} from "../src/catalog.js";

const probed = (agentInfo: Record<string, unknown> | null, agentId = "a"): ProbeSummary => ({
  at: "2026-09-04T00:00:00.000Z",
  agentId,
  descriptorFingerprint: "f".repeat(64),
  protocolVersion: 1,
  agentInfo,
  capabilities: {},
  unsupportedMethods: [],
  supportedMethods: [],
  resumeMethod: null,
  learnedParams: {},
  timings: {},
});

/**
 * WP-E: builtin ⊕ config ⊕ probe's FIRST step — which builtin, if any, describes this agent
 * (§17.2). `resolveDescriptor` takes the builtin already chosen, and choosing it needs the
 * `AgentDescriptor` and the cached probe TOGETHER, which is the Agent Catalog's material.
 */
describe("selectBuiltin — claiming a builtin profile (§17.2)", () => {
  const agent = (o: Record<string, unknown>): AgentDescriptor =>
    AgentDescriptor.parse({ id: "a", command: "npx", args: [], ...o });

  it("matches on the config id an operator wrote", () => {
    expect(selectBuiltin(agent({ id: "claude-acp" }), null)?.id).toBe("claude-acp");
  });

  it("matches on the command basename — Windows's `.cmd` shim is the same program", () => {
    expect(selectBuiltin(agent({ command: "/usr/bin/claude-code-acp" }), null)?.id).toBe(
      "claude-acp",
    );
    expect(selectBuiltin(agent({ command: "C:\\bin\\claude-code-acp.cmd" }), null)?.id).toBe(
      "claude-acp",
    );
  });

  it("matches the npm specifier buried in argv, version suffix and all", () => {
    // The real invocation: `npx -y @agentclientprotocol/claude-agent-acp@0.73.0`.
    const d = agent({
      id: "my-coding-agent",
      command: "npx",
      args: ["-y", "@agentclientprotocol/claude-agent-acp@0.73.0"],
    });
    expect(selectBuiltin(d, null)?.id).toBe("claude-acp");
  });

  it("never mistakes a scope for a version suffix", () => {
    // `@scope/pkg@1.2.3` -> `@scope/pkg` plus its last segment. Never `` and never `scope/pkg@1`.
    const d = agent({ command: "npx", args: ["-y", "@zed-industries/claude-code-acp@1.0.0"] });
    expect(selectBuiltin(d, null)?.id).toBe("claude-acp");
  });

  it("matches on the agentInfo.name a probe learned — §17.2's `/^claude-(code|agent)-acp$/`", () => {
    // The real agent answers the SCOPED name; the regex is a match on the SEGMENT.
    const d = agent({ id: "anonymous", command: "/opt/bin/agent" });
    expect(selectBuiltin(d, null)).toBeNull();
    expect(
      selectBuiltin(d, probed({ name: "@agentclientprotocol/claude-agent-acp", version: "0.73.0" }))
        ?.id,
    ).toBe("claude-acp");
  });

  it("claims nothing for an agent it has never heard of — that is DEFAULT_V1_PROFILE's job", () => {
    expect(selectBuiltin(agent({ id: "gemini", command: "gemini-acp" }), null)).toBeNull();
  });

  it("never matches on a FLAG that happens to contain the name", () => {
    const d = agent({ command: "wrapper", args: ["--agent=claude-acp"] });
    expect(selectBuiltin(d, null)).toBeNull();
  });
});

describe("selectBuiltin — §17.2's version window `>=0.70.0 <1.0.0`", () => {
  const claude = (): AgentDescriptor =>
    AgentDescriptor.parse({ id: "claude-acp", command: "npx", args: [] });

  const at = (version: string): ProbeSummary =>
    probed({ name: "claude-agent-acp", version }, "claude-acp");

  it("records the window §17.2 states", () => {
    expect(BUILTIN_VERSION_WINDOWS["claude-acp"]).toEqual({ min: "0.70.0", ltMajor: 1 });
  });

  it("applies the profile inside the window", () => {
    for (const version of ["0.70.0", "0.73.0", "0.99.9"]) {
      expect(selectBuiltin(claude(), at(version))?.id).toBe("claude-acp");
    }
  });

  it("REFUSES the profile outside it — every quirk in the table is an observation of 0.7x", () => {
    for (const version of ["0.69.9", "1.0.0", "2.3.4"]) {
      expect(selectBuiltin(claude(), at(version))).toBeNull();
    }
  });

  it("applies it when no probe has told us a version — an unknown version is not a wrong one", () => {
    expect(selectBuiltin(claude(), null)?.id).toBe("claude-acp");
    expect(selectBuiltin(claude(), at("not-a-version"))?.id).toBe("claude-acp");
  });

  it("accepts a pre-release suffix rather than refusing over punctuation", () => {
    expect(selectBuiltin(claude(), at("0.73.0-beta.1"))?.id).toBe("claude-acp");
  });
});

describe("Catalog.descriptor — builtin ⊕ config ⊕ probe (§17.2)", () => {
  const withAgent = (a: Record<string, unknown>, probe?: ProbeSummary) =>
    createCatalog(
      DaemonConfig.parse({
        tokens: [{ id: "t", secretSha256: "a".repeat(64) }],
        agents: [a],
      } as Parameters<typeof DaemonConfig.parse>[0]) as ResolvedDaemonConfig,
      probe === undefined
        ? {}
        : {
            hooks: {
              cached: () => probe,
              run: () => Promise.reject(new Error("not used")),
            },
          },
    );

  it("NEVER throws — an agent it has never heard of falls back to the v1 profile (§5.4)", () => {
    const d = withAgent({ id: "gemini", command: "gemini-acp" }).descriptor("gemini");
    expect(d.id).toBe("gemini");
    expect(d.source).toBe("builtin");
    expect(d.quirks.diffIsFragment).toBe(false);
  });

  it("answers for an agent that is not configured at all", () => {
    expect(withAgent({ id: "a", command: "x" }).descriptor("nobody")).toMatchObject({
      id: "nobody",
      source: "builtin",
    });
  });

  it("carries the claude-acp quirk table for the agent that claims it", () => {
    const d = withAgent({ id: "claude-acp", command: "npx" }).descriptor("claude-acp");
    expect(d.quirks.diffIsFragment).toBe(true);
    expect(d.quirks.configIdField).toBe("configId");
    expect(d.unverified).toContain("plan");
  });

  it("keeps the AGENT's id, not the builtin's, so a log line names what the operator wrote", () => {
    const d = withAgent({
      id: "my-agent",
      command: "npx",
      args: ["@agentclientprotocol/claude-agent-acp@0.73.0"],
    }).descriptor("my-agent");
    expect(d.id).toBe("my-agent");
    expect(d.quirks.messageIdPresent).toBe(true);
  });

  it("applies the operator's overlay on top of the builtin", () => {
    const d = withAgent({
      id: "claude-acp",
      command: "npx",
      runtime: { quirks: { diffIsFragment: false }, budgets: { turnMs: 42 } },
    }).descriptor("claude-acp");
    expect(d.source).toBe("merged");
    expect(d.quirks.diffIsFragment).toBe(false);
    expect(d.budgets.turnMs).toBe(42);
  });

  it("folds a cached probe in as the last layer", () => {
    const d = withAgent(
      { id: "claude-acp", command: "npx" },
      probed({ name: "claude-agent-acp", version: "0.73.0" }, "claude-acp"),
    ).descriptor("claude-acp");
    expect(d.source).toBe("merged");
    expect(d.fingerprint).toBe("f".repeat(64));
  });

  it("REFUSES to construct with an illegal overlay: a typo fails the daemon START", () => {
    expect(() =>
      withAgent({ id: "a", command: "x", runtime: { quirks: { diffIsFragmnt: true } } }),
    ).toThrow(/not a known quirk/);
    expect(() =>
      withAgent({
        id: "a",
        command: "x",
        runtime: { updates: { plan: { map: null, stream: false, store: true } } },
      }),
    ).toThrow(/forbidden/);
  });

  it("falls back rather than throwing when the PROBE layer produces something illegal", () => {
    // The eager pass proved builtin ⊕ config legal at startup, so a throw at request time can
    // only come from the probe — and the honest answer is the descriptor we had before it.
    const broken = { ...probed(null), protocolVersion: 1 } as ProbeSummary;
    Object.defineProperty(broken, "learnedParams", {
      get() {
        throw new Error("a corrupt cached probe");
      },
    });
    const catalog = withAgent({ id: "claude-acp", command: "npx" }, broken);
    expect(() => catalog.descriptor("claude-acp")).not.toThrow();
    expect(catalog.descriptor("claude-acp").quirks.diffIsFragment).toBe(true);
  });
});

describe("Catalog.probe — the façade row (H16)", () => {
  it("a daemon built without a probe service answers bad_request, never a 500 (D29)", async () => {
    const catalog = createCatalog(
      DaemonConfig.parse({
        tokens: [{ id: "t", secretSha256: "a".repeat(64) }],
        agents: [{ id: "a", command: "x" }],
      } as Parameters<typeof DaemonConfig.parse>[0]) as ResolvedDaemonConfig,
    );
    await expect(catalog.probe("a", {}, {} as never)).rejects.toMatchObject({
      code: "bad_request",
    });
  });
});

describe("runtimeIdFor — one identity, in the log and in the catalog (§17.2)", () => {
  const agent = (o: Record<string, unknown>): AgentDescriptor =>
    AgentDescriptor.parse({ id: "claude", command: "npx", args: [], ...o });

  it("is `<agentId>@<12 hex>`", () => {
    expect(runtimeIdFor(agent({}), null)).toMatch(/^claude@[0-9a-f]{12}$/);
  });

  it("moves when the argv moves", () => {
    expect(runtimeIdFor(agent({ args: ["a"] }), null)).not.toBe(
      runtimeIdFor(agent({ args: ["b"] }), null),
    );
  });

  it("moves when a probe names the agent's version — a descriptor change is VISIBLE", () => {
    const at = (version: string): ProbeSummary =>
      probed({ name: "claude-agent-acp", version }, "claude");
    const d = agent({});
    expect(runtimeIdFor(d, null)).not.toBe(runtimeIdFor(d, at("0.73.0")));
    expect(runtimeIdFor(d, at("0.73.0"))).not.toBe(runtimeIdFor(d, at("0.74.0")));
  });

  it("never leaks the credential it hashed", () => {
    expect(runtimeIdFor(agent({ args: ["--api-key", "sk-ant-SECRET"] }), null)).not.toContain(
      "sk-",
    );
  });
});
