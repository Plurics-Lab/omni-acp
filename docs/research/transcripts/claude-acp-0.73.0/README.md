# Raw JSON-RPC transcripts — `claude-acp` 0.73.0

Ground truth for the M1 Normalizer (DESIGN §6.1 / §6.2). Every file here is a byte-level record of what
`npx -y @agentclientprotocol/claude-agent-acp@0.73.0` actually put on the wire on 2026-09-04, Linux,
node 22.23.2, against a logged-in Claude Code. **Nothing is hand-written or reconstructed.**

These are observations, not a spec. Where the adapter contradicts DESIGN §6.1, the adapter is what M1 has
to ship against; the deltas are collected in "What the Normalizer contract must accommodate" below.

## File format

One JSON object per line:

```json
{ "dir": "client->agent" | "agent->client" | "stderr" | "meta",
  "tMs": 1550.262,          // monotonic ms since spawn (process.hrtime.bigint)
  "raw": "…",               // only for stderr / unparseable stdout
  "msg": { … } }            // the verbatim JSON-RPC message, or a recorder note when dir=="meta"
```

`dir: "meta"` lines are the recorder's own annotations — `process_spawn`, `scenario`, `permission_decision`,
`probe_method`, `workspace_after`, `process_exit`. They are not wire traffic; drop them when replaying.

Redaction: the recorder replaced the absolute home-dir prefix with `~` on write. No such prefix appears in
the result — the workspaces are all `mkdtemp` dirs under `/tmp`, and those paths are left intact because the
Normalizer's path-containment rules need real absolute paths to test against. Nothing else was removed:
`available_commands_update` really is that large, and the `_meta._claude/rateLimit` block in `usage_update`
really is on the wire.

## The recorder's exact handshake

A throwaway Node script (kept out of the repo, run from a `mkdtemp` dir). It speaks v1 ACP directly over
stdio pipes — no SDK, no daemon — so that nothing in this corpus is filtered by our own code.

1. `spawn("npx", ["-y", "@agentclientprotocol/claude-agent-acp@0.73.0"], { stdio: ["pipe","pipe","pipe"], detached: true })`
2. `→ initialize { "protocolVersion": 1, "clientCapabilities": {} }` — deliberately empty, per D3.
3. `→ session/new { "cwd": "<mkdtemp workspace>", "mcpServers": [] }` (scenario 07 sends `session/load` instead)
4. `→ session/prompt { sessionId, prompt: [{ "type": "text", "text": "…" }] }`
5. Agent→client requests are answered by a responder we control:
   - `session/request_permission` → `{ "outcome": { "outcome": "selected", "optionId": <chosen> } }`, choosing
     the offered option whose `kind` is `allow_once` (allow scenarios) or `reject_once` (deny scenario).
     **Never** `allow_always`, per D4 rule 3.
   - anything else → JSON-RPC error `-32601`.
6. Teardown: close stdin, `SIGTERM` the process group, then `SIGKILL`.

Client→agent request ids start at 1 and increment per process.

## The transcripts

| File | Scenario | Prompt / probe | Outcome |
| --- | --- | --- | --- |
| `01-plain-answer.jsonl` | Text turn, no tools | *"Reply with exactly the word PONG."* | `end_turn`. The baseline handshake + `session/new` result. Its `sessionId` and `cwd` feed scenario 07. |
| `02-tool-read.jsonl` | Read tool | *"Read note.txt and reply with only its first line."* | `end_turn`. One `tool_call` (`kind: read`) + 3 `tool_call_update`. **No permission asked** — reads are auto-allowed. |
| `03-tool-write-allowed.jsonl` | Write + permission ALLOW | *"Create a file hello.txt containing exactly: hello"* | `end_turn`, `hello.txt` created. One `request_permission` (`kind: edit`), answered `allow-once`. Carries the creation diff. |
| `04-tool-write-denied.jsonl` | Write + permission DENY | same prompt | `end_turn`, workspace empty. `request_permission` answered `reject`; the tool call ends `status: "failed"`, `rawOutput: "User refused permission to run tool"`, and the agent explains in prose that it skipped the write and did **not** route around it via Bash. |
| `05-plan.jsonl` | Plan, todo-tool forced | *"Use your todo list tool to track a 3-step plan… complete step 1 only"* | `end_turn`. **No `plan` update was emitted.** The model went looking for a todo tool (`ToolSearch`, `kind: other`), did not find one, and just wrote the file. |
| `05b-plan-natural-phrasing.jsonl` | Plan, natural phrasing | *"Make a 3-step plan… then do step 1 only"* | `end_turn`, again **no `plan` update**. Kept as the second half of the negative result. |
| `06-cancel-mid-turn.jsonl` | Cancel | *"List the numbers 1 to 200 in words"*, `session/cancel` sent on the first `agent_message_chunk` | `stopReason: "cancelled"`. One further `usage_update` arrives **after** the cancel and **before** the prompt response. |
| `07-session-load.jsonl` | Resume + history replay | Fresh process, `initialize`, then `session/load` with scenario 01's `sessionId` + same `cwd`; then *"What did I ask you before?"* | Replay landed; the agent correctly recalled the PONG request. |
| `08-set-model-extension.jsonl` | Vendor-extension / unknown-method probes | 11 probe calls, no prompt (≈0 tokens) | See the method table below. `session/set_model` does **not** exist here; `session/set_config_option`, `session/list` and `session/resume` **do**. |
| `09-permission-bad-option-id.jsonl` | Malformed permission answer | Same as 03, but the responder returned `{ outcome: "selected" }` with `optionId: undefined` | Kept deliberately. The agent does **not** fail the turn: each tool call goes `status: "failed"` with `rawOutput: "Tool permission request failed: Error: Permission option was not offered: undefined"`, and the turn still ends `end_turn`. This is the observed cost of D4 rule 1 being violated. |
| `10-tool-edit-existing.jsonl` | Edit an existing file | *"In config.txt change slow to fast."* | `end_turn`. The only transcript with a diff whose `oldText` is non-null, and the one that shows `structuredPatch`. |

