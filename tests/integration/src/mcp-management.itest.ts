import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { OmniACP, type Server } from "@omni-acp/client";
import { createDaemon } from "@omni-acp/daemon";
import type { Daemon, DaemonConfig } from "@omni-acp/protocol";

const ADMIN = "mcp-test-admin-000000000000000000000";
const USER = "mcp-test-user-0000000000000000000000";
const MARKER = "installed-MCP-was-actually-called";
const source = `import {createInterface} from 'node:readline';
createInterface({input:process.stdin}).on('line',line=>{
const m=JSON.parse(line); if(m.id===undefined)return;
let result;
if(m.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'uploaded',version:'1'}};
else if(m.method==='tools/list')result={tools:[{name:'ping',inputSchema:{type:'object',properties:{}}}]};
else if(m.method==='tools/call')result={content:[{type:'text',text:'${MARKER}'}]};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
});`;

const servers: Server[] = [];
const daemons: Daemon[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const daemon of daemons.splice(0)) await daemon.stop({ graceful: true });
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function start(config: DaemonConfig) {
  const daemon = await createDaemon(config);
  daemons.push(daemon);
  await daemon.start();
  if (!daemon.url) throw new Error("daemon did not bind");
  const admin = await OmniACP.connect({ url: daemon.url, token: ADMIN });
  const user = await OmniACP.connect({ url: daemon.url, token: USER });
  servers.push(admin, user);
  return { daemon, admin, user };
}

describe("managed MCP deployment over real HTTP", () => {
  it("uploads, persists, registers, restricts and executes a real MCP via an ACP worker", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-managed-mcp-it-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const config: DaemonConfig = {
      dataDir: join(root, "data"),
      listen: { host: "127.0.0.1", port: 0 },
      mcpManagement: { directory: join(root, "managed") },
      tokens: [
        {
          id: "admin",
          secret: ADMIN,
          role: "admin",
          cwdRoots: [workspace],
          mcpManage: true,
          mcpInstall: true,
        },
        {
          id: "user",
          secret: USER,
          role: "user",
          cwdRoots: [workspace],
          mcpPresets: ["uploaded-v1"],
        },
      ],
      agents: [
        {
          id: "managed-fixture",
          command: process.execPath,
          args: [fileURLToPath(new URL("./support/managed-mcp-agent.mjs", import.meta.url))],
        },
      ],
    };
    const { daemon, admin, user } = await start(config);
    expect(admin.me).toMatchObject({
      mcpManage: true,
      mcpInstall: true,
      mcpManagementEnabled: true,
    });
    expect(user.me).toMatchObject({
      mcpManage: false,
      mcpInstall: false,
      mcpManagementEnabled: true,
    });
    const input = {
      name: "uploaded",
      version: "1",
      runtime: "node" as const,
      entrypoint: "main.mjs",
      files: [
        {
          path: "main.mjs",
          dataBase64: Buffer.from(source).toString("base64"),
          sha256: createHash("sha256").update(source).digest("hex"),
        },
      ],
    };
    await expect(user.mcp.install(input)).rejects.toMatchObject({ status: 403 });
    const installed = await admin.mcp.install(input);
    expect(installed.totalBytes).toBe(Buffer.byteLength(source));
    await admin.mcp.register({ name: "uploaded-v1", installationId: installed.id });
    await admin.mcp.register({
      name: "hidden-v1",
      server: {
        type: "http",
        url: "https://example.invalid/mcp",
        headers: { Authorization: "SECRET-HEADER" },
      },
    });
    expect((await user.mcp.list()).map((p) => p.name)).toEqual(["uploaded-v1"]);
    expect(JSON.stringify(await admin.mcp.list())).not.toContain("SECRET-HEADER");
    await expect(
      user.mcp.register({ name: "evil", server: { command: "sh" } }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      user.createAgent("managed-fixture", { cwd: workspace, mcp: ["hidden-v1"] }),
    ).rejects.toMatchObject({ status: 403 });
    const worker = await user.createAgent("managed-fixture", {
      cwd: workspace,
      mcp: ["uploaded-v1"],
    });
    const result = await worker.prompt("call the installed MCP");
    expect(JSON.stringify(result)).toContain(MARKER);
    await worker.close();
    await admin.close();
    await user.close();
    await daemon.stop({ graceful: true });
    daemons.splice(daemons.indexOf(daemon), 1);

    const next = await start(config);
    expect((await next.admin.mcp.installation(installed.id)).id).toBe(installed.id);
    expect((await next.user.mcp.get("uploaded-v1")).installationId).toBe(installed.id);
    // Verify that the files on disk are real, not metadata-only registration.
    const resolved = next.daemon.config.mcpServers["uploaded-v1"];
    expect(resolved?.command).toBe(process.execPath);
    const entrypoint = resolved?.args[0];
    expect(typeof entrypoint).toBe("string");
    expect(await readFile(entrypoint!, "utf8")).toBe(source);
    const restoredWorker = await next.user.createAgent("managed-fixture", {
      cwd: workspace,
      mcp: ["uploaded-v1"],
    });
    expect(JSON.stringify(await restoredWorker.prompt("call after daemon restart"))).toContain(
      MARKER,
    );
    await next.admin.mcp.remove("uploaded-v1");
    expect(await next.user.mcp.list()).toEqual([]);
    // Deletion is not revocation of a live connection; close that worker explicitly.
    expect(
      JSON.stringify(await restoredWorker.prompt("existing connection still works")),
    ).toContain(MARKER);
    await restoredWorker.close();
    await expect(
      next.admin.mcp.register({ name: "uploaded-v1", installationId: installed.id }),
    ).rejects.toMatchObject({ code: "mcp_conflict", status: 409 });
  });
});
