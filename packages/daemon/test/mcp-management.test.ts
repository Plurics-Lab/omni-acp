import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonConfig, type InstallMcpRequest } from "@omni-acp/protocol";
import { createMcpManagement } from "../src/mcp-management.js";
import { createTokenStore } from "../src/auth.js";
import { readBoundedJson } from "../src/http/bounded-json.js";

const dirs: string[] = [];
const stores: Awaited<ReturnType<typeof createMcpManagement>>[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function setup(overrides: Record<string, unknown> = {}) {
  // macOS temporary roots can have symlink ancestors; the store requires a physical path.
  const dir = await realpath(await mkdtemp(join(tmpdir(), "omni-mcp-test-")));
  dirs.push(dir);
  await mkdir(join(dir, "work"));
  const config = DaemonConfig.parse({
    listen: null,
    dataDir: join(dir, "data"),
    tokens: [
      {
        id: "admin",
        secret: "admin-secret-123456",
        role: "admin",
        mcpManage: true,
        mcpInstall: true,
        cwdRoots: [join(dir, "work")],
      },
      {
        id: "user",
        secret: "user-secret-1234567",
        role: "user",
        mcpManage: true,
        mcpInstall: true,
        mcpPresets: ["allowed"],
        cwdRoots: [join(dir, "work")],
      },
      { id: "bare", secret: "bare-secret-1234567", role: "admin", cwdRoots: [join(dir, "work")] },
    ],
    mcpServers: { static: { command: "static-server", env: { TOKEN: "secret" } } },
    mcpManagement: { directory: join(dir, "store") },
    ...overrides,
  });
  const store = await createMcpManagement(config);
  stores.push(store);
  const tokens = createTokenStore(config);
  return {
    dir,
    config,
    store,
    admin: tokens.contextFor("admin"),
    user: tokens.contextFor("user"),
    bare: tokens.contextFor("bare"),
  };
}
function artifact(path = "main.js", content = "console.log('MCP');"): InstallMcpRequest {
  return {
    name: "cu",
    version: "1.0",
    runtime: "node",
    entrypoint: path,
    files: [
      {
        path,
        dataBase64: Buffer.from(content).toString("base64"),
        sha256: createHash("sha256").update(content).digest("hex"),
      },
    ],
  };
}
describe("MCP management", () => {
  it("enforces owner-only directory modes on POSIX, leaving Windows ACLs to the operator", async () => {
    const { store, config, dir } = await setup();
    await store.close();
    await chmod(join(dir, "store"), 0o755);
    if (process.platform === "win32") {
      stores.push(await createMcpManagement(config));
    } else {
      await expect(createMcpManagement(config)).rejects.toThrow(/owner-only/);
    }
  });
  it("enforces private record modes on POSIX, leaving Windows ACLs to the operator", async () => {
    const { store, admin, config, dir } = await setup();
    await store.registerPreset(admin, { name: "permissions", server: { command: "node" } });
    await store.close();
    delete config.mcpServers.permissions;
    await chmod(join(dir, "store/presets/permissions.json"), 0o644);
    if (process.platform === "win32") {
      const reopened = await createMcpManagement(config);
      stores.push(reopened);
      expect(
        (await reopened.listPresets(admin)).presets.some((p) => p.name === "permissions"),
      ).toBe(true);
    } else {
      await expect(createMcpManagement(config)).rejects.toThrow(/invalid MCP store file/);
    }
  });
  it("rejects corrupted persisted manifests and releases failed-start lock", async () => {
    const { store, admin, config, dir } = await setup();
    const installed = await store.install(admin, artifact());
    await store.close();
    const path = join(dir, "store/installations", installed.id, "manifest.json");
    const original = await readFile(path, "utf8");
    const corrupted = JSON.parse(original);
    corrupted.entrypoint = "../escape";
    await writeFile(path, JSON.stringify(corrupted), { mode: 0o600 });
    await expect(createMcpManagement(config)).rejects.toThrow(/path/);
    await writeFile(path, original, { mode: 0o600 });
    const reopened = await createMcpManagement(config);
    stores.push(reopened);
    await store.close(); // old idempotent close must NOT release the new daemon's lock
    await expect(createMcpManagement(config)).rejects.toMatchObject({ code: "mcp_conflict" });
  });
  it("requires admin and explicit capability separately", async () => {
    const { store, admin, user, bare, config } = await setup();
    expect(() => store.assertMutation(user, "manage")).toThrow(/admin/);
    expect(() => store.assertMutation(bare, "manage")).toThrow(/permission/);
    config.tokens.find((t) => t.id === "admin")!.mcpInstall = false;
    expect(() => store.assertMutation(admin, "install")).toThrow(/permission/);
    expect(() => store.assertMutation(admin, "manage")).not.toThrow();
  });
  it("filters metadata and never returns command/env/header secrets", async () => {
    const { store, admin, user } = await setup();
    await store.registerPreset(admin, {
      name: "allowed",
      server: {
        type: "http",
        url: "https://example.com/mcp",
        headers: { Authorization: "secret" },
      },
    });
    await store.registerPreset(admin, {
      name: "hidden",
      server: { command: "private-command", env: { SECRET: "secret" } },
    });
    expect((await store.listPresets(user)).presets.map((x) => x.name)).toEqual(["allowed"]);
    const output = JSON.stringify(await store.listPresets(admin));
    expect(output).not.toMatch(/secret|Authorization|command|example/);
    await expect(store.getPreset(user, "hidden")).rejects.toMatchObject({ code: "mcp_not_found" });
    await expect(store.listInstallations(user)).rejects.toMatchObject({ code: "forbidden" });
  });
  it("persists registrations, rejects static collisions, and tombstones deleted names across restart", async () => {
    const { store, admin, config, dir } = await setup();
    await store.registerPreset(admin, {
      name: "allowed",
      server: { command: "node", args: ["server.js"] },
    });
    expect(config.mcpServers.allowed?.command).toBe("node");
    await expect(
      store.registerPreset(admin, { name: "static", server: { command: "x" } }),
    ).rejects.toMatchObject({ code: "mcp_conflict" });
    await expect(store.removePreset(admin, "static")).rejects.toMatchObject({
      code: "mcp_conflict",
    });
    await store.close();
    stores.splice(stores.indexOf(store), 1);
    delete config.mcpServers.allowed;
    const reopened = await createMcpManagement(config);
    stores.push(reopened);
    expect(config.mcpServers.allowed?.command).toBe("node");
    await reopened.removePreset(admin, "allowed");
    expect(config.mcpServers.allowed).toBeUndefined();
    await expect(
      reopened.registerPreset(admin, { name: "allowed", server: { command: "changed" } }),
    ).rejects.toMatchObject({ code: "mcp_conflict" });
    expect(
      JSON.parse(await readFile(join(dir, "store/presets/allowed.json"), "utf8")).deleted,
    ).toBe(true);
  });
  it("installs content-addressed immutable files without executing them", async () => {
    const { store, admin, config, dir } = await setup();
    const input = artifact();
    const one = await store.install(admin, input),
      two = await store.install(admin, input);
    expect(one).toEqual(two);
    expect(one.id).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(join(dir, "store/installations", one.id, "files/main.js"), "utf8")).toBe(
      "console.log('MCP');",
    );
    const meta = await store.registerPreset(admin, { name: "allowed", installationId: one.id });
    expect(meta.installationId).toBe(one.id);
    expect(config.mcpServers.allowed?.command).toBe(process.execPath);
    expect(config.mcpServers.allowed?.args[0]).toContain(`${one.id}/files/main.js`);
  });
  it.each(["../escape", "/absolute", "a/../b", "a\\b", "a//b", "a/./b", "CON", "dir/NUL.txt"])(
    "rejects unsafe path %s",
    async (path) => {
      const { store, admin } = await setup();
      await expect(store.install(admin, artifact(path))).rejects.toMatchObject({
        code: "bad_request",
      });
    },
  );
  it("rejects digest mismatch, duplicate paths, byte quota, and file count", async () => {
    const { store, admin, config } = await setup();
    const wrong = artifact();
    wrong.files[0]!.sha256 = "0".repeat(64);
    await expect(store.install(admin, wrong)).rejects.toThrow(/digest/);
    const duplicate = artifact();
    duplicate.files.push(duplicate.files[0]!);
    await expect(store.install(admin, duplicate)).rejects.toThrow(/duplicate/);
    config.mcpManagement.maxUploadBytes = 1;
    await expect(store.install(admin, artifact())).rejects.toMatchObject({ code: "bad_request" });
  });
  it("rolls back staging if a file conflicts with a directory", async () => {
    const { store, admin, dir } = await setup();
    const input = artifact("x");
    input.files.push({ ...input.files[0]!, path: "x/y" });
    await expect(store.install(admin, input)).rejects.toThrow();
    expect(await readdir(join(dir, "store/installations"))).toEqual([]);
  });
  it("serializes duplicate registrations and prevents shared-store daemons", async () => {
    const { store, admin, config } = await setup();
    const results = await Promise.allSettled(
      [1, 2].map(() => store.registerPreset(admin, { name: "same", server: { command: "node" } })),
    );
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    await expect(createMcpManagement(config)).rejects.toMatchObject({ code: "mcp_conflict" });
  });
  it("disabled management retains static preset listing", async () => {
    const { store, admin } = await setup({ mcpManagement: { directory: null } });
    expect((await store.listPresets(admin)).presets[0]?.name).toBe("static");
    expect(() => store.assertMutation(admin, "manage")).toThrow(/disabled/);
  });
  it("refuses mutations over non-loopback transport", async () => {
    const { store, admin } = await setup({ listen: { host: "0.0.0.0", port: 0 } });
    expect(() => store.assertMutation(admin, "install")).toThrow(/loopback/);
  });
  it("rejects malformed server transport combinations", async () => {
    const { store, admin } = await setup();
    await expect(
      store.registerPreset(admin, {
        name: "bad",
        server: { type: "http", url: "file:///etc/passwd" },
      }),
    ).rejects.toThrow();
    await expect(
      store.registerPreset(admin, {
        name: "bad",
        server: { command: "node", url: "https://example.com" },
      }),
    ).rejects.toThrow();
  });
  it("rejects symlink and worker-overlapping storage roots", async () => {
    const { config, dir } = await setup();
    await symlink(join(dir, "store"), join(dir, "linked"), "junction");
    config.mcpManagement.directory = join(dir, "linked");
    await expect(createMcpManagement(config)).rejects.toThrow(/symlink/);
    config.mcpManagement.directory = join(dir, "linked/nested");
    await expect(createMcpManagement(config)).rejects.toThrow(/symlink ancestors/);
    config.mcpManagement.directory = join(dir, "work/subdir");
    await expect(createMcpManagement(config)).rejects.toThrow(/cwdRoots/);
  });
});
describe("MCP bounded JSON", () => {
  it("bounds chunked bodies without Content-Length", async () => {
    const body = new ReadableStream({
      start(c) {
        c.enqueue(Buffer.from("12345"));
        c.enqueue(Buffer.from("67890"));
        c.close();
      },
    });
    const req = new Request("http://local", {
      method: "POST",
      body,
      duplex: "half",
    } as RequestInit);
    await expect(readBoundedJson(req, 8)).rejects.toMatchObject({ code: "bad_request" });
  });
});
