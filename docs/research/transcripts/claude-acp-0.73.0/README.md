# Raw JSON-RPC transcripts — `claude-acp` 0.73.0

Ground truth for the Normalizer (DESIGN §6.1 / §6.2) and, from file 11 on, for M2 (DESIGN §11). Every file
here is a byte-level record of what `npx -y @agentclientprotocol/claude-agent-acp@0.73.0` actually put on the
wire, Linux, node 22.23.2, against a logged-in Claude Code. **Nothing is hand-written or reconstructed.**

Two recording sessions, same pinned adapter version:

- **01–10** — 2026-09-04, the M1 corpus.
- **11–17** — 2026-09-09, the M2 corpus: permission ALLOW-with-updates, elicitation (declared / declined /
  not-declared control), `session/set_config_option`, cancel with a tool genuinely in flight, and
  `resource_link` prompt content inside and outside `cwd`.

The adapter version is pinned; the Claude Code host under it is not. Between the two sessions the wire
surface moved on its own — see finding 16.

These are observations, not a spec. Where the adapter contradicts DESIGN §6.1, the adapter is what we have
to ship against; the deltas are collected in "What the Normalizer contract must accommodate" (findings 1–15,
from the M1 corpus) and "What the M2 contract must accommodate" (findings 16–26) below.

## File format

One JSON object per line:

```json
{ "dir": "client->agent" | "agent->client" | "stderr" | "meta",
  "tMs": 1550.262,          // monotonic ms since spawn (process.hrtime.bigint)
  "raw": "…",               // only for stderr / unparseable stdout
  "msg": { … } }            // the verbatim JSON-RPC message, or a recorder note when dir=="meta"
```

`dir: "meta"` lines are the recorder's own annotations — `process_spawn`, `scenario`, `permission_decision`,
`elicitation_decision`, `config_option_probe`, `config_option_choice`, `prompt_content`, `cancel_trigger`,
`prompt_done`, `probe_method`, `workspace_after`, `external_after`, `process_exit`. They are not wire
traffic; drop them when replaying.

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
   **Exception:** scenarios 12 and 13 send
   `{ "fs": { "readTextFile": false, "writeTextFile": false }, "terminal": false, "elicitation": { "form": {}, "url": {} } }`,
   the `ElicitationCapabilities` shape from the v1 `schema.json` (`form` / `url`, each `{}` = supported).
   Scenario 14 is the control: the identical prompt with `clientCapabilities: {}`.
3. `→ session/new { "cwd": "<mkdtemp workspace>", "mcpServers": [] }` (scenario 07 sends `session/load` instead)
4. `→ session/prompt { sessionId, prompt: [{ "type": "text", "text": "…" }] }`
5. Agent→client requests are answered by a responder we control:
   - `session/request_permission` → `{ "outcome": { "outcome": "selected", "optionId": <chosen> } }`, choosing
     the offered option whose `kind` is `allow_once` (allow scenarios) or `reject_once` (deny scenario).
     **Never** `allow_always`, per D4 rule 3.
   - `elicitation/create` → `{ "action": "accept", "content": { … } }` (scenario 12) or
     `{ "action": "decline" }` (scenario 13). The accept content is built mechanically from
     `requestedSchema.properties`: first `oneOf` const for a choice property, the literal string
     `"omni-choice.txt"` for a free-text one.
   - anything else → JSON-RPC error `-32601`.
6. Teardown: close stdin, `SIGTERM` the process group, then `SIGKILL`. (Files 12–17 keep the stderr that
   arrives during teardown; file 11 was written before that flush order was fixed and ends at the last
   wire message.)

Client→agent request ids start at 1 and increment per process. Cancel scenarios trigger off an observed
event, not a fixed clock: 16 sends `session/cancel` 5 s after the permission answer, so the tool is really
running when it lands.

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

### M2 (2026-09-09) — DESIGN §11

