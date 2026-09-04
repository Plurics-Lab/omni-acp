import { describe, expect, it } from "vitest";
import { AgentDescriptor } from "@omni-acp/protocol";
import { descriptorFingerprint, runtimeIdOf } from "../../src/runtime/descriptor.js";
import { claudeAcpDescriptor } from "../normalizer/support/claude-acp.js";
import {
  BUILTIN_RUNTIMES,
  CLAUDE_ACP_UNVERIFIED,
  DEFAULT_V1_PROFILE,
} from "../../src/runtime/known.js";

const CLAUDE = BUILTIN_RUNTIMES[0]!.descriptor;

describe("BUILTIN_RUNTIMES — exactly one non-default entry (§17.2)", () => {
  it("ships ONE builtin, and it is claude-acp", () => {
    expect(BUILTIN_RUNTIMES).toHaveLength(1);
    expect(CLAUDE.id).toBe("claude-acp");
    expect(CLAUDE.source).toBe("builtin");
  });

  it("matches the agent by config id, by package specifier, and by the agentInfo name", () => {
    // The real 0.73.0 agent answers `agentInfo.name: "@agentclientprotocol/claude-agent-acp"`,
    // so both the scoped specifier and §17.2's `/^claude-(code|agent)-acp$/` segment are listed.
    expect(BUILTIN_RUNTIMES[0]!.matches).toContain("claude-acp");
    expect(BUILTIN_RUNTIMES[0]!.matches).toContain("@agentclientprotocol/claude-agent-acp");
    expect(BUILTIN_RUNTIMES[0]!.matches).toContain("claude-agent-acp");
  });

  // §17.2's version window (`>=0.70.0 <1.0.0`) is asserted in `daemon/test/catalog.test.ts`,
  // beside `selectBuiltin` — the only code that can apply it (see the note in `known.ts`).
});

describe("the claude-acp descriptor — every field is a corpus observation (§17.2)", () => {
  it("answers protocolVersion 1 and carries v2 spellings — the hybrid F24 records", () => {
    expect(CLAUDE.protocolVersion).toBe(1);
    expect(CLAUDE.prefer["setConfig"]?.spellings).toEqual([
      "session/set_config_option",
      "session/set_mode",
    ]);
    expect(CLAUDE.prefer["list"]?.spellings).toEqual(["session/list"]);
  });

  it("prefers BOTH resume spellings — F18 saw both live on one process", () => {
    expect(CLAUDE.prefer["resume"]?.spellings).toEqual(["session/resume", "session/load"]);
    expect(CLAUDE.prefer["resume"]?.onFailure).toBe("fail");
  });

  it("`set_options` fails as a WARNING; `setConfig` fails the request (DESIGN §6.2)", () => {
    expect(CLAUDE.prefer["setOptions"]).toEqual({
      spellings: ["session/set_options"],
      onFailure: "warn",
    });
    expect(CLAUDE.prefer["setConfig"]?.onFailure).toBe("fail");
  });

  it("spells `session/update` the standard way — inboundAliases is EMPTY (review R4)", () => {
    expect(CLAUDE.inboundAliases).toEqual({});
  });

  it("carries the observed quirks, and only the observed ones", () => {
    expect(CLAUDE.quirks).toEqual({
      resumeSilentlyCreates: false,
      resumeRequiresSameCwd: true,
      loadReturnsBody: true,
      messageIdPresent: true,
      toolCallUpdateIsSparse: true,
      diffIsFragment: true,
      permissionRequestShape: "v1_tool_call",
      sessionGrantKind: "none",
      emitsUsageUpdateOnV1: true,
      emitsStateUpdate: false,
      configIdField: "configId",
      toleratesOmittedMcpCapabilities: false,
      unknownMethodErrorCode: -32601,
    });
  });

  it("`sessionGrantKind: none` ⇒ `allow_once` is the only safe allow (D4 rule 2)", () => {
    expect(CLAUDE.quirks.sessionGrantKind).toBe("none");
  });

  it("registers the two vendor extension pointers, with `~1` escaping the slash in the key", () => {
    expect(CLAUDE.extensions).toEqual({
      patch: {
        pointer: "/claudeCode/toolResponse",
        as: "patch",
        dialect: "claude_structured_patch",
      },
      rateLimit: { pointer: "/_claude~1rateLimit", as: "rate_limit", dialect: "claude_rate_limit" },
    });
  });

  it("digests `available_commands_update` — streamed in full, stored once (§14.6, M1-R3)", () => {
    expect(CLAUDE.updates).toEqual({
      available_commands_update: { map: null, stream: true, store: true, digest: true },
    });
    // Never the forbidden third shape.
    expect(CLAUDE.updates["available_commands_update"]?.stream).toBe(true);
  });

  it("keys its error rules on code + a data pointer, never on message text (F17)", () => {
    expect(CLAUDE.errorRules).toEqual([
      {
        id: "bad-config-value",
        code: -32603,
        dataPointer: "/details",
        dataMatches: "^Invalid value for config option ",
        classify: "bad_request",
      },
      {
        id: "unknown-method",
        code: -32601,
        dataPointer: "/method",
        classify: "unsupported_method",
      },
    ]);
    for (const rule of CLAUDE.errorRules) expect(rule.messageMatches).toBeUndefined();
  });

  it("declares no client host capability, for every agent M1 knows about (D3)", () => {
    expect(CLAUDE.clientHost).toEqual({ fs: false, terminal: false });
    expect(DEFAULT_V1_PROFILE.clientHost).toEqual({ fs: false, terminal: false });
  });
});