## Every JSON-RPC method observed

Client → agent (11 processes, 407 recorded lines total):

| Method | Calls | Result |
| --- | --- | --- |
| `initialize` | 11 | `{ protocolVersion: 1, agentCapabilities, agentInfo, authMethods: [], _meta }` |
| `session/new` | 10 | `{ sessionId, modes, configOptions }` |
| `session/prompt` | 10 | `{ stopReason, usage, _meta.quota }` |
| `session/set_config_option` | 3 | `-32602` when called with `optionId`; **`{ configOptions }` when called with `configId`**; `-32603 Internal error` + `data.details: "Invalid value for config option model: no-such-model-xyz"` for a bad value |
| `session/set_model` | 2 | `-32601` both times — **not implemented by this adapter** |
| `session/resume` | 2 | `-32002 "Resource not found: <sessionId>"` when `cwd` does not match; **`{ sessionId, modes, configOptions }` when it does**. Accepts and ignores `replayFrom`. |
| `session/set_options` | 1 | `-32601` |
| `session/set_mode` | 1 | `{}` , plus one `config_option_update` notification |
| `session/load` | 1 | `{ sessionId, modes, configOptions }`, preceded by replay notifications |
| `session/list` | 1 | `{ sessions: [{ sessionId, cwd, title, updatedAt }, …] }` |
| `session/cancel` | 1 | notification, no response |
| `session/notification` | 1 | `-32601` |
| `omni/definitely_unknown_method` | 1 | `-32601` |

Agent → client:

| Method | Calls | Notes |
| --- | --- | --- |
| `session/update` | 216 | Always a notification (never carries `id`). Params are exactly `{ sessionId, update }`. |
| `session/request_permission` | 7 | Request. **Ids start at 0** and are a counter independent of the client's. |

Unknown-method error shape is uniform:
`{ "code": -32601, "message": "\"Method not found\": <method>", "data": { "method": "<method>" } }`.

## Every `session/update` kind observed

| `sessionUpdate` | Total | 01 | 02 | 03 | 04 | 05 | 05b | 06 | 07 | 08 | 09 | 10 |
| --- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: |
| `agent_message_chunk` | 85 | 2 | 4 | 8 | 5 | 29 | 16 | 1 | 3 | · | 7 | 10 |
| `usage_update` | 60 | 4 | 6 | 6 | 7 | 8 | 6 | 2 | 4 | · | 9 | 8 |
| `tool_call_update` | 36 | · | 3 | 4 | 3 | 8 | 4 | · | · | · | 6 | 8 |
| `available_commands_update` | 23 | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 3 | 2 | 2 |
| `tool_call` | 10 | · | 1 | 1 | 1 | 2 | 1 | · | · | · | 2 | 2 |
| `user_message_chunk` | 1 | · | · | · | · | · | · | · | 1 | · | · | · |
| `config_option_update` | 1 | · | · | · | · | · | · | · | · | 1 | · | · |

**Never observed, across all 11 runs:** `plan`, `agent_thought_chunk`, `current_mode_update`,
`state_update`, `available_terminals_update`. Their absence is itself a contract input — see the gaps below.

## What the Normalizer contract must accommodate

