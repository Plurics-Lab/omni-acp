import { OmniACP, type InstallMcpRequest } from "@omni-acp/client";
import { describe, expect, it } from "vitest";
import { createWireDaemon, fetchOf } from "./support/wire-daemon.js";

const preset = { name: "desktop-v1", type: "stdio", source: "managed" };
const installation = {
  id: "a".repeat(64),
  name: "desktop",
  version: "1.0.0",
  runtime: "node",
  fileCount: 1,
  totalBytes: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
};

async function setup(status = 200) {
  const wire = createWireDaemon();
  const calls: { path: string; method: string; body: unknown }[] = [];
  const server = await OmniACP.connect({
    url: wire.url,
    token: wire.token,
    fetch: async (input, init) => {
      const req = input instanceof Request && init === undefined ? input : new Request(input, init);
      const path = new URL(req.url).pathname;
      if (!path.startsWith("/v1/mcp/")) return fetchOf(wire.daemon)(req);
      const raw = await req.text();
      calls.push({ path, method: req.method, body: raw ? JSON.parse(raw) : undefined });
      if (status !== 200)
        return Response.json({ code: "forbidden", message: "MCP permission denied" }, { status });
      if (path === "/v1/mcp/presets" && req.method === "GET")
        return Response.json({ presets: [preset] });
      if (path === "/v1/mcp/installations" && req.method === "GET")
        return Response.json({ installations: [installation] });
      return Response.json(path.includes("installations") ? installation : preset);
    },
  });
  return { server, calls };
}

describe("server.mcp", () => {
  it("lists metadata and registers a preset separately from worker creation", async () => {
    const { server, calls } = await setup();
    expect(await server.mcp.list()).toEqual([preset]);
    expect(await server.mcp.get("desktop-v1")).toEqual(preset);
    const input = { name: "desktop-v1", installationId: installation.id };
    expect(await server.mcp.register(input)).toEqual(preset);
    expect(calls[2]).toEqual({ path: "/v1/mcp/presets", method: "POST", body: input });
    await server.mcp.remove("desktop-v1");
    expect(calls[3]?.method).toBe("DELETE");
    await server.close();
  });

  it("uploads the manifest without reading local files or executing commands", async () => {
    const { server, calls } = await setup();
    const input: InstallMcpRequest = {
      name: "desktop",
      version: "1.0.0",
      runtime: "node",
      entrypoint: "main.mjs",
      files: [{ path: "main.mjs", dataBase64: "", sha256: "b".repeat(64) }],
    };
    expect(await server.mcp.install(input)).toEqual(installation);
    expect(calls[0]).toEqual({ path: "/v1/mcp/installations", method: "POST", body: input });
    expect(await server.mcp.installations()).toEqual([installation]);
    expect(await server.mcp.installation(installation.id)).toEqual(installation);
    await server.close();
  });

  it("encodes path segments and rejects empty identifiers without a request", async () => {
    const { server, calls } = await setup();
    await server.mcp.get("name/with?special");
    expect(calls[0]?.path).toBe("/v1/mcp/presets/name%2Fwith%3Fspecial");
    await expect(server.mcp.get("")).rejects.toMatchObject({ code: "bad_request" });
    await expect(server.mcp.remove("")).rejects.toMatchObject({ code: "bad_request" });
    await expect(server.mcp.installation("")).rejects.toMatchObject({ code: "bad_request" });
    expect(calls).toHaveLength(1);
    await server.close();
  });

  it("preserves daemon permission failures", async () => {
    const { server } = await setup(403);
    await expect(
      server.mcp.register({ name: "x", server: { command: "node" } }),
    ).rejects.toMatchObject({ code: "forbidden", status: 403 });
    await server.close();
  });

  it("refuses all MCP operations after the server is closed", async () => {
    const { server, calls } = await setup();
    await server.close();
    const input: InstallMcpRequest = {
      name: "x",
      version: "1",
      runtime: "node",
      entrypoint: "x",
      files: [],
    };
    for (const operation of [
      () => server.mcp.list(),
      () => server.mcp.get("x"),
      () => server.mcp.remove("x"),
      () => server.mcp.register({ name: "x", server: { command: "node" } }),
      () => server.mcp.install(input),
      () => server.mcp.installations(),
      () => server.mcp.installation(installation.id),
    ])
      await expect(operation()).rejects.toMatchObject({ code: "bad_request" });
    expect(calls).toHaveLength(0);
  });
});
