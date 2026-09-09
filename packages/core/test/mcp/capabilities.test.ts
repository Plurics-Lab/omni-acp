import { describe, expect, it } from "vitest";
import { filterMcpCapabilities, resolveMcpPresets } from "@omni-acp/core";
import { readMcpCapabilityBlock } from "../../src/mcp/capabilities.js";
import { configWith, PRESETS } from "./support.js";

/**
 * `filterMcpCapabilities` — DESIGN §6.2's filter, and the one rule that is easy to get backwards.
 *
 * WP-S acceptance 3, plus the descriptor half of acceptance 2.
 *
 * The two capability blocks below are RECORDED, not invented:
 *   claude-acp 0.73.0  `"mcpCapabilities":{"http":true,"sse":true}`      (corpus 03, 08, 11, …)
 *   codex-acp   1.8.0  `"mcpCapabilities":{"acp":false,"http":true,"sse":false}` (corpus 06)
 *
 * Owned by M2-B-WP-S.
 */

const CLAUDE = { http: true, sse: true } as const;
const CODEX = { acp: false, http: true, sse: false } as const;

const cfg = configWith(PRESETS);
const presetsFor = (...names: string[]) => resolveMcpPresets(names, cfg, "*");

const filter = (
  names: string[],
  caps: Readonly<Record<string, unknown>> | null,
  tolerateOmitted = false,
) => filterMcpCapabilities({ presets: presetsFor(...names), caps, tolerateOmitted });

