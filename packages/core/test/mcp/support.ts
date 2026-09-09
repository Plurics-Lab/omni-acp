import { DaemonConfig, OmniError, type ResolvedDaemonConfig } from "@omni-acp/protocol";

/** Long enough for `TokenConfig.secret`, and never a real one. */
export const SECRET = "mcp-fixture-secret-mcp-fixture-secret";

/**
 * A `ResolvedDaemonConfig` carrying the given preset table and nothing else remarkable.
 *
 * Built through `DaemonConfig.parse` rather than cast, because every default this suite relies on
 * — `type: "stdio"`, `args: []`, `headers: {}`, `env: {}` — is zod's, and a hand-written object
 * literal would be asserting against a shape the daemon never actually sees.
 */
export function configWith(mcpServers: Record<string, unknown>): ResolvedDaemonConfig {
  return DaemonConfig.parse({ tokens: [{ id: "t1", secret: SECRET }], mcpServers });
}

/** The fixture preset table: one of each transport, plus the two misconfigured shapes. */
export const PRESETS: Record<string, unknown> = {
  // stdio, the baseline — `command` + `args`, never a shell string (§6.3's rule, reused).
  files: { command: "mcp-files", args: ["--root", "/srv/w"], env: { MCP_FILES_MODE: "ro" } },
  // A second stdio preset, so "order is preserved" is observable.
  memory: { command: "mcp-memory", args: [] },
  // http, which needs `mcpCapabilities.http`.
  search: { type: "http", url: "https://mcp.example.invalid/search", headers: { "X-Key": "k" } },
  // sse, which needs `mcpCapabilities.sse`.
  feed: { type: "sse", url: "https://mcp.example.invalid/feed" },
};

export async function failure(p: Promise<unknown>): Promise<OmniError> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  if (!(e instanceof OmniError))
    throw new Error(`expected an OmniError, got ${String(e)}`, { cause: e });
  return e;
}

export function thrown(fn: () => unknown): OmniError {
  try {
    fn();
  } catch (e) {
    if (e instanceof OmniError) return e;
    throw new Error(`expected an OmniError, got ${String(e)}`, { cause: e });
  }
  throw new Error("expected a throw, got a return");
}
