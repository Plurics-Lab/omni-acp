import {
  OmniError,
  type InstallMcpRequest,
  type RegisterMcpPresetRequest,
  type McpInstallationMetadata,
  type McpPresetMetadata,
} from "@omni-acp/protocol";
import type { Transport } from "./transport.js";

/** Remote deployment management, separate from createAgent({mcp: [presetName]}).
 * Uploads contain prebuilt files; the daemon never executes install scripts.
 * Presets are immutable and removing one does not terminate existing workers.
 */
export interface McpChannel {
  list(): Promise<readonly McpPresetMetadata[]>;
  get(name: string): Promise<McpPresetMetadata>;
  register(input: RegisterMcpPresetRequest): Promise<McpPresetMetadata>;
  remove(name: string): Promise<void>;
  install(input: InstallMcpRequest): Promise<McpInstallationMetadata>;
  installations(): Promise<readonly McpInstallationMetadata[]>;
  installation(id: string): Promise<McpInstallationMetadata>;
}

export function createMcpChannel(transport: Transport, assertOpen: () => void): McpChannel {
  const segment = (value: string): string => {
    if (!value) throw new OmniError("bad_request", "an MCP resource name or id is required");
    return encodeURIComponent(value);
  };
  return {
    async list() {
      assertOpen();
      const body = await transport.request<{ presets: McpPresetMetadata[] }>(
        "GET",
        "/v1/mcp/presets",
      );
      return body.presets;
    },
    async get(name) {
      assertOpen();
      return transport.request<McpPresetMetadata>("GET", `/v1/mcp/presets/${segment(name)}`);
    },
    async register(input) {
      assertOpen();
      return transport.request<McpPresetMetadata>("POST", "/v1/mcp/presets", input);
    },
    async remove(name) {
      assertOpen();
      await transport.request("DELETE", `/v1/mcp/presets/${segment(name)}`);
    },
    async install(input) {
      assertOpen();
      return transport.request<McpInstallationMetadata>("POST", "/v1/mcp/installations", input);
    },
    async installations() {
      assertOpen();
      const body = await transport.request<{ installations: McpInstallationMetadata[] }>(
        "GET",
        "/v1/mcp/installations",
      );
      return body.installations;
    },
    async installation(id) {
      assertOpen();
      return transport.request<McpInstallationMetadata>(
        "GET",
        `/v1/mcp/installations/${segment(id)}`,
      );
    },
  };
}
