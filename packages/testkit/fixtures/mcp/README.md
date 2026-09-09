# `fixtures/mcp/` — the MCP preset table, the recorded capability blocks, and the wire recorder

Owned by **M2-B-WP-S** (`docs/M2-PLAN.md` §3).

Three files, and they are here together because they answer the same question from three sides:
**what did the agent actually receive?**

| file                | what it is                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `presets.json`      | the operator preset table every WP-S suite resolves against — one entry per transport (`stdio` ×2, `http`, `sse`). **Data, never launched.** DESIGN §8's 🔴 says a client may name a preset and may never express a command, so the commands in here exist to prove that the only place one can appear is `DaemonConfig.mcpServers`; the binaries resolve to nothing on any machine, on purpose |
| `capabilities.json` | the `mcpCapabilities` blocks the two real agents **actually advertise**, copied out of the corpora with their transcript path beside them. claude-acp says `{http:true, sse:true}`; codex-acp says `{acp:false, http:true, sse:false}` **and takes stdio anyway**, which is the whole argument of CONTRACTS §23.2                                                                               |
| `wire-recorder.mjs` | a dependency-free ndJSON ACP agent that answers a handshake and a prompt and **writes down every request it received** to `$RECORDER_LOG`                                                                                                                                                                                                                                                       |

## Why the recorder exists

Two of WP-S's acceptance bullets are claims about what did or did not reach an agent, and neither
can be checked from our side of the pipe:

- **§26 / F37 / F38** — "in every rejected case the fixture agent recorded **zero** `session/prompt`
  calls". `resource_link` is accepted by both real agents and contained by neither: claude-acp's
  only marker for an out-of-`cwd` read is the English string
  `"Reason: Path is outside allowed working directories"`, which `no-agent-prose` forbids us from
  branching on, and codex-acp reads both files in one call whose `locations` lists only the inside
  one and whose `rawInput` is absent entirely. So containment is ours, before the send, or it does
  not exist — and "before the send" is only provable from the agent's own record.
- **§12.3 row 22** — the `McpServer` `type` injection, implemented in M1 and unreachable from the
  wire because `mcpServers` was always `[]`. The recorded `session/new` params are the first look
  at what a resolved preset looks like on the wire.

It speaks JSON-RPC by hand rather than through `@agentclientprotocol/sdk` so that it can be
launched as `process.execPath <file>` from a `mkdtemp` workspace with no `node_modules`, and so
that a bug in the SDK's framing cannot be mistaken for a bug in ours. Never through `npx`
(CONTRACTS §6.3).

There is no `fixtureAgentPath()`-style helper for these: `packages/testkit/src/index.ts` is frozen
for M2, so consumers resolve the paths themselves.