| File | Scenario | Prompt / probe | Outcome |
| --- | --- | --- | --- |
| `11-permission-allow-with-updates.jsonl` | Permission ALLOW with `allow-with-updates` | *"Create a file a.txt containing exactly: A. Then create a file b.txt containing exactly: B. Then reply DONE."*, first permission answered `allow-with-updates` (`kind: allow_always`) | `end_turn`, **both** files written after **one** `request_permission`. The second Write is silent — no second request, and no notification announces the session-wide grant. |
| `12-elicitation-declared-accept.jsonl` | Elicitation, declared, accepted | `clientCapabilities.elicitation = {form:{},url:{}}`; *"Before doing anything, ask me one clarifying question about which file name to use, wait for my answer, then create that file."* | `elicitation/create` (`mode: "form"`) arrives at 11.1 s. Answered `{action:"accept", content:{question_0:"notes.md", question_0_custom:"omni-choice.txt"}}` → the agent used the **custom** answer and created `omni-choice.txt`. `end_turn`. |
| `13-elicitation-declared-decline.jsonl` | Elicitation, declared, declined | same caps + prompt | Answered `{action:"decline"}`. The `AskUserQuestion` tool call ends **`status: "completed"`** (not `failed`) with `rawOutput: "The user did not answer the questions."`; nothing written; `end_turn`. Also shows a read-only `ls -A <cwd>` Bash call (`kind: execute`) running with **no** permission request. |
| `14-elicitation-not-declared-control.jsonl` | Control: elicitation **not** declared | `clientCapabilities: {}`, identical prompt | **No `elicitation/create`, no tool call at all.** The agent asks its question as prose and ends the turn. The capability gate is real. |
| `15-set-config-option-model.jsonl` | `session/set_config_option` → model | `{configId:"model", value:"haiku"}` (chosen from `session/new`'s `configOptions`), then *"Reply with exactly the word PONG."* | Result `{ configOptions }` with `model.currentValue:"haiku"`, and the turn's `_meta.quota.model_usage[0].model` is `claude-haiku-4-5-20251001`. **No `config_option_update` notification.** The returned list **shrinks** from 4 options to 2. |
| `16-cancel-during-tool-call.jsonl` | Cancel with a tool genuinely in flight | *"Run the shell command `python3 -c 'import time; time.sleep(30); print(\"WOKE\")'` and then reply DONE."*; permission answered `allow-once` at 6.97 s, `session/cancel` at 11.97 s | `stopReason: "cancelled"` 31 ms later. The in-flight tool call gets **no terminal `tool_call_update`** — its last status is the opening `tool_call`'s `"pending"`. |
| `17-resource-link-in-and-outside-cwd.jsonl` | `resource_link` prompt content, in and out of `cwd` | `[text, resource_link(file://<cwd>/inside.txt), resource_link(file://<other tmpdir>/outside.txt)]` | Both accepted. The in-`cwd` Read runs silently; the out-of-`cwd` Read raises `request_permission` with `_meta.permission.description: "Reason: Path is outside allowed working directories"`. Answered `allow-once` → the agent read and echoed `OUTSIDE-SECRET-BETA`. |

## Every JSON-RPC method observed

Client → agent (18 processes, 794 recorded lines total):

| Method | Calls | Result |
| --- | --- | --- |
| `initialize` | 18 | `{ protocolVersion: 1, agentCapabilities, agentInfo, authMethods: [], _meta }`. `agentCapabilities` never mentions elicitation — the client capability is what gates it. |
| `session/new` | 17 | `{ sessionId, modes, configOptions }` |
| `session/prompt` | 17 | `{ stopReason, usage, _meta.quota }` |
| `session/set_config_option` | 4 | `-32602` when called with `optionId`; **`{ configOptions }` when called with `configId`** (`15` changes the model for real); `-32603 Internal error` + `data.details: "Invalid value for config option model: no-such-model-xyz"` for a bad value. **Never emits a `config_option_update` notification.** |
| `session/set_model` | 2 | `-32601` both times — **not implemented by this adapter** |
| `session/resume` | 2 | `-32002 "Resource not found: <sessionId>"` when `cwd` does not match; **`{ sessionId, modes, configOptions }` when it does**. Accepts and ignores `replayFrom`. |
| `session/set_options` | 1 | `-32601` |
| `session/set_mode` | 1 | `{}` , plus one `config_option_update` notification |
| `session/load` | 1 | `{ sessionId, modes, configOptions }`, preceded by replay notifications |
| `session/list` | 1 | `{ sessions: [{ sessionId, cwd, title, updatedAt }, …] }` |
| `session/cancel` | 2 | notification, no response |
| `session/notification` | 1 | `-32601` |
| `omni/definitely_unknown_method` | 1 | `-32601` |

Agent → client:

| Method | Calls | Notes |
| --- | --- | --- |
| `session/update` | 353 | Always a notification (never carries `id`). Params are exactly `{ sessionId, update }`. |
| `session/request_permission` | 11 | Request. **Ids start at 0** and are a counter independent of the client's. |
| `elicitation/create` | 2 | Request, only in `12`/`13` — i.e. only when the client declared `elicitation`. **Shares the same id counter as `session/request_permission`** (`12`: elicitation is id 0, the later permission is id 1). |

Unknown-method error shape is uniform:
`{ "code": -32601, "message": "\"Method not found\": <method>", "data": { "method": "<method>" } }`.

## Every `session/update` kind observed

| `sessionUpdate` | Total | 01 | 02 | 03 | 04 | 05 | 05b | 06 | 07 | 08 | 09 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 |
| --- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: |
| `agent_message_chunk` | 126 | 2 | 4 | 8 | 5 | 29 | 16 | 1 | 3 | · | 7 | 10 | 3 | 14 | 3 | 18 | 1 | · | 2 |
| `usage_update` | 93 | 4 | 6 | 6 | 7 | 8 | 6 | 2 | 4 | · | 9 | 8 | 5 | 7 | 7 | 3 | 3 | 3 | 5 |
| `tool_call_update` | 69 | · | 3 | 4 | 3 | 8 | 4 | · | · | · | 6 | 8 | 8 | 7 | 7 | · | · | 3 | 8 |
| `available_commands_update` | 37 | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 3 | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 2 |
| `tool_call` | 19 | · | 1 | 1 | 1 | 2 | 1 | · | · | · | 2 | 2 | 2 | 2 | 2 | · | · | 1 | 2 |
| `session_info_update` | 7 | · | · | · | · | · | · | · | · | · | · | · | 1 | 1 | 1 | 1 | 1 | 1 | 1 |
| `user_message_chunk` | 1 | · | · | · | · | · | · | · | 1 | · | · | · | · | · | · | · | · | · | · |
| `config_option_update` | 1 | · | · | · | · | · | · | · | · | 1 | · | · | · | · | · | · | · | · | · |

**Never observed, across all 18 runs:** `plan`, `agent_thought_chunk`, `current_mode_update`,
`state_update`, `available_terminals_update`. Their absence is itself a contract input — see the gaps below.
`session_info_update` appears in **every** M2 run and **no** M1 run — see finding 16.

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
write-with-permission turn 4.98 s; edit-existing turn 7.38 s. The M2 runs agree: `initialize` 0.94–1.10 s
warm (14.5 s once, cold npx, in `11`), `session/new` a further 0.82–0.95 s. Turns: one-word 1.77 s (`15`,
on Haiku), prose-only 4.27 s, two writes under one grant 5.28 s, two reads via `resource_link` 6.09 s,
elicitation round-trip 12.4 s accept / 15.4 s decline (the agent thinks before and after asking).

## What the M2 contract must accommodate

**16. `session_info_update` is on the wire now, and was not five days earlier.** All seven M2 runs emit
exactly one per turn — `{ sessionUpdate: "session_info_update", title, updatedAt }` — and it lands **5–22 ms
*after* `session/prompt` resolves**, in every single run. None of the eleven M1 runs emitted it, against the
same pinned adapter version. The adapter version pins the adapter, not the Claude Code host under it, so the
wire surface can move with no version change: the Runtime descriptor must be tolerant of new
`sessionUpdate` kinds appearing at runtime, and §6.1 needs an explicit row (or an explicit drop) for this
one. It is also the strongest form of finding 14 — **the turn does not end when `session/prompt` resolves**,
now 7/7 rather than 1/1. M2's idle watchdog must start its quiet window *after* the last update, not at the
response, or it will race a post-response update on literally every turn.

**17. `allow-with-updates` really is a session-wide grant, and nothing on the wire announces it** (`11`).
Answering the *first* `edit` permission with `optionId: "allow-with-updates"` (`kind: allow_always`) let the
*second* Write of the same turn complete with **no second `session/request_permission`**: one request, two
files on disk, `end_turn`. No `config_option_update`, no `current_mode_update`, no `session_info_update`
field, nothing reports the grant. This is the measured cost of breaking D4 rule 3: after a single
`allow_always` the daemon's policy engine is simply never consulted again for that session, and it receives
no event telling it so. `allow_once` per call is the only setting under which every tool call passes policy.

**18. The `allow_always` option's `name` is contextual; only `kind` and `optionId` are stable.** The same
`{ optionId: "allow-with-updates", kind: "allow_always" }` arrived as three different names across the M2
runs: *"Yes, allow all edits during this session"* (Write, `11`), *"Yes, and don't ask again for similar
commands"* (Bash, `16`), *"Yes, allow reading from omni-m2-external-…/ during this session"* (Read outside
`cwd`, `17`) — the last one even embeds a path. A policy engine that matches on `name` will mis-classify;
match on `kind`, fall back to `optionId`, never on `name`.

