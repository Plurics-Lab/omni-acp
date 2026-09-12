import { describe, expect, it } from "vitest";
import { DaemonConfig, ENV_DENY_EXACT } from "@omni-acp/protocol";
import { createCatalog } from "../../src/catalog.js";

/**
 * `Catalog.toSpawnSpec`'s credential composition (docs/M3-WP1-CREDENTIALS.md §Home 隔离).
 *
 * It lives in the catalog and nowhere else because `SpawnSpec.env` is documented as COMPLETE — the
 * Supervisor adds nothing and removes nothing — and a second composer is exactly how the create
 * path and the wake path come to spawn one worker with two different environments. So the
 * assertions here are about WHICH VARIABLE lands and about the LAYERING order, which is the half
 * that decides whether an isolated worker can reach the operator's own `~/.claude`.
 *
 * Owned by M3-WP1.
 */

const config = (agents: { id: string; env?: Record<string, string> }[]) =>
  DaemonConfig.parse({
    dataDir: "/tmp/omni-envcomp",
    tokens: [{ id: "t", secret: "s".repeat(32) }],
    agents: agents.map((a) => ({
      id: a.id,
      command: process.execPath,
      args: ["-e", ""],
      ...(a.env === undefined ? {} : { env: a.env }),
    })),
    logLevel: "silent",
  });

describe("toSpawnSpec — the credential environment, composed in ONE place", () => {
  it("sets the descriptor's OWN homeEnv, per runtime, and never a guessed one", () => {
    const catalog = createCatalog(config([{ id: "claude-acp" }, { id: "codex-acp" }]));

    // MEASURED, per runtime (E1/E2): claude-acp reads `CLAUDE_CONFIG_DIR` and codex-acp reads
    // `CODEX_HOME`. The variable comes off the DESCRIPTOR, so adding a third runtime is a
    // `known.ts` entry and not a branch here — §17.1's rule, applied to the home.
    const claude = catalog.toSpawnSpec(catalog.get("claude-acp"), {
      cwd: "/work",
      home: "/data/homes/w_1",
    });
    expect(claude.env["CLAUDE_CONFIG_DIR"]).toBe("/data/homes/w_1");
    expect(claude.env["CODEX_HOME"]).toBeUndefined();

    const codex = catalog.toSpawnSpec(catalog.get("codex-acp"), {
      cwd: "/work",
      home: "/data/homes/w_2",
    });
    expect(codex.env["CODEX_HOME"]).toBe("/data/homes/w_2");
    expect(codex.env["CLAUDE_CONFIG_DIR"]).toBeUndefined();
  });

  it("sets NOTHING for a runtime with no credential contract, which is M2 exactly", () => {
    // `plain` matches no builtin, so its descriptor carries `credentials: null`: there is no
    // variable to set, and setting one would be pointing an agent at a directory it does not read.
    const catalog = createCatalog(config([{ id: "plain" }]));
    const spec = catalog.toSpawnSpec(catalog.get("plain"), { cwd: "/work", home: "/data/h" });
    expect(spec.env["CLAUDE_CONFIG_DIR"]).toBeUndefined();
    expect(spec.env["CODEX_HOME"]).toBeUndefined();
  });

  it("composes NOTHING when neither option is given — the M2 caller, byte for byte", () => {
    const catalog = createCatalog(config([{ id: "claude-acp", env: { AGENT_PROFILE: "x" } }]));
    const before = catalog.toSpawnSpec(catalog.get("claude-acp"), { cwd: "/work" });
    // This IS the backward-compatibility bar for the whole work package: every M2 call site passes
    // only a cwd, and the composition must be what it was.
    expect(before.env["AGENT_PROFILE"]).toBe("x");
    expect(before.env["CLAUDE_CONFIG_DIR"]).toBe(process.env["CLAUDE_CONFIG_DIR"]);
    expect(before.env["PATH"]).toBe(process.env["PATH"]);
  });

  it("puts the credential variable AFTER the descriptor's own, so isolation wins", () => {
    // An operator who pinned `CLAUDE_CONFIG_DIR` in `agents[].env` pinned the SHARED home;
    // `home: "isolated"` is a per-worker request to override exactly that, and it must win — or
    // two workers would share one session directory and race on one credential file.
    const catalog = createCatalog(
      config([{ id: "claude-acp", env: { CLAUDE_CONFIG_DIR: "/operator/shared" } }]),
    );
    const shared = catalog.toSpawnSpec(catalog.get("claude-acp"), { cwd: "/work" });
    expect(shared.env["CLAUDE_CONFIG_DIR"]).toBe("/operator/shared");

    const isolated = catalog.toSpawnSpec(catalog.get("claude-acp"), {
      cwd: "/work",
      home: "/data/homes/w_1",
    });
    expect(isolated.env["CLAUDE_CONFIG_DIR"]).toBe("/data/homes/w_1");
  });

  it("lands a token / apiKey credential under the variable the credential layer chose", () => {
    const catalog = createCatalog(config([{ id: "claude-acp" }]));
    const spec = catalog.toSpawnSpec(catalog.get("claude-acp"), {
      cwd: "/work",
      home: "/data/homes/w_1",
      // The layer resolved this from the store: the descriptor says the variable, the store says
      // the value, and this is the one place the two meet.
      credentialEnv: {
        CLAUDE_CONFIG_DIR: "/data/homes/w_1",
        CLAUDE_CODE_OAUTH_TOKEN: "PLANTED-OAUTH",
      },
    });
    expect(spec.env["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("PLANTED-OAUTH");
    expect(spec.env["CLAUDE_CONFIG_DIR"]).toBe("/data/homes/w_1");
  });

  it("overrides an INHERITED credential variable, which is the isolation boundary", () => {
    // The daemon's own process may well have `CLAUDE_CONFIG_DIR` exported — an operator who ran
    // `omni-acp start` from a shell where they had been using Claude Code. Inheriting it would
    // point every isolated worker at the operator's real `~/.claude`, which is the one directory
    // this work package exists to keep agents out of.
    const previous = process.env["CLAUDE_CONFIG_DIR"];
    process.env["CLAUDE_CONFIG_DIR"] = "/home/operator/.claude";
    try {
      const catalog = createCatalog(config([{ id: "claude-acp" }]));
      const spec = catalog.toSpawnSpec(catalog.get("claude-acp"), {
        cwd: "/work",
        home: "/data/homes/w_1",
      });
      expect(spec.env["CLAUDE_CONFIG_DIR"]).toBe("/data/homes/w_1");
    } finally {
      if (previous === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
      else process.env["CLAUDE_CONFIG_DIR"] = previous;
    }
  });
});

describe("the six credential variables are on the HARD deny list (DESIGN §8)", () => {
  it("names every variable the credential layer sets, so a client can never set one", () => {
    // The layer above sets these ITSELF, in `toSpawnSpec`, which is above the deny list and not
    // subject to it. The list governs the CLIENT's contribution — and a client that could set
    // `CLAUDE_CONFIG_DIR` would be pointing the agent at a home the daemon did not build, which is
    // the whole isolation boundary in one variable.
    for (const key of [
      "CLAUDE_CONFIG_DIR",
      "CODEX_HOME",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "ANTHROPIC_API_KEY",
      "CODEX_API_KEY",
      "OPENAI_API_KEY",
    ]) {
      expect(ENV_DENY_EXACT).toContain(key);
    }
  });
});
