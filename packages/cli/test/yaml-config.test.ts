import { yamlToDaemonConfig } from "@omni-acp/cli";
import { hashSecret } from "@omni-acp/protocol";
import { describe, expect, it } from "vitest";

const MINIMAL = `
tokens:
  - id: local
    secret: a-secret-long-enough-for-zod
`;

/**
 * D15 constraint 3: YAML exists ONLY in this package. `yamlToDaemonConfig` is the whole of it —
 * pure, no file system, no daemon — which is what lets `createDaemon()` be embedded in someone
 * else's process without a config-file format coming along.
 */
describe("yamlToDaemonConfig", () => {
  it("parses a minimal document and fills in every documented default", () => {
    const config = yamlToDaemonConfig(MINIMAL, {});

    expect(config).toMatchObject({
      dataDir: "~/.omni-acp",
      listen: null, // no socket unless asked — D15 constraint 1
      maxWorkers: 64,
      handshakeTimeoutMs: 60_000,
      logLevel: "info",
      eventLog: {
        driver: "memory",
        maxEventsPerWorker: 10_000,
        subscriberQueueSize: 1_024,
        sseHeartbeatMs: 15_000,
      },
      // D16: 250 ms quiet / 5 000 ms hard, the only latency the daemon adds to every turn.
      turn: { quietMs: 250, hardMs: 5_000, cancelGraceMs: 10_000 },
      supervisor: { gracefulMs: 5_000, allowShimLaunch: false, windowsHide: true },
    });
    expect(config.tokens?.[0]).toMatchObject({ id: "local", role: "user", maxWorkers: 16 });
  });

  it("lets CLI flags override the YAML", () => {
    const yaml = `${MINIMAL}
dataDir: /from/yaml
listen:
  host: 10.0.0.1
  port: 7777
`;
    const config = yamlToDaemonConfig(yaml, { dataDir: "/from/cli", listen: { port: 0 } });

    expect(config.dataDir).toBe("/from/cli");
    // `--port 0` overrides the port and LEAVES the host: `listen` merges field by field, because
    // a flag that silently deleted a sibling setting is a very quiet outage.
    expect(config.listen).toEqual({ host: "10.0.0.1", port: 0 });
  });

  it("treats an absent flag as absent, not as an instruction to unset", () => {
    const yaml = `${MINIMAL}\ndataDir: /from/yaml\n`;
    const config = yamlToDaemonConfig(yaml, { dataDir: undefined, listen: undefined });
    expect(config.dataDir).toBe("/from/yaml");
  });

  it("uses the override's listen wholesale when the YAML has none", () => {
    const config = yamlToDaemonConfig(MINIMAL, { listen: { port: 0 } });
    expect(config.listen).toEqual({ host: "127.0.0.1", port: 0 });
  });

  it("accepts an empty document when the overrides are a complete config", () => {
    const config = yamlToDaemonConfig("", {
      tokens: [{ id: "local", secret: "a-secret-long-enough-for-zod" }],
    });
    expect(config.tokens).toHaveLength(1);
  });

  it("accepts a pre-hashed secret and an agent list", () => {
    const yaml = `
tokens:
  - id: ops
    secretSha256: ${hashSecret("whatever")}
    role: admin
    cwdRoots: ["/srv"]
agents:
  - id: example
    command: /usr/bin/node
    args: ["agent.js"]
`;
    const config = yamlToDaemonConfig(yaml, {});
    expect(config.tokens?.[0]).toMatchObject({ id: "ops", role: "admin", cwdRoots: ["/srv"] });
    expect(config.agents?.[0]).toMatchObject({
      id: "example",
      command: "/usr/bin/node",
      args: ["agent.js"],
      protocolVersion: 1,
      shutdown: { signal: "SIGTERM", graceMs: 5_000 },
    });
  });

  it("rejects YAML that is not a mapping, and says so about the file", () => {
    expect(() => yamlToDaemonConfig("- a\n- b\n", {})).toThrow(/YAML mapping/);
    expect(() => yamlToDaemonConfig("just a string\n", {})).toThrow(/YAML mapping/);
  });

  it("reports a syntax error as a config error, not a stack from inside a parser", () => {
    expect(() => yamlToDaemonConfig("tokens: [\n", {})).toThrow(/not valid YAML/);
  });

  it("names the offending path when the shape is wrong", () => {
    expect(() => yamlToDaemonConfig("tokens: []\n", {})).toThrow(/invalid configuration: tokens/);
    expect(() => yamlToDaemonConfig("tokens:\n  - id: x\n    secret: short\n", {})).toThrow(
      /invalid configuration/,
    );
    // `strictObject`: a key this milestone does not accept is a typo, not an extension point.
    expect(() => yamlToDaemonConfig(`${MINIMAL}\npolicies: {}\n`, {})).toThrow(
      /invalid configuration/,
    );
  });

  it("rejects a token that carries both a secret and a hash", () => {
    const yaml = `
tokens:
  - id: local
    secret: a-secret-long-enough-for-zod
    secretSha256: ${hashSecret("x")}
`;
    expect(() => yamlToDaemonConfig(yaml, {})).toThrow(/invalid configuration/);
  });

  it("is pure: the same text and overrides give the same object, and neither is mutated", () => {
    const overrides = { dataDir: "/x" };
    const first = yamlToDaemonConfig(MINIMAL, overrides);
    const second = yamlToDaemonConfig(MINIMAL, overrides);
    expect(first).toEqual(second);
    expect(overrides).toEqual({ dataDir: "/x" });
  });
});
