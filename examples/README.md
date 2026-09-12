# omni-acp examples

| file                  | what it shows                                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `01-local.mjs`        | `OmniACP.local()` — embed the daemon in your process; `createAgent`, `prompt()`, `stream()`, `close()`                                                              |
| `02-remote.mjs`       | `OmniACP.connect()` to a running daemon; two parallel workers, `on("state")`, queue vs `worker_busy`, `attach` + lease steal, replaying `events({since})`           |
| `03-interactive.mjs`  | M2: `onUnresolved:"park"` + `on("interaction")`, `setConfig`, and `TurnResult.patch` — the disk truth                                                               |
| `04-run-webhook.mjs`  | M2: `server.runs.create()` plus a thin signed webhook (eight keys; the receiver pulls the rest back)                                                                |
| `05-credentials.mjs`  | M3-WP1: `localCredential` → `credentials.put`, two workers with two homes and ONE canonical credential file, `restart()`, `setCredential()`                         |
| `m3-acceptance.mjs`   | the M3-WP1 acceptance script, run for real against one agent: `node m3-acceptance.mjs claude\|codex`. Its output is `docs/M3-WP1-CREDENTIALS.md` §Real-agent record |
| `daemon.example.yaml` | a daemon config for `omni-acp start --config …`                                                                                                                     |

Prerequisites: `pnpm install && pnpm -r build` at the repo root, and a logged-in agent on this machine
(`claude` for claude-acp, `codex` for codex-acp). Every example defaults to `claude-acp`; set `AGENT=codex-acp` to switch.
`03` needs `git` on `PATH` for the patch half — without one the turn still runs and `patch` is `null` with
`patch_git_missing`, which is the provider being honest rather than the example being broken.

```bash
pnpm --filter @omni-acp/examples local
pnpm --filter @omni-acp/examples interactive     # park -> answer -> patch -> setConfig
pnpm --filter @omni-acp/examples run-webhook     # a Run, and one signed delivery
pnpm --filter @omni-acp/examples credentials     # store a login, two homes, restart, rotate

pnpm --filter @omni-acp/examples daemon          # terminal 1, prints the admin token
OMNI_TOKEN=… pnpm --filter @omni-acp/examples remote   # terminal 2
```

The M2 surface these two use, in one place:

```js
// stop and ask a human instead of auto-deciding (D4, D10)
const w = await server.createAgent(agentId, {
  cwd,
  onUnresolved: "park", // "park" is ALSO what declares clientCapabilities.elicitation
  policy: { default: "park" }, // or a preset name: "readonly" | "src-edit" | "full" | "deny-all"
  parkTimeoutMs: 0, // 0 = wait for a human forever
  patch: "on_write", // per-worker diff.mode; "off" opts out of the git patch
  watchdog: { toolMs: 600_000 }, // per-worker override of the idle budgets
  mcp: ["fs-readonly"], // preset NAMES only — a client can never send a command
  env: { MY_FLAG: "1" }, // a blacklisted key is REJECTED by name, never dropped
});
w.on("interaction", (req) => req.allow()); // or req.deny() / req.answer({question_0: "notes.md"})
await w.setConfig("model", "haiku"); // returns the FULL replacement list; membership can shrink
result.patch; // the turn's real diff, or null WITH a named warning

await server.runs.create({ agent, cwd, prompt, webhook: { url, secret: "ci" } });
```

And the M3-WP1 surface, likewise in one place:

```js
// the login is read on THIS side: a daemon that read ~/.claude for you would read any path
await server.credentials.put(agentId, await OmniACP.localCredential(agentId));
const w = await server.createAgent(agentId, {
  cwd,
  credential: "default", // a NAME, never a value. "none" ⇒ 422 at create; "inherit" ⇒ M2
  home: "isolated", // the default: <dataDir>/homes/<wid>, credential SYMLINKED to the store
});
w.snapshot.credential; // {name, method, fingerprint} — 12 hex, never the secret
await w.restart(); // same id, same lease, same home, same session, generation + 1
await w.restart({ force: true }); // interrupts a live turn: error.code "restarted", no fake idle
await w.setCredential("rotated"); // `applied` is what HAPPENED: "immediate" on claude (it re-reads
//                                  the file per request), "restarted"/"on-next-start" on codex
//                                  (it caches) — both measured, see the spec's Real-agent record
const put = await server.credentials.put(agentId, cred); // in-place update…
put.restartRequired; // …names the live workers a swap cannot reach on its own
```

The CLI reaches the same surface: `omni-acp workers` (state + pending count),
`omni-acp interactions <wid>`, `omni-acp interactions answer <wid> <reqId> --allow|--deny|--value q=v`,
`omni-acp config <wid> <configId> <value>`, `omni-acp runs`, `omni-acp deliveries [--redeliver <id>]`,
and `omni-acp credentials import|put|list|get|rm|check` — where `put` reads the secret from **stdin**,
because an argv is in the shell history and in every process listing on the machine.
