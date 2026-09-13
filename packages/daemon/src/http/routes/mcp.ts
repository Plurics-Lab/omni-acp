import { InstallMcpRequest, RegisterMcpPresetRequest } from "@omni-acp/protocol";
import type { Hono } from "hono";
import type { Daemon } from "../../types.js";
import { authMiddleware, authOf } from "../auth-middleware.js";
import { readBoundedJson } from "../bounded-json.js";

export function registerMcpRoutes(app: Hono, daemon: Daemon): void {
  const auth = authMiddleware(daemon);
  app.get("/v1/mcp/presets", auth, async (c) =>
    c.json(await daemon.mcp.listPresets(authOf(c.req.raw))),
  );
  app.get("/v1/mcp/presets/:name", auth, async (c) =>
    c.json(await daemon.mcp.getPreset(authOf(c.req.raw), c.req.param("name"))),
  );
  app.post("/v1/mcp/presets", auth, async (c) => {
    daemon.mcp.assertMutation(authOf(c.req.raw), "manage");
    return c.json(
      await daemon.mcp.registerPreset(
        authOf(c.req.raw),
        RegisterMcpPresetRequest.parse(await readBoundedJson(c.req.raw, 128 * 1024)),
      ),
      201,
    );
  });
  app.delete("/v1/mcp/presets/:name", auth, async (c) => {
    await daemon.mcp.removePreset(authOf(c.req.raw), c.req.param("name"));
    return c.json({});
  });
  app.get("/v1/mcp/installations", auth, async (c) =>
    c.json(await daemon.mcp.listInstallations(authOf(c.req.raw))),
  );
  app.get("/v1/mcp/installations/:id", auth, async (c) =>
    c.json(await daemon.mcp.getInstallation(authOf(c.req.raw), c.req.param("id"))),
  );
  app.post("/v1/mcp/installations", auth, async (c) => {
    daemon.mcp.assertMutation(authOf(c.req.raw), "install");
    return c.json(
      await daemon.mcp.install(
        authOf(c.req.raw),
        InstallMcpRequest.parse(
          await readBoundedJson(
            c.req.raw,
            Math.ceil((daemon.config.mcpManagement.maxUploadBytes * 4) / 3) +
              daemon.config.mcpManagement.maxFiles * 2048 +
              8192,
          ),
        ),
      ),
      201,
    );
  });
}