describe("filterMcpCapabilities (§23.2)", () => {
  it("NEVER filters stdio — there is no stdio bit, and codex takes stdio while advertising none", () => {
    // The backwards reading this test exists to prevent: v1 has no `mcpCapabilities.stdio`, so a
    // filter that demanded a bit would drop every stdio preset from every agent, starting with
    // the one whose recorded block says `{acp:false, http:true, sse:false}`.
    for (const caps of [CODEX, CLAUDE, {}, null]) {
      const out = filter(["files", "memory"], caps);
      expect(out.applied, JSON.stringify(caps)).toEqual(["files", "memory"]);
      expect(out.dropped, JSON.stringify(caps)).toEqual([]);
      expect(out.warnings, JSON.stringify(caps)).toEqual([]);
    }
  });

  it("passes http/sse only against the matching bit — codex keeps search and drops feed", () => {
    const out = filter(["files", "search", "feed"], CODEX);
    expect(out.applied).toEqual(["files", "search"]);
    expect(out.dropped).toEqual([
      { name: "feed", reason: "the agent does not advertise mcpCapabilities.sse" },
    ]);
    expect(filter(["search", "feed"], CLAUDE).dropped).toEqual([]);
  });

  it("an unusable http preset is a REPORT, not an error: applied:[] + dropped + a TurnWarning", () => {
    const out = filter(["search"], { http: false, sse: false });
    expect(out.applied).toEqual([]);
    expect(out.servers).toEqual([]);
    expect(out.dropped).toEqual([
      { name: "search", reason: "the agent does not advertise mcpCapabilities.http" },
    ]);
    expect(out.warnings).toHaveLength(1);
    const [warning] = out.warnings;
    expect(warning?.code).toBe("mcp_preset_dropped");
    expect(warning?.message).toContain('"search"');
    // The snapshot row and the warning carry the SAME `{name, reason}`, so an operator reading a
    // turn and one reading `GET /v1/workers/{wid}` see one story rather than two.
    expect(warning?.detail).toMatchObject({ name: "search", reason: out.dropped[0]?.reason });
  });

  it("decides the ABSENT block from the DESCRIPTOR, in both directions", () => {
    // `toleratesOmittedMcpCapabilities: false` is what both builtin descriptors say today, and
    // it is the fail-closed reading: no block, no http.
    const strict = filter(["files", "search"], null, false);
    expect(strict.applied).toEqual(["files"]);
    expect(strict.dropped[0]?.reason).toContain("declared no mcpCapabilities block");

    // Flip ONE boolean on the descriptor and the same presets land. No agent id anywhere.
    const tolerant = filter(["files", "search"], null, true);
    expect(tolerant.applied).toEqual(["files", "search"]);
    expect(tolerant.dropped).toEqual([]);
  });

  it("an EMPTY block is an answer, not an absence — the quirk does not rescue it", () => {
    // `mcpCapabilities: {}` is an agent that answered "none of them"; a capabilities envelope
    // with no such key is an agent that was never asked. Conflating the two would let
    // `toleratesOmittedMcpCapabilities` widen a refusal the agent actually made.
    const out = filter(["search"], { loadSession: true, mcpCapabilities: {} }, true);
    expect(out.applied).toEqual([]);
    expect(out.dropped[0]?.reason).toBe("the agent does not advertise mcpCapabilities.http");

    // …and the envelope WITHOUT the key is the absent case, which the quirk does decide.
    expect(filter(["search"], { loadSession: true }, true).applied).toEqual(["search"]);
  });

  it("a bare `{}` is ABSENT, because it is the shape the two cases share", () => {
    // The production input is `AgentCapabilitiesSnapshot.raw` — the whole verbatim
    // `agentCapabilities` — where `{}` unambiguously means "this agent declared no MCP block".
    // A caller passing the BLOCK directly can only reach `{}` by declaring nothing either, so
    // the two readings agree and the fail-closed one is chosen.
    expect(filter(["search"], {}, false).applied).toEqual([]);
    expect(filter(["search"], {}, false).dropped[0]?.reason).toContain(
      "declared no mcpCapabilities block",
    );
  });

  it("requires the bit to be exactly `true`, not merely truthy", () => {
    for (const value of ["true", 1, {}, [], "yes"]) {
      expect(filter(["search"], { http: value }).applied, JSON.stringify(value)).toEqual([]);
    }
    expect(filter(["search"], { http: true }).applied).toEqual(["search"]);
  });

  it("emits stdio UNTAGGED and http/sse TAGGED — v1's anyOf, and §12.3 row 22's opening", () => {
    const out = filter(["files", "search", "feed"], CLAUDE);
    expect(out.servers[0]).toStrictEqual({
      // NO `type` key. v1's stdio arm is the untagged one, both real agents take it, and it is
      // what leaves row 22 ("an McpServer without a type gets one") something to do.
      name: "files",
      command: "mcp-files",
      args: ["--root", "/srv/w"],
      env: [{ name: "MCP_FILES_MODE", value: "ro" }],
    });
    expect(out.servers[1]).toStrictEqual({
      type: "http",
      name: "search",
      url: "https://mcp.example.invalid/search",
      headers: [{ name: "X-Key", value: "k" }],
    });
    expect(out.servers[2]).toMatchObject({ type: "sse", name: "feed", headers: [] });
  });

  it("key-sorts env and headers, so two equal presets produce equal wire bytes", () => {
    const multi = configWith({ many: { command: "c", env: { B: "2", A: "1", C: "3" } } });
    const out = filterMcpCapabilities({
      presets: resolveMcpPresets(["many"], multi, "*"),
      caps: null,
      tolerateOmitted: false,
    });
    expect((out.servers[0] as { env: unknown }).env).toEqual([
      { name: "A", value: "1" },
      { name: "B", value: "2" },
      { name: "C", value: "3" },
    ]);
  });

  it("resolves to nothing when there are no presets", () => {
    expect(filter([], CLAUDE)).toStrictEqual({
      servers: [],
      applied: [],
      dropped: [],
      warnings: [],
    });
  });
});

describe("readMcpCapabilityBlock — one block, three recorded spellings", () => {
  it("finds v1's `agentCapabilities.mcpCapabilities` (both real agents)", () => {
    expect(
      readMcpCapabilityBlock({ promptCapabilities: { image: true }, mcpCapabilities: CLAUDE }),
    ).toStrictEqual(CLAUDE);
  });

  it("finds v2's `capabilities.session.mcp` (§12.3 row 20 moves it under `session`)", () => {
    expect(readMcpCapabilityBlock({ session: { mcp: { http: true } } })).toStrictEqual({
      http: true,
    });
  });

  it("accepts the block itself, which is what the signature documents", () => {
    expect(readMcpCapabilityBlock(CODEX)).toStrictEqual(CODEX);
  });

  it("reads ABSENT for null, for a capabilities envelope with no block, and for a non-object", () => {
    expect(readMcpCapabilityBlock(null)).toBeNull();
    expect(readMcpCapabilityBlock({ loadSession: true })).toBeNull();
    expect(readMcpCapabilityBlock({ mcpCapabilities: "yes" })).toBeNull();
    expect(readMcpCapabilityBlock({ session: { mcp: [] } })).toBeNull();
  });

  it("never reads a prototype key as a block", () => {
    expect(readMcpCapabilityBlock({})).toBeNull();
    expect(readMcpCapabilityBlock({ constructor: { http: true } })).toBeNull();
  });
});