**19. Elicitation is gated on the *client* capability, and this adapter honours the gate.** With
`clientCapabilities.elicitation = { form: {}, url: {} }` the "ask me a clarifying question first" prompt
produced a real agent→client `elicitation/create` request (`12`, `13`). With `clientCapabilities: {}` and the
byte-identical prompt (`14`) there is **no `elicitation/create` and no tool call at all** — the model asks its
question as prose and ends the turn. `agentCapabilities` in the `initialize` response never mentions
elicitation either way. That is D10's gating confirmed end to end: declaring elicitation only when
`onUnresolved: "park"` genuinely changes agent behaviour, and *not* declaring it is safe — the agent degrades
to prose rather than erroring, hanging, or guessing.

**20. `elicitation/create` params, v1, as observed.**
`{ mode: "form", sessionId, toolCallId, message, requestedSchema }`. The `ElicitationSessionScope` fields are
**flattened into `params`**, not nested under a `scope` key, matching the schema's `allOf` composition — an
M2 type that models scope as a nested object will not parse this. `requestedSchema` is
`{ type: "object", properties: {…} }` with **no `required` array** in either observation, and no schema-level
`title`/`description`. Only `mode: "form"` was seen; no `url` mode, no `elicitation/complete` notification,
and no request-scoped (`requestId`) elicitation. The request is generated by Claude Code's `AskUserQuestion`
tool and is mirrored in the stream as a `tool_call` with `_meta.claudeCode.toolName: "AskUserQuestion"`,
`kind: "other"`, `title: "Asking for your input"` — so the same interaction shows up twice, once as a
request the daemon must answer and once as a tool call it must not double-count.