**1. This adapter is a v1/v2 hybrid, not clean v1.** It answers `initialize` with `protocolVersion: 1` and
hangs `session/prompt` until the turn ends (v1), but it already emits `usage_update` and
`config_option_update`, already returns `configOptions` from `session/new`, and already implements
`session/set_config_option`, `session/list` and `session/resume` — all v2. The Normalizer's v1→v2 map must be
per-field and per-method, driven by the Runtime descriptor, not a single version switch. It must also be
idempotent on fields that are already v2-shaped.

**2. `messageId` is present — do not backfill it.** Every `agent_message_chunk` and `user_message_chunk`
carries one. Agent ids look like `msg_011Ceh…`; the replayed user-message id is a plain UUID. Consecutive
chunks of one message share the id (`07`: two chunks, one `msg_011CehUUNHsFHRRieaSF7bBM`). CONTRACTS §2.3
lists "`messageId` backfill" as M1 work; for this agent the correct behaviour is to **pass through** and only
synthesize when absent.

**3. `tool_call` fires once, `tool_call_update` is a sparse patch — merge, never replace.** The opening
`tool_call` is a near-empty placeholder (`rawInput: {}`, `status: "pending"`, `title: "Preparing file…"`,
empty `locations`). Later updates each carry an arbitrary subset of keys. Some carry **only**
`{ toolCallId, sessionUpdate, _meta }` — no `status`, no `content`, no `kind`. Others carry `status` and
`rawOutput` but drop `kind` and `title`. Collapsing `tool_call` into `tool_call_update` per §6.1 is right,
but an omitted field means *unchanged*; treating it as cleared loses `kind` and `locations` before the call
completes. `locations` in particular arrives empty on `tool_call` and is filled by the first update.

**4. The diff blocks cannot produce a git patch on their own.** Shape is
`{ type: "diff", path, oldText, newText }` — `oldText: null` for a creation. For an edit (`10`), `oldText`
and `newText` are the **changed fragment**, and they are *widened* between updates: first
`"mode = slow"` → `"mode = fast"`, then `"mode = slow\nretries = 3"` → `"mode = fast\nretries = 3"`. They are
never the whole file and carry no line numbers. DESIGN §6.1's `diff → {changes, patch:{format:"git_patch"}}`
therefore cannot be computed from the standard fields alone. The real patch data is a vendor extension:
`_meta.claudeCode.toolResponse.structuredPatch` (`[{oldStart, oldLines, newStart, newLines, lines:["-…","+…"," …"]}]`)
alongside `originalFile` and `userModified`. Either register that `_meta` path in the Runtime descriptor, or
accept that `patch` stays null for this agent and D8's git provider is the only source of truth.

**5. Permission requests are v1-shaped, and the options are stable.** Params are
`{ sessionId, toolCall, options, _meta.permission }` — a `toolCall` (with `kind`, `locations`, `content`,
`rawInput`, `status`, `title`, `name`), **not** v2's `{ title, subject }`. Both observed requests offered
exactly the same three options, in this order:

| `optionId` | `kind` | `name` |
| --- | --- | --- |
| `allow-once` | `allow_once` | Yes |
| `allow-with-updates` | `allow_always` | Yes, allow all edits during this session |
| `reject` | `reject_once` | No |

Note the field is **`optionId`**, not `id`. There is no session-scoped grant kind here — D4 rule 2's
preferred `allow_session` / `approve_for_session` does not exist, so `allow_once` is the only safe allow, and
the `allow_always` option must stay unselected per D4 rule 3. `kind` on the tool call was `read`, `edit`,
`execute` and `other` (`other` for a tool the adapter does not classify).

**6. A malformed permission answer degrades, it does not fail loudly** (`09`). An `optionId` the agent never
offered produces `status: "failed"` on that tool call with a human-readable `rawOutput`, and the turn still
returns `end_turn`. So D4 rule 1 ("never invent an optionId") cannot be enforced by watching `stopReason` —
a policy engine that invents ids would silently produce turns that look successful and did nothing.

