# Native agent acceptance — 2026-09-13

Tested on this Linux machine, with installed **native executables**, existing
subscription logins, and the local omni-acp build. No mock model or fixture agent
was used in these runs. The MCP itself is deliberately
a harmless test service, not Computer Use.

## Results

| Path | Executable / adapter | Result | Duration |
| --- | --- | --- | --- |
| Claude Code CLI → installed MCP | Claude Code 2.1.270 | PASS, one real tool call | 5.5 s |
| omni-acp → Claude ACP → native Claude → installed MCP | Adapter 0.73.0; native 2.1.270 | PASS, one real tool call | 10.4 s |
| Codex CLI → installed MCP | Codex CLI 0.154.0 | PASS, one real tool call | 14.3 s |
| omni-acp → Codex ACP → native Codex → installed MCP | Adapter 1.8.0; native 0.154.0 | PASS, one real tool call | 18.5 s |

The Claude calls used the `haiku` model alias (native CLI reported
`claude-haiku-4-5-20251001`). The Codex ACP worker reported `gpt-6-astra` with low
reasoning effort. ACP adapters were explicitly configured with
`CLAUDE_CODE_EXECUTABLE` and `CODEX_PATH`, so their bundled default executables
were not the target of this test.

For each run, the client uploaded `scripts/fixtures/management-probe.mjs` via
`server.mcp.install()`, registered the resulting installation as `omni-probe`,
and supplied a unique nonce in the prompt. The MCP generated a fresh random
receipt **only when `tools/call` actually executed**. A private audit log recorded
the nonce, receipt and MCP PID; the response was checked against that receipt.
This does not count a model's textual imitation of a tool call as success.

The ACP cases created real workers with `mcp: ["omni-probe"]`. Claude exposed
`mcp__omni-probe__management_probe`; Codex exposed
`mcp.omni-probe.management_probe`. Both completed the tool call and returned the
receipt. The direct CLI cases used the exact installed program and launch
configuration but, naturally, did not exercise ACP transport themselves.

Both runs also verified that the ordinary worker token cannot install an MCP
(403), and that deleting the preset removes it from that token's listing.
All test workers and daemons were stopped; the four successful MCP process IDs
were verified absent afterwards. No global MCP configuration was edited.

## Initial failure retained, not counted as a pass

The first Claude attempt used `--safe-mode` / `CLAUDE_CODE_SAFE_MODE=1` to isolate
customizations. Native Claude's help explicitly says that this also disables
MCP servers. Neither Claude path executed the probe in that attempt. The direct
CLI generated tool-call-looking text; the ACP worker's ToolSearch returned no
matching tools. Both were correctly recorded as failures because the audit log
contained no call.

The test configuration was corrected: direct Claude now uses explicit MCP
configuration with `--strict-mcp-config`, empty setting sources and disabled
hooks, without safe mode. The ACP executable override remains unchanged and no
longer enables safe mode. Both Claude cases then passed. No production
management implementation change was needed.

Machine-local evidence (temporary storage, not durable across cleanup/reboot):

- Initial run, including both passing Codex cases:
  `/tmp/omni-mcp-native-XtE4F6/report.json`
- Corrected Claude run:
  `/tmp/omni-mcp-native-DtI1Aa/report.json`
- Each directory also contains the probe audit, direct CLI output and ACP turn
  results. No bearer tokens or credential files were deliberately exported into
  these reports.

Claude reported a non-blocking weekly subscription utilization warning of 98%
during the corrected ACP call. This is an account limit observation, not an MCP
management failure; avoid unnecessarily repeating live calls.

## Reproduce

Build with `pnpm build`. Supply an operator-owned JSON file:

```json
{
  "claude": { "binary": "/absolute/path/to/claude", "adapter": "/absolute/path/to/claude-agent-acp/dist/index.js" },
  "codex": { "binary": "/absolute/path/to/codex", "adapter": "/absolute/path/to/codex-acp/dist/index.js" }
}
```

```sh
node scripts/test-mcp-management-live.mjs /absolute/path/to/agents.json
# Optional: repeat only one agent's direct CLI and ACP paths.
OMNI_MCP_LIVE_AGENTS=claude node scripts/test-mcp-management-live.mjs /absolute/path/to/agents.json
```

This test consumes real model quota and is deliberately not part of `pnpm test`.
It prints a private temporary output directory and exits nonzero on failed
checks. Authentication is inherited from the daemon process; ensure only the
intended account and trusted user configuration are available to the adapters.

## Scope

This verifies prebuilt-file installation, preset registration/selection,
ordinary-user denial, deletion, and real stdio MCP calls through both native
agents and ACP adapters. It does **not** establish image forwarding, desktop
input correctness, HTTP/SSE/OAuth interoperability, cross-host network deployment,
or hotplug. The daemon ran on loopback and
the SDK crossed a real HTTP connection on this machine.
