// Harmless real MCP: receipt generation is the only tool. No shell, network or desktop access.
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const send = (value) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...value })}\n`);
createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  if (method === "initialize")
    return send({
      id,
      result: {
        protocolVersion: params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "omni-management-probe", version: "1.0.0" },
      },
    });
  if (method === "ping") return send({ id, result: {} });
  if (method === "tools/list")
    return send({
      id,
      result: {
        tools: [
          {
            name: "management_probe",
            description:
              "Return a fresh receipt for the supplied test nonce. Harmless MCP installation test; no filesystem reads, commands, network or desktop actions.",
            inputSchema: {
              type: "object",
              properties: { nonce: { type: "string" } },
              required: ["nonce"],
              additionalProperties: false,
            },
            annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
          },
        ],
      },
    });
  if (method === "tools/call" && params.name === "management_probe") {
    const record = { nonce: params.arguments.nonce, receipt: randomUUID(), pid: process.pid };
    appendFileSync(process.env.OMNI_MCP_PROBE_AUDIT, `${JSON.stringify(record)}\n`, {
      mode: 0o600,
    });
    return send({
      id,
      result: { content: [{ type: "text", text: JSON.stringify(record) }], isError: false },
    });
  }
  send({ id, error: { code: -32601, message: "Method not found" } });
});
