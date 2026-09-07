# omni-acp examples

| file                  | what it shows                                                                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `01-local.mjs`        | `OmniACP.local()` — embed the daemon in your process; `createAgent`, `prompt()`, `stream()`, `close()`                                                    |
| `02-remote.mjs`       | `OmniACP.connect()` to a running daemon; two parallel workers, `on("state")`, queue vs `worker_busy`, `attach` + lease steal, replaying `events({since})` |
| `daemon.example.yaml` | a daemon config for `omni-acp start --config …`                                                                                                           |

Prerequisites: `pnpm install && pnpm -r build` at the repo root, and a logged-in agent on this machine
(`claude` for claude-acp, `codex` for codex-acp). Both examples default to `claude-acp`; set `AGENT=codex-acp` to switch.

```bash
pnpm --filter @omni-acp/examples local

pnpm --filter @omni-acp/examples daemon          # terminal 1, prints the admin token
OMNI_TOKEN=… pnpm --filter @omni-acp/examples remote   # terminal 2
```
