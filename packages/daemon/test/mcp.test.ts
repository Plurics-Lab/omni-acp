import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveMcpForWorker } from "@omni-acp/daemon";
import { DEFAULT_V1_PROFILE } from "@omni-acp/core";
import { DaemonConfig, OmniError, type RuntimeDescriptor } from "@omni-acp/protocol";

/**
 * The daemon half of MCP presets: 400 for unknown, 403 for disallowed, `dropped` for unusable.
 *
 * WP-S acceptance 1 and 3, at the seam a route will call.
 *
 * The preset table and the two capability blocks are READ from `packages/testkit/fixtures/mcp/`,
 * so a future agent-version bump changes one file rather than a dozen literals — and so that the
 * blocks under test are the ones the corpora actually recorded rather than ones recalled here.
 *
 * Owned by M2-B-WP-S.
 */

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "testkit",
  "fixtures",
  "mcp",
);
const readFixture = <T>(name: string): T =>
  JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as T;

const presetTable = readFixture<{ mcpServers: Record<string, unknown> }>("presets.json").mcpServers;
const recorded =
  readFixture<Record<string, { mcpCapabilities: Record<string, unknown> } | undefined>>(
    "capabilities.json",
  );

const CLAUDE = recorded["claude-acp-0.73.0"]?.mcpCapabilities;
const CODEX = recorded["codex-acp-1.8.0"]?.mcpCapabilities;

const config = DaemonConfig.parse({
  tokens: [{ id: "t1", secret: "daemon-mcp-secret-daemon-mcp-secret" }],
  mcpServers: presetTable,
});

/** The descriptor is the ONLY branch: two of them, differing in one boolean (§17.1). */
const strict: RuntimeDescriptor = DEFAULT_V1_PROFILE;
const tolerant: RuntimeDescriptor = {
  ...DEFAULT_V1_PROFILE,
  id: "tolerant-fixture",
  quirks: { ...DEFAULT_V1_PROFILE.quirks, toleratesOmittedMcpCapabilities: true },
};

function resolve(o: {
  names?: readonly string[];
  allow?: readonly string[] | "*";
  caps?: Readonly<Record<string, unknown>> | null;
  descriptor?: RuntimeDescriptor;
}) {
  return resolveMcpForWorker({
    names: o.names,
    config,
    allow: o.allow ?? "*",
    descriptor: o.descriptor ?? strict,
    caps: o.caps === undefined ? null : o.caps,
  });
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

describe("resolveMcpForWorker", () => {
  it("reads the fixture table the whole work package shares", () => {
    expect(Object.keys(presetTable).sort()).toEqual(["feed", "files", "memory", "search"]);
    expect(CLAUDE).toStrictEqual({ http: true, sse: true });
    expect(CODEX).toStrictEqual({ acp: false, http: true, sse: false });
  });

  it("resolves NOTHING for a request that named nothing — M1's `mcpServers: []`", () => {
    for (const names of [undefined, []]) {
      expect(resolve({ names })).toStrictEqual({
        servers: [],
        applied: [],
        dropped: [],
        warnings: [],
      });
    }
  });

  it("an unknown preset name is 400 NAMING it and one outside the token's mcpPresets is 403", () => {
    const unknown = thrown(() => resolve({ names: ["files", "nope"] }));
    expect(unknown.code).toBe("bad_request");
    expect(unknown.status).toBe(400);
    expect(unknown.message).toContain('"nope"');

    const disallowed = thrown(() => resolve({ names: ["files"], allow: ["memory"] }));
    expect(disallowed.code).toBe("forbidden");
    expect(disallowed.status).toBe(403);
    expect(disallowed.message).toContain('"files"');

    // FAIL CLOSED: `TokenConfig.mcpPresets` defaults to `[]`, which refuses everything.
    expect(thrown(() => resolve({ names: ["files"], allow: [] })).status).toBe(403);
  });

  it("a preset the AGENT cannot take is reported as dropped with a TurnWarning, never as an error", () => {
    // codex-acp's RECORDED block: it takes http, refuses sse, and takes stdio while advertising
    // no bit for it at all.
    const out = resolve({ names: ["files", "search", "feed"], caps: { mcpCapabilities: CODEX } });
    expect(out.applied).toEqual(["files", "search"]);
    expect(out.dropped).toEqual([
      { name: "feed", reason: "the agent does not advertise mcpCapabilities.sse" },
    ]);
    expect(out.warnings.map((w) => w.code)).toEqual(["mcp_preset_dropped"]);
    // The worker still starts: this is a report, not a failure.
    expect(out.servers).toHaveLength(2);
  });

  it("claude-acp's RECORDED block keeps both remote transports", () => {
    const out = resolve({ names: ["search", "feed"], caps: { mcpCapabilities: CLAUDE } });
    expect(out.applied).toEqual(["search", "feed"]);
    expect(out.dropped).toEqual([]);
  });

  it("decides the absent block FROM THE DESCRIPTOR, and there is no agent id anywhere in it", () => {
    expect(resolve({ names: ["files", "search"], caps: null }).applied).toEqual(["files"]);
    expect(
      resolve({ names: ["files", "search"], caps: null, descriptor: tolerant }).applied,
    ).toEqual(["files", "search"]);

    // The two descriptors differ in exactly one boolean, which is what "from the descriptor,
    // never from an agent-id branch" means in practice.
    expect(strict.quirks.toleratesOmittedMcpCapabilities).toBe(false);
    expect(tolerant.quirks.toleratesOmittedMcpCapabilities).toBe(true);
  });

  it("emits the ACP wire shape: stdio untagged, http/sse tagged, env and headers as pairs", () => {
    const out = resolve({ names: ["files", "search"], caps: { mcpCapabilities: CLAUDE } });
    expect(out.servers[0]).toStrictEqual({
      name: "files",
      command: "omni-acp-fixture-mcp-files",
      args: ["--root", "."],
      env: [{ name: "MCP_FILES_MODE", value: "ro" }],
    });
    expect(out.servers[1]).toStrictEqual({
      type: "http",
      name: "search",
      url: "https://mcp.example.invalid/search",
      headers: [{ name: "X-Fixture", value: "search" }],
    });
  });

  it("never lets a caller's mutation reach the operator's config", () => {
    const first = resolve({ names: ["files"], caps: { mcpCapabilities: CLAUDE } });
    (first.servers[0] as { args: string[] }).args.push("--injected");
    const second = resolve({ names: ["files"], caps: { mcpCapabilities: CLAUDE } });
    expect((second.servers[0] as { args: string[] }).args).toEqual(["--root", "."]);
  });
});