**7. Deny is invisible in `stopReason`.** The denied turn (`04`) also ends `end_turn`. The only machine-
readable signal is `tool_call_update.status: "failed"` with
`rawOutput: "User refused permission to run tool"`. §5.5's `TurnResult` aggregation must surface denied tool
calls explicitly; `end_turn` ≠ the work happened (the mirror of §6.2's "`end_turn` ≠ success").

**8. History replay lands strictly between the `session/load` request and its response** — exactly the window
D6 assumes, confirmed: request at 943.8 ms, two replay updates at 1491.9 / 1492.5 ms, response at 1493.1 ms.
The replay contains only conversational content (`user_message_chunk`, `agent_message_chunk`, both with
`messageId`); it does **not** replay `usage_update`, `tool_call*` or `available_commands_update`. So marking
`replay: true` on everything in that window is safe, but the replayed stream is **not** a faithful re-emission
of the original turn — the daemon's own event log stays the authority for tool calls and usage.

**9. `session/load` returns a body, contrary to the v1 schema.** It returns
`{ sessionId, modes, configOptions }` — the same shape as `session/new`, not `null`. The Normalizer should
read `configOptions` off the load result rather than treating resume as capability-free.

**10. `session/resume` (the v2 name) works, and its failure mode breaks D2's classifier.** With a matching
`cwd` it returns the `session/new` shape. With a **mismatched `cwd`** it returns
`{ code: -32002, message: "Resource not found: <sessionId>", data: { uri: <sessionId> } }` — for a session
that is alive and healthy. D2's rule ("code ∈ {-32603, -32602, -32002, -32000} **and** text contains
`session not found` / `no session found` / `unknown session` → permanent") does not match this string, so it
falls through to `unknown` and the pointer is kept — the safe outcome, but by luck rather than by design.
Any loosening of that text matcher to "resource not found" would turn a recoverable `cwd` mismatch into
`rejected_permanent` and destroy a live session pointer. Keep the matcher strict, and record
`cwd`-must-match as a `claude-acp` quirk.

**11. `session/set_model` does not exist here.** multica saw it on 8 runtimes; this adapter answers `-32601`.
Its equivalent is `session/set_config_option` with **`configId`** (not `optionId`) — `{ configId: "model",
value: "sonnet" }` → `{ configOptions: [...] }`. A bad value gives `-32603 Internal error` with
`data.details: "Invalid value for config option model: <value>"`, i.e. a wrong-value error is indistinguishable
from a genuine internal error by `code` alone; the registry has to key on `data.details`. `session/set_mode`
also still works (`{}` + a `config_option_update` notification), so mode has two live spellings on the same
process. The vendor-extension registry must therefore express *preference order over several spellings*, not
one name per capability.

**12. `available_commands_update` is unmapped and enormous.** It has no row in §6.1's table, arrives twice per
turn (once immediately on `session/prompt`, once ~70 ms later), and the largest one here is 12.7 KB on a single line because it
enumerates every slash command and skill on the host. At 7-day retention (D6) this dominates the event log.
It needs an explicit decision: map to a v2 kind, drop, or store-but-do-not-stream.

**13. `usage_update` already exists on v1 and is high-frequency.** 60 of 216 updates. Fields are
`{ used, size }` plus an optional `cost: { amount, currency }` on the last one of a turn, and an optional
`_meta._claude/rateLimit` block carrying `status: "allowed_warning"`, `utilization`, and `resetsAt` windows.
That `_meta` is the concrete signal §6.2's "`end_turn` ≠ success / promote to failed on 429" needs — it is
structured, and it arrives before the failure rather than as stderr text.

**14. The turn does not end at the prompt response.** In `06`, a `usage_update` arrives 53 ms *after* our
`session/cancel` and ~4 ms before the response. §6.2's close-out chain (quiet window → close stdin → drain →
cancel) is doing real work; a Normalizer that emits `state_update{idle}` the instant `session/prompt` resolves
will order that update after events that belong to the turn.

**15. Timings, for the descriptor.** `initialize` 0.94–1.03 s warm (the M0 smoke measured ~7 s cold);
`session/new` a further 0.49–0.52 s; `session/load` with replay 0.55 s. Plain-answer turn 3.15 s; read-tool turn 5.19 s;
write-with-permission turn 4.98 s; edit-existing turn 7.38 s.

### Known gaps in this corpus

- **No `plan` update, in two attempts.** This build's tool set has no todo/plan tool, so §6.1's
  `plan → plan_update` row has **no real-agent ground truth** here. It must be covered by a testkit fixture,
  and the compat suite must not assert on it for `claude-acp`.
- **No `agent_thought_chunk`.** Not emitted at the default `effort`. Same conclusion: fixture-only.
- **No `current_mode_update`.** `session/set_mode` produced the v2 `config_option_update` instead, so the
  §6.1 row `current_mode_update → config_option_update` has no v1-side sample from this agent.
- **No `fs/*` or `terminal/*` calls**, as D3 predicts under `clientCapabilities: {}`. Confirmed across all
  11 runs: the only agent→client methods are `session/update` and `session/request_permission`.
- **No `authenticate` / `auth/logout`, no MCP servers, no image or resource content blocks** — every run sent
  `mcpServers: []` and text-only prompts.
- **No multi-turn tool-call interleaving** and no `tool_call_update` for a tool that fails on its own merits
  (as opposed to a denied permission).