describe("`unverified` is the SINGLE SOURCE OF TRUTH for claude-acp's corpus gaps (review R8)", () => {
  it("is the seven rows §17.2 enumerates, in order", () => {
    expect(CLAUDE.unverified).toEqual([
      "plan",
      "agent_thought_chunk",
      "current_mode_update",
      "mcp",
      "image_content",
      "authenticate",
      "tool_failure_on_merits",
    ]);
  });

  it("the exported constant and the descriptor's list are the SAME list, not two transcriptions", () => {
    expect(CLAUDE.unverified).toEqual([...CLAUDE_ACP_UNVERIFIED]);
  });

  it("the DEFAULT profile claims nothing, because it describes no agent", () => {
    expect(DEFAULT_V1_PROFILE.unverified).toEqual([]);
  });
});

describe("descriptorFingerprint (§17.2)", () => {
  const agent = (o: Record<string, unknown>): AgentDescriptor =>
    AgentDescriptor.parse({ id: "a", command: "npx", args: [], ...o });

  it("is a 64-character lower-case sha256", () => {
    expect(descriptorFingerprint(agent({}))).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable for the same command ⊕ args ⊕ version ⊕ agentInfo", () => {
    const one = agent({ command: "npx", args: ["-y", "pkg@1"] });
    const two = agent({ command: "npx", args: ["-y", "pkg@1"] });
    expect(descriptorFingerprint(one)).toBe(descriptorFingerprint(two));
  });

  it("changes when the COMMAND changes", () => {
    expect(descriptorFingerprint(agent({ command: "npx" }))).not.toBe(
      descriptorFingerprint(agent({ command: "node" })),
    );
  });

  it("changes when the ARGS change — including a credential the operator rotated", () => {
    const before = agent({ args: ["--api-key", "sk-A"] });
    const after = agent({ args: ["--api-key", "sk-B"] });
    expect(descriptorFingerprint(before)).not.toBe(descriptorFingerprint(after));
  });

  it("does not collide on argv boundaries the way a naive join(' ') would", () => {
    expect(descriptorFingerprint(agent({ args: ["--a", "b"] }))).not.toBe(
      descriptorFingerprint(agent({ args: ["--a b"] })),
    );
  });

  it("changes when the AGENT's own version changes — a probe describes a program", () => {
    const d = agent({});
    const v073 = descriptorFingerprint(d, { name: "claude-agent-acp", version: "0.73.0" });
    const v074 = descriptorFingerprint(d, { name: "claude-agent-acp", version: "0.74.0" });
    expect(v073).not.toBe(v074);
  });

  it("distinguishes `never probed` from `probed and nameless`", () => {
    const d = agent({});
    expect(descriptorFingerprint(d)).not.toBe(descriptorFingerprint(d, {}));
  });

  it("does not leak the credential it hashed", () => {
    const fingerprint = descriptorFingerprint(agent({ args: ["--api-key", "sk-ant-SECRET"] }));
    expect(fingerprint).not.toContain("sk-ant-SECRET");
  });

  it("ignores the operator's runtime overlay: it answers `is this the same program?`", () => {
    const plain = agent({});
    const overlaid = agent({ runtime: { quirks: { loadReturnsBody: true } } });
    expect(descriptorFingerprint(plain)).toBe(descriptorFingerprint(overlaid));
  });

  it("runtimeIdOf publishes only the first 12 hex characters", () => {
    const fingerprint = descriptorFingerprint(agent({}));
    expect(runtimeIdOf("claude", fingerprint)).toBe(`claude@${fingerprint.slice(0, 12)}`);
    expect(runtimeIdOf("claude", fingerprint)).toHaveLength("claude@".length + 12);
  });
});