**21. Choices arrive as `oneOf`, not `enum`, and each question carries a paired free-text property.** One
question becomes two properties: `question_0` (`type: "string"`, `title`, `oneOf: [{const, title,
description}, …]`) and `question_0_custom` (`type: "string"`, `title: "Other"`, marked by
`_meta._askUserQuestionCustomAnswer: { questionId: "question_0", isCustomAnswer: true }`). Our accept filled
**both** — `{ question_0: "notes.md", question_0_custom: "omni-choice.txt" }` — and the agent used the
**custom** one, creating `omni-choice.txt` and not `notes.md`. So the `_meta` marker silently wins, and a
client that fills every declared property overrides the user's actual selection. M2's
`worker.on("interaction", …)` → `answer(...)` mapping must send exactly one value per `questionId`, and must
read `oneOf[].const` (the schema's own note says single-select uses "`enum` **or** `oneOf`").

**22. Accept and decline both end the turn `end_turn`, and both leave the tool call `completed`.** Accept
(`12`): `AskUserQuestion` → `status: "completed"`, `rawOutput: "The user answered: \"…\"=\"omni-choice.txt\". …"`,
file written. Decline (`13`): the same tool call → **`status: "completed"` as well** (not `failed`),
`rawOutput: "The user did not answer the questions."` plus a matching `content` block, nothing written, and
the agent explains in prose. As with a denied permission (finding 7), `stopReason` carries no signal — and
here neither does `tool_call_update.status`, which is the one place finding 7 said to look. The daemon must
record the InteractionRequest outcome itself; `deny` and `parkTimeoutAction` results cannot be recovered
from the agent's stream at all.

**23. `session/set_config_option{configId:"model"}` works, notifies nothing, and returns a list that can
shrink** (`15`). `{ configId: "model", value: "haiku" }` → `{ configOptions: [...] }` with
`model.currentValue: "haiku"`; the next turn's `_meta.quota.model_usage[0].model` is
`claude-haiku-4-5-20251001`, so the switch is real, not cosmetic. Two traps for `POST /v1/workers/{wid}/config`:
(a) **no `config_option_update` notification is emitted** — unlike `session/set_mode`, which does notify
(finding 11) — so `configOptions` on the snapshot must be refreshed from the method's own result, never from
the event stream; (b) the result is a **full replacement whose membership changes**: `session/new` returned
four options (`mode`, `model`, `effort`, `fast`) and the post-set result returned **two** (`mode`, `model`),
because Haiku exposes no effort levels. Merging by `id` would leave a phantom `effort` on the snapshot that
no longer exists — replace the list wholesale.

**24. Cancelling a turn with a tool genuinely in flight strands that tool call with no terminal status**
(`16`). Timeline: `tool_call` (`pending`) 6.07 s → `request_permission` 6.97 s → answered `allow-once`
6.97 s → the 30-second sleep is running → `session/cancel` 11.97 s → `usage_update` 11.99 s →
`stopReason: "cancelled"` 12.00 s. Between the permission answer and the response the tool call received
**no `tool_call_update` at all**: no `failed`, no `cancelled`, no `completed`; its last observed `status` is
the opening frame's `"pending"`. (`06` cancelled a turn with nothing in flight and so never showed this.)
A cancelled turn can therefore leave tool calls non-terminal forever. M2's watchdog `cancel_timeout` close
must synthesize the terminal status itself, and `TurnResult` aggregation must not block waiting for one.

**25. `resource_link` prompt content is accepted, resolved by the agent, and contained only by a permission
prompt** (`17`). A prompt of `[text, resource_link(file://<cwd>/inside.txt),
resource_link(file://<other tmpdir>/outside.txt)]` was accepted with no error and no `promptCapabilities`
complaint (`initialize` advertises `promptCapabilities: { image: true, embeddedContext: true }` — nothing
about resource links). The agent expanded each link into its **own** `Read` tool call with the resolved
absolute path in `rawInput.file_path` and in `locations[]`. The in-`cwd` read ran with **no permission
request**. The out-of-`cwd` read raised a `session/request_permission` whose only distinguishing marker is
the vendor string `_meta.permission.description: "Reason: Path is outside allowed working directories"` —
a `_meta` string, not a field, and the `kind` is plain `read` like any other. We answered `allow-once` and
the agent read and echoed `OUTSIDE-SECRET-BETA`. So the agent will read anywhere on disk the client permits:
M2-B's prompt-content path containment must reject the link **before the prompt is sent**, and any policy
preset that auto-allows `kind: read` exfiltrates every absolute path a client can name.

**26. Some `execute` tool calls are auto-allowed and some are not.** In `13` a read-only
`ls -A <cwd>` (`kind: "execute"`, `toolName: "Bash"`) ran to `completed` with **no** permission request; in
`16` a `python3 -c …` in the same `cwd` did raise one. The split is decided inside Claude Code and is not
visible in the `tool_call` frame, so the daemon cannot predict which calls will reach the policy engine —
policy must be evaluated on what actually arrives, and "no permission request" must never be read as "no
tool ran".

### Known gaps in this corpus


- **No `plan` update, in two attempts.** This build's tool set has no todo/plan tool, so §6.1's
  `plan → plan_update` row has **no real-agent ground truth** here. It must be covered by a testkit fixture,
  and the compat suite must not assert on it for `claude-acp`.
- **No `agent_thought_chunk`.** Not emitted at the default `effort`. Same conclusion: fixture-only.
- **No `current_mode_update`.** `session/set_mode` produced the v2 `config_option_update` instead, so the
  §6.1 row `current_mode_update → config_option_update` has no v1-side sample from this agent.
- **No `fs/*` or `terminal/*` calls**, as D3 predicts under `clientCapabilities: {}`. Confirmed across all
  18 runs — including `12`/`13`, which declared `fs: { readTextFile: false, writeTextFile: false }` and
  `terminal: false` explicitly. The only agent→client methods anywhere in the corpus are `session/update`,
  `session/request_permission` and `elicitation/create`.
- **No `authenticate` / `auth/logout`, and no MCP servers** — every run sent `mcpServers: []`.
- **No multi-turn tool-call interleaving** and no `tool_call_update` for a tool that fails on its own merits
  (as opposed to a denied permission).
- **Elicitation: only `mode: "form"`, only session-scoped.** No `url`-mode elicitation, no
  `elicitation/complete` notification, no request-scoped (`requestId`) elicitation, no multi-question form,
  no `required` array, and no `action: "cancel"` response — M2 must handle those from the schema, not from
  ground truth. Both observations came from the same `AskUserQuestion` tool; whether an MCP server's
  elicitation would be forwarded the same way is untested (no MCP server was ever configured).
- **No `parkTimeoutAction` observation.** Both elicitations were answered within ~1 ms. What the agent does
  when an `elicitation/create` is left unanswered for minutes — and whether it ever times out on its own —
  is untested.
- **`resource_link` only.** No embedded `resource` content block (`type: "resource"` with inline text or
  blob) was ever sent, so M2-B's containment rule has ground truth for links and none for embedded
  resources.
- **`set_config_option` observed only for `model`.** `effort` and `fast` were never set, and no value was
  set *during* a turn, so whether a mid-turn config change is honoured or rejected is unknown.
