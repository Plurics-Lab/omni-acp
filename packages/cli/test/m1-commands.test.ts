import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../src/main.js";
import { parseArgs } from "../src/args.js";
import { declaresEventLogDriver, yamlToDaemonConfig } from "../src/yaml-config.js";
import { renderProbe, renderWorkers, targetOf } from "../src/remote.js";
import type { ProbeResponse, WorkerSnapshot } from "@omni-acp/protocol";

/**
 * M1's CLI (CONTRACTS.md §5.7): `omni-acp probe|agents|workers`, and ruling M1-R17's
 * `eventLog.driver: "sqlite"` on `start`.
 *
 * The three read-only commands are driven against a real loopback HTTP server rather than a
 * mocked `fetch`: they exist to talk to a daemon over a socket, and a double that never binds one
 * would not exercise the one thing they do.
 *
 * Owned by M1-WP-F.
 */

function sink(): {
  io: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream };
  out: () => string;
  err: () => string;
} {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: { write: (c: string) => ((stdout += c), true) } as unknown as NodeJS.WritableStream,
      stderr: { write: (c: string) => ((stderr += c), true) } as unknown as NodeJS.WritableStream,
    },
    out: () => stdout,
    err: () => stderr,
  };
}

/** A minimal `/v1` responder on a real ephemeral port — no daemon, just the shapes. */
async function serve(routes: Record<string, unknown>): Promise<{
  url: string;
  seen: { path: string; auth: string | null }[];
  close: () => Promise<void>;
}> {
  const { createServer } = await import("node:http");
  const seen: { path: string; auth: string | null }[] = [];
  const server = createServer((req, res) => {
    seen.push({ path: req.url ?? "", auth: req.headers.authorization ?? null });
    const body = routes[req.url ?? ""];
    res.writeHead(body === undefined ? 400 : 200, { "content-type": "application/json" });
    res.end(
      JSON.stringify(body ?? { code: "bad_request", message: `no route for ${req.url ?? ""}` }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempConfig(text: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "omni-cli-"));
  dirs.push(dir);
  const path = join(dir, "omni.yaml");
  await writeFile(path, text, "utf8");
  return path;
}

describe("parseArgs — the three M1 commands", () => {
  it("parses each command with its own flags", () => {
    expect(parseArgs(["agents", "--url", "http://d", "--token", "t"])).toEqual({
      cmd: "agents",
      url: "http://d",
      token: "t",
    });
    expect(parseArgs(["workers", "--include-closed", "--json"])).toEqual({
      cmd: "workers",
      includeClosed: true,
      json: true,
    });
    expect(parseArgs(["probe", "claude-acp", "--deep", "--force"])).toEqual({
      cmd: "probe",
      agent: "claude-acp",
      deep: true,
      force: true,
    });
  });

  it("keeps every flag scoped to the command that declares it", () => {
    // `--include-closed` is a `workers` flag and nothing else. A shared table would have made it
    // silently legal everywhere, which is how a typo becomes a no-op instead of an error.
    expect(parseArgs(["agents", "--include-closed"])).toEqual({
      cmd: "error",
      message: 'unknown flag "--include-closed"',
    });
    expect(parseArgs(["start", "--deep"])).toEqual({
      cmd: "error",
      message: 'unknown flag "--deep"',
    });
  });

  it("needs exactly one agent id for probe", () => {
    expect(parseArgs(["probe"])).toEqual({ cmd: "error", message: "probe needs an agent id" });
    expect(parseArgs(["probe", "a", "b"])).toEqual({
      cmd: "error",
      message: 'unexpected argument "b"',
    });
  });

  it("still parses every M0 `start` form, unchanged", () => {
    expect(parseArgs(["start", "--port=8080", "-c", "x.yaml", "--print-token"])).toEqual({
      cmd: "start",
      port: 8080,
      configPath: "x.yaml",
      printToken: true,
    });
    expect(parseArgs(["start", "--port", "notanumber"])).toEqual({
      cmd: "error",
      message: '--port must be an integer, got "notanumber"',
    });
  });
});

describe("ruling M1-R17 — `omni-acp start` writes sqlite, `createDaemon()` keeps memory", () => {
  it("is a DEFAULT, not an override: a config that chose a driver keeps it", () => {
    expect(declaresEventLogDriver("eventLog:\n  driver: memory\n")).toBe(true);
    expect(declaresEventLogDriver("eventLog:\n  retentionDays: 3\n")).toBe(false);
    expect(declaresEventLogDriver("")).toBe(false);
    // An operator who wrote `driver: memory` meant it. A `start` that silently reversed that is
    // the "magic in the schema" the ruling rejected, moved one layer up.
  });

  it("adds the driver WITHOUT deleting the file's other eventLog fields", () => {
    const config = yamlToDaemonConfig(
      "tokens: [{id: t, secret: 0123456789abcdef}]\neventLog: {retentionDays: 3}\n",
      { eventLog: { driver: "sqlite" } },
    );
    expect(config.eventLog?.driver).toBe("sqlite");
    // A shallow `{...yaml, ...overrides}` would have erased this, and the failure would only
    // surface as a retention policy nobody asked for.
    expect(config.eventLog?.retentionDays).toBe(3);
  });

  it("start with no config file builds a sqlite daemon", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omni-cli-data-"));
    dirs.push(dir);
    const io = sink();
    // `listen: null` is not reachable from the CLI, so this really does bind an ephemeral port
    // and really does open the database, then stops on the signal the test sends.
    const running = main(["start", "--data-dir", dir, "--port", "0"], {}, io.io);
    await new Promise<void>((resolve) => {
      const check = (): void => {
        if (io.out().includes("ready")) resolve();
        else setTimeout(check, 10);
      };
      check();
    });
    process.emit("SIGINT");
    expect(await running).toBe(0);

    const { readdir } = await import("node:fs/promises");
    // The observable half of M1-R17: a daemon started from a shell leaves a database behind,
    // because a long-running daemon must survive a restart.
    expect(await readdir(dir)).toContain("events.db");
  });

  it("start with `driver: memory` in the file leaves NO database behind", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omni-cli-data-"));
    dirs.push(dir);
    const config = await tempConfig(
      `dataDir: ${JSON.stringify(dir)}\nlisten: {host: 127.0.0.1, port: 0}\n` +
        "tokens: [{id: t, secret: 0123456789abcdef, role: admin}]\n" +
        "eventLog: {driver: memory}\n",
    );
    const io = sink();
    const running = main(["start", "--config", config], {}, io.io);
    await new Promise<void>((resolve) => {
      const check = (): void => {
        if (io.out().includes("ready")) resolve();
        else setTimeout(check, 10);
      };
      check();
    });
    process.emit("SIGINT");
    expect(await running).toBe(0);

    const { readdir } = await import("node:fs/promises");
    expect(await readdir(dir)).not.toContain("events.db");
  });
});

describe("omni-acp agents / workers / probe", () => {
  it("resolves the daemon from flags, then the environment, then says which is missing", () => {
    expect(targetOf({ url: "http://a/", token: "t" }, {}, "x")).toEqual({
      url: "http://a",
      token: "t",
    });
    expect(targetOf({}, { OMNI_ACP_URL: "http://b", OMNI_ACP_TOKEN: "e" }, "x")).toEqual({
      url: "http://b",
      token: "e",
    });
    expect(() => targetOf({}, {}, "omni-acp agents")).toThrow(/OMNI_ACP_URL/);
    expect(() => targetOf({ url: "http://a" }, {}, "omni-acp agents")).toThrow(/OMNI_ACP_TOKEN/);
  });

  it("lists agents over real loopback HTTP, with the token in the header and not the url", async () => {
    const server = await serve({
      "/v1/agents": {
        agents: [
          {
            id: "example",
            command: "/usr/bin/node",
            args: ["agent.js"],
            source: "config",
            probed: null,
            runtimeId: "example@abcdef012345",
          },
        ],
      },
    });
    try {
      const io = sink();
      const code = await main(
        ["agents", "--url", server.url, "--token", "secret-token-value"],
        {},
        io.io,
      );
      expect(code).toBe(0);
      expect(io.out()).toContain("example");
      expect(io.out()).toContain("example@abcdef012345");
      expect(server.seen[0]?.auth).toBe("Bearer secret-token-value");
      expect(server.seen[0]?.path).toBe("/v1/agents");
      // Never in the URL: a query parameter lands in every proxy log (§8.4).
      expect(server.seen[0]?.path).not.toContain("secret-token-value");
    } finally {
      await server.close();
    }
  });

  it("hides closed workers unless --include-closed, and prints `-` for a worker with no process", () => {
    const base = {
      daemonId: "d_01J00000000000000000000000",
      ref: "d_01J00000000000000000000000:w_01J00000000000000000000001",
      sessionId: "s1",
      cwd: "/tmp/w",
      label: null,
      ownerTokenId: "local",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      headSeq: 4,
      currentTurnId: null,
      capabilities: null,
      closeReason: null,
      lease: {
        workerId: "w_01J00000000000000000000001",
        holder: null,
        epoch: 1,
        expiresAt: null,
        acquiredAt: null,
        pinned: false,
      },
      hibernatedAt: null,
      crashed: false,
      resume: null,
      wakeCount: 0,
      wakeFailures: 0,
      orphan: null,
      generation: 1,
      runtimeId: "example@abcdef012345",
      persistence: "durable",
    } as unknown as WorkerSnapshot;

    const live = {
      ...base,
      workerId: "w_live",
      agentId: "example",
      state: "ready",
      process: { pid: 42 },
    } as unknown as WorkerSnapshot;
    const asleep = {
      ...base,
      workerId: "w_sleep",
      agentId: "example",
      state: "hibernated",
      process: null,
    } as unknown as WorkerSnapshot;
    const gone = {
      ...base,
      workerId: "w_gone",
      agentId: "example",
      state: "closed",
      process: null,
    } as unknown as WorkerSnapshot;

    const shown = renderWorkers([live, asleep, gone], {});
    expect(shown).toContain("w_live");
    expect(shown).toContain("w_sleep");
    expect(shown).not.toContain("w_gone");
    // §15.2: a hibernated worker owns no process, and `-` is the honest rendering of that `null`
    // rather than a stale pid from before the tree was reclaimed.
    expect(shown).toMatch(/w_sleep\s+example\s+hibernated\s+-/);

    expect(renderWorkers([live, asleep, gone], { includeClosed: true })).toContain("w_gone");
  });

  it("renders a probe summary including the rows that become `capability` skips", () => {
    const body: ProbeResponse = {
      cached: true,
      probe: {
        at: "2026-09-04T00:00:00.000Z",
        agentId: "claude-acp",
        descriptorFingerprint: "abcdef012345",
        protocolVersion: 1,
        agentInfo: { name: "claude-code-acp", version: "0.73.0" },
        capabilities: { loadSession: true },
        unsupportedMethods: ["session/set_model"],
        supportedMethods: ["session/resume"],
        resumeMethod: "session/resume",
        learnedParams: { setConfig: "configId" },
        timings: { initialize: 940 },
      },
    };

    const text = renderProbe(body);
    expect(text).toContain("claude-code-acp 0.73.0");
    expect(text).toContain("session/resume");
    // §18.3: an unsupported method is exactly a case the compat suite must skip with
    // `source: "capability"` rather than fail, so an operator has to be able to read the list.
    expect(text).toContain("session/set_model");
    // F17's learned param name, which is the whole reason the probe reads `-32602 data._errors`.
    expect(text).toContain("setConfig=configId");
    expect(text).toContain("cached         true");
  });

  it("--json prints the daemon's answer verbatim", async () => {
    const server = await serve({ "/v1/workers": { workers: [] } });
    try {
      const io = sink();
      await main(["workers", "--url", server.url, "--token", "t", "--json"], {}, io.io);
      expect(JSON.parse(io.out())).toEqual({ workers: [] });
    } finally {
      await server.close();
    }
  });

  it("reports the daemon's own message and exits 1, never a stack", async () => {
    const server = await serve({});
    try {
      const io = sink();
      const code = await main(["agents", "--url", server.url, "--token", "t"], {}, io.io);
      expect(code).toBe(1);
      expect(io.err()).toBe("omni-acp: no route for /v1/agents\n");
      expect(io.out()).toBe("");
    } finally {
      await server.close();
    }
  });

  it("says which variable is missing rather than failing at the socket", async () => {
    const io = sink();
    expect(await main(["agents"], {}, io.io)).toBe(1);
    expect(io.err()).toContain("OMNI_ACP_URL");
  });
});
