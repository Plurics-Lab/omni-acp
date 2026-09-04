import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HEADER, type AgentListResponse } from "@omni-acp/protocol";
import { fakeSupervisor, nullLogger, seqIds } from "@omni-acp/testkit";
import { createDaemon } from "../../src/create-daemon.js";
import type { Daemon } from "../../src/types.js";
import { removeTempRoots, tempRoot } from "../support/temp-dirs.js";

/** ~800 leaked `/tmp` directories per full run without this; see `support/temp-dirs.ts`. */
afterEach(async () => {
  await removeTempRoots();
});

vi.mock("@omni-acp/core", async (importOriginal) => {
  const { fakeCoreModule } = await import("./../fake-core.js");
  return await fakeCoreModule(importOriginal as never);
});

const SECRET = "the-only-valid-secret-0123456789";

/**
 * H4 is readable by EVERY bearer token — `agents: []` restricts which agents a token may RUN, not
 * what the listing shows — so the listing is the widest audience any descriptor field has. A real
 * ACP agent is configured as `claude-code-acp --api-key sk-…`, which is exactly the argv shape
 * `ProcessInfo.argsRedacted` already refuses to serve on `GET /v1/workers/{id}`.
 */
async function daemonWithSecretArgs(): Promise<Daemon> {
  const root = await tempRoot("omni-http-agents-");
  return await createDaemon(
    {
      dataDir: join(root, "data"),
      listen: null,
      tokens: [
        // Lowest privilege on the daemon: role "user", and NOT permitted to use this agent.
        { id: "low", secret: SECRET, role: "user", agents: [], cwdRoots: [root] },
      ],
      agents: [
        {
          id: "claude",
          command: process.execPath,
          args: ["--model", "sonnet", "--api-key", "sk-ant-SUPER-SECRET", "--token=tok-SECRET"],
        },
      ],
      logLevel: "silent",
    },
    { supervisor: fakeSupervisor(), ids: seqIds(), logger: nullLogger() },
  );
}

describe("GET /v1/agents does not serve credentials (H4, DESIGN §8)", () => {
  it("redacts both `--api-key sk-x` and `--token=tok-x` spellings", async () => {
    const daemon = await daemonWithSecretArgs();
    const res = await daemon.fetch(
      new Request("http://daemon.invalid/v1/agents", {
        headers: { [HEADER.auth]: `Bearer ${SECRET}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as AgentListResponse;

    expect(body.agents).toEqual([
      {
        id: "claude",
        command: process.execPath,
        args: ["--model", "sonnet", "--api-key", "<redacted>", "--token=<redacted>"],
        source: "config",
        probed: null,
        // Which quirk table WILL govern a worker created now (§5.1 AgentCatalogEntry): the
        // agent id, then 12 hex characters of the real sha256 over command ⊕ args ⊕ version.
        runtimeId: expect.stringMatching(/^claude@[0-9a-f]{12}$/) as unknown as string,
      },
    ]);
    // Belt and braces: the secret must not appear ANYWHERE in the response bytes.
    expect(JSON.stringify(body)).not.toContain("sk-ant-SUPER-SECRET");
    expect(JSON.stringify(body)).not.toContain("tok-SECRET");

    await daemon.stop();
  });

  it("still launches the agent with the REAL argv — redaction is the description, not the spec", async () => {
    const daemon = await daemonWithSecretArgs();
    const spec = daemon.catalog.toSpawnSpec(daemon.catalog.get("claude"), { cwd: tmpdir() });
    expect(spec.args).toEqual([
      "--model",
      "sonnet",
      "--api-key",
      "sk-ant-SUPER-SECRET",
      "--token=tok-SECRET",
    ]);
    await daemon.stop();
  });
});
