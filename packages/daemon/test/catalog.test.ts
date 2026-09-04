import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { DaemonConfig, OmniError } from "@omni-acp/protocol";
import { createCatalog, runtimeIdFor } from "../src/catalog.js";

const AGENT = {
  id: "example",
  command: process.execPath,
  args: ["--version"],
  env: { AGENT_TOKEN: "from-config", PATH: "/overridden" },
  shutdown: { signal: "SIGHUP", graceMs: 1_234 },
};

const config = (agents: unknown[] = [AGENT]) =>
  DaemonConfig.parse({
    tokens: [{ id: "t", secretSha256: "a".repeat(64) }],
    agents,
    supervisor: { killConfirmMs: 111, exitGraceMs: 222, maxFrameBytes: 333, stderrTailBytes: 444 },
  } as Parameters<typeof DaemonConfig.parse>[0]);

describe("Catalog (H4, D22)", () => {
  it("lists the static config with probed: null", () => {
    expect(createCatalog(config()).list()).toEqual([
      {
        id: "example",
        command: process.execPath,
        args: ["--version"],
        source: "config",
        probed: null,
        // Which quirk table WILL govern a worker created now (§5.1 AgentCatalogEntry): the
        // agent id, then 12 hex characters of the real sha256 over command ⊕ args ⊕ version.
        // Asserted through `runtimeIdFor` rather than as a literal, because a hard-coded digest
        // would encode `process.execPath` — different on every machine and in CI.
        runtimeId: runtimeIdFor(config().agents[0]!, null),
      },
    ]);
  });

  it("is empty when no agents are configured", () => {
    expect(createCatalog(config([])).list()).toEqual([]);
  });

  it("throws bad_request — not a new code — for an unknown agent id (D29)", () => {
    try {
      createCatalog(config()).get("nope");
      expect.unreachable();
    } catch (e) {
      expect(OmniError.is(e, "bad_request")).toBe(true);
      expect((e as OmniError).status).toBe(400);
      expect((e as OmniError).message).toBe('unknown agent "nope"');
    }
  });

  it("refuses a config with two agents sharing an id", () => {
    expect(() => createCatalog(config([AGENT, AGENT]))).toThrow(/duplicate agent id/);
  });

  it("redacts credential-shaped args, on the same rule as ProcessInfo.argsRedacted (DESIGN §8)", () => {
    const catalog = createCatalog(
      config([
        {
          ...AGENT,
          args: ["--model", "sonnet", "--api-key", "sk-ant-SECRET", "--token=tok-SECRET"],
        },
      ]),
    );
    expect(catalog.list()[0]?.args).toEqual([
      "--model",
      "sonnet",
      "--api-key",
      "<redacted>",
      "--token=<redacted>",
    ]);
    // The DESCRIPTOR keeps the real argv — the child needs it — and so does the SpawnSpec.
    expect(catalog.get("example").args).toContain("sk-ant-SECRET");
    expect(catalog.toSpawnSpec(catalog.get("example"), { cwd: tmpdir() }).args).toContain(
      "sk-ant-SECRET",
    );
  });
});

describe("Catalog.toSpawnSpec — the ONLY producer of a SpawnSpec (§5.4)", () => {
  const spec = () => {
    const catalog = createCatalog(config());
    return catalog.toSpawnSpec(catalog.get("example"), { cwd: tmpdir() });
  };

  it("composes the COMPLETE environment: daemon env, then descriptor env on top", () => {
    const composed = spec();
    // Inherited, because an ACP agent needs the operator's PATH/HOME…
    expect(Object.keys(composed.env).length).toBeGreaterThan(1);
    // …and overridden by the trusted descriptor (D19).
    expect(composed.env["PATH"]).toBe("/overridden");
    expect(composed.env["AGENT_TOKEN"]).toBe("from-config");
    // No `undefined` leaked in as the string "undefined".
    expect(Object.values(composed.env).every((v) => typeof v === "string")).toBe(true);
  });

  it("carries the agent's own shutdown contract and the supervisor's knobs", () => {
    const composed = spec();
    expect(composed).toMatchObject({
      command: process.execPath,
      args: ["--version"],
      cwd: tmpdir(),
      gracefulMs: 1_234,
      shutdownSignal: "SIGHUP",
      killConfirmMs: 111,
      exitGraceMs: 222,
      maxFrameBytes: 333,
      stderrTailBytes: 444,
      label: "example",
    });
  });

  it("copies args rather than aliasing the descriptor", () => {
    const catalog = createCatalog(config());
    const descriptor = catalog.get("example");
    const composed = catalog.toSpawnSpec(descriptor, { cwd: tmpdir() });
    (composed.args as string[]).push("mutated");
    expect(descriptor.args).toEqual(["--version"]);
  });
});
