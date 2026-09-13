// Opt-in live test: uses logged-in native agents and may consume subscription/API quota.
// Usage: node scripts/test-mcp-management-live.mjs /absolute/path/agents.json
// Config: {claude:{binary,adapter},codex:{binary,adapter}}; adapter paths are cached JS entrypoints.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createDaemon } from "../packages/daemon/dist/index.js";
import { OmniACP } from "../packages/client/dist/index.js";

if (!process.argv[2])
  throw new Error("Supply a JSON file with native binary and ACP adapter paths");
const native = JSON.parse(await readFile(process.argv[2], "utf8"));
const selected = (process.env.OMNI_MCP_LIVE_AGENTS ?? "claude,codex").split(",");
if (selected.some((kind) => !["claude", "codex"].includes(kind)))
  throw new Error("Unknown live agent selection");
const root = await realpath(await mkdtemp(join(tmpdir(), "omni-mcp-native-")));
const workspace = join(root, "workspace");
await mkdir(workspace);
const auditFile = join(root, "probe-audit.jsonl");
const report = {
  root,
  startedAt: new Date().toISOString(),
  agents: native,
  checks: [],
  stages: [],
};
const note = (stage, details = {}) => console.log(JSON.stringify({ stage, ...details }));
note("start", { root });

function run(binary, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: workspace,
      env: { ...process.env, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let stdout = "",
      stderr = "";
    const timeout = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        /* already gone */
      }
      setTimeout(() => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* gone */
        }
      }, 3000).unref();
    }, 180_000);
    child.stdout.on("data", (b) => {
      stdout += b;
    });
    child.stderr.on("data", (b) => {
      stderr += b;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr });
    });
  });
}
async function receipts(nonce) {
  const content = await readFile(auditFile, "utf8").catch(() => "");
  return content
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((row) => row.nonce === nonce);
}
const prompt = (nonce) =>
  `This is a narrow MCP installation acceptance test. Call the management_probe tool from the omni-probe MCP exactly once with nonce ${nonce}. Do not use shell, file, web, other MCP tools or subagents. Return the receipt from the tool result verbatim in your final answer. If the tool is unavailable, say UNAVAILABLE; do not invent a receipt.`;
async function check(label, action) {
  const started = Date.now();
  note("running", { label });
  try {
    const result = await action();
    const row = { label, ...result, durationMs: Date.now() - started };
    report.stages.push(row);
    note("result", row);
  } catch (error) {
    const row = { label, passed: false, error: String(error), durationMs: Date.now() - started };
    report.stages.push(row);
    note("result", row);
  }
  await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
}

