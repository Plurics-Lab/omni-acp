import { describe, expect, it } from "vitest";
import { resolveMcpPresets } from "@omni-acp/core";
import { configWith, PRESETS, thrown } from "./support.js";

/**
 * `resolveMcpPresets` — the one place a preset NAME becomes a command line, and it reads that
 * command line from `DaemonConfig` and from nowhere else (§23.1, DESIGN §8's 🔴).
 *
 * WP-S acceptance 1, the resolution half.
 *
 * Owned by M2-B-WP-S.
 */

const cfg = configWith(PRESETS);

describe("resolveMcpPresets (§23.1)", () => {
  it("resolves a named preset to the OPERATOR's server object, in request order", () => {
    const out = resolveMcpPresets(["memory", "files"], cfg, "*");
    expect(out.map((r) => r.name)).toEqual(["memory", "files"]);
    expect(out[1]?.server).toStrictEqual({
      type: "stdio",
      command: "mcp-files",
      args: ["--root", "/srv/w"],
      headers: {},
      env: { MCP_FILES_MODE: "ro" },
    });
  });

  it("asks for nothing when the request named nothing", () => {
    expect(resolveMcpPresets([], cfg, "*")).toEqual([]);
  });

  it("names an unknown preset in a 400 — never a silent drop", () => {
    const e = thrown(() => resolveMcpPresets(["files", "typo"], cfg, "*"));
    expect(e.code).toBe("bad_request");
    expect(e.status).toBe(400);
    // NAMING it: a client that believed a tool was available and was not spends a whole turn
    // discovering it, and the agent explains the failure in prose we may not parse.
    expect(e.message).toContain('"typo"');
    expect(e.detail).toStrictEqual({ preset: "typo" });
  });

  it("refuses a name outside the token's mcpPresets with a 403", () => {
    const e = thrown(() => resolveMcpPresets(["files"], cfg, ["memory"]));
    expect(e.code).toBe("forbidden");
    expect(e.status).toBe(403);
    expect(e.message).toContain('"files"');
  });

  it("FAILS CLOSED on the default allowlist: [] allows nothing, and it is not '*'", () => {
    // `TokenConfig.mcpPresets` defaults to `[]`, which this asserts is a real refusal rather
    // than an empty filter that lets everything through.
    for (const name of Object.keys(PRESETS)) {
      expect(thrown(() => resolveMcpPresets([name], cfg, [])).code).toBe("forbidden");
    }
    expect(resolveMcpPresets(["files"], cfg, "*").length).toBe(1);
  });

  it("asks the ACL BEFORE the config, so the reply is not a preset-table oracle", () => {
    // A token allowed nothing must not be able to enumerate the operator's table by watching
    // which names answer 400 (exists) and which answer 403 (does not). Both answer 403.
    expect(thrown(() => resolveMcpPresets(["files"], cfg, [])).code).toBe("forbidden");
    expect(thrown(() => resolveMcpPresets(["no-such-preset"], cfg, [])).code).toBe("forbidden");
  });

  it("never reads a key off Object.prototype", () => {
    // `cfg.mcpServers["constructor"]` is truthy on every object in JavaScript; a bare read here
    // would resolve `constructor` to a Function and then try to launch it.
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(thrown(() => resolveMcpPresets([name], cfg, "*")).code).toBe("bad_request");
    }
  });

  it("collapses a repeated name to ONE server, keeping first-mention order", () => {
    const out = resolveMcpPresets(["files", "memory", "files"], cfg, "*");
    expect(out.map((r) => r.name)).toEqual(["files", "memory"]);
  });

  it("hands back a COPY: mutating a resolved server cannot edit the operator's config", () => {
    const first = resolveMcpPresets(["files"], cfg, "*")[0];
    expect(first).toBeDefined();
    first?.server.args.push("--injected");
    (first?.server.env as Record<string, string>)["MCP_FILES_MODE"] = "rw";

    const second = resolveMcpPresets(["files"], cfg, "*")[0];
    expect(second?.server.args).toEqual(["--root", "/srv/w"]);
    expect(second?.server.env).toStrictEqual({ MCP_FILES_MODE: "ro" });
  });

  it("refuses an unlaunchable preset as INTERNAL, and never echoes the command", () => {
    // `McpServerPreset.type` defaults to "stdio", so `{url: …}` with no `type` parses as a stdio
    // server with no command — an operator trap whose only other symptom is a spawn failure
    // minutes later, inside the agent, reported in prose.
    const broken = configWith({
      forgot_type: { url: "https://mcp.example.invalid/x" },
      no_command: { type: "stdio", args: ["-x"] },
      both: { type: "stdio", command: "c", url: "https://mcp.example.invalid/x" },
      http_no_url: { type: "http" },
      http_command: { type: "http", url: "https://mcp.example.invalid/x", command: "c" },
    });
    for (const name of ["forgot_type", "no_command", "both", "http_no_url", "http_command"]) {
      const e = thrown(() => resolveMcpPresets([name], broken, "*"));
      expect(e.code, name).toBe("internal");
      expect(e.status, name).toBe(500); // the CLIENT named a preset that exists and is allowed
      expect(e.message, name).toContain(`"${name}"`);
      expect(JSON.stringify(e.detail), name).not.toContain("mcp-files");
    }
    expect(thrown(() => resolveMcpPresets(["http_command"], broken, "*")).detail).toStrictEqual({
      preset: "http_command",
      type: "http",
    });
  });

  it("clamps an over-long name in the message rather than echoing it whole", () => {
    const long = "z".repeat(300);
    const e = thrown(() => resolveMcpPresets([long], cfg, "*"));
    expect(e.message.length).toBeLessThan(120);
    expect(e.message).toContain("…");
  });
});
