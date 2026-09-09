# codex-acp 1.8.0 — raw observations (2026-09-04 / 2026-09-09)

Recorded on Linux with the ChatGPT-logged-in Codex (`~/.codex/auth.json`, codex-cli 0.153.2 on PATH; the
adapter uses its bundled `@openai/codex` 0.152 unless `CODEX_PATH` is set). Recorder: a throwaway v1 stdio
client (`initialize{clientCapabilities:{}}` → `session/new{mcpServers:[]}` → optional config switch →
`session/prompt`), logging every line with a `[<ms>] <-`/`->` prefix. Home-directory prefixes replaced by `~`.
Unlike the claude-acp corpus these files are NOT bare JSONL — strip the prefix to parse a line. `##` lines
are recorder annotations (`process_spawn`, `scenario`, `cancel_trigger`, `prompt_content`, `prompt_done`,
`workspace_after`, `external_after`, `process_exit`), not wire traffic; `!!` is stderr.

Two recording sessions against the same pinned adapter version: **02–06** on 2026-09-04 (M0/M1 permission
work) and **07–09** on 2026-09-09 (M2: `session/set_config_option`, cancel with a shell in flight,
`resource_link` prompt content). Every clientCapability stayed `{}` throughout.

| file | what it shows |
| --- | --- |
| `02-write-in-cwd-default-mode.log` | default mode `agent`: "create hello.txt" → `tool_call{kind:edit}` → `tool_call_update{completed}`, file written, **no `session/request_permission`** |
| `03-write-in-cwd-after-set-config-read-only.log` | `session/set_config_option{configId:"mode",value:"read-only"}` is accepted (`currentValue:"read-only"` echoed) — and the write still happens without asking |
| `04-write-external-path-read-only.log` | read-only mode, target path OUTSIDE the workspace (`/tmp/omni-external-…`) — still written, no request |
| `05-write-external-path-INITIAL_AGENT_MODE.log` | same with the README's `INITIAL_AGENT_MODE=read-only` env — same result |
| `06-CODEX_CONFIG-approval-untrusted-rejected.log` | `CODEX_CONFIG='{"approval_policy":"untrusted",…}'` → `session/new` fails `-32603 "approval_policy = \"untrusted\" is no longer supported"` |
| `07-set-config-mode-and-effort.log` | `session/set_config_option{configId:"mode",value:"read-only"}` then `{configId:"reasoning_effort",value:"high"}`, then *"Reply with exactly the word PONG."* — both accepted, both echoed in a **full** `{configOptions}` result, **no `config_option_update` notification** from either |
| `08-cancel-during-shell-tool.log` | *"Run the shell command `sleep 30` and then reply DONE."*, `session/cancel` 5 s after the `tool_call` — `stopReason:"cancelled"` 27 ms later, and the in-flight tool call gets **no terminal `tool_call_update`** |
| `09-resource-link-in-and-outside-cwd.log` | prompt = `[text, resource_link(file://<cwd>/inside.txt), resource_link(file://<other tmpdir>/outside.txt)]` — **both** read, in **one** tool call, with **no permission request** for either |

## Facts a Normalizer / descriptor must accommodate

- `initialize`: `protocolVersion 1`, `loadSession: true`, `sessionCapabilities {resume,list,close,delete,fork,additionalDirectories,subagents}`,
  `mcpCapabilities {acp:false, http:true, sse:false}`, `promptCapabilities {image, embeddedContext}`,
  `authMethods: [{id:"api-key"…}]` — but the ChatGPT login is used without any `authenticate` call.
  `_meta.steering`, `_meta.goal` vendor extensions.
- `session/new` returns the v2-ish trio **`models`** (`availableModels[]` with `modelId` like `gpt-5.6-sol[low]`),
  **`modes`** (`availableModes` read-only / agent / agent-full-access, `currentModeId:"agent"`) and
  **`configOptions`** (`mode`, `collaboration_mode` default|plan, `model`, `reasoning_effort` low…xhigh).
- Timings (warm npx cache): initialize ≈1.6 s, session/new ≈0.4 s more, a one-word turn ≈3.8 s, an edit turn ≈8–10 s.
  **Cold** `npx -y @agentclientprotocol/codex-acp` downloads the `@openai/codex` binary and took >90 s once.
- Updates seen: `agent_message_chunk` (with `messageId`, `_meta.codex.phase:"final_answer"`), `tool_call`
  (ids `exec-<uuid>`, `kind` edit/read/execute, `status:"in_progress"` from the first frame — no `pending`),
  `tool_call_update` (`status:"completed"`, `rawOutput{formatted_output, exit_code}`, `_meta.terminal_output_delta`),
  `usage_update {used,size}` (no `cost`), `session_info_update` (`title`, and `_meta.codex.threadStatus`),
  `available_commands_update` once per session (commands carry `_meta.commandAction` → `setConfigOption`).
- `session/prompt` response carries `usage {totalTokens,inputTokens,cachedReadTokens,outputTokens,thoughtTokens}`
  and `_meta.quota` (per-model token counts).
- **Permission: never requested for file edits**, in any mode, inside or outside the workspace. The compat
  entry therefore declares `provides: [tools, cancel]` and a `config` skip for `permission-deny`.
  `09` extends this to reads: nothing is ever asked, for any path.