const token = randomBytes(32).toString("hex");
const userToken = randomBytes(32).toString("hex");
const agents = [
  {
    id: "claude-acp",
    command: process.execPath,
    args: [native.claude.adapter],
    env: {
      CLAUDE_CODE_EXECUTABLE: native.claude.binary,
    },
  },
  {
    id: "codex-acp",
    command: process.execPath,
    args: [native.codex.adapter],
    env: {
      CODEX_PATH: native.codex.binary,
      CODEX_CONFIG: JSON.stringify({
        approval_policy: "never",
        sandbox_mode: "read-only",
        model_reasoning_effort: "low",
      }),
    },
  },
];
const config = {
  dataDir: join(root, "data"),
  listen: { host: "127.0.0.1", port: 0 },
  logLevel: "error",
  handshakeTimeoutMs: 90000,
  mcpManagement: { directory: join(root, "managed") },
  tokens: [
    {
      id: "deployer",
      secret: token,
      role: "admin",
      cwdRoots: [workspace],
      mcpManage: true,
      mcpInstall: true,
    },
    {
      id: "worker",
      secret: userToken,
      cwdRoots: [workspace],
      agents: ["claude-acp", "codex-acp"],
      mcpPresets: ["omni-probe"],
    },
  ],
  agents,
};
let daemon, admin, user;
try {
  daemon = await createDaemon(config);
  await daemon.start();
  admin = await OmniACP.connect({ url: daemon.url, token });
  user = await OmniACP.connect({ url: daemon.url, token: userToken, requestTimeoutMs: 120000 });
  const bytes = await readFile(new URL("./fixtures/management-probe.mjs", import.meta.url));
  const installInput = {
    name: "omni-probe",
    version: "1.0.0",
    runtime: "node",
    entrypoint: "server.mjs",
    files: [
      {
        path: "server.mjs",
        dataBase64: bytes.toString("base64"),
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    ],
  };
  const installed = await admin.mcp.install(installInput);
  await admin.mcp.register({
    name: "omni-probe",
    installationId: installed.id,
    env: { OMNI_MCP_PROBE_AUDIT: auditFile },
  });
  report.installation = installed;
  const launch = daemon.config.mcpServers["omni-probe"];
  note("installed", { id: installed.id });
  try {
    await user.mcp.install(installInput);
    report.checks.push({ name: "user-install-denied", passed: false });
  } catch (error) {
    report.checks.push({ name: "user-install-denied", passed: error.status === 403 });
  }

  for (const kind of selected) {
    await check(`${kind}-native-cli`, async () => {
      const nonce = randomUUID();
      let args;
      if (kind === "claude")
        args = [
          "-p",
          "--setting-sources",
          "",
          "--settings",
          JSON.stringify({ disableAllHooks: true }),
          "--disable-slash-commands",
          "--no-session-persistence",
          "--strict-mcp-config",
          "--mcp-config",
          JSON.stringify({ mcpServers: { "omni-probe": launch } }),
          "--tools",
          "",
          "--allowedTools",
          "mcp__omni-probe__management_probe",
          "--model",
          "haiku",
          "--output-format",
          "json",
          prompt(nonce),
        ];
      else {
        const overrides = `mcp_servers.omni-probe={command=${JSON.stringify(launch.command)},args=${JSON.stringify(launch.args)},env={OMNI_MCP_PROBE_AUDIT=${JSON.stringify(auditFile)}},required=true}`;
        args = [
          "exec",
          "--ignore-user-config",
          "--ignore-rules",
          "--ephemeral",
          "--skip-git-repo-check",
          "--sandbox",
          "read-only",
          "--json",
          "-c",
          overrides,
          "-c",
          'approval_policy="never"',
          "-c",
          'model_reasoning_effort="low"',
          prompt(nonce),
        ];
      }
      const output = await run(native[kind].binary, args);
      await writeFile(join(root, `${kind}-native.stdout`), output.stdout, { mode: 0o600 });
      await writeFile(join(root, `${kind}-native.stderr`), output.stderr, { mode: 0o600 });
      const calls = await receipts(nonce);
      return {
        passed:
          output.code === 0 &&
          calls.length > 0 &&
          calls.some((c) => output.stdout.includes(c.receipt)),
        exitCode: output.code,
        calls,
        outputFile: join(root, `${kind}-native.stdout`),
      };
    });
  }

  for (const kind of selected) {
    await check(`${kind}-via-omni-acp`, async () => {
      const nonce = randomUUID();
      let worker;
      try {
        worker = await user.createAgent(`${kind}-acp`, {
          cwd: workspace,
          mcp: ["omni-probe"],
          timeoutMs: 120000,
          idleTimeoutMs: 0,
          policy: {
            default: "deny",
            rules: [
              {
                id: "probe",
                match: { subject: "tool_call", kind: ["other", "read"] },
                action: "allow",
              },
            ],
          },
        });
        note("worker-ready", {
          kind,
          id: worker.id,
          options: worker.snapshot.configOptions?.map((o) => ({
            id: o.id,
            currentValue: o.currentValue,
          })),
        });
        if (kind === "claude" && worker.snapshot.configOptions?.some((o) => o.id === "model"))
          await worker.setConfig("model", "haiku");
        const result = await worker.prompt(prompt(nonce), { signal: AbortSignal.timeout(180000) });
        const serialized = JSON.stringify(result);
        await writeFile(join(root, `${kind}-acp-result.json`), serialized, { mode: 0o600 });
        const calls = await receipts(nonce);
        return {
          passed: calls.length > 0 && calls.some((c) => serialized.includes(c.receipt)),
          workerId: worker.id,
          calls,
          stopReason: result.stopReason,
          resultFile: join(root, `${kind}-acp-result.json`),
        };
      } finally {
        await worker?.close().catch(() => {});
      }
    });
  }
  await admin.mcp.remove("omni-probe");
  report.checks.push({ name: "preset-delete", passed: (await user.mcp.list()).length === 0 });
} finally {
  await user?.close();
  await admin?.close();
  await daemon?.stop({ graceful: true });
  report.finishedAt = new Date().toISOString();
  await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  const passed =
    report.stages.length === selected.length * 2 &&
    report.stages.every((s) => s.passed) &&
    report.checks.every((s) => s.passed);
  note("finished", { report: join(root, "report.json"), passed });
  if (!passed) process.exitCode = 1;
}