/**
 * The two independent readings of §17.2 must agree — the reconciliation both work packages
 * asked for at the merge.
 *
 * M1-WP-B transcribed §17.2's table into its own test tree because `BUILTIN_RUNTIMES` was still
 * `[]` when the corpus goldens were written, and every one of those goldens maps against that
 * transcription. M1-WP-E then wrote the shipped builtin from the same table. If the two drift,
 * the corpus is proving the map correct against a runtime nobody runs — which is the exact
 * failure mode a golden suite is supposed to catch and cannot catch about itself.
 *
 * The comparison is TOTAL (`toEqual` over the whole descriptor) rather than field by field, so a
 * field added to `Quirks` in M2 has to be reconciled rather than silently forgotten. Two fields
 * are excluded and each for a stated reason.
 */
describe("§17.2 has ONE table: the builtin and M1-WP-B's transcription agree", () => {
  const transcribed = claudeAcpDescriptor();

  it("is the same descriptor, field for field", () => {
    expect({
      ...transcribed,
      // The corpus fixture pins a fingerprint so its goldens have a stable `runtimeId`; the
      // shipped builtin carries the sentinel until a probe resolves it (Land note S6). The
      // fingerprint describes a PROGRAM, not a table, so it is not part of the agreement.
      fingerprint: CLAUDE.fingerprint,
    }).toEqual(CLAUDE);
  });

  it("agrees about the two fields that diverged before the merge", () => {
    // §17.2 lists TWO setConfig spellings: `session/set_model` is `-32601` on this agent (F18).
    expect(CLAUDE.prefer.setConfig.spellings).toEqual([
      "session/set_config_option",
      "session/set_mode",
    ]);
    expect(transcribed.prefer.setConfig.spellings).toEqual(CLAUDE.prefer.setConfig.spellings);
    // Not in §17.2's table at all, so it takes the conservative `Quirks` default: the corpus
    // always sends `mcpServers: []`, so this agent was never asked to tolerate the omission.
    expect(CLAUDE.quirks.toleratesOmittedMcpCapabilities).toBe(false);
    expect(transcribed.quirks.toleratesOmittedMcpCapabilities).toBe(false);
  });

  it("agrees about `unverified`, which is what makes the compat suite refuse to assert (§18.3)", () => {
    expect([...transcribed.unverified].sort()).toEqual([...CLAUDE_ACP_UNVERIFIED].sort());
  });
});
