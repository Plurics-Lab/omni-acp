# codex-acp 1.8.0 — raw observations (2026-09-04)

Recorded on Linux with the ChatGPT-logged-in Codex (`~/.codex/auth.json`, codex-cli 0.153.2 on PATH; the
adapter uses its bundled `@openai/codex` 0.152 unless `CODEX_PATH` is set). Recorder: a throwaway v1 stdio
client (`initialize{clientCapabilities:{}}` → `session/new{mcpServers:[]}` → optional mode switch →
`session/prompt`), logging every line with a `[<ms>] <-`/`->` prefix. Home-directory prefixes replaced by `~`.
Unlike the claude-acp corpus these files are NOT bare JSONL — strip the prefix to parse a line.

| file | what it shows |
| --- | --- |
| `02-write-in-cwd-default-mode.log` | default mode `agent`: "create hello.txt" → `tool_call{kind:edit}` → `tool_call_update{completed}`, file written, **no `session/request_permission`** |
| `03-write-in-cwd-after-set-config-read-only.log` | `session/set_config_option{configId:"mode",value:"read-only"}` is accepted (`currentValue:"read-only"` echoed) — and the write still happens without asking |
| `04-write-external-path-read-only.log` | read-only mode, target path OUTSIDE the workspace (`/tmp/omni-external-…`) — still written, no request |
| `05-write-external-path-INITIAL_AGENT_MODE.log` | same with the README's `INITIAL_AGENT_MODE=read-only` env — same result |
| `06-CODEX_CONFIG-approval-untrusted-rejected.log` | `CODEX_CONFIG='{"approval_policy":"untrusted",…}'` → `session/new` fails `-32603 "approval_policy = \"untrusted\" is no longer supported"` |

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

## Compat result (first run, 2026-09-04, `OMNI_COMPAT_AGENTS=codex-acp`)

12 passed / 1 failed before the yaml correction — the failure was exactly `permission-deny` ("a denied turn
reported no denied tool calls"). `hibernate-wake` (13.9 s), `restart-survives`, `lease`, `stream-resume`,
`resume-cwd-mismatch`, `cancel-late-update`, `tool-merge` all green on the first attempt.