## Facts the M2 contract must accommodate (files 07–09)

- **`session/set_config_option` is the only config surface, it works, and it notifies nothing.**
  `{configId:"mode", value:"read-only"}` and then `{configId:"reasoning_effort", value:"high"}` were both
  accepted; each returns the **full** `{ configOptions }` array with the new `currentValue` echoed
  (`mode: agent → read-only`, then `reasoning_effort: medium → high`). **No `config_option_update`
  notification is emitted by either call** — same as `claude-acp`, so `POST /v1/workers/{wid}/config` must
  refresh `configOptions` from the method result, never from the event stream.
- **Unlike `claude-acp`, the returned option list does not shrink.** All five entries
  (`mode`, `collaboration_mode`, `model`, `reasoning_effort`, `fast-mode`) survive every set. So membership
  churn is a per-agent behaviour, not a protocol rule — replacing the list wholesale is the only handling
  that is correct for both.
- **`fast-mode` (`off`/`on`) is new** in `session/new`'s `configOptions` since the 02–06 recordings, with the
  adapter version unchanged. As with `claude-acp`, the pinned adapter does not pin the wire surface.
- **`reasoning_effort: "high"` is not observable in usage.** The following one-word turn still reports
  `usage.thoughtTokens: 0` and `_meta.quota.token_count.reasoningOutputTokens: 0`. There is no wire evidence
  a client can use to confirm the effort actually applied.
- **Two spellings of the model id.** `session/new` lists `models.availableModels[].modelId` as
  `gpt-5.6-sol[low]` (effort baked into the id), while `configOptions[model].currentValue` and the prompt
  response's `_meta.quota.model_usage[0].model` are the bare `gpt-5.6-sol`. A snapshot that mixes the two
  will never match itself.
- **Cancel with a shell in flight strands the tool call, exactly as `claude-acp` does** (`08`). The
  `tool_call` arrives already `status: "in_progress"` (never `pending`) with
  `content: [{ type: "terminal", terminalId }]` — a terminal content block even though the client declared
  no terminal capability. `session/cancel` at 12.91 s → `usage_update` → `session_info_update` with
  `_meta.codex.threadStatus: { type: "idle" }` → `stopReason: "cancelled"` at 12.94 s. **No
  `tool_call_update` for that call ever arrives**: no `completed`, no `failed`, no `cancelled`. Both real
  agents leave cancelled tool calls non-terminal, so M2's watchdog `cancel_timeout` close must synthesize
  the terminal status rather than wait for one. `threadStatus.idle` is this agent's one vendor signal that
  the turn is actually over, and it arrives *before* the prompt response.
- **`resource_link` is accepted and silently resolved, in or out of `cwd`** (`09`). Both links were taken
  without error. Codex answered them with a **single** tool call reported as `kind: "read"`,
  `title: "Read file '<inside path>'"`, `locations: [<inside path only>]` and **no `rawInput` whatsoever** —
  but its `rawOutput.formatted_output` is a `head`-style dump of **both** files
  (`==> <inside> <==` … `==> <outside> <==`), including `OUTSIDE-SECRET-BETA` from outside the workspace,
  and the final message echoes both. Three consequences: `title` and `locations[]` **under-report what the
  call touched**; the command itself is invisible (a `cmd`-matching policy rule has nothing to match on for
  a call this agent classifies as `read`); and this agent enforces **no containment at all** for
  prompt-supplied paths. M2-B's prompt-content path check is the only thing standing between a
  client-supplied `file://` URI and any file on the host — and for this agent it must run before the prompt
  is sent, because nothing downstream will see the path again.
- **The agent creates `.git/` in `cwd` on its own.** After `08` the workspace contained `.git/`, `.codex/`
  and `.agents/` that the recorder never created; the `mkdtemp` workspaces of `07` and `09` did not. D8's
  git-diff provider must expect the working tree to be a repository the *agent* initialised mid-session,
  not the user's — "outside a repo → `patch: null`" cannot be decided once at worker start.
- **Timings (warm).** `initialize` 2.02–2.23 s, `session/new` a further 0.16–1.35 s; one-word turn 3.16 s;
  the two-file `resource_link` read turn 10.25 s.
- **A host banner arrives as a `messageId`-less `agent_message_chunk`.** All three M2 turns open with an
  `agent_message_chunk` carrying *"Warning: Skill descriptions were shortened to fit the skills context
  budget…"* and **no `messageId`, no `_meta`** — unlike every real answer chunk, which carries both
  (`_meta.codex.phase: "commentary"` while narrating, `"final_answer"` for the answer). It appears in none of
  02–06. Finding 2 of the claude-acp corpus ("`messageId` is present — do not backfill it") does not hold
  here: grouping keyed on `messageId` must tolerate its absence, and this chunk is host chrome, not model
  output.

## Compat result (first run, 2026-09-04, `OMNI_COMPAT_AGENTS=codex-acp`)

12 passed / 1 failed before the yaml correction — the failure was exactly `permission-deny` ("a denied turn
reported no denied tool calls"). `hibernate-wake` (13.9 s), `restart-survives`, `lease`, `stream-resume`,
`resume-cwd-mismatch`, `cancel-late-update`, `tool-merge` all green on the first attempt.
