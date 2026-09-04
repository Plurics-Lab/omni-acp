# omni-acp — M1 Code-Level Contract

> Status: **binding** · 2026-09-04 · derived from `docs/DESIGN.md` v0.8 (D1–D15 settled),
> `docs/research/transcripts/claude-acp-0.73.0/` (11 processes, 407 lines, the M1 ground truth) and
> the shipped M0 code on `main` (978 tests green).
>
> This document is the single source of truth for **M0 and M1 shapes**. Every signature in §5 becomes a
> scaffold stub verbatim. Work packages (see `docs/M1-PLAN.md`) fill bodies in; they do not change
> signatures. A signature change is a renegotiation of this document, not a commit.
>
> **Reading M0 vs M1.** M0's text is kept in place, because M0 shipped and its reasoning is still the
> reason the code looks the way it does. Wherever M1 changes an M0 statement, the M0 sentence carries a
> `~~strikethrough~~` or a **SUPERSEDED BY §n** banner and the new rule is stated next to it — never by
> silently rewriting history. §12–§18 are new and are M1-only. §11.4–§11.6 record the M1 rulings.
>
> Where D1–D15 already decided something, this document only makes it typed. Where the three
> M1 proposals disagreed, §11.5 records the decision and the one-line reason.
---

## 0. Facts verified against the artefacts (not recalled)

### 0.0 M0 facts (F1–F10) — still binding

These are the load-bearing observations. Each one changes a contract below.

| #   | Fact                                                                                                                                                                                                                                                                                                                                       | Evidence                                                                | Consequence                                                                                                                                                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F1  | The M0 fixture `@agentclientprotocol/sdk/dist/examples/agent.js` issues `session/request_permission` **mid-turn** and awaits it forever. Options offered: `{kind:"allow_once", optionId:"allow"}`, `{kind:"reject_once", optionId:"reject"}`.                                                                                              | `dist/examples/agent.js` L~120–200                                      | **M0 must ship a permission responder** or the §11 acceptance criterion is unreachable. See §7.4.                                                                                                                                                                              |
| F2  | v2 `SessionUpdate` ends in an **open arm** `{ sessionUpdate: string; [key: string]: unknown }`. v1 `SessionUpdate` does **not**.                                                                                                                                                                                                           | `dist/v2/schema/types.gen.d.ts:3441`, `dist/schema/types.gen.d.ts:3440` | A v1 update is structurally assignable to the v2 type. M0 can type every payload as `V2SessionUpdate` and still forward v1 verbatim. The envelope's `payloadVersion` says which you actually have.                                                                             |
| F3  | v1 `ContentChunk.messageId?: MessageId \| null` (optional); v2 requires it.                                                                                                                                                                                                                                                                | both `types.gen.d.ts`                                                   | Nothing in M0 — daemon or client — may read `messageId`. `messageId` backfill is M1. Asserted by a test.                                                                                                                                                                       |
| F4  | `Usage` on `IdleStateUpdate` is `{totalTokens, inputTokens, …}`. `UsageUpdate` (the `usage_update` payload, present in **both** v1 and v2 with the same shape) is `{used, size, cost?}` — which is what `DESIGN §9.1 TurnResult.usage` specifies.                                                                                          | `dist/v2/schema/types.gen.d.ts:4204,4227`; `dist/schema/types.gen.d.ts` | `reduceTurn` sources `usage` from the **last `usage_update`**, never from `idle.usage`.                                                                                                                                                                                        |
| F5  | v1 `Diff = { path: string; oldText?: string \| null; newText: string }`, reachable as `ToolCallContent{type:"diff"}` in both versions.                                                                                                                                                                                                     | `dist/schema/types.gen.d.ts:522`                                        | `TurnResult.changes` is a 12-line deterministic extraction and ships in M0. `patch` stays `null` (git provider is M2, D8).                                                                                                                                                     |
| F6  | `ndJsonStream(output: WritableStream<Uint8Array>, input: ReadableStream<Uint8Array>): Stream` — first argument is what **we write** (agent stdin), second is what **we read** (agent stdout). The SDK's own example names the locals misleadingly.                                                                                         | `dist/acp.d.ts:28`, `dist/examples/agent.js`                            | Argument order is called out in `spawn.ts`'s doc comment and pinned by a test.                                                                                                                                                                                                 |
| F7  | `acp.Stream = { writable: WritableStream<AnyMessage>; readable: ReadableStream<AnyMessage> }` — a **message** stream, not a byte stream. Two cross-wired `TransformStream`s satisfy it.                                                                                                                                                    | `dist/acp.d.ts:15`                                                      | `AgentProcess.stream: Stream` is the test seam: an in-memory pair drives a real `acp.agent()` against a real `acp.client()` with **no process and no framing**. This is the Tier‑1 fixture.                                                                                    |
| F8  | The SDK does **not** export `./package.json` or `./dist/examples/*` in its `exports` map.                                                                                                                                                                                                                                                  | `package.json` `exports`                                                | The fixture path must be derived from the main entry: `join(dirname(createRequire(import.meta.url).resolve("@agentclientprotocol/sdk")), "examples/agent.js")`. Never `require.resolve(".../package.json")`, never `new URL(...).pathname` (breaks on Windows `file:///C:/…`). |
| F9  | multica deliberately uses `CREATE_NEW_CONSOLE + SW_HIDE` on Windows and documents that `CREATE_NO_WINDOW` is what produced its per‑grandchild popup storm (GH #1521). Node's `windowsHide:true` maps to `CREATE_NO_WINDOW`; Node cannot express `CREATE_NEW_CONSOLE + SW_HIDE`, cannot create a Job Object, and cannot `CREATE_SUSPENDED`. | `multica/server/pkg/agent/proc_windows.go:17–43`                        | Windows process ownership in M0 is **strictly weaker than multica's** and must be reported as such, not papered over. See §6.4 and `PlatformOwnership`.                                                                                                                        |
| F10 | multica POSIX: `Setpgid` is set in `newRuntimeCmd`, the single construction point, precisely because per-backend opt-in leaked 19 of 27 sites (GH #7522).                                                                                                                                                                                  | `proc_other.go:26–32`                                                   | The single-spawn-entry rule is enforced by a **test that fails on a planted violation**, not by convention.                                                                                                                                                                    |


### 0.1 M1 facts — verified on this machine on 2026-09-04, not recalled

Every row was executed or measured while writing this document. Each one changes a contract below.
"corpus" means `docs/research/transcripts/claude-acp-0.73.0/*.jsonl`.

| #   | Fact | Evidence | Consequence |
| --- | ---- | -------- | ----------- |
| F11 | `runEventLogConformance` asserts **object identity**: `const e = log.append(…); expect(log.read(0)[0]).toBe(e)`. | `packages/testkit/src/event-log-conformance.ts:73-80` | A pure-SQLite `read()` deserialises and returns a *different* object, so it fails a suite §8.1 says the M1 driver "must pass verbatim". The SQLite driver is therefore **write-through behind the existing in-memory ring** — a contract requirement, not a performance choice (§14.1, ruling M1-R1). |
| F12 | `node:sqlite`'s `DatabaseSync` works unflagged on node 22.23.2 and prints exactly one `ExperimentalWarning` at first import. 1 000 single-row prepared inserts: **2.5 ms** in-memory. | executed | §8.1's stated reason for deferring SQLite (import noise inside `OmniACP.local()`) is answered by a lazy, driver-gated import plus a surgical suppression (§14.2), not by `--no-warnings`. Synchronous `append()` survives intact. |
| F13 | `available_commands_update` is **275 270 of 313 643** update bytes (**87.8 %**) across 23 notifications carrying only **2 distinct payloads**. Largest single line 12.7 KB. | measured over all 11 transcripts | At D6's 7-day retention it dominates the log. Ruling M1-R3: stream in full, store by content digest; never store-but-do-not-stream (§14.6). |
| F14 | A replayed `messageId` is **byte-identical** to the live one — `msg_011CehUNRWv8TiYSkoViPkpy` appears in `01` and again in `07`'s replay — but the **chunking differs**: live was `"P"` + `"ONG"`, the replay is one `"PONG"`. The replayed *user* id is a fresh UUID. | measured | Replay de-duplication can key on `messageId` and **cannot** key on a per-chunk content hash. It is still one agent at one version, so dedup is **opt-in**, not the default (ruling M1-R5). |
| F15 | The `-32002 "Resource not found: <sessionId>"` cwd-mismatch response that the corpus README §10 builds D2's most dangerous edge case on **does not appear in any committed transcript**: `grep -c "Resource not found" *.jsonl` is zero across all 11 files. | executed | It is an unrecorded observation, not wire evidence. The classifier's negative lock uses the README's recorded shape as a **regression fixture**, and the compat suite must **re-observe it live** (`resume-cwd-mismatch` case) so the claim becomes reproducible. See §15.4 and ruling M1-R6. |
| F16 | The replay window in `07` is exact and uninterleaved: `session/load` request at **943.803 ms**, replay updates at **1491.918 / 1492.487 ms**, response at **1493.135 ms**. The first *non*-replay update (`available_commands_update`) is at 1495.271 ms — after the response. | measured | D6's "everything between the request and its response is replay" is literally correct for this agent. The window is opened and closed by the Worker, not carried as reducer state (§15.3). |
| F17 | Error shapes are uniform and machine-separable: unknown method `-32601 {message:"\"Method not found\": <m>", data:{method}}`; wrong **param name** `-32602 {data:{configId:{_errors:[…]}}}`; wrong **value** `-32603 {data:{details:"Invalid value for config option model: …"}}`. | corpus `08` | The vendor registry and the probe classify on **code + a JSON pointer into `data`**, never on message text. `-32603` alone cannot distinguish a bad value from a genuine internal error (§17.4). The probe *learns* that the field is `configId` from the `-32602` body. |
| F18 | Both `session/resume` (the v2 name) and `session/load` are implemented and both return the `session/new` body `{sessionId, modes, configOptions}`. `replayFrom:{type:"start"}` is accepted and ignored. `session/set_model` and `session/set_options` are `-32601`; `session/set_mode` and `session/set_config_option{configId}` are **both live on one process**. | corpus `07`, `08` | The descriptor expresses **preference order over several spellings per capability**, not one name per capability (§17.3). `AgentCapabilitiesSnapshot.resume.method` is resolved once at handshake. |
| F19 | `_meta.claudeCode.toolResponse` carries `{filePath, oldString, newString, originalFile, structuredPatch, userModified, replaceAll}`. The v1 `diff` block's `oldText`/`newText` are the **changed fragment**, widened between updates. | corpus `10` | DESIGN §6.1's `diff → {changes, patch:{format:"git_patch"}}` is **not computable from the standard v1 fields**. `changes` is computable; `patch` stays `null` (D8) and the reconstructed vendor patch is surfaced separately as `TurnResult.vendorPatch` (§12.5, ruling M1-R11). `FileChange.fragment` exists because treating a fragment as file content corrupts the file. |
| F20 | `usage_update._meta["_claude/rateLimit"]` = `{status:"allowed_warning", resetsAt, rateLimitType, utilization:0.78, isUsingOverage, surpassedThreshold, unifiedWindows}`. | corpus `01` | This is the structured signal DESIGN §6.2's "`end_turn` ≠ 成功 / promote to failed on 429" needs. It arrives **before** the failure and is not stderr text (§13.4). |
| F21 | The `session/prompt` **response** carries `usage: {inputTokens, outputTokens, cachedReadTokens, cachedWriteTokens, totalTokens}` — the v2 `IdleStateUpdate.usage` shape, which is a **different type** from `usage_update`'s `{used, size, cost?}` (F4). | corpus `01` | F4 stands: `TurnResult.usage` still comes from the last `usage_update`. M1 additionally lands the response block on `state_update{idle}.usage` (where v2 puts it) and exposes it as `TurnResult.tokens` (§12.3 row 15). |
| F22 | `Worker.prompt()` and `Worker.cancel()` already call `this.#deps.lease.assertHolder(who)` as their first statement. | `packages/core/src/worker/worker.ts:274, :369` | D5 enforcement lands with **zero edits to `worker.ts`** — WP‑D swaps the `Lease` factory the registry passes in. This is the payoff of M0's DI and it is what keeps the lease work package file-disjoint (§16.1). |
| F23 | `reduceTurn`'s `upsertToolCall` already folds **both** `tool_call` and `tool_call_update`, already implements "an absent field means unchanged", and already replaces `content` wholesale. | `packages/protocol/src/turn.ts:135-208` | Corpus finding 3 ("merge, never replace") is already satisfied in the projection. The Normalizer's `tool_call → tool_call_update` row is therefore a **rename of the discriminant and nothing else**; merging in the mapper would make the stream a materialized view and break `?since=` (§12.1, ruling M1-R13). |
| F24 | claude-acp answers `initialize` with `protocolVersion: 1` and hangs `session/prompt` (v1), while already emitting `usage_update` and `config_option_update`, already returning `configOptions` from `session/new`, and already implementing `session/set_config_option` / `session/list` / `session/resume` (v2). | corpus, all 11 | The v1→v2 map is **per-field and per-method, descriptor-driven, and idempotent on already-v2 fields**. No mapping rule may read a version number. `Normalizer.sourceProtocolVersion` is for reporting only (§12.2). |
---

## 1. Conventions (settled; do not debate)

| Item                         | Value                                                                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language                     | TypeScript, `strict: true`, plus `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`, `erasableSyntaxOnly` |
| `exactOptionalPropertyTypes` | **off** — the SDK's generated types are pervasively `?: T \| null`; turning it on buys friction, not safety. Revisit at M1.                                   |
| Modules                      | ESM only. `"type":"module"`, `module`/`moduleResolution`: `nodenext`, **`.js` specifiers in source**                                                          |
| Node                         | `>=22` (`engines`), CI pins `22.x` on all three OSes                                                                                                          |
| Package manager              | pnpm 11.25 workspaces, `workspace:*` for internal deps                                                                                                        |
| Build                        | `tsc -b` project references. No bundler. `rootDir: src`, `outDir: dist`, `composite`, `declaration`, `declarationMap`, `sourceMap`                            |
| Test                         | vitest. **Tests run against built `dist`, after `pnpm -r build`** (see §11 D25). Root `test` script is `tsc -b && vitest run` so a fresh clone cannot answer with a module-resolution error instead of a test result (review R5)                                                                               |
| Validation                   | zod v4 for anything crossing a wire or a config file                                                                                                          |
| ACP SDK                      | `@agentclientprotocol/sdk` pinned to exactly `1.4.0` (no caret) in every package that uses it, asserted by a test                                             |
| ids                          | ULID, Crockford base32, 26 chars, prefixed: `d_` daemon, `w_` worker, `t_` turn. `sessionId` is agent-assigned and **opaque — never parsed**                  |
| Time                         | Every timestamp is ISO‑8601 with milliseconds, produced by an injected `Clock`. No bare `Date.now()` outside `Clock`                                          |
| Line endings                 | `.gitattributes: * text=auto eol=lf`; Windows CI sets `core.autocrlf false`, `core.longpaths true`                                                            |
| Acceptance command           | `pnpm -r build && pnpm -r test` green on ubuntu-latest, macos-latest, windows-latest                                                                          |

**M1 leaves this table unchanged**, including `exactOptionalPropertyTypes: off` (ruling M1-R20 — the SDK is still
pinned at 1.4.0 with the same pervasively `?: T | null` generated types, and M1 *adds* optional-field
surface) and `@agentclientprotocol/sdk` at exactly `1.4.0`. M1 adds one runtime dependency of its own:
**`node:sqlite`, a Node built-in** — no package, no lockfile change (§14.2).

---

## 2. M0 + M1 slice — what is IN

> §2.1/§2.2 carry M0's rows unchanged (they shipped) plus the M1 rows. §2.3 is now **what is out of M1**;
> every M0-deferred item that M1 lands has moved up into §2.1/§2.2 and is struck through in the M1
> deferral table with the row that replaced it.

### 2.1 HTTP surface (`/v1`)

All routes except `GET /v1/health` require `Authorization: Bearer <secret>`. `Omni-Client-Id` is recorded
for audit and — **from M1** — is the lease identity (D5); it is still **not** a visibility boundary (D13).

| #   | Route                                      | Contract                                                                                                                                                                                                                                                                              |
| --- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1  | `GET /v1/health`                           | **Unauthenticated.** `200 {"ok":true}`. Liveness only — no daemonId, no version, no ACL data.                                                                                                                                                                                         |
| H2  | `GET /v1/info`                             | Authenticated. `200 DaemonInfo` — persistent `daemonId`, version, platform, node, `protocolVersions`, `ownership` (§6). **M1 adds** `canonicalPayloadVersion: 2`, `persistence` (driver / file / schemaVersion / sizeBytes / writeFailures / retentionDays / lastSweep), `bootId` and `orphansAtStart` (§14.9, §15.7) — the fields that let an operator see that persistence is off, degraded, or that a previous boot left processes behind. |
| H3  | `GET /v1/whoami`                           | `200 WhoAmIResponse`. The only call `OmniACP.connect()` makes (DESIGN §8).                                                                                                                                                                                                            |
| H4  | `GET /v1/agents`                           | `200 { agents: AgentCatalogEntry[] }`. ~~`probed: null` in M0.~~ **M1**: `probed` is the cached `ProbeSummary` or `null` if never probed — never fabricated — plus `runtimeId` (`"<agentId>@<fingerprint12>"`), the descriptor identity that governed the last worker. `args` stay redacted through `redactArgs`; the probe result must not become the leak `catalog.ts` closed. |
| H5  | `POST /v1/workers`                         | **Synchronously ready**: spawn → `initialize` → `session/new` → `201 WorkerSnapshot{state:"ready"}` with the real handshake `capabilities`. Handshake JSON-RPC error → `502 agent_error`; budget exceeded → `504 agent_timeout`. **Both reclaim the process tree before responding.** **M1 body additions**: `idleTimeoutMs` (per-worker hibernate override, `0` disables) and `lease: "take" \| "observe"` (default `take` — the creator holds the lease, D5). |
| H6  | `GET /v1/workers`                          | `200 { workers: WorkerSnapshot[] }`, filtered by D13 visibility. **M1**: served from the worker store, so it includes `hibernated` workers and workers adopted from a previous boot; live handles override the persisted row because a live snapshot is fresher (§14.8). |
| H7  | `GET /v1/workers/{wid}`                    | `200 WorkerSnapshot`, or `404 worker_not_found` (also when invisible — never leak existence). **M1**: a worker not in memory is lazily rehydrated from the store before this answers (§14.8). |
| H8  | `POST /v1/workers/{wid}/prompt`            | `202 PromptAccepted { turnId, seq }`. `409 worker_busy` unless state is `ready`; `410 worker_closed`; content pre-checked against `promptCapabilities` → `400 bad_request`; **still only `type:"text"` blocks** (M2 relaxes, review R12). **M1**: a `hibernated` worker **auto-wakes** (DESIGN §3.2) — the call blocks for the wake budget and then behaves normally, or fails with `422` / `502` / `504` / `429` per §15.5. Lease-gated (`423`). |
| H9  | `POST /v1/workers/{wid}/cancel`            | `202 {}`. ACP `session/cancel` notification, then bounded escalation (§6.5). Idempotent; a no-op when not `running`. Lease-gated (`423`).                                                                                                                                              |
| H10 | `GET /v1/workers/{wid}/events?since=<seq>` | SSE. Synchronous backlog replay then live tail (§8). **M1**: restart-survivable under `eventLog.driver:"sqlite"` — the same `?since=N` returns the same envelopes with the same `seq` after a `stop()`/`createDaemon()` cycle (§14.4). **Never lease-gated**: observer mode is the point of D5 (§16.2). |
| H11 | `GET /v1/workers/{wid}/turns/{turnId}`     | `200 TurnStatus`. Unknown turn → `state:"unknown", result:null` (**not** a 404 — §11 D29).                                                                                                                                                                                            |
| H12 | `DELETE /v1/workers/{wid}`                 | Best-effort `session/close` (skipped unless advertised) → kill tree → `200 CloseResult`. **Idempotent**, now across a **daemon restart** too: the persisted `CloseResult` is returned byte-for-byte rather than recomputed, because recomputing would report a `treeGone` we never proved (§15.6). **M1 adds** `CloseResult.sessionClosed` — false for every close of a `hibernated` worker, because we do not spawn a process in order to close a session. Requires the lease **or** `role:"admin"` (§16.1 rule L3). |
| H13 | Auth middleware                            | SHA-256 of the bearer secret compared with `timingSafeEqual`, **re-evaluated on every request, never cached** (DESIGN §8). Token never appears in a URL or a log line.                                                                                                                |
| H14 | ACL                                        | Agent allowlist and `cwdRoots` (after `realpath`) → `403 forbidden`. Per-token and global `maxWorkers` → `429 worker_limit`. **M1**: a `hibernated` worker holds **no** `maxWorkers` slot (it owns no process) and one `hibernate.maxHibernated` slot instead; a wake re-reserves a `maxWorkers` slot and may therefore legitimately `429`. A wake also **re-runs the full ACL check against the current config** — a restart must not resurrect a worker the present ACL forbids (§15.7). |
| H15 | Error body                                 | `{ code, message, acp?, lease?, resume? }`, produced by exactly one mapper over `ERROR_STATUS` (§9). `lease` appears **only** on `423`, `resume` **only** on `422`, so two bodies for the same failure stay deep-equal. |
| **H16** | `POST /v1/agents/{id}/probe`           | **M1.** `auth.assertAgent(id)` **first**, so a forbidden agent `403`s before a process exists. Then ONE throwaway process through `Supervisor.spawn` (never a second spawn site, F10): `initialize`, and when `deep` also `session/new` in a `mkdtemp` cwd plus the side-effect-free method battery. `200 ProbeResponse { probe, cached }`; `502` / `504` on agent failure. Result cached to `<dataDir>/probes/<id>.json`, mode `0600`, invalidated by the descriptor fingerprint. Concurrent probes of one agent **share one in-flight process**. Bounded by `probe.maxConcurrent`; probes do not consume `maxWorkers` slots but do reclaim their tree on every edge. |
| **H17** | `POST /v1/workers/{wid}/lease/{acquire\|release\|steal}` | **M1.** `200 LeaseSnapshot`. `423 lease_held` carries `body.lease` naming the holder and the epoch — a client must not need a second round trip against a worker it may no longer control. `steal` requires `role:"admin"`, or a same-token peer after `lease.stealAfterIdleMs`; it bumps the epoch and appends an audited `omni.lease{op:"stolen", reason}` envelope (§16). |
| **H18** | `POST /v1/workers/{wid}/hibernate`     | **M1.** `200 WorkerSnapshot{state:"hibernated"}`. `409 worker_busy` while a turn is live. `422 not_resumable` when the agent advertises no resume spelling and `hibernate.whenNotResumable:"keep"` (the default) — hibernating a worker that can never wake is a one-way door (ruling M1-R15). Lease-gated. |
| **H19** | `POST /v1/workers/{wid}/wake`          | **M1.** `200 WorkerSnapshot{state:"ready"}`; the full outcome table is §15.5. Prompting auto-wakes, so this route exists for two reasons only: to let an operator pay the cold start deliberately, and to make a `422 not_resumable` observable **without burning a prompt**. Idempotent and single-flight: concurrent callers share one attempt. Lease-gated. |
| **H20** | Lease gating, stated once              | **M1.** Gated: `prompt`, `cancel`, `hibernate`, `wake`, `DELETE` (or admin), and — when M2 lands them — `config` and `interactions`. **Ungated: every `GET`, and the SSE stream.** An optional `Omni-Lease-Epoch` header is a fencing check: present and stale ⇒ `423` even from the right client id (§16.1 rule L7). |
| **H21** | `GET /v1/info` honesty                 | **M1.** `persistence.driver` says whether this daemon's logs survive a restart, `persistence.writeFailures` says whether they still do, and `orphansAtStart {found, reaped, skipped}` says what a previous boot left behind — including `skipped: n` on Windows, where nothing can be reaped (§15.7). An operator must be able to read these **before** anything goes wrong (§6.6's rule, extended). |

### 2.2 Library / core

M0 rows L1–L13 stand unchanged and are not restated except where M1 alters them.

| #   | Item                                                                                                                                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L5′ | **Event Log** — M0's in-memory ring, unchanged, **plus** an optional write-through durable backend. `append` is still synchronous and is still the sole assigner of `seq`. `EventLog` gains `persistent` and `flush()` and nothing else (§14.1).                                                                                       |
| L6′ | **Normalizer** — no longer "lifecycle only". Three layers: a pure, total, idempotent **map** (`mapUpdate` / `mapPermissionRequest` / `mapRequest`), the **lifecycle** reducer (turn boundary, close-out ladder, replay window), and the **projection** (`reduceTurn`, unchanged in kind). §12.                                          |
| L8′ | **Lease** — real. Acquire / release / steal with a fencing **epoch**, TTL that cannot fire mid-turn, implicit acquire of an unheld lease, release on hibernate, `omni.lease` audit envelopes, `423 lease_held` carrying the holder. `alwaysGrantedLease` is retained for in-process callers and fixtures. §16.                        |
| L14 | **`EventStore` / `WorkerStore` on `node:sqlite`** — one `DatabaseSync` per `dataDir`, WAL, lazy driver-gated import, surgical `ExperimentalWarning` suppression, write-through behind the ring (F11, F12). §14.1–§14.3.                                                                                                               |
| L15 | **`seq` continuity across restarts** — restored as `max(persisted head_seq, max(seq))`, so a worker whose rows were fully evicted by retention does **not** restart its own sequence at 1 (§14.4). This is the single most dangerous line in M1 and it has a named regression test.                                                    |
| L16 | **Retention** — three bounds that are constantly confused and are enumerated once: the RAM ring (memory only), a per-worker durable row cap, and 7 days after **close**. `tail` tells the truth after every sweep; a live or hibernated worker is never aged out (§14.5).                                                              |
| L17 | **Durable worker records + lazy rehydration + adoption** — `workerId → (agentId, sessionId, cwd, label, owner, state, capabilities, closeResult, …)` (D2). `GET`/`DELETE`/`?since=` all work against a worker this process never created; boot adoption turns every live-state row from a previous boot into `hibernated` or `closed` (§14.8, §15.7). |
| L18 | **Orphan handling** — a process fingerprint captured at spawn (`/proc/<pid>/stat` starttime + `/proc/stat` btime on Linux, `ps -o lstart=` on darwin, `null` on win32). A restarted daemon **records every orphan** and **signals only a matching fingerprint**; a null or mismatched fingerprint is never signalled, because pid reuse makes that a coin flip on somebody else's process (§15.7).                                       |
| L19 | **Hibernate / wake / resume four-state** — idle timer → process reclaimed, lease released, record and session pointer kept; wake = spawn → `initialize` → the descriptor's preferred resume spelling → `classifyResume` (pure, rule-numbered) → `landed` / `rejected_permanent` / `rejected_transient` / `unknown`. §15.               |
| L20 | **`422 not_resumable` and `423 lease_held` become reachable.** No new error codes: DESIGN §5.4's table is unchanged and both codes were reserved in M0 (§9).                                                                                                                                                                          |
| L21 | **Runtime descriptors** (builtin ⊕ config ⊕ probe), a **vendor-extension registry with preference order over several spellings per capability** and `-32601` learning, and error classification keyed on **code + a JSON pointer into `data`** — never on message text (F17, F18). §17.                                              |
| L22 | **`POST /v1/agents/{id}/probe`** + an on-disk probe cache, and `AgentCatalogEntry.probed` populated from it. §17.5.                                                                                                                                                                                                                   |
| L23 | **Turn close-out: two ladders** — `settle` (per turn: quiet window, unchanged from M0) and `close_out` (teardown: quiet → `session/cancel` → close stdin → drain → terminate; the cancel precedes the stdin EOF because it travels on stdin, ruling M1-R4a). `closeStdin()` still never appears at turn end (§13, ruling M1-R4).                                                                                     |
| L24 | **Config-driven compat suite** (`tests/compat/`) — the agent list is YAML, one real entry today (`claude-acp`), and adding an agent is a YAML edit with **zero code changes**, proven by a test. Skips are reported with a source and a reason; a skip with no source is a failure. §18.                                              |

### 2.3 What is OUT of M1 — deferred, one line each

| Deferred                                                                                                                                                                                                                            | To                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| ~~Full v1→v2 map~~ · ~~`session/load`/`session/resume`, replay marking, resume four-state, `hibernated`, `422`~~ · ~~Event-log persistence, 7-day retention, restart-survivable `?since=`~~ · ~~Lease acquire/release/steal, `423`~~ · ~~Turn close-out beyond the quiet window~~ · ~~Vendor extension registry, Runtime descriptors, quirk table~~ · ~~`POST /v1/agents/{id}/probe`~~ | **LANDED in M1** — §12–§18 |
| **v2→v1 reverse map.** D1 says the map's other half; M1 ships only v1→v2 because that is where the traffic is (DESIGN §1.1: 0 of 39 registry agents have v2 evidence).                                                              | M4 (D1)                 |
| **Client Host `fs/*` / `terminal/*`.** D3 keeps `clientCapabilities: {}`; the corpus confirms across all 11 runs that the only agent→client methods are `session/update` and `session/request_permission`. §12.3's `terminal_update` / `terminal_output_chunk` rows are therefore **not implemented**. | M4 (D3)                 |
| **`TurnResult.patch`** — stays `null`. The reconstructed vendor patch is `TurnResult.vendorPatch`, clearly labelled and descriptor-driven; D8's git provider remains the only source of truth for changes the agent did not self-report (ruling M1-R11). | M2 (D8)                 |
| Policy rule engine, `onUnresolved: park\|fail`, `policyCeiling`, `POST …/interactions/{reqId}`, `requires_action` — M1's worker state set is `starting \| ready \| running \| hibernated \| closed`.                                | M2 (D4/D10)             |
| `elicitation/create`                                                                                                                                                                                                                | M2 (D10)                |
| `mcpServers` presets + `mcpCapabilities` filtering — M1 **still always sends `mcpServers: []`**. The MCP `type` injection rule (§12.3 row 22) is implemented and unit-tested but **unreachable from the wire**.                     | M2 (DESIGN §8)          |
| Image / audio / `resource_link` / embedded-resource prompt content — still `type:"text"` only.                                                                                                                                       | M2 (DESIGN §5.1)        |
| `authenticate` → `auth/login` — the map row and the descriptor spelling ship; there is **no real-agent exercise** (corpus gap), so the descriptor marks it `unverified` and the compat suite refuses to assert it.                   | M2                      |
| Per-request `CreateWorkerRequest.env` + blacklist, credential store                                                                                                                                                                 | M2                      |
| Webhooks, `POST /v1/runs`, Run API, idle watchdog dual budget                                                                                                                                                                       | M2 (D9)                 |
| `POST /v1/workers/{wid}/config` — M1 **probes** the config methods and records their spellings; it does not expose them.                                                                                                             | M2                      |
| **Lease persistence.** A restart leaves every worker unleased; the adoption pass emits `omni.lease{op:"expired", how:"daemon_restart"}` so the transfer is **audited rather than silent** (ruling M1-R8).                            | M2 (D5)                 |
| `GET /v1/fs/*`, TLS/mTLS, token issue/revoke                                                                                                                                                                                        | M2–M4                   |
| `adopt: "prefer" \| "require"`, `daemon.json` discovery/reuse                                                                                                                                                                        | M3 (D14)                |
| `Fleet`, `server.runs`, cross-daemon access to one `dataDir` (**one daemon per data dir, lock-enforced** — §14.10)                                                                                                                   | M3/M4 (D11)             |
| `/acp/{agentId}`, `AcpServer`, WebSocket, `@omni-acp/bridge`                                                                                                                                                                        | M4 (D12)                |
| `agents: "auto"` discovery, registry install                                                                                                                                                                                        | M4 (DESIGN §7)          |
| cgroup v2 / Job Object resource limits; a Windows Job Object that would also fix `treeGone` and orphan reaping                                                                                                                       | M2+                     |
| A second event-log backend (Postgres/S3) — the `EventStore` seam exists; only SQLite implements it.                                                                                                                                 | never scheduled         |

**Acceptance (DESIGN §11's M1 criterion, made mechanical).** The **config-driven compat suite** (§18) runs
the identical SDK script against every configured agent — today `claude-acp` only, tomorrow a YAML edit —
and for each one asserts: a tool-using turn completes with the same observable `TurnResult` shape; an SSE
stream dropped mid-turn and reconnected with `?since=` yields a union whose **envelope frames** — the
`id:`/`event:`/`data:` triples, with `: hb` heartbeat comments and the `retry:` / `omni.stream_truncated` /
`_overflow` / `_end` control frames excluded — are **identical** to an uninterrupted observer's, and
gap-free (review R12: `sse.ts` writes a `retry:` preamble on every stream and heartbeats on a phase the two
connections do not share, so a RAW byte comparison is unachievable against a file M1 froze by checksum); a worker forced to `hibernated` by a small `idleTimeoutMs` wakes on
the next prompt with a recorded `ResumeReport` whose `outcome` is `landed`; a second client's `prompt`
returns `423` with the holder named, and its `steal` transfers the lease, bumps the epoch and makes the
first client's next call `423`. Agents not configured on this machine are **skipped with a printed
reason**, never silently passed. Full script in `docs/M1-PLAN.md` §4.

---

## 3. Package layout

```
omni-acp/
├── package.json                    private root; scripts; ALL devDependencies
├── pnpm-workspace.yaml
├── pnpm-lock.yaml                  regenerated ONLY by the scaffold step
├── tsconfig.base.json              compilerOptions only — no `paths`
├── tsconfig.json                   solution file: references only
├── vitest.config.ts                root runner, `projects: ["packages/*", "tests/*"]`
├── .npmrc  .gitattributes  .editorconfig  .prettierrc  eslint.config.js  .gitignore
├── .github/workflows/ci.yml
└── packages/
    ├── protocol/     @omni-acp/protocol      published
    │   ├── schema/{v1.schema.json, v2.schema.unstable.json, PROVENANCE.md}
    │   └── src/{index,ids,errors,events,worker,turn,control-plane,config,acp,contracts}.ts
    │                +M1 src/{lease,resume,runtime}.ts
    ├── testkit/      @omni-acp/testkit       PRIVATE, never published
    │   ├── src/{index,memory-stream,scripted-agent,fake-supervisor,fake-clock,seq-ids,
    │   │         stub-daemon,sse,process-tree,paths,event-log-conformance}.ts
    │   │                +M1 src/{corpus,wire-agent,fake-runtime,tmp-persistence,lease-conformance}.ts
    │   └── fixtures/agents/{echo,crash,slow,chatty,orphan,noisy}.mjs
    │                +M1 fixtures/agents/{plan,thought,mode,hybrid}.mjs
    ├── core/         @omni-acp/core          published
    │   └── src/
    │       ├── index.ts                       re-export barrel (frozen by scaffold)
    │       ├── process/{spawn,platform,platform-posix,platform-windows,
    │       │            agent-process,stderr-tail,frame-limit,supervisor}.ts
    │       ├── event-log/memory-log.ts
    │       │                +M1 event-log/{log-core,sqlite-log,retention}.ts
    │       │                +M1 persist/{open,schema,event-store,worker-store,persistence,lock,warning}.ts
    │       ├── normalizer/{normalizer,turn-lifecycle}.ts
    │       │                +M1 normalizer/map/{update,tool-call,diff,permission,capabilities,
    │       │                                    message-id,methods,digest}.ts
    │       │                +M1 normalizer/vendor/{registry,dialects}.ts
    │       ├── acp/link.ts
    │       ├── worker/{worker,handshake,permission-responder}.ts
    │       │                +M1 worker/{session-open,resume,resume-classify,hibernate,wake,rehydrated}.ts
    │       │                +M1 process/fingerprint.ts
    │       │                +M1 runtime/{descriptor,known,merge,probe,classify,extensions}.ts
    │       └── lease/{always-granted}.ts     +M1 lease/{lease,policy}.ts
    ├── daemon/       @omni-acp/daemon         published
    │   └── src/
    │       ├── index.ts                       frozen barrel
    │       ├── {create-daemon,types,registry,catalog,auth,ids-file,clock,logger}.ts
    │       │                +M1 {boot-recovery,probe-service,probe-cache,event-store}.ts
    │       └── http/{app,routes,auth-middleware,sse,errors}.ts
    │                +M1 http/routes/{index,workers,lease,agents}.ts   (routes.ts is split)
    ├── client/       @omni-acp/client         published
    │   └── src/{index,omni-acp,server,worker,transport,sse-parse,local}.ts
    └── cli/          @omni-acp/cli            published, bin `omni-acp`
        └── src/{bin,main,args,yaml-config}.ts
└── tests/integration/  @omni-acp/integration-tests   PRIVATE
    │   └── src/*.itest.ts
└── tests/compat/        @omni-acp/compat-tests        PRIVATE, M1
    ├── agents.ci.yaml         hermetic: the SDK example agent + the EIGHT turn-completing
    │                          testkit fixtures (crash and orphan are excluded — neither
    │                          completes a turn, which every case here asserts)
    ├── agents.local.yaml      real agents; ONE entry today (claude-acp); OMNI_COMPAT_REAL=1
    └── src/{config,runner,cases}.ts
```

`bridge/` is **not created** in M0 (M4, D12).

### 3.1 Dependency direction (a DAG; enforced by a manifest test)

```
protocol ──┬──► testkit
           ├──► core ──► daemon ──► cli
           └──► client                    integration ──► {client, daemon, core, testkit}
```

`@omni-acp/client` must never carry `hono`, `yaml` or `@omni-acp/daemon` in its **runtime** dependency
closure; `@omni-acp/daemon` never appears in `client`'s `dependencies` — only in `peerDependencies` with
`peerDependenciesMeta.optional: true`, reached solely through `await import("@omni-acp/daemon")` (D14).

### 3.2 Manifests

| package                                 | `dependencies`                                                                                                    |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `@omni-acp/protocol`                    | `@agentclientprotocol/sdk@1.4.0`, `zod@^4`                                                                        |
| `@omni-acp/testkit` (private)           | `@omni-acp/protocol@workspace:*`, `@agentclientprotocol/sdk@1.4.0`                                                |
| `@omni-acp/core`                        | `@omni-acp/protocol@workspace:*`, `@agentclientprotocol/sdk@1.4.0` · dev: `@omni-acp/testkit`                     |
| `@omni-acp/daemon`                      | `@omni-acp/protocol`, `@omni-acp/core`, `hono@^4`, `@hono/node-server@^2` · dev: `@omni-acp/testkit`              |
| `@omni-acp/client`                      | `@omni-acp/protocol` **only** · peer(optional): `@omni-acp/daemon` · dev: `@omni-acp/testkit`, `@omni-acp/daemon` |
| `@omni-acp/cli`                         | `@omni-acp/protocol`, `@omni-acp/daemon`, `yaml@^2`                                                               |
| `@omni-acp/integration-tests` (private) | all of the above + `@agentclientprotocol/sdk@1.4.0`                                                               |

Every package: `"type":"module"`, `"engines":{"node":">=22"}`,
`"exports":{".":{"types":"./dist/index.d.ts","import":"./dist/index.js"}}`,
`"scripts":{"build":"tsc -b","test":"vitest run","clean":"tsc -b --clean"}`.

**`files` and build info (review R4).** Every published package ships `["dist", "src"]` (protocol
adds `"schema"`). `src` is published because `tsconfig.base.json` sets `declarationMap` and
`sourceMap`: without the sources, every `.d.ts.map` / `.js.map` in the tarball points at a path
that does not exist, and a consumer's go-to-definition and stack frames resolve to nothing. For
the same reason the incremental build state moved out of the published directory —
`"tsBuildInfoFile": ".tsbuildinfo"` in each `packages/*/tsconfig.json`, covered by the root
`.gitignore`'s `*.tsbuildinfo` — instead of being published as `dist/.tsbuildinfo`.

**Pinned versions (scaffold's choice, amendment A5).** `typescript@^6.0.3` (not 7.x: the native
port's build-mode/composite behaviour is unvalidated for this layout), `vitest@^4.1.11`,
`zod@^4.5.4`, `hono@^4.13.5`, `@hono/node-server@^2.1.1`, `@types/node@^22.20.1` (matched to the
Node 22 runtime, so a test cannot type-check against an API Node 22 lacks), `yaml@^2.9.0`,
eslint 10 + typescript-eslint 8 + prettier 3. `@agentclientprotocol/sdk` is exactly `1.4.0`, no
caret, asserted by `sdk-version-pinned`.

**Dependency freeze.** Every runtime and dev dependency is declared by the scaffold step. No work package
adds, removes or bumps a dependency, or touches `pnpm-lock.yaml`. A needed dependency is a request to the
scaffold owner, not an edit — this removes the only guaranteed merge conflict in a parallel pnpm workspace.

**Barrel freeze.** Every `packages/*/src/index.ts` is written by the scaffold and is re-export-only. No work
package edits one.

---

## 4. Why every cross-package interface lives in `@omni-acp/protocol`

`tsc -b` project references must be acyclic. `testkit` must produce values typed as `Supervisor` /
`AgentProcess` / `EventLog` / `Daemon`, while `core`'s and `daemon`'s tests consume `testkit`. Putting those
interfaces in `core` forces `testkit → core → testkit`. So `packages/protocol/src/contracts.ts` holds
**every** interface that crosses a package boundary; `core` and `daemon` implement and re-export them.

This is also the mechanism that makes the work packages genuinely file-disjoint: WP‑4 (Worker) compiles and
tests against `Supervisor` as an _interface_ plus `FakeSupervisor` from testkit, never against WP‑2's
implementation; WP‑5's HTTP half tests against `stubDaemon()`, never against its own registry.

---

## 5. Public interfaces — these become the scaffold stubs

### 5.1 `@omni-acp/protocol`

#### `src/ids.ts`

```ts
/** Template-literal ids: a DaemonId is not assignable to a WorkerId, with no brand ceremony. */
export type DaemonId = `d_${string}`;
export type WorkerId = `w_${string}`;
export type TurnId = `t_${string}`;
export type TokenId = string;
export type ClientId = string;
/** Agent-assigned. Opaque. NEVER parsed, NEVER pattern-matched. */
export type SessionId = string;
/** 1-based, strictly increasing, gap-free, per worker. Deliberately unbranded: arithmetic. */
export type Seq = number;

/** Global address across daemons (D11). */
export type WorkerRef = `${DaemonId}:${WorkerId}`;

export const ULID_BODY = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export const ID_PATTERN: {
  readonly daemon: RegExp;
  readonly worker: RegExp;
  readonly turn: RegExp;
};

export function isDaemonId(s: string): s is DaemonId;
export function isWorkerId(s: string): s is WorkerId;
export function isTurnId(s: string): s is TurnId;
/** Throws OmniError("bad_request") with the offending value elided from the message. */
export function assertWorkerId(s: string): WorkerId;
export function assertTurnId(s: string): TurnId;

export function workerRef(d: DaemonId, w: WorkerId): WorkerRef;
export function parseWorkerRef(ref: string): { daemonId: DaemonId; workerId: WorkerId };

/**
 * Monotonic ULID factory. Injected everywhere so tests are deterministic.
 *
 * Hand-rolled, no `ulid` package (amendment A7): §3.2 pins protocol's dependencies to the SDK
 * and zod, and the injection points here need `now`/`random` replaceable — which `ulid`'s
 * monotonicFactory does not cleanly allow.
 */
export function createIdGen(opts?: { now?: () => number; random?: () => number }): IdGen; // IdGen is declared in contracts.ts
```

#### `src/errors.ts`

```ts
/** Exactly DESIGN §5.4. No additions — see §11 D29. */
export const OMNI_ERROR_CODES = [
  "bad_request",
  "unauthorized",
  "forbidden",
  "policy_exceeds_ceiling",
  "worker_not_found",
  "worker_busy",
  "worker_closed",
  "not_resumable",
  "lease_held",
  "worker_limit",
  "agent_error",
  "agent_timeout",
  "internal",
] as const;
export type OmniErrorCode = (typeof OMNI_ERROR_CODES)[number];

/** The ONLY status mapping in the repository. The HTTP layer has no other. */
export const ERROR_STATUS: { readonly [C in OmniErrorCode]: number };

/** The agent's JSON-RPC error, passed through verbatim and never reshaped. */
export interface AcpErrorDetail {
  code: number;
  message: string;
  data?: unknown;
}
export interface OmniErrorBody {
  code: OmniErrorCode;
  message: string;
  acp?: AcpErrorDetail;
}

export class OmniError extends Error {
  readonly code: OmniErrorCode;
  readonly status: number;
  readonly acp?: AcpErrorDetail;
  /** Machine-readable extras that never cross the wire (pid, exit code, path…). */
  readonly detail?: Readonly<Record<string, unknown>>;
  constructor(
    code: OmniErrorCode,
    message: string,
    opts?: {
      acp?: AcpErrorDetail;
      cause?: unknown;
      detail?: Record<string, unknown>;
    },
  );
  toBody(): OmniErrorBody;
  static is(e: unknown, code?: OmniErrorCode): e is OmniError;
  /**
   * Never throws. `acp.RequestError` → agent_error carrying `acp`;
   * AbortError/TimeoutError → agent_timeout; OmniError → itself; anything else → internal.
   */
  static from(e: unknown, fallback?: OmniErrorCode): OmniError;
}
```

#### `src/acp.ts` — the single ACP-SDK re-export point

```ts
/**
 * The ONE place the ACP SDK is imported for types. A 1.4.0 → 1.5.0 bump has exactly one
 * blast radius. Nothing else in the repo type-imports from "@agentclientprotocol/sdk".
 */
export type {
  ContentBlock,
  ToolCall,
  ToolCallUpdate,
  ToolCallStatus,
  ToolCallContent,
  ToolKind,
  Diff,
  AgentCapabilities,
  PromptCapabilities,
  SessionCapabilities,
  McpServer,
  PermissionOption,
  PermissionOptionKind,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionUpdate as V1SessionUpdate,
  InitializeResponse as V1InitializeResponse,
  NewSessionResponse as V1NewSessionResponse,
  PromptResponse as V1PromptResponse,
  Stream as AcpStream,
} from "@agentclientprotocol/sdk";
export {
  PROTOCOL_VERSION as ACP_V1_VERSION,
  RequestError as AcpRequestError,
} from "@agentclientprotocol/sdk";

export type {
  SessionUpdate as V2SessionUpdate,
  StateUpdate as V2StateUpdate,
  StopReason,
  UsageUpdate as V2UsageUpdate,
} from "@agentclientprotocol/sdk/experimental/v2";

/**
 * D1's canonical payload type. Because v2's SessionUpdate ends in an open arm
 * `{ sessionUpdate: string; [k: string]: unknown }` (verified, F2), an un-normalized v1
 * update is structurally assignable to it. The envelope's `payloadVersion` says which
 * you actually hold, so M1 flipping payloads to true v2 is not a wire break.
 */
export type NormalizedSessionUpdate = V2SessionUpdate;
```

#### `src/events.ts`

```ts
export const WORKER_STATES = [
  "starting",
  "ready",
  "running",
  "requires_action",
  "hibernated",
  "closed",
] as const;
export type WorkerState = (typeof WORKER_STATES)[number];
/** Reachable in M0. The other two are wire-stable but never emitted, so M1 is additive. */
export const M0_WORKER_STATES = ["starting", "ready", "running", "closed"] as const;

export const EVENT_KINDS = [
  "acp.session_update",
  "acp.interaction",
  "omni.policy_decision",
  "omni.worker_state",
  "omni.error",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export interface EnvelopeMeta {
  readonly seq: Seq;
  readonly ts: string; // ISO-8601 with ms, from Clock
  readonly daemonId: DaemonId;
  readonly workerId: WorkerId;
  readonly sessionId: SessionId | null; // null before session/new lands
  readonly turnId: TurnId | null; // null outside a turn
  /**
   * ACP version of `payload` AS WRITTEN.
   * M0: daemon-synthesized state_update = 2; agent-forwarded updates = 1.
   * M1: every acp.* payload becomes 2. Clients branch on this instead of guessing,
   * which is what makes the M1 normalizer a non-breaking change.
   * Non-acp kinds are always 2.
   */
  readonly payloadVersion: 1 | 2;
  /** Set while draining a session/load|resume replay window (M1). Absent in M0. */
  readonly replay?: true;
}

export type WorkerCloseReason =
  | "client_request"
  | "daemon_shutdown"
  | "spawn_failed"
  | "handshake_error"
  | "handshake_timeout"
  | "agent_exited"
  | "agent_crashed"
  | "protocol_error"
  | "cancel_timeout"
  | "not_resumable"; // reserved for M1

export interface WorkerStatePayload {
  readonly state: WorkerState;
  readonly previous: WorkerState | null;
  readonly reason: WorkerCloseReason | "created" | "handshake_ok" | "prompt" | "turn_end";
  readonly exit?: { code: number | null; signal: string | null };
  /** Honest process-ownership reporting; see §6. Present on close only. */
  readonly leaderExited?: boolean;
  readonly treeGone?: boolean;
  readonly error?: OmniErrorBody;
}

export interface InteractionPayload {
  readonly requestId: string;
  readonly method: "session/request_permission"; // M2 adds "elicitation/create"
  readonly request: Readonly<Record<string, unknown>>; // verbatim v1 shape in M0
  readonly status: "pending" | "answered" | "failed";
  /** M0: always present and immediate — the baseline responder answers inline. */
  readonly answer?: {
    readonly optionId: string | null;
    readonly by: "baseline" | "policy" | "human";
  };
}

export interface PolicyDecisionPayload {
  readonly requestId: string;
  /**
   * `request.toolCall.title ?? ""`, captured when the decision is made. It lives here so that
   * `reduceTurn` stays a fold over ONE envelope kind and still produces a well-typed
   * `InteractionRecord`: v1 `RequestPermissionRequest` has no top-level `title`, and the
   * responder already holds the request when it decides, so this is free (review R9).
   */
  readonly title: string;
  readonly decision: "allow" | "deny" | "error";
  readonly rule: string; // M0 is always "m0:auto-deny"
  readonly optionId: string | null;
  readonly offered: readonly PermissionOption[];
}

export type EventBody =
  | { readonly kind: "acp.session_update"; readonly payload: NormalizedSessionUpdate }
  | { readonly kind: "acp.interaction"; readonly payload: InteractionPayload }
  | { readonly kind: "omni.policy_decision"; readonly payload: PolicyDecisionPayload }
  | { readonly kind: "omni.worker_state"; readonly payload: WorkerStatePayload }
  | { readonly kind: "omni.error"; readonly payload: OmniErrorBody & { stderrTail?: string } };

export type EventEnvelope = EnvelopeMeta & EventBody;

/**
 * What producers hand to EventLog.append(). seq / ts / daemonId / workerId / sessionId are
 * the log's job and are not expressible here — an attempt to stamp one is a compile error.
 */
export type EventInput = EventBody & {
  readonly payloadVersion: 1 | 2;
  readonly turnId?: TurnId | null;
  readonly replay?: true;
};

export const eventEnvelopeSchema: z.ZodType<EventEnvelope>; // used by the client to parse SSE
```

#### `src/worker.ts`

```ts
export interface ProcessInfo {
  readonly pid: number;
  /** POSIX process-group id (== pid). `null` on Windows: no addressable group. */
  readonly groupId: number | null;
  readonly startedAt: string;
  readonly command: string;
  readonly argsRedacted: readonly string[];
}

export interface AgentCapabilitiesSnapshot {
  readonly protocolVersion: 1; // M0 negotiates 1 only
  /** Verbatim `agentCapabilities` from initialize. Never reshaped, never cached. */
  readonly raw: Readonly<Record<string, unknown>>;
  readonly loadSession: boolean;
  readonly promptCapabilities: PromptCapabilities | null;
  readonly supportsSessionClose: boolean; // sessionCapabilities?.close
}

export interface WorkerSnapshot {
  readonly workerId: WorkerId;
  readonly daemonId: DaemonId;
  readonly ref: WorkerRef;
  readonly sessionId: SessionId | null; // null while `starting`
  readonly agentId: string;
  readonly state: WorkerState;
  readonly cwd: string; // realpath'd
  readonly label: string | null;
  readonly ownerTokenId: TokenId;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly headSeq: Seq;
  readonly currentTurnId: TurnId | null;
  readonly capabilities: AgentCapabilitiesSnapshot | null;
  readonly process: ProcessInfo | null; // null once closed
  readonly closeReason: WorkerCloseReason | null;
}

export interface CloseResult {
  readonly workerId: WorkerId;
  readonly state: "closed";
  readonly reason: WorkerCloseReason;
  readonly leaderExited: boolean;
  /** true ONLY when the whole tree is provably gone. Always false on Windows in M0 (§6). */
  readonly treeGone: boolean;
}
```

#### `src/turn.ts` — THE aggregator (DESIGN §5.5)

> M1 grows `FileChange`, `TurnResult` and `reduceTurn`'s contract — see the M1 diff below and §12.5/§13.4.

```ts
export interface FileChange {
  readonly path: string;
  readonly oldText: string | null;
  readonly newText: string;
}

export interface ToolCallView {
  readonly toolCallId: string;
  readonly title: string | null;
  readonly kind: string | null;
  readonly status: ToolCallStatus | string | null;
  readonly locations: readonly { path: string; line?: number }[];
  readonly content: readonly ToolCallContent[];
  readonly rawInput?: unknown;
  readonly rawOutput?: unknown;
}

export interface InteractionRecord {
  readonly requestId: string;
  readonly title: string;
  readonly decision: "allow" | "deny" | "error";
  readonly optionId: string | null;
  readonly rule: string;
  readonly at: string;
}

/** DESIGN §9.1, with M0's honest nulls. */
export interface TurnResult {
  readonly turnId: TurnId;
  readonly workerId: WorkerId;
  /** null when the turn ended by worker close rather than by `idle` — never faked (§7.3). */
  readonly stopReason: StopReason | null;
  readonly text: string;
  readonly toolCalls: readonly ToolCallView[];
  readonly changes: readonly FileChange[]; // from ToolCallContent{type:"diff"} (F5)
  readonly patch: string | null; // M0: always null (D8, git provider is M2)
  readonly usage?: { used: number; size: number; cost?: { amount: number; currency: string } };
  readonly interactions: readonly InteractionRecord[];
  readonly error: OmniErrorBody | null;
}

export type TurnState = "running" | "completed" | "failed" | "unknown";

export interface TurnStatus {
  readonly turnId: TurnId;
  readonly state: TurnState;
  readonly startSeq: Seq | null;
  readonly endSeq: Seq | null;
  readonly stopReason: StopReason | null;
  /** null only when state === "unknown". For "running" it is the partial aggregate so far. */
  readonly result: TurnResult | null;
}

/**
 * Pure, dependency-free, deterministic. Same envelopes in ⇒ deep-equal result out, always.
 * Called by the daemon for GET /turns/{id} AND by the client SDK for prompt().
 * One implementation ⇒ polling and streaming cannot disagree (DESIGN §5.5).
 *
 * A turn is terminal on `state_update{idle}` for that turnId OR on any
 * `omni.worker_state{state:"closed"}` — see §7.3.
 *
 * MUST NOT read `messageId` (F3).
 */
export function reduceTurn(turnId: TurnId, envelopes: readonly EventEnvelope[]): TurnResult;
export function turnStatus(turnId: TurnId, envelopes: readonly EventEnvelope[]): TurnStatus;
```

#### `src/control-plane.ts`

```ts
import { z } from "zod";

/** ACP content blocks are NOT re-modelled (proxy-chains: preserve unknown fields).
 *  Only `type` is validated; the array is forwarded verbatim. */
export const ContentBlockLoose = z.looseObject({ type: z.string() });

export const CreateWorkerRequest = z.strictObject({
  agent: z.string().min(1),
  cwd: z.string().min(1),
  label: z.string().max(200).optional(),
  /** M0: must be absent or []. Anything else → bad_request (DESIGN §8). */
  mcp: z.array(z.string()).max(0).optional(),
  /** M0: must be absent or "deny". park/fail need the policy engine (M2). */
  onUnresolved: z.literal("deny").optional(),
  /** Handshake budget in ms. Default 60_000. */
  timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
  // M1+/M2, rejected by strictObject in M0: policy, env
});
export type CreateWorkerRequest = z.infer<typeof CreateWorkerRequest>;

/**
 * M0 accepts ONLY `type:"text"` blocks (§2.3, review R12). DESIGN §5.1 requires `resource_link`
 * and embedded-resource paths to be absolute and to realpath into the token's `cwdRoots`; that
 * containment check is M2, and under D3 the agent reads the disk itself, so forwarding an
 * unvalidated absolute path is the cwd escape D18 calls arbitrary code execution. A whitelist
 * closes it; the zod failure is H8's `400`. The blocks are still not re-modelled — only `type`
 * is inspected — so M1 relaxing this is additive.
 */
export const PromptRequestBody = z.strictObject({
  content: z
    .array(ContentBlockLoose)
    .min(1)
    .refine((blocks) => blocks.every((b) => b.type === "text"), {
      message: 'M0 accepts only content blocks with type "text" (resource paths are M2)',
    }),
});
export type PromptRequestBody = z.infer<typeof PromptRequestBody>;

export interface PromptAccepted {
  readonly turnId: TurnId;
  /**
   * seq of this turn's `state_update{running}`. A client that subscribes with
   * `since = seq - 1` is GUARANTEED to see the whole turn. This is what removes the
   * subscribe/prompt race without requiring a pre-existing subscription.
   */
  readonly seq: Seq;
}

export interface WhoAmIResponse {
  readonly tokenId: TokenId;
  readonly role: "user" | "admin";
  readonly daemonId: DaemonId;
  readonly agents: readonly string[] | "*";
  readonly cwdRoots: readonly string[];
  readonly maxWorkers: number;
  readonly policyCeiling: null; // M2; present-and-null so the field never appears/disappears
}

export interface HealthResponse {
  readonly ok: true;
}

export interface DaemonInfo {
  readonly daemonId: DaemonId;
  readonly version: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly nodeVersion: string;
  readonly protocolVersions: readonly (1 | 2)[]; // M0: [1]
  readonly startedAt: string;
  readonly ownership: PlatformOwnership; // §6 — the honesty field
}

export interface AgentCatalogEntry {
  readonly id: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly source: "config";
  readonly probed: null; // M1
}

export interface WorkerListResponse {
  readonly workers: readonly WorkerSnapshot[];
}
export interface AgentListResponse {
  readonly agents: readonly AgentCatalogEntry[];
}

export const HEADER = {
  auth: "authorization",
  clientId: "omni-client-id",
  lastEventId: "last-event-id",
} as const;

/** SSE control frames that are NOT envelopes and consume no seq (§8.4). */
export const SSE_CONTROL = {
  truncated: "omni.stream_truncated",
  overflow: "omni.stream_overflow",
  end: "omni.stream_end",
} as const;
```

#### `src/config.ts` — zod is the source of truth; the TS type is inferred

```ts
export const TokenConfig = z
  .object({
    id: z.string().min(1),
    /** Exactly one of secret / secretSha256. Plaintext is hashed at load and dropped (DESIGN §8). */
    secret: z.string().min(16).optional(),
    secretSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    role: z.enum(["user", "admin"]).default("user"),
    agents: z.union([z.literal("*"), z.array(z.string())]).default("*"),
    /** Every cwd must realpath into one of these. Defaults to [os.homedir()] at load. */
    cwdRoots: z.array(z.string()).default([]),
    maxWorkers: z.number().int().positive().default(16),
  })
  .refine(
    (t) => (t.secret == null) !== (t.secretSha256 == null),
    "exactly one of secret / secretSha256",
  );

export const AgentDescriptor = z.object({
  id: z.string().min(1),
  /** Absolute path or PATH-resolvable name. NEVER a shell string. See §6.3 for .cmd/.bat. */
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  /** Trusted, config-supplied. Per-request env is M2. */
  env: z.record(z.string(), z.string()).default({}),
  protocolVersion: z.literal(1).default(1),
  shutdown: z
    .object({
      signal: z.string().default("SIGTERM"),
      graceMs: z.number().int().min(0).default(5_000),
    })
    .prefault({}), // zod 4: `.default()` takes the OUTPUT type, so `{}` is rejected here (A4)
});
export type AgentDescriptor = z.infer<typeof AgentDescriptor>;

export const ListenConfig = z.object({
  host: z.string().default("127.0.0.1"),
  port: z.number().int().min(0).max(65535).default(0), // 0 = ephemeral
});

export const SupervisorConfig = z.object({
  gracefulMs: z.number().int().positive().default(5_000),
  killConfirmMs: z.number().int().positive().default(2_000),
  /** Wait for `exit` after stdout EOF before declaring a crash and forcing. */
  exitGraceMs: z.number().int().positive().default(1_000),
  /** Hard cap on one ndjson frame. Over it ⇒ protocol_error + kill. */
  maxFrameBytes: z
    .number()
    .int()
    .positive()
    .default(32 * 1024 * 1024),
  stderrTailBytes: z
    .number()
    .int()
    .positive()
    .default(32 * 1024),
  /** Refuse to launch a .cmd/.bat shim on win32 unless true (§6.3). */
  allowShimLaunch: z.boolean().default(false),
  /** Windows only. See §6.4 for why this is a knob and not a constant. */
  windowsHide: z.boolean().default(true),
});

/**
 * Resolved (post-parse) views of the nested blocks. They exist so a package downstream of
 * `protocol` can name a fully-defaulted config without a zod dependency of its own — §3.2 pins
 * zod to `protocol`, and a bare `z.output<typeof SupervisorConfig>` at a `core` call site would
 * quietly break that (amendment A3). Structurally identical to the inline form.
 */
export type ResolvedSupervisorConfig = z.output<typeof SupervisorConfig>;

export const TurnConfig = z.object({
  quietMs: z.number().int().nonnegative().default(250),
  hardMs: z.number().int().positive().default(5_000),
  cancelGraceMs: z.number().int().positive().default(10_000),
});
export type ResolvedTurnConfig = z.output<typeof TurnConfig>;
export type ResolvedListenConfig = z.output<typeof ListenConfig>;

export const DaemonConfig = z.strictObject({
  daemonId: z.string().optional(), // else generated + persisted to dataDir
  dataDir: z.string().default("~/.omni-acp"),
  /** null ⇒ no socket, in-process only (D15 constraint 1). */
  listen: ListenConfig.nullable().default(null),
  tokens: z.array(TokenConfig).min(1),
  /** M0: explicit list only. `"auto"` discovery is M1/M4. */
  agents: z.array(AgentDescriptor).default([]),
  maxWorkers: z.number().int().positive().default(64),
  eventLog: z
    .object({
      /** M0: "memory" only. "sqlite" parses but is rejected at runtime (M1). */
      driver: z.enum(["memory", "sqlite"]).default("memory"),
      maxEventsPerWorker: z.number().int().positive().default(10_000),
      subscriberQueueSize: z.number().int().positive().default(1_024),
      sseHeartbeatMs: z.number().int().positive().default(15_000),
    })
    .prefault({}),
  handshakeTimeoutMs: z.number().int().positive().default(60_000),
  supervisor: SupervisorConfig.prefault({}),
  turn: TurnConfig.prefault({}),
  logLevel: z.enum(["silent", "error", "warn", "info", "debug"]).default("info"),
});
export type DaemonConfig = z.input<typeof DaemonConfig>;
export type ResolvedDaemonConfig = z.output<typeof DaemonConfig>;

export function hashSecret(secret: string): string; // sha256 hex
export function verifySecret(secret: string, sha256Hex: string): boolean; // timingSafeEqual
```

#### `src/contracts.ts` — frozen by the scaffold; the shared seam

> The block below is **M0's declaration, kept verbatim**. Its M1 form is the diff under
> "M1 diffs to the existing `@omni-acp/protocol` files" further down this section: `Lease`,
> `Normalizer`, `TurnInput`/`TurnOutput`, `PermissionResponder`, `WorkerHandle`, `WorkerRegistry`,
> `Catalog`, `Supervisor` and `PlatformOps` all grow, and `EventStore` / `WorkerStore` /
> `PersistenceHandle` / `SessionStrategy` are new. Read them together; the M1 diff wins.

```ts
// ── ambient ──────────────────────────────────────────────────────────────────
export interface TimerHandle {
  cancel(): void;
}
export interface Clock {
  now(): number; // epoch ms
  iso(): string; // ISO-8601 of now()
  setTimer(delayMs: number, fn: () => void): TimerHandle;
}
export interface IdGen {
  daemon(): DaemonId;
  worker(): WorkerId;
  turn(): TurnId;
  request(): string;
}
export interface Logger {
  child(bindings: Record<string, unknown>): Logger;
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

// ── process layer (WP-2 implements) ──────────────────────────────────────────
export interface SpawnSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** The COMPLETE environment. The Supervisor adds nothing and removes nothing. */
  readonly env: Readonly<Record<string, string>>;
  readonly gracefulMs?: number;
  readonly killConfirmMs?: number;
  readonly exitGraceMs?: number;
  readonly maxFrameBytes?: number;
  readonly stderrTailBytes?: number;
  readonly shutdownSignal?: string;
  readonly label?: string; // diagnostics only
}

export interface ProcessExit {
  readonly code: number | null;
  readonly signal: string | null;
  readonly at: number;
  /** true when we initiated the exit, not the agent. */
  readonly requested: boolean;
}

export type TerminationRung = "already_exited" | "stdin_eof" | "sigterm" | "sigkill" | "taskkill";

export interface KillOutcome {
  readonly exit: ProcessExit | null;
  /** The leader is confirmed absent. */
  readonly leaderExited: boolean;
  /**
   * The WHOLE tree is provably gone. POSIX: kill(-pgid,0) === ESRCH within killConfirmMs.
   * Windows M0: ALWAYS false — taskkill /T cannot prove it. Never optimistic.
   */
  readonly treeGone: boolean;
  readonly escalatedTo: TerminationRung;
  readonly durationMs: number;
}

export interface StderrTail {
  /** Last N bytes as valid UTF-8; an incomplete trailing rune is hidden. */
  snapshot(): string;
  /** Complete lines only. Returns an unsubscribe. */
  onLine(cb: (line: string) => void): () => void;
  /** Flush a trailing unterminated line at EOF. Idempotent — this is the crash reason. */
  finalize(): void;
}

export interface AgentProcess {
  readonly pid: number | null;
  readonly info: ProcessInfo;
  /** The ACP transport seam (F7). FakeAgentProcess supplies an in-memory pair. */
  readonly stream: AcpStream;
  readonly stderr: StderrTail;
  /** Resolves on the child's `exit`. NEVER rejects. */
  readonly exited: Promise<ProcessExit>;
  /**
   * Resolves when stdout EOFs. May fire BEFORE `exited` (transport dies first) or long
   * AFTER it (a grandchild inherited the pipe and holds it open). Both are handled by Worker.
   */
  readonly stdoutEnded: Promise<void>;
  /** Graceful: EOF on stdin. Never blocks, never throws. */
  closeStdin(): void;
  /** The full escalation ladder (§6.5). Idempotent; concurrent callers share one run. */
  terminate(opts?: { gracefulMs?: number; force?: boolean }): Promise<KillOutcome>;
}

export interface PlatformOwnership {
  readonly kind: "posix-process-group" | "windows-taskkill-tree";
  /** Can terminate() positively prove the whole tree is gone? */
  readonly confirmsTreeGone: boolean;
  /** Do descendants survive a SIGKILL of the daemon itself? */
  readonly survivesDaemonKill: boolean;
  /** Human-readable caveat, surfaced verbatim in GET /v1/info. */
  readonly caveat: string | null;
}

/** Platform-specific operations. Chosen ONCE, at Supervisor construction — never at kill time. */
export interface PlatformOps {
  readonly ownership: PlatformOwnership;
  /** POSIX {detached:true, windowsHide:false}; Windows {detached:false, windowsHide:true}. */
  spawnOptions(cfg: { windowsHide: boolean }): { detached: boolean; windowsHide: boolean };
  /** Resolve command+args through PATH/PATHEXT; refuse .cmd/.bat unless allowShim (§6.3). */
  resolveLaunch(
    command: string,
    args: readonly string[],
    allowShim: boolean,
  ): Promise<{ file: string; args: string[]; windowsVerbatimArguments: boolean }>;
  /** POSIX: kill(-pgid, sig). Windows: no-op for SIGTERM; taskkill /T /F for SIGKILL. */
  signalTree(p: AgentProcess, sig: "SIGTERM" | "SIGKILL"): Promise<TerminationRung>;
  /** POSIX: kill(-pgid,0) === ESRCH. Windows: always false. */
  isTreeGone(p: AgentProcess): Promise<boolean>;
  /** POSIX: kill(pid,0). Windows: tasklist /FI. */
  isLeaderGone(p: AgentProcess): Promise<boolean>;
}

/**
 * A short-lived utility process whose stdout is read to completion — `taskkill` and `tasklist`
 * on Windows (§6.4). It exists because §6.1 makes `spawn.ts` the only file allowed to call
 * `node:child_process`, and `Supervisor.spawn()` (ACP stream + frame limiter + stderr tail) is
 * the wrong shape for a one-shot command. `platform-windows.ts` receives it by INJECTION, since
 * importing `spawn.ts` — which itself consumes `PlatformOps` — would be a cycle (review R8).
 * The implementation is `runUtility` in `core/src/process/spawn.ts` (§5.3).
 */
export type RunUtility = (
  file: string,
  args: readonly string[],
  o: { timeoutMs: number },
) => Promise<{ code: number | null; stdout: string }>;

// `createPlatformOps` is NOT declared here: contracts.ts is types-only (M0-PLAN §1.1) and
// platform behaviour is core's job. Its signature lives in §5.3 (amendment A2).

export interface Supervisor {
  readonly platform: PlatformOps;
  /** THE ONLY caller of node:child_process in this repository (test-enforced, F10). */
  spawn(spec: SpawnSpec, signal?: AbortSignal): Promise<AgentProcess>;
  readonly live: ReadonlySet<AgentProcess>;
  /** Kill everything still owned, in parallel, bounded. Called by daemon.stop(). */
  shutdown(opts?: { gracefulMs?: number; timeoutMs?: number }): Promise<KillOutcome[]>;
}

// ── event log (WP-3 implements) ──────────────────────────────────────────────
export type EventListener = (e: EventEnvelope) => void;
export interface Subscription {
  close(): void;
  readonly closed: boolean;
}

export interface EventLog {
  readonly workerId: WorkerId;
  /** Highest assigned seq. 0 when empty. */
  readonly head: Seq;
  /** Lowest retained seq. 1 until the ring evicts. */
  readonly tail: Seq;
  readonly subscriberCount: number;
  /**
   * SYNCHRONOUS by contract, even for a future persisting driver.
   * The ONLY place a `seq` is ever assigned (§8.2, test-enforced).
   */
  append(input: EventInput): EventEnvelope;
  appendAll(inputs: readonly EventInput[]): EventEnvelope[];
  /** Exclusive lower bound: returns seq > since, ascending. */
  read(since: Seq, limit?: number): readonly EventEnvelope[];
  /**
   * Replays read(since) into `listener`, then attaches the live tail, in ONE synchronous
   * critical section — no event can slip between replay and live. `listener` MUST be
   * synchronous and MUST NOT throw.
   */
  subscribe(
    since: Seq,
    listener: EventListener,
    opts?: {
      onOverflow?: (lastDelivered: Seq) => void;
      queueSize?: number;
    },
  ): Subscription;
  /** Closes every subscription. Idempotent. */
  close(): void;
  /**
   * Called once, right after `session/new`; envelopes appended from this point carry the
   * sessionId. Earlier envelopes stay frozen with `sessionId: null` — they precede the session's
   * existence, and back-filling them would contradict §8.2 rule 3 (review R16).
   */
  setSessionId(id: SessionId): void;
}

// ── normalizer (WP-3 implements) ─────────────────────────────────────────────
export type TurnInput =
  | { readonly type: "prompt_sent"; readonly turnId: TurnId; readonly at: number }
  | { readonly type: "agent_update"; readonly update: unknown; readonly at: number }
  | { readonly type: "prompt_result"; readonly stopReason: StopReason; readonly at: number }
  | { readonly type: "prompt_error"; readonly error: OmniErrorBody; readonly at: number }
  | {
      readonly type: "process_gone";
      readonly error: OmniErrorBody;
      readonly stderrTail: string;
      readonly at: number;
    }
  | { readonly type: "tick"; readonly at: number };

export type SettleReason = "quiet" | "hard" | "error" | "gone";

export interface TurnOutput {
  /** Appended to the log in array order, in one synchronous loop. */
  readonly emit: readonly EventInput[];
  /** Absolute epoch-ms at which the Worker must deliver a `tick`, or null. */
  readonly scheduleTickAt: number | null;
  readonly state: "idle" | "running" | "settling";
  readonly turnId: TurnId | null;
  readonly settled: SettleReason | null;
}

export interface Normalizer {
  readonly sourceProtocolVersion: 1;
  readonly slice: "m0-lifecycle";
  /** PURE. No timers, no I/O, no async. Same inputs ⇒ same outputs, forever. */
  step(input: TurnInput): TurnOutput;
}

// ── permission responder (WP-4 implements) ───────────────────────────────────
export interface PermissionDecision {
  /** null ⇒ the Worker must reply with JSON-RPC -32603 (D4 rule 4). */
  readonly response: RequestPermissionResponse | null;
  readonly record: PolicyDecisionPayload;
}
export interface PermissionResponder {
  decide(req: RequestPermissionRequest): PermissionDecision;
}

// ── lease (WP-4 implements; D5 enforcement is M1) ────────────────────────────
export interface ClientRef {
  readonly tokenId: TokenId;
  readonly clientId: ClientId | null;
}
export interface Lease {
  readonly holder: ClientRef | null;
  /** M0: never throws. M1: throws OmniError("lease_held"). Callers already branch today. */
  assertHolder(who: ClientRef): void;
  acquire(who: ClientRef, opts?: { steal?: boolean }): void; // M0: throws bad_request
  release(who: ClientRef): void; // M0: throws bad_request
}

// ── worker handle (WP-4 implements; WP-5 consumes) ───────────────────────────
export interface WorkerHandle {
  readonly id: WorkerId;
  readonly log: EventLog;
  readonly lease: Lease;
  snapshot(): WorkerSnapshot;
  /** Returns once `state_update{running}` is appended and session/prompt is on the wire. */
  prompt(content: readonly unknown[], who: ClientRef): Promise<PromptAccepted>;
  cancel(who: ClientRef): Promise<void>;
  /** Idempotent: session/close (if advertised) → kill tree → state closed. */
  close(reason: WorkerCloseReason): Promise<CloseResult>;
  turn(turnId: TurnId): TurnStatus;
  onStateChange(cb: (s: WorkerState, prev: WorkerState | null) => void): () => void;
  readonly closed: Promise<CloseResult>;
}
```

#### `src/lease.ts` — NEW in M1

```ts
/** The wire form of `ClientRef`. `clientId: null` = "the token's default client" (§16.1 rule L4). */
export interface ClientRefWire {
  readonly tokenId: TokenId;
  readonly clientId: ClientId | null;
}

export interface LeaseSnapshot {
  readonly workerId: WorkerId;
  readonly holder: ClientRefWire | null;
  /**
   * FENCING TOKEN. Monotonic per worker, +1 on every acquire / steal / expiry. A client that
   * cached "I hold it" cannot act after a steal: it sends `Omni-Lease-Epoch` and a stale value
   * is a 423 rather than a silent hijack of somebody else's turn. This is the one thing that
   * makes a lease a lease rather than an advisory hint.
   */
  readonly epoch: number;
  /** null = no TTL configured, OR expiry is pinned because a turn is live (never a lie). */
  readonly expiresAt: string | null;
  readonly acquiredAt: string | null;
  readonly pinned: boolean;
}

export type LeaseOp = "acquired" | "released" | "stolen" | "expired";

export interface LeaseEventPayload {
  readonly op: LeaseOp;
  readonly lease: LeaseSnapshot;
  readonly previous: ClientRefWire | null;
  /** Who caused it. `null` for `expired` — the clock did, or a daemon restart did. */
  readonly by: ClientRefWire | null;
  /** "implicit" = the first gated call on an unheld lease claimed it (§16.1 rule L5). */
  readonly how: "explicit" | "implicit" | "create" | "steal" | "hibernate" | "timeout" | "daemon_restart";
  readonly reason: string | null;
}
```

#### `src/resume.ts` — NEW in M1

```ts
export type ResumeMethod = "session/load" | "session/resume";

/** D2's four states, verbatim. NEVER a boolean, at any layer. */
export const RESUME_OUTCOMES = ["landed", "rejected_permanent", "rejected_transient", "unknown"] as const;
export type ResumeOutcome = (typeof RESUME_OUTCOMES)[number];

/**
 * `hint` is the evidence, so an operator can argue with the classifier instead of guessing, and
 * so a compat run can assert the DIAGNOSIS separately from the ACTION. Two rows may share an
 * `outcome` and differ only here — `cwd_mismatch` and `unclassified` are both `unknown` and both
 * keep the pointer, but only one of them is recoverable by fixing the request (F15, §15.4).
 */
export type ResumeHint =
  | "ok" | "cwd_mismatch" | "not_found" | "silently_created" | "refusal_no_activity"
  | "capability_absent" | "method_not_found" | "transport" | "timeout" | "rate_limited" | "unclassified";

export interface ResumeReport {
  readonly outcome: ResumeOutcome;
  readonly hint: ResumeHint;
  /** Which rule fired, verbatim, e.g. "rule4:unclassified-jsonrpc". Auditable classification. */
  readonly rule: string;
  readonly method: ResumeMethod | null;
  /** The session id we ASKED for. */
  readonly requested: SessionId | null;
  /** The session actually in force AFTER the attempt. `!== requested` is itself the evidence. */
  readonly landedOn: SessionId | null;
  /**
   * true when the AGENT's model context is provably gone. The daemon's own event log still has
   * every envelope — this is D2's "保得住发生过什么，保不住 agent 进程内的模型上下文", made a field.
   */
  readonly historyLost: boolean;
  /** The agent's JSON-RPC error, passed through, never reshaped. */
  readonly acp: AcpErrorDetail | null;
  /** `session/update` notifications observed inside the replay window (F16). */
  readonly replayedEvents: number;
  /** Non-zero only when `resume.replay: "drop_duplicates"` is enabled (ruling M1-R5). */
  readonly replayDropped: number;
  readonly durationMs: number;
  readonly at: string;
}
```

#### `src/runtime.ts` — NEW in M1

```ts
/**
 * DESIGN §7's Runtime descriptor. It is the ONLY thing the Normalizer branches on: a compatible
 * fork is a new descriptor, not new code, and the `descriptor-is-the-only-branch` guard (§10.2)
 * fails the build on an agent-id string literal anywhere under `core/src/normalizer/**`.
 *
 * Resolution order is builtin ⊕ config overlay ⊕ probe, and `source` records which layers ran.
 */
export interface RuntimeDescriptor {
  readonly id: string;
  /** sha256 over command ⊕ args ⊕ descriptor version ⊕ agentInfo.name/version. Cache + audit key. */
  readonly fingerprint: string;
  readonly protocolVersion: 1 | 2;
  readonly source: "builtin" | "config" | "probe" | "merged";
  readonly prefer: MethodPreferences;
  readonly updates: Readonly<Record<string, UpdateRule>>;
  readonly extensions: Readonly<Record<string, ExtensionPath>>;
  readonly errorRules: readonly ErrorRule[];
  readonly quirks: Quirks;
  /**
   * INBOUND method aliases (review R4): an agent→client notification whose method matches a key is
   * normalized to the value BEFORE the update map runs — DESIGN §1.3's `session/notification` as an
   * alias for `session/update`, registered as §6.2 requires. `{}` by default and `{}` for
   * claude-acp; an UNREGISTERED method keeps §7.6's `-32601`, so a typo cannot silently swallow
   * updates.
   */
  readonly inboundAliases: Readonly<Record<string, string>>;
  /** D3: both false for every agent M1 knows about. */
  readonly clientHost: { readonly fs: boolean; readonly terminal: boolean };
  readonly budgets: {
    readonly initializeMs: number; readonly sessionNewMs: number;
    readonly resumeMs: number; readonly turnMs: number;
  };
  /** Rows the compat suite must NOT assert for this agent — corpus gaps, not failures (§18.3). */
  readonly unverified: readonly string[];
}

/**
 * PREFERENCE ORDER OVER SPELLINGS, not one name per capability. F18 is decisive: on ONE
 * claude-acp process `session/set_mode` and `session/set_config_option` are both live while
 * `session/set_model` — which multica saw on 8 runtimes — is `-32601`. A registry that maps one
 * capability to one method name cannot express that.
 *
 * The first entry not already known-unsupported is used; a `-32601` marks it unsupported for the
 * life of the process (never persisted — a version bump may add it) and the next one is tried.
 */
export interface MethodPreference {
  readonly spellings: readonly string[];
  /** DESIGN §6.2, made a field: `set_model` failing is `fail`, `set_options` failing is `warn`. */
  readonly onFailure: "fail" | "warn";
}
/**
 * A RECORD, not four fixed arrays (review R2). `session/set_options` is a vendor extension §6.2
 * requires the descriptor to carry, and a fixed shape would have made adding it an edit to a type
 * frozen for the whole of M1. Well-known keys: `resume` / `setConfig` / `setOptions` / `list` /
 * `close`; a runtime may carry more, and a consumer that does not know a key ignores it.
 * `prefer.resume.spellings` holds `ResumeMethod` values, narrowed by `handshake.ts`.
 */
export type MethodPreferences = Readonly<Record<string, MethodPreference>>;

export interface UpdateRule {
  /** The v2 `sessionUpdate` kind, or `null` = no row in the map (vendor passthrough). */
  readonly map: string | null;
  readonly stream: boolean;
  /**
   * `stream: false, store: true` is FORBIDDEN and rejected at descriptor resolution: an envelope
   * withheld from the live tail but present in `?since=` makes two subscribers disagree about the
   * log (§14.6, ruling M1-R3). The legal shapes are stream+store, or drop (neither).
   */
  readonly store: boolean;
  /** Store this payload under its sha256 in a side table and reference it (§14.6). */
  readonly digest: boolean;
}

/** A vendor field the descriptor promotes out of `_meta` into a typed slot. */
export interface ExtensionPath {
  /** RFC-6901 JSON pointer, rooted at the update's `_meta`. `~1` escapes a "/" in a key. */
  readonly pointer: string;
  readonly as: "patch" | "rate_limit" | "provenance" | "opaque";
  readonly dialect?: "claude_structured_patch" | "claude_rate_limit";
}

/**
 * Classify a JSON-RPC error by CODE + a JSON pointer into `data`. NEVER by message text:
 * F17 shows the message carries embedded quotes (`"\"Method not found\": <m>"`) and is not a
 * stable contract, while `data.method` / `data.details` / `data.<field>._errors` carry the same
 * information in a field. `messageMatches` exists for runtimes that leave us nothing else and is
 * discouraged in prose and in review.
 */
export interface ErrorRule {
  readonly id: string;
  readonly code?: number;
  readonly dataPointer?: string;
  readonly dataMatches?: string;
  readonly messageMatches?: string;
  readonly classify:
    | "bad_request" | "agent_error" | "unsupported_method" | "resume_permanent" | "resume_transient";
}

export interface Quirks {
  readonly resumeSilentlyCreates: boolean;
  /** claude-acp: a MISMATCHED cwd is refused for a session that is alive and healthy (F15). */
  readonly resumeRequiresSameCwd: boolean;
  /** `session/load` / `session/resume` return the `session/new` body, contrary to the v1 schema. */
  readonly loadReturnsBody: boolean;
  readonly messageIdPresent: boolean;
  readonly toolCallUpdateIsSparse: boolean;
  /** v1 `oldText`/`newText` are the changed FRAGMENT, not whole-file content (F19). */
  readonly diffIsFragment: boolean;
  readonly permissionRequestShape: "v1_tool_call" | "v2_subject";
  /** D4 rule 2's preferred `allow_session` / `approve_for_session`. "none" ⇒ `allow_once` only. */
  readonly sessionGrantKind: "none" | "allow_session";
  readonly emitsUsageUpdateOnV1: boolean;
  readonly emitsStateUpdate: boolean;
  readonly configIdField: "configId" | "optionId";
  readonly toleratesOmittedMcpCapabilities: boolean;
  readonly unknownMethodErrorCode: number;
}

/** What a probe learned. Never fabricated; `null` on `AgentCatalogEntry.probed` until probed. */
export interface ProbeSummary {
  readonly at: string;
  readonly agentId: string;
  readonly descriptorFingerprint: string;
  readonly protocolVersion: number;
  readonly agentInfo: Readonly<Record<string, unknown>> | null;
  readonly capabilities: Readonly<Record<string, unknown>>;
  /** Methods answered `-32601`. Recorded so the registry skips them next time. */
  readonly unsupportedMethods: readonly string[];
  readonly supportedMethods: readonly string[];
  readonly resumeMethod: ResumeMethod | null;
  /** What `-32602 data.<field>._errors` taught us about param names (F17). */
  readonly learnedParams: Readonly<Record<string, string>>;
  readonly timings: Readonly<Record<string, number>>;
}

export type MethodVerdict =
  | { readonly kind: "implemented"; readonly result: unknown }
  | { readonly kind: "not_implemented"; readonly code: number }
  /** `-32602` with `data.<field>._errors`: implemented, WRONG PARAM NAME — this is the row that
   *  teaches the probe the field is `configId` and not `optionId` (F17). */
  | { readonly kind: "implemented_other_params"; readonly code: -32602; readonly hints: readonly string[] }
  /** `-32603` with `data.details`: implemented, value rejected. Indistinguishable from a genuine
   *  internal error by `code` alone, which is why the registry keys on the pointer. */
  | { readonly kind: "implemented_bad_value"; readonly code: -32603; readonly details: string }
  | { readonly kind: "error"; readonly code: number; readonly message: string }
  | { readonly kind: "skipped"; readonly reason: string };
```

#### M1 diffs to the existing `@omni-acp/protocol` files

**`src/errors.ts`.** `OMNI_ERROR_CODES` and `ERROR_STATUS` are **unchanged** — `not_resumable` (422) and
`lease_held` (423) were reserved in M0 and M1 only makes them reachable. The body grows two optional
fields, each present only for its own code:

```diff
 export interface OmniErrorBody {
   code: OmniErrorCode;
   message: string;
   acp?: AcpErrorDetail;
+  /** ONLY on `lease_held` (423). Says WHO holds it and at which epoch, so a caller does not have
+   *  to re-GET a worker it may no longer control just to find out (§16.1). */
+  lease?: LeaseSnapshot;
+  /** ONLY on `not_resumable` (422). Which of D2's four states fired, and on what evidence. */
+  resume?: ResumeReport;
 }
```

`OmniError`'s constructor takes `lease` / `resume` in `opts` and `toBody()` spreads them conditionally, so
two bodies for the same failure stay deep-equal and there is still exactly **one** mapper (§9).

**`src/events.ts`.**

```diff
-/** Reachable in M0. The other two are wire-stable but never emitted, so M1 is additive. */
 export const M0_WORKER_STATES = ["starting", "ready", "running", "closed"] as const;
+/** Reachable in M1. `requires_action` stays wire-stable and unemitted until M2's policy engine. */
+export const M1_WORKER_STATES = ["starting", "ready", "running", "hibernated", "closed"] as const;

 export const EVENT_KINDS = [
   "acp.session_update", "acp.interaction", "omni.policy_decision", "omni.worker_state",
+  /** D5's audit trail: acquire / release / steal / expire. M1 has no separate audit log (M2). */
+  "omni.lease",
   "omni.error",
 ] as const;

 export type WorkerCloseReason =
   … | "cancel_timeout" | "not_resumable"
+  /** Idle timer fired on a worker whose agent cannot resume AND `hibernate.whenNotResumable:"close"`. */
+  | "idle_timeout"
+  /** `hibernate.maxWakeFailures` consecutive transient wake failures; the pointer is abandoned. */
+  | "wake_failed"
+  /** A previous boot owned this row and the agent cannot resume, so the session is unrecoverable. */
+  | "orphaned";

 export interface EnvelopeMeta {
   …
-  /** M0: daemon-synthesized state_update = 2; agent-forwarded updates = 1. M1: every acp.* becomes 2. */
+  /**
+   * M1 SHARPENS THIS (ruling M1-R10). `2` means the Normalizer landed the payload on a KNOWN v2
+   * arm — mapped or already v2-shaped. `1` means the map has **no row** for this `sessionUpdate`
+   * kind and the agent's object was forwarded by identity. A client can therefore tell
+   * "normalized" from "vendor passthrough" with no second field, and adding a row later flips a
+   * payload from 1 to 2 with no wire break. Non-`acp.*` kinds are always 2.
+   */
   readonly payloadVersion: 1 | 2;
-  /** Set while draining a session/load|resume replay window (M1). Absent in M0. */
+  /**
+   * D6. Set on EVERY envelope appended between the `session/load|resume` request bytes reaching
+   * stdin and its response resolving — the window F16 confirms is exact and uninterleaved.
+   *
+   * The literal `true` is deliberately KEPT rather than widened to an object: the envelope field
+   * is a filter flag for consumers, and the audit (which method, how many, how many dropped)
+   * belongs on `ResumeReport`, which is where an operator reads it (ruling M1-R5).
+   *
+   * Replay envelopes are STORED, consume a `seq`, AND are streamed. `reduceTurn` ignores them and
+   * the SDK's `stream()` filters them by default.
+   */
   readonly replay?: true;
 }

 export interface WorkerStatePayload {
   readonly state: WorkerState;
   readonly previous: WorkerState | null;
-  readonly reason: WorkerCloseReason | "created" | "handshake_ok" | "prompt" | "turn_end";
+  readonly reason:
+    | WorkerCloseReason
+    | "created" | "handshake_ok" | "prompt" | "turn_end"
+    | "hibernate"       // ready -> hibernated, idle timer or explicit request
+    | "wake"            // hibernated -> starting
+    | "resumed"         // starting -> ready after a wake; `resume` is always present
+    | "wake_retry"      // starting -> hibernated; transient failure, pointer KEPT
+    | "daemon_restart"; // a previous boot owned this row; `orphan` is present
   readonly exit?: { code: number | null; signal: string | null };
   readonly leaderExited?: boolean;
   readonly treeGone?: boolean;
   readonly error?: OmniErrorBody;
+  /** Present on `resumed` | `wake_retry` | `not_resumable`. */
+  readonly resume?: ResumeReport;
+  /** Present on `daemon_restart` | `orphaned`. */
+  readonly orphan?: OrphanRecord;
+  /** Sticky: set by any abnormal death, and it NEVER goes back to false (D2). */
+  readonly crashed?: boolean;
+  /** Processes this worker has had. 0 = it has never run. Increments on every wake. */
+  readonly generation?: number;
 }

+/** A process this daemon no longer owns, recorded so it is never silently forgotten (§15.7). */
+export interface OrphanRecord {
+  readonly pid: number;
+  readonly groupId: number | null;
+  readonly startedAt: string;
+  /** `null` where this platform cannot fingerprint (win32) — then we NEVER signal the pid. */
+  readonly fingerprint: string | null;
+  readonly reaped: boolean;
+  /** "fingerprint_mismatch" | "unsupported_platform" | "policy" | "gone" | null. */
+  readonly reapSkipped: string | null;
+}

 export interface PolicyDecisionPayload {
   … readonly offered: readonly PermissionOption[];
+  /**
+   * `subject.toolCall.toolCallId` when the subject is a tool call, else null.
+   *
+   * This is what makes corpus finding 7 ("deny is invisible in `stopReason`") tractable WITHOUT
+   * parsing English. The only agent-side signal is `rawOutput: "User refused permission to run
+   * tool"`. We do not need it: we are the party that denied, so `reduceTurn` joins this id to the
+   * tool call and reports it in `TurnResult.deniedToolCalls` (§13.4).
+   */
+  readonly toolCallId: string | null;
 }

 export type EventBody =
   … | { readonly kind: "omni.worker_state"; readonly payload: WorkerStatePayload }
+  | { readonly kind: "omni.lease"; readonly payload: LeaseEventPayload }
   | { readonly kind: "omni.error"; readonly payload: OmniErrorBody & { stderrTail?: string } };
```

`eventEnvelopeSchema` gains the `omni.lease` arm, the six new `WORKER_STATE_REASONS`, and the
`resume` / `orphan` / `crashed` / `generation` / `toolCallId` fields — all fully specified, because
`omni.*` payloads are ours.

**`src/worker.ts`.**

```diff
 export interface ProcessInfo {
   readonly pid: number; readonly groupId: number | null; readonly startedAt: string;
   readonly command: string; readonly argsRedacted: readonly string[];
+  /**
+   * A platform token identifying THIS process incarnation, captured at spawn (§15.7).
+   * Linux `"linux:<btime>:<starttime-ticks>"`, darwin `"darwin:<lstart-epoch>"`, `null` on win32
+   * and on any failure. A null fingerprint means we will NEVER signal this pid after a restart:
+   * pid reuse would make the kill a coin flip on an unrelated process.
+   */
+  readonly fingerprint: string | null;
 }

 export interface AgentCapabilitiesSnapshot {
-  readonly protocolVersion: 1; // M0 negotiates 1 only
+  /** M1 still negotiates 1; widened so a v2 agent is a data change, not a type change (F24). */
+  readonly protocolVersion: 1 | 2;
   readonly raw: …; readonly loadSession: boolean;
   readonly promptCapabilities: PromptCapabilities | null;
   readonly supportsSessionClose: boolean;
+  /**
+   * Resolved ONCE at handshake from the descriptor's preference order (F18).
+   * `method: null` means this worker can NEVER hibernate: the idle timer refuses to fire, or
+   * closes, per `hibernate.whenNotResumable` (ruling M1-R15).
+   */
+  readonly resume: {
+    readonly method: ResumeMethod | null;
+    readonly replayFrom: boolean;
+    readonly requiresSameCwd: boolean;
+  };
+  readonly supportsSessionList: boolean;
+  /**
+   * Verbatim `configOptions` from `session/new` — and from `session/load`/`session/resume`, which
+   * return a body contrary to the v1 schema (F18). `null` when the agent returned none. Kept
+   * because `current_mode_update -> config_option_update` cannot be built without the catalogue.
+   */
+  readonly configOptions: readonly unknown[] | null;
+  /** v1 `NewSessionResponse.modes`. The source for the synthesized `mode` config option. */
+  readonly modes: Readonly<Record<string, unknown>> | null;
+  /** Method names the probe or the registry proved live, in descriptor preference order. */
+  readonly extensions: readonly string[];
 }

 export interface WorkerSnapshot {
   … readonly closeReason: WorkerCloseReason | null;
+  /** ALWAYS present. `holder: null` is a real, actionable state, not "no lease feature". */
+  readonly lease: LeaseSnapshot;
+  /** ISO-8601 of the transition into `hibernated`; null in every other state. */
+  readonly hibernatedAt: string | null;
+  /** Sticky. Set by any abnormal death, including "a previous boot owned this row". */
+  readonly crashed: boolean;
+  /** The LAST wake attempt's classification. null before the first wake. */
+  readonly resume: ResumeReport | null;
+  readonly wakeCount: number;
+  /** Consecutive transient failures; reset to 0 by a successful wake. */
+  readonly wakeFailures: number;
+  readonly orphan: OrphanRecord | null;
+  /** Processes this worker has had. 1 after the first handshake. */
+  readonly generation: number;
+  /** Descriptor identity: `"<agentId>@<fingerprint12>"`. Which quirk table governed this worker. */
+  readonly runtimeId: string;
+  /**
+   * "memory"   — nothing here survives a restart, and we say so.
+   * "durable"  — write-through is healthy.
+   * "degraded" — a durable write FAILED. The log is still correct in RAM; a restart will not help.
+   */
+  readonly persistence: "memory" | "durable" | "degraded";
 }

 export interface CloseResult {
   … readonly treeGone: boolean;
+  /**
+   * Whether `session/close` was actually sent and acknowledged. FALSE for every close of a
+   * `hibernated` worker: we do not spawn a process in order to politely close a session (§15.6).
+   * The daemon guarantees it stops referencing the session, not that the agent deleted it.
+   */
+  readonly sessionClosed: boolean;
 }
```

**`src/turn.ts`.**

```diff
 export interface FileChange {
   readonly path: string;
+  /** v2 `DiffChange.operation`. Derived when the agent gives only v1 fields: `oldText == null ? "add" : "modify"`. */
+  readonly operation: "add" | "modify" | "delete" | "move" | "copy" | string;
   readonly oldText: string | null;
   readonly newText: string;
+  /**
+   * TRUE when `oldText`/`newText` are the CHANGED FRAGMENT rather than whole-file content, from
+   * the descriptor's `diffIsFragment` quirk — never guessed. F19: claude-acp widens the pair
+   * between updates (`"mode = slow"→"mode = fast"`, then `"mode = slow\nretries = 3"→…`), so a
+   * consumer that writes `newText` to `path` corrupts the file.
+   */
+  readonly fragment: boolean;
 }

+/** DESIGN §6.2's "`end_turn` ≠ 成功", made machine-readable — with no new event kind (§13.4). */
+export type TurnVerdict = "ok" | "partial" | "failed";
+
+export interface TurnWarning {
+  /** "rate_limit" | "tool_denied" | "tool_failed" | "permission_not_offered" | … */
+  readonly code: string;
+  readonly message: string;
+  /** Where it came from, so a consumer can weigh it. `stderr` is the weakest and is descriptor-gated. */
+  readonly source: "usage_meta" | "stderr" | "policy" | "tool_status";
+  readonly detail?: Readonly<Record<string, unknown>>;
+}

 export interface TurnResult {
   … readonly changes: readonly FileChange[];
-  readonly patch: string | null; // M0: always null (D8, git provider is M2)
+  /** STILL `null` in M1 (D8, ruling M1-R11). The git provider is M2 and is the only thing that
+   *  may fill it, because only it can compare against the actual disk. */
+  readonly patch: string | null;
+  /**
+   * A patch reconstructed from a descriptor-registered VENDOR `_meta` extension, clearly labelled
+   * as such. For claude-acp that is `_meta.claudeCode.toolResponse.{structuredPatch, originalFile,
+   * content}` (F19), which reconstructs a patch `git apply --check` accepts for both an edit and a
+   * creation. `null` for any agent without a registered extractor, and `null` rather than wrong
+   * when the reconstructed hunk line counts disagree with `oldLines`/`newLines`.
+   */
+  readonly vendorPatch: { format: "git_patch"; text: string; source: string } | null;
   readonly usage?: { used: number; size: number; cost?: { amount: number; currency: string } };
+  /**
+   * The v2 `Usage` block from the prompt RESPONSE (F21) — a different shape from `usage` above,
+   * which stays sourced from the last `usage_update` (F4). Rides on `state_update{idle}.usage`,
+   * which is where v2 puts it.
+   */
+  readonly tokens?: {
+    totalTokens: number; inputTokens: number; outputTokens: number;
+    cachedReadTokens?: number; cachedWriteTokens?: number;
+  };
   readonly interactions: readonly InteractionRecord[];
+  readonly verdict: TurnVerdict;
+  readonly warnings: readonly TurnWarning[];
+  /** Tool calls whose FINAL status is "failed", in stream order. */
+  readonly failedToolCalls: readonly string[];
+  /** Tool calls THIS daemon denied, from our own `omni.policy_decision` — never from prose. */
+  readonly deniedToolCalls: readonly string[];
   readonly error: OmniErrorBody | null;
 }
```

`CLOSE_REASON_CODE` — the private table that says which `OmniErrorCode` a mid-turn close reports —
gains M1's four reasons, and the reading is "whose decision was it?" (Land note S13): `idle_timeout` and
`orphaned` are OURS (`worker_closed`); `wake_failed` is a run of failed attempts against the agent
(`agent_error`); `acl_revoked` is the current config's (`forbidden`, §15.5). The table is a mapped type
over `WorkerCloseReason`, so a fifth reason is a compile error until somebody decides which of those it is.

`reduceTurn`'s contract changes in exactly two ways and is otherwise the M0 function:

```diff
- * MUST NOT read `messageId` (CONTRACTS.md F3).
+ * READS `messageId`, but only to group chunks into messages. v1 types it OPTIONAL and v2
+ * requires it, so `reduceTurn` MUST tolerate its absence — a chunk without one is its own
+ * message. The `no-message-id` guard is replaced by `message-id-optional` (§10.2).
+ *
+ * SKIPS every envelope carrying `replay: true`: a replayed history belongs to no turn of ours,
+ * and folding it would double-count text the log already holds (§15.3).
```

**`src/config.ts`.** All additions have defaults, so an M0 config file parses unchanged.

```diff
 export const TurnConfig = z.object({
   quietMs: …default(250), hardMs: …default(5_000), cancelGraceMs: …default(10_000),
+  /** Forced close-out rung 3: how long to drain stdout after stdin EOF (§13.2). */
+  drainGraceMs: z.number().int().nonnegative().default(2_000),
 });

 export const AgentDescriptor = z.object({
   id, command, args, env,
-  protocolVersion: z.literal(1).default(1),
+  protocolVersion: z.union([z.literal(1), z.literal(2)]).default(1),
   shutdown: …,
+  /** Operator overlay on the builtin descriptor; the probe overlays this in turn (§17.2). */
+  runtime: RuntimeOverlay.prefault({}),
+  /**
+   * Per-agent probe overrides. Spelled out as its own UNDEFAULTED `ProbeOverrides` schema and
+   * NOT `ProbeConfig.partial()`: `.partial()` only makes the keys optional, so the inner
+   * `.default()`s still fire and `{}` would parse into the full default block — an agent overlay
+   * would then silently beat the daemon-wide `probe` setting on every field the operator never
+   * wrote. An override that cannot be absent is not an override (Land note S12).
+   */
+  probe: ProbeOverrides.prefault({}),
 });

 export const SupervisorConfig = z.object({
   … windowsHide: …,
+  /**
+   * What to do with a process a PREVIOUS boot left behind (§15.7).
+   * "fingerprint" signals only when the captured incarnation token still matches; it degrades to
+   * "never" wherever `PlatformOps.fingerprint` returns null (win32 today) and SAYS SO in the
+   * envelope and in `GET /v1/info`, rather than silently doing nothing.
+   */
+  reapOrphans: z.enum(["never", "fingerprint"]).default("fingerprint"),
 });

+export const HibernateConfig = z.object({
+  /** DESIGN §12: 30 min. 0 disables hibernation daemon-wide. */
+  idleMs: z.number().int().nonnegative().default(1_800_000),
+  /** Budget for spawn + initialize + resume. Separate from `handshakeTimeoutMs`: a wake is warm
+   *  (claude-acp ~0.94 s initialize + ~0.55 s load) where a create may be cold (~7 s). */
+  wakeTimeoutMs: z.number().int().positive().default(90_000),
+  /**
+   * A worker whose agent advertises NO resume spelling.
+   * "keep"  — refuse to hibernate; hold the process. The default (ruling M1-R15): hibernating a
+   *           worker you can never wake turns a healthy worker into a guaranteed 422 on a timer.
+   * "close" — reclaim the process and close with `idle_timeout`. For operators who would rather
+   *           lose the session than the memory.
+   */
+  whenNotResumable: z.enum(["keep", "close"]).default("keep"),
+  /** Consecutive TRANSIENT wake failures before the pointer is abandoned (`wake_failed`). Without
+   *  a cap, a worker whose agent binary was uninstalled retries a 7 s npx spawn on every prompt. */
+  maxWakeFailures: z.number().int().positive().default(3),
+  /** A hibernated worker owns no process, so it is bounded separately from `maxWorkers` (H14). */
+  maxHibernated: z.number().int().nonnegative().default(256),
+});
+
+export const LeaseConfig = z.object({
+  /** 0 = never expires. A holder that vanishes without releasing must not wedge a worker. */
+  ttlMs: z.number().int().nonnegative().default(900_000),
+  renewOnUse: z.boolean().default(true),
+  /** A same-token peer waits this long after the holder's last use before stealing. Admin never
+   *  waits (D13). 0 = immediately, which is D5's plain reading. */
+  stealAfterIdleMs: z.number().int().nonnegative().default(0),
+  /** true ⇒ a lease-gated request with no `Omni-Client-Id` is `400`. Default false so raw-curl and
+   *  `curl-shapes.itest.ts` keep working; the SDK mints a ULID per `connect()` (§16.1 rule L4). */
+  requireClientId: z.boolean().default(false),
+});
+
+export const ProbeConfig = z.object({
+  onStart: z.enum(["never", "cached", "always"]).default("cached"),
+  ttlHours: z.number().int().positive().default(168),
+  timeoutMs: z.number().int().positive().default(90_000),
+  maxConcurrent: z.number().int().positive().default(2),
+  /** The method battery after `session/new`. ~0 tokens — corpus `08` ran 11 probes and no prompt. */
+  deep: z.boolean().default(true),
+});
+
+export const ResumeReplayConfig = z.object({
+  /**
+   * "mark_all" (DEFAULT) — replay envelopes are stored, streamed and marked `replay:true`.
+   * "drop_duplicates" — additionally drop, BEFORE `append()`, any replayed `*_message_chunk`
+   *   whose `messageId` the log already holds. Correct for claude-acp (F14) but resting on one
+   *   agent at one version, so it is opt-in (ruling M1-R5). Dropping before append means no seq is
+   *   consumed and the log stays gap-free.
+   * "drop_all" — the blunt instrument; loses history the daemon never saw.
+   */
+  replay: z.enum(["mark_all", "drop_duplicates", "drop_all"]).default("mark_all"),
+});

 DaemonConfig gains:
   eventLog: {
     /**
      * STILL "memory" BY DEFAULT (ruling M1-R17). `omni-acp start` writes "sqlite" into the config
      * it builds, because a long-running daemon must survive a restart; `createDaemon()` keeps a
      * zero-file, zero-experimental-module footprint so `OmniACP.local()` in a user's script does
      * not leave a database behind. One default per entry point, no magic in the schema, and
      * `GET /v1/info.persistence.driver` reports which is in force so it is never a guess.
      */
     driver: z.enum(["memory", "sqlite"]).default("memory"),
     file: z.string().optional(),                                  // default `<dataDir>/events.db`
     maxEventsPerWorker: …default(10_000),                          // RAM ring; bounds memory ONLY
     maxPersistedEventsPerWorker: …default(200_000),                // durable row cap; 0 = unbounded
     retentionDays: …default(7),                                    // DESIGN §12
     retentionSweepMs: …default(3_600_000),
     synchronous: z.enum(["off","normal","full"]).default("normal"),// WAL + NORMAL: a daemon crash
                                                                    // loses nothing; only power loss can
     suppressExperimentalWarning: z.boolean().default(true),        // §14.2, surgical, never --no-warnings
     subscriberQueueSize: …default(1_024), sseHeartbeatMs: …default(15_000),
   }
   hibernate: HibernateConfig.prefault({})
   lease:     LeaseConfig.prefault({})
   probe:     ProbeConfig.prefault({})
   resume:    ResumeReplayConfig.prefault({})
```

**`src/control-plane.ts`.**

```diff
 export const CreateWorkerRequest = z.strictObject({
   agent, cwd, label, mcp, onUnresolved, timeoutMs,
+  /** Per-worker override of `hibernate.idleMs`. 0 disables hibernation for this worker. */
+  idleTimeoutMs: z.number().int().nonnegative().max(86_400_000).optional(),
+  /** "take" (default) ⇒ the creator holds the lease; "observe" ⇒ created lease-free (D5). */
+  lease: z.enum(["take", "observe"]).optional(),
-  // M1+/M2, rejected by strictObject in M0: policy, env
+  // M2, still rejected by strictObject: policy, env
 });

+export const LeaseRequestBody = z.strictObject({
+  ttlMs: z.number().int().nonnegative().max(86_400_000).optional(),
+  /** `steal` only; recorded VERBATIM in the `omni.lease` audit envelope (D5: 带审计). */
+  reason: z.string().max(500).optional(),
+});
+export const WakeRequestBody = z.strictObject({ timeoutMs: z.number().int().min(1_000).max(600_000).optional() });
+export const ProbeRequestBody = z.strictObject({
+  force: z.boolean().optional(), deep: z.boolean().optional(),
+  timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
+});
+export interface ProbeResponse {
+  readonly probe: ProbeSummary;
+  /** true ⇒ served from `<dataDir>/probes/<id>.json` without spawning anything. */
+  readonly cached: boolean;
+}

 export interface AgentCatalogEntry {
   readonly id; readonly command; readonly args; readonly source: "config";
-  readonly probed: null; // M1
+  readonly probed: ProbeSummary | null;
+  /** The descriptor that WILL govern a worker created now: `"<agentId>@<fingerprint12>"`. */
+  readonly runtimeId: string;
 }

 export interface DaemonInfo {
   … readonly ownership: PlatformOwnership;
+  /** The version of the canonical payload this daemon WRITES. M1: 2 (ruling M1-R10). */
+  readonly canonicalPayloadVersion: 2;
+  readonly persistence: {
+    readonly driver: "memory" | "sqlite"; readonly file: string | null;
+    readonly schemaVersion: number; readonly sizeBytes: number;
+    readonly writeFailures: number; readonly retentionDays: number;
+    readonly lastSweep: RetentionReport | null;
+  };
+  /** This daemon INSTANCE's id (not the stable `daemonId`). Distinguishes boots (§15.7). */
+  readonly bootId: string;
+  readonly orphansAtStart: { found: number; reaped: number; skipped: number };
 }

 export const HEADER = {
   auth: "authorization", clientId: "omni-client-id", lastEventId: "last-event-id",
+  /** Optional fencing token. Present and stale ⇒ 423 (§16.1 rule L7). */
+  leaseEpoch: "omni-lease-epoch",
 } as const;
```

**`src/contracts.ts`.** The seam. Additions only; nothing M0 declared is removed.

```ts
// ── persistence ──────────────────────────────────────────────────────────────

/**
 * The durable side of an EventLog. SYNCHRONOUS, for exactly the reason `EventLog.append` is:
 * `DatabaseSync` is synchronous, and an async `put` reintroduces the interleave that a
 * non-monotonic `seq` is (§8.1). Nothing here assigns a `seq` — the store is TOLD what it is.
 */
export interface EventStore {
  /** `max(seq)` ever assigned, INCLUDING rows retention has already evicted (§14.4). */
  headOf(workerId: WorkerId): Seq;
  /** Lowest RETAINED seq; `head + 1` when everything for this worker is gone. Never 1 by default. */
  tailOf(workerId: WorkerId): Seq;
  put(e: EventEnvelope): void;
  /** seq > since, ascending, at most `limit`. Deserialized — object identity is NOT preserved,
   *  which is exactly why the ring stays in front of it (F11). */
  read(workerId: WorkerId, since: Seq, limit: number): readonly EventEnvelope[];
  /** Delete `seq <= upTo` for one worker AND raise its durable tail, in ONE transaction. */
  evict(workerId: WorkerId, upTo: Seq): number;
  /** The nth-oldest retained seq, or null — the row-cap sweep without `DELETE … LIMIT`. */
  seqAtOffset(workerId: WorkerId, offset: number): Seq | null;
  workersWithEvents(): readonly WorkerId[];
  readonly diagnostics: EventStoreDiagnostics;
}

export interface EventStoreDiagnostics {
  readonly driver: "sqlite" | "memory";
  readonly file: string | null;
  readonly schemaVersion: number;
  readonly sizeBytes: number;
  /** Non-zero after any `put` failure; surfaced in `GET /v1/info` (§14.3). */
  readonly writeFailures: number;
}

/** The durable half of the Worker Registry — D2's `workerId → (agentId, sessionId, cwd, …)`. */
export interface WorkerStore {
  upsert(row: WorkerRow): void;
  get(id: WorkerId): WorkerRow | null;
  /** Newest `updatedAt` first. Visibility is the REGISTRY's job, never the store's. */
  list(): readonly WorkerRow[];
  /** Rows whose `bootId` is not the current one AND whose state is live — §15.7's orphans. */
  abandoned(currentBootId: string): readonly WorkerRow[];
  delete(id: WorkerId): void;
  closedBefore(cutoffMs: number): readonly WorkerRow[];
}

/** A snapshot plus what a snapshot does not carry because it is not client-facing. */
export interface WorkerRow {
  readonly snapshot: WorkerSnapshot;
  readonly agentId: string;
  /** The daemon INSTANCE that last wrote this row. Not `daemonId`, which is stable across boots. */
  readonly bootId: string;
  /** Persisted so `DELETE` is idempotent ACROSS a restart, byte-for-byte (§15.6). */
  readonly closeResult: CloseResult | null;
  readonly lastActiveMs: number;
  readonly closedAtMs: number | null;
  readonly hibernateIdleMs: number | null;
}

export interface RetentionReport {
  readonly workersDropped: number; readonly eventsDeleted: number;
  readonly byAge: number; readonly byRowCap: number; readonly durationMs: number;
}

/** What `createDaemon()` opens once and hands to the registry. `null` for the memory driver. */
export interface PersistenceHandle {
  readonly events: EventStore;
  readonly workers: WorkerStore;
  readonly bootId: string;
  /** One bounded retention pass. Returns what it deleted, for the log line and the test. */
  sweep(nowMs: number): RetentionReport;
  close(): void;
}

export interface EventLog {
  … // M0's members are unchanged
+ /** true ⇒ survives a daemon restart; `tail` is bounded by retention, not by the ring. */
+ readonly persistent: boolean;
+ /** sqlite: commit anything pending. memory: no-op. Called before `daemon.stop()` returns. */
+ flush(): void;
}

// ── lease ────────────────────────────────────────────────────────────────────

export interface Lease {
  readonly holder: ClientRef | null;
  readonly epoch: number;
  snapshot(): LeaseSnapshot;
  /**
   * Throws `lease_held` (423) carrying `snapshot()` in the error body. On an UNHELD lease it
   * implicitly acquires for `who` and emits `omni.lease{acquired, how:"implicit"}` — a worker
   * nobody controls should not 423 the first client that reaches for it (§16.1 rule L5).
   * `opts.epoch` is the optional fencing check from `Omni-Lease-Epoch`.
   */
  assertHolder(who: ClientRef, opts?: { epoch?: number }): LeaseSnapshot;
  acquire(who: ClientRef, opts?: { ttlMs?: number }): LeaseSnapshot;
  release(who: ClientRef): LeaseSnapshot;
  /** D13: admin always; a same-token peer after `stealAfterIdleMs`. Audited, epoch +1. */
  steal(who: ClientRef, opts: { reason: string | null; admin: boolean }): LeaseSnapshot;
  /** Suspends expiry while a turn is live; returns the un-pin. Nested calls refcount (rule L6). */
  pinExpiry(): () => void;
  /** Hibernation releases the lease unconditionally (DESIGN §3.2: 进程回收、lease 释放). */
  releaseForHibernate(): LeaseSnapshot;
  onChange(cb: (e: LeaseEventPayload) => void): () => void;
  close(): void;
}

// ── session strategy: the seam that keeps `worker.ts` frozen ─────────────────

export interface SessionOpenResult {
  readonly capabilities: AgentCapabilitiesSnapshot;
  readonly sessionId: SessionId;
  readonly resume: ResumeReport | null;
}

/**
 * After M1, `Worker` never names `initialize`, `session/new`, `session/load` or `session/resume`
 * again: it holds a `SessionStrategy` and calls `open` on create and `reopen` on wake. This is
 * the seam that lets the resume work package and the daemon work package own disjoint files while
 * `worker.ts` itself is edited exactly once, by the Land step, and then frozen (M1-PLAN §1).
 *
 * `controls.replayWindow()` opens D6's window and returns the closer; the Worker sets the flag,
 * the strategy decides when. The reducer stays pure.
 */
export interface SessionStrategy {
  open(link: AcpLinkLike, o: SessionOpenOptions): Promise<SessionOpenResult>;
  reopen(link: AcpLinkLike, o: SessionReopenOptions): Promise<SessionOpenResult>;
  /** Best-effort `session/close` when advertised. NEVER throws. */
  close(link: AcpLinkLike, sessionId: SessionId): Promise<void>;
}

// ── normalizer ───────────────────────────────────────────────────────────────

export type TurnInput =
  | { readonly type: "prompt_sent"; readonly turnId: TurnId; readonly at: number }
  | { readonly type: "agent_update"; readonly update: unknown; readonly at: number;
      /** D6. Set by the WORKER for every update inside the replay window; the reducer copies it
       *  onto every `EventInput` it emits for this update and carries no window state (§15.3). */
      readonly replay?: true }
  | { readonly type: "prompt_result"; readonly stopReason: StopReason;
      /** v1 `PromptResponse.usage` (F21). Lands on `state_update{idle}.usage`. */
      readonly usage?: unknown; readonly at: number }
  | { readonly type: "prompt_error"; readonly error: OmniErrorBody; readonly at: number }
  | { readonly type: "process_gone"; readonly error: OmniErrorBody; readonly stderrTail: string; readonly at: number }
  /** Starts the FORCED close-out ladder. The reducer decides which rung is next (§13.2). */
  | { readonly type: "close_requested"; readonly at: number }
  /** stdout EOF observed during the drain rung. */
  | { readonly type: "drained"; readonly at: number }
  /** One COMPLETE stderr line, for `end_turn`-with-fatal-stderr promotion (§13.4). */
  | { readonly type: "stderr_line"; readonly line: string; readonly at: number }
  | { readonly type: "tick"; readonly at: number };

export type SettleReason = "quiet" | "hard" | "error" | "gone" | "drained" | "cancelled";

/** The rung the Worker must perform next. `null` = do nothing. The ONLY side effect the reducer
 *  requests, which is what keeps the whole ladder unit-testable with a fake clock and no process. */
export type CloseOutAction = "close_stdin" | "drain" | "cancel" | "terminate";

export interface TurnOutput {
  readonly emit: readonly EventInput[];
  readonly scheduleTickAt: number | null;
  readonly state: "idle" | "running" | "settling" | "closing";
  readonly turnId: TurnId | null;
  readonly settled: SettleReason | null;
  readonly action: CloseOutAction | null;
}

export interface Normalizer {
  readonly sourceProtocolVersion: 1 | 2;   // reporting only; NO mapping rule reads it (F24)
  readonly slice: "m1-full";
  readonly descriptor: RuntimeDescriptor;
  /** PURE. No timers, no I/O, no async. Same inputs ⇒ same outputs, forever. */
  step(input: TurnInput): TurnOutput;
  /**
   * The v1→v2 map as a free function on the interface, so it is testable without a turn and
   * reusable by the compat suite and the golden generator. PURE, TOTAL and IDEMPOTENT:
   * `mapUpdate(mapUpdate(x).payload).payload` is deep-equal to `mapUpdate(x).payload` for every
   * input, and an unrecognized kind comes back BY IDENTITY with `payloadVersion: 1` (§12).
   */
  mapUpdate(update: unknown): MappedUpdate;
  /** v1 `{sessionId, toolCall, options}` → v2 `{title, subject, options}`. PURE, idempotent. */
  mapPermissionRequest(req: unknown): MappedPermissionRequest;
  /** Canonical (v2) client→agent call → the spelling THIS runtime answers (§17.3). PURE. */
  mapRequest(method: string, params: Record<string, unknown>): OutboundCall;
  /** Record a `-32601` so the next `mapRequest` skips that spelling for this process. */
  noteUnsupported(method: string): void;
  /** Classify a JSON-RPC error with the descriptor's rules. NEVER throws. */
  classifyError(e: AcpErrorDetail): ErrorClass;
}

export interface MappedUpdate {
  readonly payload: NormalizedSessionUpdate;
  /** 2 when the mapper landed on a KNOWN v2 arm; 1 when it passed an unrecognized kind through. */
  readonly payloadVersion: 1 | 2;
  /** Which table row fired, e.g. "tool_call->tool_call_update". "" for identity. Golden-tested. */
  readonly rule: string;
  /** For chunk kinds: the messageId in force after mapping, real or synthesized. */
  readonly messageId: string | null;
  /** false ⇒ the descriptor says drop this kind; it is never appended and consumes no seq (§14.6). */
  readonly keep: boolean;
}

export interface MappedPermissionRequest {
  readonly sessionId: string;
  readonly title: string;
  /** v2's TAGGED subject. `tool_call` is the only arm a v1 agent can produce; `toolCall` is
   *  passed BY IDENTITY so `kind`/`locations`/`content`/`rawInput` — what M2's rule engine
   *  matches on — arrive unmodified. */
  readonly subject: Readonly<Record<string, unknown>> | null;
  readonly options: readonly PermissionOption[];
  readonly toolCallId: string | null;
  readonly _meta?: Readonly<Record<string, unknown>>;
}

export interface OutboundCall {
  readonly method: string;
  readonly params: Record<string, unknown>;
  /** null when every spelling is exhausted; the caller reports `unsupported`. */
  readonly spelling: string | null;
  readonly onFailure: "fail" | "warn";
}

export type ErrorClass =
  | { readonly kind: "bad_request" }
  | { readonly kind: "agent_error" }
  | { readonly kind: "unsupported_method"; readonly method: string | null }
  | { readonly kind: "resume"; readonly outcome: ResumeOutcome; readonly hint: ResumeHint }
  | { readonly kind: "unclassified" };

export interface PermissionResponder {
  /**
   * `req` is the V2-MAPPED request (ruling M1-R14). D4's rule set is written against v2's tagged
   * `subject`, and mapping first is what lets M2's rule engine match `kind` / `path` / `cmd` with
   * no per-agent branch.
   */
  decide(req: MappedPermissionRequest): PermissionDecision;
}

// ── worker handle / registry / catalog ───────────────────────────────────────

export interface WorkerHandle {
  … // M0's members unchanged
  /**
   * ready → hibernated. Idempotent; throws `worker_busy` while a turn is live. Reclaims the
   * process tree, RELEASES the lease, keeps the record and the session pointer, and NEVER sends
   * `session/close` — the pointer is the entire value being preserved (§15.2).
   */
  hibernate(reason: "idle_timeout" | "client_request"): Promise<WorkerSnapshot>;
  /**
   * hibernated → ready. Idempotent and SINGLE-FLIGHT: concurrent callers share one attempt.
   * Throws `not_resumable` (422) carrying the `ResumeReport`, `agent_error` (502),
   * `agent_timeout` (504), `worker_limit` (429) or `worker_closed` (410) — the table is §15.5.
   */
  wake(who: ClientRef, opts?: { timeoutMs?: number }): Promise<WorkerSnapshot>;
  readonly generation: number;
}

export interface WorkerRegistry {
  … // M0's members unchanged
  /** Workers occupying NO process. Bounded by `hibernate.maxHibernated`, not `maxWorkers`. */
  readonly hibernatedSize: number;
  /** Façade rows, so an HTTP route stays parse → ONE call → serialize (review R11). */
  lease(id: WorkerId, auth: AuthContext, op: "acquire" | "release" | "steal", body: LeaseRequestBody): LeaseSnapshot;
  hibernate(id: WorkerId, auth: AuthContext): Promise<WorkerSnapshot>;
  wake(id: WorkerId, auth: AuthContext): Promise<WorkerSnapshot>;
  /** Boot adoption: every live-state row from a previous boot becomes `hibernated` or `closed`. */
  adopt(): Promise<{ hibernated: number; closed: number; orphans: readonly OrphanRecord[] }>;
}

export interface Catalog {
  … // M0's members unchanged
  /** Merged builtin ⊕ config ⊕ cached-probe descriptor. NEVER throws; falls back to the v1 profile. */
  descriptor(id: string): RuntimeDescriptor;
  probe(id: string, o: ProbeRequestBody, auth: AuthContext): Promise<ProbeResponse>;
}

export interface DaemonDeps {
  … // M0's members unchanged
  readonly persistence?: PersistenceHandle;
  readonly session?: SessionStrategy;
  /**
   * SEAM 3 (M1-PLAN §1.2, review R14): the `Lease` factory the registry hands each new worker.
   * Absent ⇒ `alwaysGrantedLease`, i.e. M0's behaviour. M1-WP-D lands `createLease` in its own
   * files and M1-WP-E flips this default in `create-daemon.ts`, so D5 enforcement costs
   * `worker.ts` and `registry.ts` zero further edits.
   */
  readonly leaseFactory?: (owner: ClientRef, workerId: WorkerId) => Lease;
}

// ── supervisor / platform ────────────────────────────────────────────────────

export interface Supervisor {
  … // M0's members unchanged
  /**
   * Kill a process this daemon did NOT spawn, gated on the fingerprint a previous boot captured.
   * NEVER signals when `fingerprint` is null or does not match — a recycled pid is somebody
   * else's process. ALWAYS resolves: a reap failure is data (`reapSkipped`), not an exception.
   */
  reapOrphan(o: OrphanRecord): Promise<OrphanRecord>;
}

export interface PlatformOps {
  … // M0's members unchanged
  /** The incarnation token for a live pid, or null where this platform cannot take one. */
  fingerprint(pid: number): Promise<string | null>;
  signalTreeByGroup(groupId: number, sig: "SIGTERM" | "SIGKILL"): Promise<TerminationRung>;
  isGroupGone(groupId: number): Promise<boolean>;
}
```

### 5.2 `@omni-acp/testkit` (private)

Frozen after the scaffold step, so five work packages can share it without conflict.

```ts
/** Two cross-wired TransformStreams satisfying acp.Stream (F7). No process, no framing. */
export function memoryStreamPair(): [AcpStream, AcpStream];

/** A scriptable ACP v1 agent built on the SDK's public acp.agent() builder. */
export interface ScriptedAgent {
  readonly stream: AcpStream; // hand this to FakeAgentProcess
  readonly sessionIds: readonly string[];
  emitChunk(text: string): Promise<void>;
  emitThought(text: string): Promise<void>;
  emitToolCall(u: Record<string, unknown>): Promise<void>;
  emitDiff(
    toolCallId: string,
    path: string,
    oldText: string | null,
    newText: string,
  ): Promise<void>;
  emitUsage(used: number, size: number): Promise<void>;
  /** Issues session/request_permission and resolves with the option the client chose. */
  requestPermission(options: readonly PermissionOption[]): Promise<string | { error: number }>;
  resolvePrompt(stopReason: StopReason): void;
  /** Emit an update `ms` after the prompt response has already returned (the L5 case). */
  emitAfterPromptResolves(ms: number, text: string): void;
  hang(): void;
  die(): void;
  setCapabilities(caps: Record<string, unknown>): void;
}
export function scriptedAgent(opts?: { name?: string }): ScriptedAgent;

export interface FakeAgentProcess extends AgentProcess {
  simulateExit(code: number | null, signal?: string | null): void;
  writeStderr(s: string): void;
  readonly terminateCalls: readonly { gracefulMs?: number; force?: boolean }[];
}
export interface FakeSupervisor extends Supervisor {
  readonly spawnCalls: readonly SpawnSpec[];
  /** Registers the ScriptedAgent the next spawn() will be wired to. */
  enqueue(agent: ScriptedAgent | { failWith: Error }): void;
  allTreesReclaimed(): boolean;
}
export function fakeSupervisor(opts?: { ownership?: PlatformOwnership }): FakeSupervisor;

export interface FakeClock extends Clock {
  advance(ms: number): void;
  readonly pendingTimers: number;
  set(epochMs: number): void;
}
export function fakeClock(startEpochMs?: number): FakeClock;

/** Deterministic ids: d_000…001, w_000…001, t_000…001. */
export function seqIds(): IdGen;
export function nullLogger(): Logger;

/** A Daemon whose methods are recorded stubs — for pure HTTP routing tests. */
export function stubDaemon(overrides?: Partial<Daemon>): Daemon & {
  readonly calls: readonly { method: string; args: unknown[] }[];
};

export function parseSse(text: string): { id?: string; event?: string; data: string }[];
export function collectSse(
  res: Response,
  opts: {
    until?: (e: EventEnvelope) => boolean;
    count?: number;
    timeoutMs?: number;
  },
): Promise<{ envelopes: EventEnvelope[]; control: { event: string; data: unknown }[] }>;

/** Per-OS liveness probes: kill(pid,0) on POSIX, tasklist on Windows. */
export function isAlive(pid: number): Promise<boolean>;
export function waitGone(pid: number, timeoutMs?: number): Promise<boolean>;

/** F8: derived from the SDK's main entry, never from an unexported subpath. */
export function sdkExampleAgentPath(): string;
export function fixtureAgentPath(
  name: "echo" | "crash" | "slow" | "chatty" | "orphan" | "noisy",
): string;

/** The suite M1's SQLite driver must pass verbatim. Call inside a describe block. */
export function runEventLogConformance(name: string, make: () => EventLog): void;
```

**Fixture agents** (`fixtures/agents/*.mjs`, launched as `process.execPath <path>` — never `npx`):

| fixture      | behaviour                                                                        | proves                                                      |
| ------------ | -------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `echo.mjs`   | two chunks + `end_turn`, no permission                                           | happy path over real pipes                                  |
| `crash.mjs`  | answers `initialize`, then `process.exit(1)` mid-prompt                          | crash classification, §7.3                                  |
| `slow.mjs`   | never answers `session/prompt`, ignores `session/cancel`                         | cancel escalation, handshake timeout mode                   |
| `chatty.mjs` | emits one chunk 400 ms **after** returning `{stopReason:"end_turn"}`             | the quiet window (L5) — with it removed the assertion fails |
| `orphan.mjs` | spawns a grandchild that appends to `$MARKER_FILE` every 100 ms and sleeps 300 s | tree kill on all three OSes                                 |
| `noisy.mjs`  | one frame > `maxFrameBytes`; 1 MiB of stderr; exits mid-turn on command          | frame limit, stderr tail, protocol_error                    |

### 5.3 `@omni-acp/core`

`src/index.ts` (frozen barrel) re-exports every contract type by name plus these factories:

```ts
// process/platform.ts — WP-2
/**
 * Chosen ONCE, at Supervisor construction; no call site downstream branches on
 * `process.platform` (§6.1). Declared here rather than in `contracts.ts`, which is types-only
 * (amendment A2). `deps.runUtility` defaults to `spawn.ts`'s implementation and is what
 * `platform-windows.ts` uses for `taskkill` / `tasklist` — injected, not imported, because
 * `spawn.ts` consumes `PlatformOps` (review R8).
 */
export function createPlatformOps(
  platform?: NodeJS.Platform,
  deps?: { runUtility: RunUtility },
): PlatformOps;

// process/spawn.ts — WP-2. The second and last spawn site in the repository; see §6.1.
export function runUtility(
  file: string,
  args: readonly string[],
  o: { timeoutMs: number },
): Promise<{ code: number | null; stdout: string }>;

// process/supervisor.ts  — WP-2
export interface SupervisorOptions {
  /** `ResolvedSupervisorConfig` from protocol, so `core` takes no zod dependency (A3). */
  readonly config: ResolvedSupervisorConfig;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly platform?: PlatformOps; // injectable for tests
  /** Injected only by unit tests that observe argv without spawning. */
  readonly spawnFn?: typeof import("node:child_process").spawn;
}
export function createSupervisor(o: SupervisorOptions): Supervisor;

// event-log/memory-log.ts — WP-3
export interface MemoryEventLogOptions {
  readonly workerId: WorkerId;
  readonly daemonId: DaemonId;
  readonly clock: Clock;
  readonly maxEvents: number;
  readonly subscriberQueueSize: number;
}
export function createMemoryEventLog(o: MemoryEventLogOptions): EventLog;

// normalizer/normalizer.ts — WP-3
export function createNormalizer(o: { quietMs: number; hardMs: number }): Normalizer;

// acp/link.ts — WP-4
export interface AcpLinkHandlers {
  onSessionUpdate(n: { sessionId: string; update: Record<string, unknown> }): void;
  /** MUST resolve or throw acp.RequestError. Throwing anything else maps to -32603. */
  onPermissionRequest(req: RequestPermissionRequest): Promise<RequestPermissionResponse>;
  /** Fires exactly once, before `closed` resolves. */
  onClosed(err: Error | null): void;
}
export interface AcpLink {
  request<R = unknown>(method: string, params: unknown): Promise<R>;
  notify(method: string, params: unknown): Promise<void>;
  readonly closed: Promise<void>;
  close(): void;
}
/**
 * Wraps an AgentProcess.stream in acp.client(...). Unknown agent→client requests are
 * answered -32601, never left hanging (DESIGN §6.2). clientCapabilities is {} (D3).
 */
export function openAcpLink(stream: AcpStream, h: AcpLinkHandlers, o: { logger: Logger }): AcpLink;

// worker/permission-responder.ts — WP-4
/**
 * D4's hard rules, no rule engine:
 *  1. only ever selects an optionId the agent actually offered
 *  2. allow: session-grant id → any kind==="allow_once"; NEVER "allow_always"
 *  3. deny:  offered kind==="reject_once"
 *  4. nothing acceptable offered ⇒ response:null ⇒ caller replies -32603
 *  5. NEVER returns outcome:"cancelled"
 *  6. unknown `kind` is treated as non-grant (fail closed)
 * M0 wires only mode "deny"; "allow" is implemented and unit-tested but unreachable from the wire.
 */
export function createBaselineResponder(mode: "allow" | "deny", clock: Clock): PermissionResponder;

// lease/always-granted.ts — WP-4
export function alwaysGrantedLease(holder: ClientRef): Lease;

// worker/worker.ts — WP-4
export interface CreateWorkerDeps {
  readonly workerId: WorkerId;
  readonly daemonId: DaemonId;
  readonly descriptor: AgentDescriptor;
  readonly cwd: string; // already realpath'd and ACL-checked
  readonly label: string | null;
  readonly owner: ClientRef;
  readonly supervisor: Supervisor;
  readonly log: EventLog;
  readonly normalizer: Normalizer;
  readonly responder: PermissionResponder;
  readonly lease: Lease;
  readonly clock: Clock;
  readonly ids: IdGen;
  readonly logger: Logger;
  readonly limits: {
    handshakeTimeoutMs: number;
    cancelGraceMs: number;
    exitGraceMs: number;
    gracefulMs: number;
  };
}
/**
 * spawn → initialize{protocolVersion:1, clientCapabilities:{}} → session/new{mcpServers:[]}.
 * Resolves ONLY when state === "ready". On ANY failure it reclaims the process tree,
 * appends omni.error + omni.worker_state{closed,…}, and REJECTS with an OmniError whose
 * code is already correct (agent_error / agent_timeout).
 */
export function createWorker(deps: CreateWorkerDeps, signal?: AbortSignal): Promise<WorkerHandle>;
```

### 5.4 `@omni-acp/daemon`

```ts
// src/index.ts (frozen barrel)
export { createDaemon } from "./create-daemon.js";
export type { AuthContext, Catalog, Daemon, DaemonDeps, DaemonEvent, WorkerRegistry } from "./types.js";
export { createHttpApp } from "./http/app.js";

// declared in protocol/src/contracts.ts; re-exported unchanged from daemon/src/types.ts
// (amendment A1 — §4's rule, and the only way testkit's `stubDaemon(): Daemon` avoids the
//  testkit -> daemon -> testkit cycle). The import path every consumer uses is `./types.js`.
export interface AuthContext {
  readonly tokenId: TokenId;
  readonly role: "user" | "admin";
  readonly clientId: ClientId | null;
  /** M1: `Omni-Lease-Epoch` as sent, or null. Travels to the lease inside `asClientRef()`
   *  (§16.1 L7). A non-numeric header is `bad_request`, never a silently ignored fence. */
  readonly leaseEpoch: number | null;
  readonly agents: readonly string[] | "*";
  readonly cwdRoots: readonly string[];
  readonly maxWorkers: number;
  /** Throws forbidden when the agent id is out of bounds. */
  assertAgent(agentId: string): void;
  /** realpath + containment. Returns the canonical cwd. Throws forbidden. */
  assertCwd(cwd: string): Promise<string>;
  /** D13: admin sees all; otherwise same ownerTokenId only. */
  canSee(w: WorkerSnapshot): boolean;
  asClientRef(): ClientRef;
}

export interface WorkerRegistry {
  readonly size: number;
  /** In-process path — no HTTP, no headers (D15). */
  create(req: CreateWorkerRequest, auth: AuthContext, signal?: AbortSignal): Promise<WorkerHandle>;
  /** Throws worker_not_found when absent OR invisible — never leak existence. */
  get(id: WorkerId, auth: AuthContext): WorkerHandle;
  list(auth: AuthContext): readonly WorkerSnapshot[];
  delete(id: WorkerId, auth: AuthContext): Promise<CloseResult>;
  closeAll(reason: WorkerCloseReason, opts?: { timeoutMs?: number }): Promise<void>;

  // ── result-returning façade (review R11) ──────────────────────────────────
  // Each is `get(id, auth)` plus one call on the handle. They exist so an HTTP route really is
  // "parse → call ONE daemon method → serialize" instead of a get-then-act orchestration in the
  // adapter — the one place D15 constraint 1 leaked. In-process callers still use `get()`.
  /** H7. Throws worker_not_found when absent or invisible. */
  snapshot(id: WorkerId, auth: AuthContext): WorkerSnapshot;
  /** H8. */
  prompt(id: WorkerId, auth: AuthContext, body: PromptRequestBody): Promise<PromptAccepted>;
  /** H9. Idempotent; a no-op when the worker is not running. */
  cancel(id: WorkerId, auth: AuthContext): Promise<void>;
  /** H11. An unknown turn is `state:"unknown"`, never a 404 (D29). */
  turn(id: WorkerId, auth: AuthContext, turnId: TurnId): TurnStatus;
  /** H10: the log the SSE writer subscribes to; visibility is checked here, not in `http/`. */
  logFor(id: WorkerId, auth: AuthContext): EventLog;
}

export interface Catalog {
  list(): readonly AgentCatalogEntry[];
  /** Throws bad_request(`unknown agent "<id>"`). */
  get(id: string): AgentDescriptor;
  /** Descriptor + cwd → SpawnSpec. The ONLY producer of SpawnSpec. */
  toSpawnSpec(d: AgentDescriptor, o: { cwd: string }): SpawnSpec;
}

export type DaemonEvent =
  | { readonly type: "worker.state"; readonly workerId: WorkerId; readonly envelope: EventEnvelope }
  | {
      readonly type: "worker.event";
      readonly workerId: WorkerId;
      readonly envelope: EventEnvelope;
    };

export interface Daemon {
  readonly id: DaemonId;
  readonly config: ResolvedDaemonConfig;
  readonly info: DaemonInfo;
  /** null until start(), and forever when config.listen is null. */
  readonly url: string | null;
  readonly workers: WorkerRegistry;
  readonly catalog: Catalog;
  readonly supervisor: Supervisor;

  /**
   * The in-process entry to everything `AuthContext` gates (D15's library-first path, review
   * R10). Throws `unauthorized` for an unknown token id. `authenticate(headers)` is the HTTP
   * adapter's thin wrapper over this, so an embedder running with `listen: null` never has to
   * forge a `Bearer` header to reach `workers.create()`.
   */
  authContextFor(tokenId: TokenId, clientId?: ClientId | null): AuthContext;

  /** Throws unauthorized. Re-evaluated every call; no decision cache (DESIGN §8). */
  authenticate(headers: Headers): AuthContext;
  whoami(auth: AuthContext): WhoAmIResponse;

  /** D15 constraint 1, made testable: a web-standard handler that needs no socket. */
  readonly fetch: (req: Request) => Promise<Response>;

  on(type: DaemonEvent["type"], handler: (e: DaemonEvent) => void): () => void;

  /** Binds the socket when listen != null; otherwise a no-op that marks started. */
  start(): Promise<void>;
  /** SSE subs → workers (killing trees) → socket. Idempotent. */
  stop(opts?: { graceful?: boolean; timeoutMs?: number }): Promise<void>;
}

export interface DaemonDeps {
  readonly supervisor?: Supervisor; // ← tests inject fakeSupervisor(); nothing else is needed
  readonly clock?: Clock;
  readonly ids?: IdGen;
  readonly logger?: Logger;
  readonly responder?: PermissionResponder;
}
export function createDaemon(config: DaemonConfig, deps?: DaemonDeps): Promise<Daemon>;

// src/http/app.ts — ZERO business logic (D15 constraint 1)
/**
 * Every route: parse (zod) → call ONE daemon method → serialize. No branching on domain state.
 * Literally satisfiable because of the `WorkerRegistry` façade above; the single exception is
 * `POST /v1/workers`, which serializes `snapshot()` on the handle `create()` just returned — a
 * pure accessor, not a decision (review R11).
 */
export function createHttpApp(daemon: Daemon): Hono;
```

### 5.5 `@omni-acp/client`

```ts
export interface ConnectOptions {
  readonly url: string;
  readonly token: string;
  readonly clientId?: ClientId; // → Omni-Client-Id; default: random per process
  /** Injectable. Tests pass `daemon.fetch` and touch no socket at all. */
  readonly fetch?: typeof globalThis.fetch;
  readonly requestTimeoutMs?: number; // default 30_000; SSE excluded
}

export interface LocalOptions {
  /**
   * M0 default: "never" — a bare `OmniACP.local()` always starts a fresh embedded daemon.
   * DESIGN D14's example writes "prefer"; `daemon.json` discovery/reuse arrives with the other
   * adopt modes in M3, and until then "prefer" | "require" throw `bad_request` naming M3
   * (review R13, §2.3).
   */
  readonly adopt?: "prefer" | "never" | "require";
  /** M0: true throws until M3. */
  readonly detach?: boolean;
  readonly dataDir?: string;
  readonly config?: Partial<DaemonConfig>;
}

export declare const OmniACP: {
  connect(opts: ConnectOptions): Promise<Server>;
  /**
   * D14. Dynamic-imports @omni-acp/daemon, starts it on 127.0.0.1:0 with a generated admin
   * token, then connects over ordinary loopback HTTP — one client code path, no in-memory
   * transport. If the optional peer is absent, throws a message naming
   * `npm i @omni-acp/daemon`, not a module-not-found stack.
   */
  local(opts?: LocalOptions): Promise<Server>;
};

export interface CreateAgentOptions {
  readonly cwd: string;
  readonly label?: string;
  readonly timeoutMs?: number;
  readonly mcp?: readonly []; // M0: only the empty tuple type-checks
  readonly onUnresolved?: "deny";
}

export interface Server {
  readonly url: string;
  readonly daemonId: DaemonId;
  readonly me: WhoAmIResponse; // from connect()'s single /whoami
  info(): Promise<DaemonInfo>;
  agents(): Promise<readonly AgentCatalogEntry[]>;
  createAgent(agentId: string, opts: CreateAgentOptions): Promise<Worker>;
  /** Snapshots, not live handles — a listing must not open N SSE streams. */
  workers(): Promise<readonly WorkerSnapshot[]>;
  attach(workerId: string): Promise<Worker>;
  /** Closes local streams. For local(), also stops the embedded daemon. Remote workers survive. */
  close(): Promise<void>;
}

export type PromptInput = string | ContentBlock | readonly ContentBlock[];
export interface PromptOptions {
  /** DESIGN §9.1: one turn at a time per worker. Default true (SDK-side serialization). */
  readonly queue?: boolean;
  readonly signal?: AbortSignal;
}

export type StreamEvent =
  | { readonly type: "text"; readonly delta: string }
  | { readonly type: "thought"; readonly delta: string }
  | { readonly type: "tool_call"; readonly toolCall: ToolCallView }
  | { readonly type: "state"; readonly state: "running" | "idle"; readonly stopReason?: StopReason }
  | { readonly type: "raw"; readonly envelope: EventEnvelope }
  | { readonly type: "done"; readonly result: TurnResult };

export interface WorkerEventMap {
  state: (s: WorkerState, e: EventEnvelope) => void;
  event: (e: EventEnvelope) => void;
  error: (e: OmniError) => void;
  closed: (s: WorkerSnapshot) => void;
}

export interface Worker {
  readonly id: WorkerId;
  readonly ref: WorkerRef;
  readonly daemonId: DaemonId;
  readonly sessionId: SessionId | null;
  readonly agentId: string;
  readonly state: WorkerState;
  readonly snapshot: WorkerSnapshot;
  /**
   * POST /prompt → subscribe with `since = accepted.seq - 1` → collect until this turnId's
   * state_update{idle} OR any worker_state{closed} → reduceTurn() locally.
   * Uses the SAME pure reducer the daemon uses for GET /turns/{id}, so no extra round trip
   * and no possible disagreement (DESIGN §5.5).
   */
  prompt(input: PromptInput, opts?: PromptOptions): Promise<TurnResult>;
  stream(input: PromptInput, opts?: PromptOptions): AsyncIterable<StreamEvent>;
  /** Raw envelope tail; auto-reconnects with the last seen seq. */
  events(opts?: { since?: Seq; signal?: AbortSignal }): AsyncIterable<EventEnvelope>;
  turn(turnId: string): Promise<TurnStatus>;
  cancel(): Promise<void>;
  close(): Promise<CloseResult>;
  on<K extends keyof WorkerEventMap>(event: K, cb: WorkerEventMap[K]): () => void;
  readonly closed: Promise<WorkerSnapshot>;
}

export { OmniError } from "@omni-acp/protocol";
export type {
  TurnResult,
  TurnStatus,
  EventEnvelope,
  WorkerSnapshot,
  WorkerState,
  OmniErrorBody,
  WhoAmIResponse,
  DaemonInfo,
  AgentCatalogEntry,
} from "@omni-acp/protocol";
```

### 5.6 `@omni-acp/cli`

```ts
// src/bin.ts — 3 lines; everything testable lives elsewhere
#!/usr/bin/env node
import { main } from "./main.js";
process.exitCode = await main(process.argv.slice(2), process.env);

// src/args.ts — pure
export type ParsedArgs =
  | { cmd: "start"; configPath?: string; host?: string; port?: number; dataDir?: string; printToken?: boolean }
  | { cmd: "version" } | { cmd: "help" } | { cmd: "error"; message: string };
export function parseArgs(argv: readonly string[]): ParsedArgs;

// src/yaml-config.ts — pure. D15 constraint 3: YAML exists ONLY in this package.
export function yamlToDaemonConfig(text: string, overrides: Partial<DaemonConfig>): DaemonConfig;

// src/main.ts — the whole shell: argv/YAML → DaemonConfig → createDaemon → start → await signal
export function main(argv: readonly string[], env: NodeJS.ProcessEnv, io?: {
  stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream;
}): Promise<number>;
```

### 5.7 M1 additions to `testkit` / `core` / `daemon` / `client` / `cli`

Every name below becomes a scaffold stub in the Land step (`docs/M1-PLAN.md` §1) and is then owned by
exactly one work package.

**`@omni-acp/testkit`** (still private, still frozen after the Land step):

```ts
/** The corpus loader. Drops `dir:"meta"` lines; the repo root is resolved from the package, never
 *  from `process.cwd()`, so the golden suite runs identically from any directory. */
export interface TranscriptLine { dir: "client->agent" | "agent->client" | "stderr" | "meta"; tMs: number; msg?: unknown; raw?: string }
export function loadTranscript(name: string): readonly TranscriptLine[];
export function transcriptNames(): readonly string[];
/** Every `agent->client` `session/update` param, in wire order. 216 across the 11 files. */
export function transcriptUpdates(name: string): readonly Record<string, unknown>[];

/** A tier-2 fixture agent that REPLAYS a recorded transcript over a REAL pipe, so the corpus also
 *  exercises the Supervisor, the frame limiter and the AcpLink — not only the mapper. */
export function wireAgentPath(): string;

/** A fully-defaulted descriptor for tests that need one and do not care which. */
export function fakeRuntime(overrides?: Partial<RuntimeDescriptor>): RuntimeDescriptor;

/** M1's persistence harness: a real sqlite file under `mkdtemp`, reopenable, self-cleaning. */
export function tmpPersistence(): Promise<{
  handle: PersistenceHandle; dir: string;
  reopen(): Promise<PersistenceHandle>;   // same file, new handle — the restart test
  dispose(): Promise<void>;
}>;

/** M0's suite, UNCHANGED, plus the durable half. Both drivers must pass what applies (§14.11). */
export function runEventLogConformance(name: string, make: () => EventLog): void;
export function runEventLogPersistenceConformance(name: string, make: typeof tmpPersistence): void;
/** Run against the `Lease` object AND against the HTTP surface, so the two cannot drift (§16.4). */
export function runLeaseConformance(name: string, make: () => Lease, clock: FakeClock): void;

export function fixtureAgentPath(
  name: "echo" | "crash" | "slow" | "chatty" | "orphan" | "noisy"
      /** M1's four, covering the corpus gaps the README enumerates (§18.3). */
      | "plan" | "thought" | "mode" | "hybrid",
): string;
```

| new fixture   | behaviour                                                                                  | covers the gap                                    |
| ------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| `plan.mjs`    | emits v1 `plan` **and** v1-shaped `plan_update`, then `end_turn`                            | no `plan` in the corpus, in two attempts           |
| `thought.mjs` | `agent_thought_chunk` **with** and **without** `messageId`                                  | never emitted at default effort; the only exercise of `messageId` synthesis |
| `mode.mjs`    | `session/new` returns `modes`, then emits `current_mode_update`                             | `session/set_mode` produced the v2 shape instead   |
| `hybrid.mjs`  | `protocolVersion: 1` + `usage_update` + `config_option_update` + `configOptions` on `session/new`, and a tool call that **fails on its own merits** | idempotency on already-v2 fields (F24), and the "tool failed, not denied" case the corpus lacks |

**`@omni-acp/core`** — new factories on the frozen barrel:

```ts
// event-log/  — WP-A
export function createEventLogCore(o: EventLogCoreOptions): EventLog;      // ring + subs + seq, shared
export function createMemoryEventLog(o: MemoryEventLogOptions): EventLog;  // now a thin wrapper
export function createPersistedEventLog(o: PersistedEventLogOptions): EventLog;
export function planRetention(o: RetentionInput): RetentionPlan;           // PURE, table-tested
export function runRetention(h: PersistenceHandle, p: RetentionPlan): RetentionReport;
// persist/     — WP-A
export function openPersistence(o: {
  dataDir: string; file?: string; config: ResolvedEventLogConfig; clock: Clock; logger: Logger;
}): Promise<PersistenceHandle>;                                            // lock → open → migrate
export function acquireDataDirLock(dir: string, self: { pid: number; bootId: string }):
  Promise<{ release(): Promise<void>; brokeStaleLock: boolean }>;          // §14.10

// normalizer/  — WP-B.  M1's four new options are OPTIONAL as landed (`drainGraceMs`,
// `cancelGraceMs`, `descriptor` defaulting to DEFAULT_V1_PROFILE, `ids`): typing them required at
// the Land step would have broken every M0 call site while the bodies were still stubs, and a
// caller written against this block compiles either way. M1-WP-B tightens the defaults away.
export function createNormalizer(o: {
  quietMs: number; hardMs: number; drainGraceMs?: number; cancelGraceMs?: number;
  descriptor?: RuntimeDescriptor;
  /** For `messageId` synthesis and plan ids. Deterministic per worker; injected so the map stays pure. */
  ids: { synth(prefix: string): string };
}): Normalizer;

// worker/      — WP-C
/** SEAM 2's third verb (M1-PLAN §1.2), Land-written and frozen. `worker.ts` EXPORTS its `Worker`
 *  class and its constructor takes `restore?: { row: WorkerRow }`, so §14.8's "the same `Worker`
 *  class constructed in a non-`starting` initial state" is constructible from another file. For a
 *  `closed` row it pre-resolves the close with `row.closeResult`, which is what makes §15.6's
 *  byte-for-byte `DELETE` replay automatic rather than a second implementation. NOT on the barrel. */
export class Worker implements WorkerHandle { constructor(deps: CreateWorkerDeps, restore?: { row: WorkerRow }); }
export function createSessionStrategy(o: { descriptor: RuntimeDescriptor; clock: Clock; logger: Logger }): SessionStrategy;
/** PURE, rule-numbered, no I/O. The table test in §15.4 is written against exactly this. */
export function classifyResume(a: ResumeAttempt): ResumeReport;
export function createHibernateTimer(o: { clock: Clock; idleMs: number; onFire: () => void }): HibernateTimer;
/** A `WorkerHandle` with no process, over a persisted row + its log. The SAME `Worker` class,
 *  constructed in a non-`starting` initial state — a second class would give `close()`/`wake()`/
 *  `snapshot()` two implementations each, and the second one is where the "DELETE after a restart
 *  returns a different body" bug lives (§14.8). */
export function createRehydratedWorker(row: WorkerRow, log: EventLog, deps: RehydrateDeps): WorkerHandle;
// process/     — WP-C
export function fingerprintOf(pid: number, platform: NodeJS.Platform, run: RunUtility): Promise<string | null>;

// lease/       — WP-D
export function createLease(o: LeaseOptions): Lease;
/** KEPT: fixtures + in-process callers. `workerId` is optional and only sharpens the snapshot —
 *  without it `LeaseSnapshot.workerId` is the `w_unknown` sentinel rather than a fabricated id. */
export function alwaysGrantedLease(holder: ClientRef, workerId?: WorkerId): Lease;

// runtime/     — WP-E
export const BUILTIN_RUNTIMES: readonly BuiltinRuntime[];       // exactly one entry today: claude-acp
export const DEFAULT_V1_PROFILE: RuntimeDescriptor;             // generic v1, zero quirks
export function resolveDescriptor(builtin: RuntimeDescriptor | null, overlay: RuntimeOverlay, probe: ProbeSummary | null): RuntimeDescriptor;
export function descriptorFingerprint(d: AgentDescriptor, agentInfo?: { name?: string; version?: string }): string;
export function classifyProbe(e: unknown): MethodVerdict;
export function probeAgent(o: ProbeOptions): Promise<ProbeSummary>;
```

**The two seams the Land step wrote, and their types.** Neither is a new interface — that is the
point (ruling M1-R19). `worker.ts` and `registry.ts` are edited ONCE, by the Land step, and then
frozen, so every field a work package will need has to exist now (review R13, R14):

```ts
// core/src/worker/worker.ts — Land-written, then FROZEN for the whole of M1.
export interface CreateWorkerDeps {
  … // §5.3's M0 members, unchanged and still required
  /** The catalog's SpawnSpec producer; absent ⇒ the derivation in `worker.ts` (M0 note). */
  readonly toSpawnSpec?: (d: AgentDescriptor, o: { cwd: string }) => SpawnSpec;
  /** SEAM 2. Absent ⇒ M0's inline `runHandshake`, so the M0 suite runs untouched (note S3). */
  readonly session?: SessionStrategy;
  /** The RESOLVED quirk table handed to `open` / `reopen`; absent ⇒ `DEFAULT_V1_PROFILE`. */
  readonly runtime?: RuntimeDescriptor;
  /** `"<agentId>@<fingerprint12>"` for `WorkerSnapshot.runtimeId`; absent ⇒ `@unresolved`. */
  readonly runtimeId?: string;
  readonly limits: {
    handshakeTimeoutMs: number; cancelGraceMs: number; exitGraceMs: number; gracefulMs: number;
    /** §15.3's wake budget; absent ⇒ `handshakeTimeoutMs`. */
    wakeTimeoutMs?: number;
    /** §15.5's cap on consecutive TRANSIENT wake failures; absent ⇒ 3, the config default. */
    maxWakeFailures?: number;
    /** SEAM 1's backstop on §13.2's ladder — the answer to "the reducer never said `settled`",
     *  never a rung deadline, so it must EXCEED `hardMs + drainGraceMs + cancelGraceMs`. */
    closeOutMs?: number;
  };
}

// daemon/src/registry.ts — Land-written, then transferred to WP-E.
export interface WorkerRegistryOptions {
  … // M0's members, unchanged
  /** SEAM 3. Absent ⇒ `alwaysGrantedLease(owner, workerId)`, i.e. M0 exactly. */
  readonly leaseFactory?: (owner: ClientRef, workerId: WorkerId) => Lease;
}
```

`Worker` also owns SEAM 1's **input** side, Land-written: `close_requested` from `#doClose` (after
`session/close`, before the kill, skipped on a forced close), from `#doHibernate` and from `cancel()`'s
escalation timer; `drained` from the process's own `stdoutEnded`; `stderr_line` from `StderrTail.onLine`.
Without producers §13.2's ladder is a reducer arm that unit-tests and never runs.

`Worker.hibernate()` / `Worker.wake()` are Land-written **state transitions** that delegate every
session decision to `SessionStrategy` (§15.2, §15.3); `registry.delete()` and the `lease()` façade
row are Land-written **enforcement points** that call the injected lease — `delete()` under an
`auth.role !== "admin"` guard, which is §16.1 rule L3's "the lease **or** admin" half. What each work package
then implements is its own file: WP‑C the strategy, the timer and `classifyResume`; WP‑D
`createLease`; WP‑E the store, the rehydration and the daemon wiring.

**`@omni-acp/daemon`** — new modules behind the frozen barrel (all WP‑E except the lease route):

```ts
export function createProbeService(o: {…}): { probe(...): Promise<ProbeResponse>; descriptor(id: string): RuntimeDescriptor; warmup(): Promise<void> };
export interface ProbeCache { read(agentId: string): Promise<ProbeSummary | null>; write(agentId: string, p: ProbeSummary): Promise<void>; }
/** Runs ONCE inside `createDaemon()` before `start()` returns. Records every orphan; reaps only a
 *  matching fingerprint; converges every abandoned row on `hibernated` or `closed` (§15.7). */
export function recoverFromPreviousBoot(o: {…}): Promise<{ found: number; reaped: number; skipped: number }>;
export function registerLeaseRoutes(app: Hono, daemon: Daemon): void;    // WP-D
export function registerAgentRoutes(app: Hono, daemon: Daemon): void;    // probe + catalog
```

**`@omni-acp/client`**:

```ts
export interface Worker {
  … // M0's members unchanged
  /** Default filters `replay: true` envelopes — a replayed history is not this turn's stream. */
  stream(input: PromptInput, opts?: PromptOptions & { includeReplay?: boolean }): AsyncIterable<StreamEvent>;
  hibernate(): Promise<WorkerSnapshot>;
  wake(): Promise<WorkerSnapshot>;
  readonly lease: {
    readonly snapshot: LeaseSnapshot;
    acquire(o?: { ttlMs?: number }): Promise<LeaseSnapshot>;
    release(): Promise<LeaseSnapshot>;
    steal(reason: string): Promise<LeaseSnapshot>;
  };
  /** The last wake's classification, or null. */
  readonly resume: ResumeReport | null;
}
export interface Server { … ; probe(agentId: string, o?: ProbeRequestBody): Promise<ProbeResponse>; }
```

`transport.ts` mints a **ULID `Omni-Client-Id` per `connect()`** (so two SDK clients of one token are
genuinely two controllers, §16.1 rule L4), sends `Omni-Lease-Epoch` when it knows one, and parses
`body.lease` / `body.resume` off `423` / `422` into the thrown `OmniError`.

**`@omni-acp/cli`**: `omni-acp probe <agent> [--deep] [--force]`, `omni-acp agents`,
`omni-acp workers [--include-closed]`. `omni-acp start` writes `eventLog.driver: "sqlite"` into the config
it builds (ruling M1-R17) unless the YAML says otherwise.
---

## 6. Supervisor — cross-platform design

### 6.1 The one rule

`packages/core/src/process/spawn.ts` is the **only** file in the repository allowed to import
`node:child_process`. A vitest test walks `packages/*/src/**/*.ts` and fails on any other import, and
separately on any `spawn(` / `exec(` / `execFile(` / `fork(` call site outside it. The test must be
demonstrated failing on a deliberately planted violation during review.

It matches **imports and call sites**, not raw substrings: `SupervisorOptions.spawnFn?: typeof
import("node:child_process").spawn` (§5.3) is a type position that emits nothing and is exempt, and
the module name also appears in doc comments in `agent-process.ts` and `contracts.ts` (amendment
A8). The same is true of `client-has-no-daemon-import`: `@omni-acp/daemon` appears in prose in
`client/src/{local,index}.ts`, and only a static **import** is a violation.

The file has exactly two exports that reach the OS: `spawnAgentProcess()` for long-lived agents,
and `runUtility()` for the one-shot `taskkill` / `tasklist` commands `platform-windows.ts` needs
(§5.3, review R8). `platform-windows.ts` receives `runUtility` by injection through
`createPlatformOps(platform, { runUtility })`, because importing `spawn.ts` — which consumes
`PlatformOps` — would be a cycle. The guard's allowlist is this one file.

This is multica's `TestOnlyLaunchGoSpawnsRuntimeProcesses`, ported. It exists because per-backend opt-in
left 19 of 27 spawn sites without a process group (GH #7522, F10). Adding the test on day one is cheaper
than the incident.

The platform is decided **once, at `createSupervisor()` construction** (`createPlatformOps()`), not at kill
time. No call site anywhere branches on `process.platform`.

### 6.2 Spawn sequence

```
Catalog.toSpawnSpec()  →  Supervisor.spawn(spec)
  1. platform.resolveLaunch(command, args, allowShimLaunch)     // PATH/PATHEXT, .cmd refusal (§6.3)
  2. child_process.spawn(file, args, {
        cwd, env,                                                // COMPLETE env; caller composed it
        stdio: ["pipe", "pipe", "pipe"],                         // NEVER "inherit" — stderr must be sniffable
        shell: false,                                            // NEVER true — injection + an extra layer that breaks kill
        ...platform.spawnOptions({ windowsHide }),               // { detached, windowsHide }
        windowsVerbatimArguments,                                // only for an explicit cmd-shim launch
      })
  3. attach "error" (spawn failure) and "exit" listeners BEFORE returning
  4. wrap stdout in a frame-limiting TransformStream, then
     acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout))   // F6: (write, read)
  5. attach StderrTail (ring + line splitter)
```

### 6.3 Windows `.cmd` / `.bat` — the npx trap

Since the CVE‑2024‑27980 fix (Node ≥18.20.2), `spawn()` throws `EINVAL` for `.cmd`/`.bat` without
`shell:true`. On Windows, `npx` and every npm-distributed agent's bin **is** a `.cmd` shim. Therefore:

- `resolveLaunch` resolves `command` through `PATH` + `PATHEXT`. If the resolution lands on `.cmd`/`.bat`
  and `supervisor.allowShimLaunch` is false, it throws `bad_request` with a message naming the fix:
  **launch the module directly** — `command: process.execPath, args: ["<path-to-agent.js>", …]`.
- With `allowShimLaunch: true` (off by default) it spawns `%ComSpec% /d /s /c "<quoted>"` with
  `windowsVerbatimArguments: true`.
- The direct-module form is the sanctioned one and the one the M0 fixtures use. It also removes an entire
  wrapper process from the tree — exactly the layer that makes Windows tree kill unreliable.

### 6.4 Per-OS mechanism table

| Concern                       | Linux                                                                                                                                                                        | macOS                                          | Windows                                                                                                                                                                                                                                                                                                                          |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| spawn options                 | `detached:true` (⇒ `setsid()`, `pgid === pid`)                                                                                                                               | same                                           | `detached:false`, `windowsHide:true`                                                                                                                                                                                                                                                                                             |
| why not `detached` on Windows | —                                                                                                                                                                            | —                                              | libuv maps it to `DETACHED_PROCESS \| CREATE_NEW_PROCESS_GROUP`. `DETACHED_PROCESS` means **no console**, so every console-subsystem grandchild allocates its **own visible** window (multica #1521), and it defeats `windowsHide`. `CREATE_NEW_PROCESS_GROUP` buys nothing because Node cannot send `GenerateConsoleCtrlEvent`. |
| tree identity                 | pgid == pid                                                                                                                                                                  | same                                           | **none addressable from Node**                                                                                                                                                                                                                                                                                                   |
| cooperative stop              | `closeStdin()` → `kill(-pgid, SIGTERM)`                                                                                                                                      | same                                           | `closeStdin()` only — Windows has no signal we can send                                                                                                                                                                                                                                                                          |
| force kill                    | `kill(-pgid, SIGKILL)`                                                                                                                                                       | same                                           | `taskkill /PID <pid> /T /F`, run through `spawn.ts`'s injected `runUtility` (§6.1)                                                                                                                                                                                                                                                                 |
| "tree is gone" proof          | `kill(-pgid, 0) === ESRCH`, polled 10 ms up to `killConfirmMs`                                                                                                               | same                                           | **unprovable** → `treeGone: false`, always, in M0                                                                                                                                                                                                                                                                                |
| "leader is gone" proof        | `kill(pid, 0)`                                                                                                                                                               | same                                           | `tasklist /FI "PID eq <pid>" /NH`                                                                                                                                                                                                                                                                                                |
| grandchild reached?           | yes, proven                                                                                                                                                                  | yes, proven                                    | best effort — `/T` walks the **live** PPID chain; a grandchild whose parent already exited is missed (Windows does not reparent), and PID reuse can hit an unrelated process                                                                                                                                                     |
| cancel a turn                 | ACP `session/cancel` notification first; kill only on close/timeout                                                                                                          | same                                           | same                                                                                                                                                                                                                                                                                                                             |
| zombie reaping                | libuv `SIGCHLD`                                                                                                                                                              | same                                           | n/a                                                                                                                                                                                                                                                                                                                              |
| daemon killed with SIGKILL    | children survive (`detached` ⇒ own session). Best-effort `exit`/`SIGINT`/`SIGTERM` handlers; a startup reaper is M1                                                          | same                                           | children survive too (no Job Object)                                                                                                                                                                                                                                                                                             |
| console noise                 | n/a                                                                                                                                                                          | n/a                                            | `windowsHide:true` ⇒ `CREATE_NO_WINDOW`. multica documents this flag as the popup-storm cause and prefers `CREATE_NEW_CONSOLE + SW_HIDE`, which **Node cannot express** (F9). Hence the `supervisor.windowsHide` knob and a Windows CI canary.                                                                                   |
| resource limits               | cgroup v2 — M2                                                                                                                                                               | wall-clock + rlimit only, documented as weaker | Job Object — M2, needs native code                                                                                                                                                                                                                                                                                               |
| stderr                        | 32 KiB tail ring, truncation advanced to a UTF‑8 rune boundary, incomplete trailing rune hidden, `finalize()` flushes the last unterminated line (multica `acp_terminal.go`) | same                                           | same                                                                                                                                                                                                                                                                                                                             |

### 6.5 The escalation ladder — one ladder, both platforms, different rungs

`terminate()` is idempotent and concurrency-safe: a second caller awaits the first and receives the same
`KillOutcome`.

```
terminate({ gracefulMs, force }):
  0. already exited            → { escalatedTo:"already_exited", treeGone: await isTreeGone() }
  1. closeStdin()                                   # ACP agents exit on stdin EOF
     await race(exited, gracefulMs / 2)
  2. POSIX:   signalTree("SIGTERM")                 # kill(-pgid, SIGTERM)
     Windows: (no rung — nothing cooperative to send)
     await race(exited, gracefulMs / 2)
  3. POSIX:   signalTree("SIGKILL")
     Windows: taskkill /PID <pid> /T /F
  4. confirm: poll isLeaderGone() and isTreeGone() every 10 ms, up to killConfirmMs
  5. return { exit, leaderExited, treeGone, escalatedTo, durationMs }
```

Step 1 is first because killing at the response boundary truncates the agent's last output (L5, DESIGN §6.2),
and because a surviving grandchild holding the inherited stdout pipe means "the leader exited" is not
"the work is done".

**Do not copy multica's turn teardown verbatim.** multica closes stdin at _turn_ end because its processes
are one-shot; omni-acp Workers are long-lived across turns. `closeStdin()` appears **only** in
`terminate()`, never at turn end — a test asserts a second `prompt()` succeeds after a `cancel()`.

### 6.6 The honesty contract

Because `treeGone` is `false` on Windows in M0, that fact must surface in three places, never be swallowed:

1. `GET /v1/info` → `ownership.confirmsTreeGone: false`, `ownership.caveat` (a sentence an operator can read
   _before_ anything goes wrong),
2. the `omni.worker_state{state:"closed"}` payload,
3. the `DELETE /v1/workers/{wid}` response body.

**M1 extends this to a fourth place and a fifth fact** (§15.7): `GET /v1/info.orphansAtStart` reports what a
previous boot left behind, and `ProcessInfo.fingerprint` is `null` on Windows — so a restarted daemon there
**records** an orphan and never signals it, because a reaper that cannot prove what it killed is exactly what
this contract forbids.

`KillOutcome.treeGone` is **never** optimistic: it means "the whole tree is provably gone", nothing weaker.
The weaker fact lives in `leaderExited`. This is multica's `logger.Warn("could not take ownership…")`
promoted to an API field.

### 6.7 Crash detection — four signals and their ordering

The transport EOF can precede `exit` by milliseconds, or follow it by forever (a grandchild holding the pipe).
Both are handled:

| Signal                                                                                     | Meaning                        | Action                                                                                                                 |
| ------------------------------------------------------------------------------------------ | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `error` before any I/O                                                                     | `ENOENT` / `EACCES` / `EINVAL` | `spawn_failed` → `agent_error` (502)                                                                                   |
| in-flight RPC rejects with a plain `Error("ACP connection closed")` (**no JSON-RPC code**) | transport died                 | do **not** classify from this error; wait for the next two                                                             |
| `stdoutEnded`                                                                              | pipe EOF                       | start the `exitGraceMs` timer for `exit`; if it does not fire, `terminate({force:true})` and classify from the outcome |
| `exit(code, signal)`                                                                       | authoritative                  | `code === 0 && requested` → `agent_exited`; otherwise `agent_crashed` with `{code, signal}` and the stderr tail        |

The classifier lives in `Worker`, not in `AcpLink`, because it needs the worker's state to know whether a
mid-turn death is a crash or a requested close.

---

## 7. Normalizer — the M0 slice

> **§7.1 and §7.5 are SUPERSEDED BY §12** (the full v1→v2 map) and **§7.4 by §12.6** (the responder now
> receives the v2-mapped request). **§7.2 (the quiet window), §7.3 (the crash rule) and §7.6 (`seq` is
> assigned nowhere but `append`) are unchanged and still binding** — §13's forced ladder is added beside the
> quiet window, not in place of it. The M0 text below is kept because it is still the reason the code looks
> the way it does.

### 7.1 What is synthesized — the complete list

```jsonc
// 1. appended IMMEDIATELY BEFORE the session/prompt request bytes reach stdin
{ kind: "acp.session_update", payloadVersion: 2, turnId,
  payload: { sessionUpdate: "state_update", state: "running" } }

// 2. after the prompt response AND the quiet window (§7.2)
{ kind: "acp.session_update", payloadVersion: 2, turnId,
  payload: { sessionUpdate: "state_update", state: "idle", stopReason } }
```

That is the entire v1→v2 synthesis in M0. The payload shapes are taken verbatim from
`@agentclientprotocol/sdk/experimental/v2`'s `RunningStateUpdate` / `IdleStateUpdate`, so M1 does not
reshape them.

Ordering matters and is asserted: `state_update{running}` must have a **lower seq than any update the agent
produces for that turn**. Because `EventLog.append` is synchronous and the RPC write is not, appending
before calling `link.request` is sufficient — and it is what makes `PromptAccepted.seq - 1` a sound
subscription cursor.

### 7.2 The quiet window (L5)

v1's turn boundary is fuzzy: `session/update` notifications keep arriving after `session/prompt` returns.
Emitting `idle` at the response boundary truncates the answer.

```
on prompt_result(turnId, stopReason) at T:
    deadline   = T + quietMs                       # default 250
    hardCutoff = T + hardMs                        # default 5_000
on agent_update at U while settling:
    forward it, then deadline = min(U + quietMs, hardCutoff)
on tick at K >= deadline:
    emit state_update{idle, stopReason}; state := idle
```

The `chatty.mjs` fixture emits one chunk 400 ms after `{stopReason:"end_turn"}`; the test asserts
`seq(chunk) < seq(idle)`. With the quiet window removed, that assertion fails.

`quietMs` is the only latency the daemon adds to every turn, so it is config, not a constant.

### 7.3 What is **not** synthesized — the crash rule

**A dead agent never produces a fabricated `idle`.** On `process_gone` the Normalizer emits only
`omni.error{agent_error, stderrTail}`; the Worker then appends `omni.worker_state{state:"closed", reason,
exit, leaderExited, treeGone}`. `TurnResult.stopReason` stays `null` and `TurnResult.error` is set.

The rule every consumer implements — daemon `turnStatus`, client `prompt()`, client `stream()`:

> **A turn is terminal on `state_update{idle}` for that turnId, OR on any
> `omni.worker_state{state:"closed"}`.**

Consequence: `prompt()` can never hang on a dead agent, and no lie enters the canonical log. Fabricating
`{state:"idle", stopReason:"cancelled"}` would put a falsehood into `TurnResult.stopReason` and flow it into
every downstream consumer including future Run results and webhooks.

`prompt_error` (the agent returned a JSON-RPC error but is still alive) is different and **does** end the
turn cleanly: emit `omni.error{agent_error, acp:{…}}` then `state_update{idle, stopReason:null}`, and the
worker returns to `ready`.

### 7.4 Permission handling (required by F1)

`session/request_permission` is answered inline by `createBaselineResponder("deny", clock)`, which implements
D4's hard rules 1/3/4/5/6 with no rule engine. Two envelopes are appended per request:
`acp.interaction{status:"answered", answer:{optionId, by:"baseline"}}` and
`omni.policy_decision{title, decision:"deny", rule:"m0:auto-deny", optionId, offered}`. `title` is
`request.toolCall.title ?? ""`, captured by the responder while it still holds the request — which
is what lets `reduceTurn` build an `InteractionRecord` from this one envelope kind (review R9).

M0 wires only `mode: "deny"`. The `"allow"` branch (rule 2: session-grant id → `allow_once`, never
`allow_always`) is implemented and unit-tested but unreachable from the wire — this keeps the first thing we
ship fail-closed while leaving M2's policy engine nothing to invent.

Against the M0 fixture this produces the `reject` branch, and the turn completes in ~5 s with
`stopReason:"end_turn"` and the text _"I'll skip the configuration update."_ — which is a **stronger**
acceptance assertion than the allow branch, because only an actually-delivered answer produces it.

### 7.5 Everything else is verbatim

Every other `session/update` is forwarded byte-for-byte inside
`acp.session_update` with `payloadVersion: 1`. `_meta` is preserved by forwarding the object, not rebuilding it.

Most v1 variants are already identical in v2 (`agent_message_chunk`, `agent_thought_chunk`,
`tool_call_update`, `plan_update`, `available_commands_update`, `config_option_update`,
`session_info_update`, `usage_update`, `compaction_*`). Exactly three genuinely differ and are **left alone
in M0**: `tool_call` (v2 folds it into `tool_call_update`), `plan` (v2: `plan_update`),
`current_mode_update` (v2: `config_option_update`). `messageId` backfill (F3) is also M1.

This is a deliberate, bounded deviation from DESIGN §3.3's invariant "everything inside a Worker is v2-shaped".
`payloadVersion` is what keeps it honest: an M0 client branches on `payloadVersion === 1` for those three, and
when M1 flips them to `2` the client's already-written v2 branch takes over with **no wire break**. Shipping
M0 with the invariant claimed but not held, and no flag to detect it, is the outcome this field exists to
prevent.

### 7.6 Also in M0's normalization path

- **`clientCapabilities: {}`** on `initialize` (D3). Nothing else.
- **`mcpServers: []`** on `session/new`. Always. Presets are M2 (DESIGN §8).
- **Unknown agent→client requests answer `-32601`**, never silence (DESIGN §6.2). The SDK's client does this
  for unregistered methods; a test asserts the turn still completes afterwards.
- **`Seq` is assigned nowhere but `EventLog.append()`.** `Normalizer.step()` returns `EventInput[]` with no
  `seq`, no `ts`, no `daemonId`, no `workerId` — the type makes stamping one a compile error. The Worker's
  entire coupling is:

```ts
const out = this.norm.step(input);
this.log.appendAll(out.emit); // seq assigned here, synchronously, in array order
this.rescheduleTick(out.scheduleTickAt);
```

Enforced by a source-scanning test alongside the single-spawn-entry one.

---

## 8. Event log and SSE

### 8.1 Storage: in-memory ring, with the seam already cut

> **SUPERSEDED BY §14.** M1 keeps the ring — F11 makes that a contract requirement, not a choice — and puts
> a write-through `node:sqlite` backend behind it. **§8.2, §8.3 and §8.4 are unchanged and still binding.**
> The paragraph below explaining why SQLite was deferred is kept because §14.2 answers it point by point.

`createMemoryEventLog({ maxEvents: 10_000 })` per worker: a ring evicting from the tail, plus bounded
subscriber queues. `EventLog.tail` exposes the oldest retained seq, so a client asking for `since < tail` is
told the truth instead of getting a silent gap.

**Why not `node:sqlite` in M0:** it is experimental on Node 22 and prints `ExperimentalWarning` on every
import — unacceptable noise inside `OmniACP.local()` running in a user's script — and M0 has no restart,
no hibernate and no resume, so persistence buys nothing this milestone.

**Why the retrofit is bounded to one file:** `append()` / `read()` / `head` / `tail` are all **synchronous**
because `node:sqlite`'s `DatabaseSync` is synchronous, and `runEventLogConformance()` ships in M0 as an
exported suite that M1's SQLite driver must pass verbatim. `DaemonConfig.eventLog.driver` already accepts
`"sqlite"` and rejects it at runtime, so the config shape does not change in M1 either.

An **async** `append` is the one change this design cannot absorb: two concurrent turns could interleave and
produce a non-monotonic log, which is exactly the corruption `?since=` cannot recover from.

### 8.2 Seq

```ts
append(input: EventInput): EventEnvelope {
  const seq = ++this.#head;                                  // synchronous, single-threaded
  const e = Object.freeze({ ...input, seq, ts: this.#clock.iso(),
                            daemonId: this.#daemonId, workerId: this.#workerId,
                            sessionId: this.#sessionId });
  this.#ring.push(e);                                        // evict from tail if full
  for (const s of this.#subs) s.deliver(e);                  // sync fan-out; slow sinks buffer
  return e;
}
```

1. `append` is synchronous and is the sole assigner of `seq`.
2. `seq` starts at 1, is gap-free, per worker, never reused. **Seq 1 is always
   `omni.worker_state{state:"starting"}`**, so `?since=0` replays a worker's entire life from birth.
3. Envelopes are **frozen** at append — a downstream mutation would otherwise show up as two clients seeing
   different history.

### 8.3 Turn linkage

Every event appended while a turn is live carries that `turnId`; events outside a turn carry `null`.
`TurnStatus.startSeq/endSeq` bracket the turn, so `GET /turns/{turnId}` is
`turnStatus(turnId, log.read(0))` — a fold over the log, memoisable once the turn is terminal.

### 8.4 SSE — `GET /v1/workers/{wid}/events?since=<seq>`

| Rule                   | Behaviour                                                                                                                                                                                                                                                                  |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cursor semantics       | `?since=N` ⇒ deliver `seq > N` (**exclusive**), then live tail.                                                                                                                                                                                                            |
| Precedence             | explicit `?since=` wins; else `Last-Event-ID`; else `0`.                                                                                                                                                                                                                   |
| Default                | `since` absent ⇒ **full retained replay**. Correct by default, cheap because bounded, and it removes the create-then-subscribe race entirely. Every consumer must therefore be replay-tolerant from event 1 — this is the normal path, not an edge case.                   |
| Frame                  | `id: <seq>\nevent: <kind>\ndata: <the full envelope JSON>\n\n`. `data` alone is enough (one parse, one type). `event:` is the envelope `kind`, so `addEventListener("omni.worker_state", …)` works.                                                                        |
| Preamble               | `retry: 2000` once at stream open.                                                                                                                                                                                                                                         |
| Heartbeat              | `: hb\n\n` every `sseHeartbeatMs` (15 s). A comment frame — no `id`, consumes no seq.                                                                                                                                                                                      |
| Replay + live handover | One synchronous `subscribe()` call. **No event can slip between them.**                                                                                                                                                                                                    |
| `since < log.tail`     | First frame is `event: omni.stream_truncated\ndata: {"tail":N}`, then replay proceeds from `tail`. The stream is **not** closed — truncated history beats none, and the client is told.                                                                                    |
| `since > log.head`     | Accepted; no replay, live only. Cursor skew must not be an error.                                                                                                                                                                                                          |
| Slow consumer          | Per-subscription queue of `subscriberQueueSize` (1 024). On overflow: `event: omni.stream_overflow\ndata: {"lastSeq":N}`, then close. The producer is never blocked and no event is silently dropped; the client reconnects with `?since=N`.                               |
| Worker closed          | The `omni.worker_state{closed}` frame is delivered, then `event: omni.stream_end\ndata: {"reason":"worker_closed","lastSeq":N}`, then close. A close **without** `stream_end` is a network drop; the client reconnects with `?since=<lastSeq>`.                            |
| Control frames         | `omni.stream_truncated` / `omni.stream_overflow` / `omni.stream_end` are **out-of-band**: they carry no `id:`, are not `EventEnvelope`s, and consume no `seq`. This is why they cannot be `omni.error` envelopes — two subscribers would otherwise disagree about the log. |
| Multi-observer         | N concurrent subscribers per worker with different cursors, all seeing identical envelopes over overlapping ranges (D5). This is the first thing omni-acp adds over the SDK's `AcpServer`, which 409s the second reader.                                                   |
| Lease (M1)             | **Never gated.** Observer mode is the point of D5: any number of clients may stream a worker they do not control (§16.1 rule L2).                                                                                                                                          |
| Restart (M1)           | Under `driver:"sqlite"`, the same `?since=N` returns the same envelopes with the same `seq` after a `stop()`/`createDaemon()` cycle. `sse.ts` is **byte-identical to M0** — the seam was cut at `EventLog` (§14.8), and a checksum test asserts it stayed that way.        |
| Auth                   | The same Bearer middleware as every other route. Token in the header only, **never** the query string.                                                                                                                                                                     |
| Abort                  | The request's `AbortSignal` closes the `Subscription`. A leaked subscription per reconnect is the classic SSE memory leak; a test asserts `log.subscriberCount` returns to 0.                                                                                              |

---

## 9. Error model

`{ code, message, acp?: { code, message, data } }`. `acp` is the agent's JSON-RPC error, **passed through
verbatim, never reshaped**. One mapper, one table, no other status logic anywhere in the HTTP layer.

| HTTP | code                     | M0 trigger                                                                                                                                                                                                  |
| ---- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400  | `bad_request`            | zod failure; unknown agent id; malformed/absent JSON body; a prompt content block whose `type` is not `"text"` (review R12) or a type outside the handshake `promptCapabilities`; non-empty `mcp`; `onUnresolved` other than `"deny"`; a malformed worker/turn id. `cwd` containment failure is `403`, not `400` |
| 401  | `unauthorized`           | header missing / malformed / unknown secret                                                                                                                                                                 |
| 403  | `forbidden`              | agent not in the token's allowlist; `realpath(cwd)` outside `cwdRoots`                                                                                                                                      |
| 403  | `policy_exceeds_ceiling` | **reserved** — never returned in M0 (M2)                                                                                                                                                                    |
| 404  | `worker_not_found`       | unknown worker, or one invisible to this token (D13 — never leak existence)                                                                                                                                 |
| 409  | `worker_busy`            | `prompt` while a turn is live                                                                                                                                                                               |
| 410  | `worker_closed`          | any operation on a closed worker                                                                                                                                                                            |
| 422  | `not_resumable`          | **M1, reachable.** Hibernated with no resume spelling; a cleared session pointer; resume ⇒ `rejected_permanent`; `maxWakeFailures` exhausted. Body carries `resume: ResumeReport` (§15.5)                    |
| 423  | `lease_held`             | **M1, reachable.** A non-holder's `prompt`/`cancel`/`hibernate`/`wake`/`DELETE`, or a stale `Omni-Lease-Epoch`. Body carries `lease: LeaseSnapshot` naming the holder (§16.1)                                |
| 429  | `worker_limit`           | per-token or global `maxWorkers` exceeded                                                                                                                                                                   |
| 502  | `agent_error`            | spawn failure, handshake JSON-RPC error, mid-turn crash, oversized frame                                                                                                                                    |
| 504  | `agent_timeout`          | handshake exceeded `timeoutMs`                                                                                                                                                                              |
| 500  | `internal`               | anything unclassified; the message is generic, the detail is logged not returned                                                                                                                            |

No codes are added to DESIGN §5.4's settled table. Two consequences:

- **Unknown agent id → `400 bad_request`**, not a new `agent_not_found`: an agent id is a request parameter,
  which is exactly what DESIGN's 400 row describes.
- **Unknown turn id → `200 { state:"unknown", result:null }`**, not a 404: turn state is _derived from the
  log_, and after eviction "unknown" is the honest answer. `TurnState` carries it (§5.1 `src/turn.ts`).
- **M1 adds no error codes.** DESIGN §5.4's table is still exactly as settled; M1 only makes two reserved
  rows reachable, and it adds two **optional body fields** (`lease`, `resume`) that appear only for their own
  code, so two bodies for the same failure stay deep-equal and there is still exactly one mapper.
- **Client-side unimplemented features** (`local({adopt:"prefer"})`) throw
  `OmniError("bad_request", "… is not implemented until M<n>")` — a caller asking for something this version
  does not do. No `not_implemented` code is introduced.

---

## 10. Test and CI conventions

### 10.1 Three fixture tiers, ~90 / 8 / 2

| Tier  | Fixture                                                          | Process | Framing                | Used by                                             |
| ----- | ---------------------------------------------------------------- | ------- | ---------------------- | --------------------------------------------------- |
| **1** | `memoryStreamPair()` + `scriptedAgent()` (F7)                    | no      | none                   | core/worker, core/normalizer, daemon, http, client  |
| **2** | `fixtures/agents/*.mjs` via `process.execPath` (**never `npx`**) | yes     | real ndJSON over pipes | core/process, worker crash/cancel, tree kill        |
| **3** | the SDK's own `dist/examples/agent.js` (path via F8)             | yes     | real ndJSON            | `tests/integration` only — the acceptance criterion |

`fakeSupervisor()` injected via `createDaemon(config, { supervisor })` is the **only** thing a daemon or HTTP
test needs to avoid real agents.

### 10.2 Architecture guard tests — cheap, cross-platform, encode the settled rules

| Test                          | Rule                                                                                                                                                |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `no-direct-spawn`             | one spawn entry point (§6.1, F10) — matched on imports and call sites, never as a substring scan (a type position and doc comments name the module legally). Must be shown failing on a planted violation. |
| `seq-single-writer`           | `seq` assigned only inside `packages/core/src/event-log/` (§7.6).                                                                                   |
| `http-has-no-logic`           | nothing under `packages/daemon/src/http/**` **imports** `@omni-acp/core` or `node:child_process`, and nothing there branches on domain state — no `WorkerState` literal, no status decision of its own; every route is parse → one daemon call → serialize (D15 constraint 1). **`sse.ts` is exempt for exactly two things** (review R7): the `heartbeatMs` interval, and the stream-terminal predicate that recognises a closed-worker envelope in order to write `omni.stream_end`. Both are transport concerns §8.4 mandates and neither is a policy decision; M1 may move the predicate into `protocol` as `isWorkerClosedEnvelope(e)` and inject a `Clock` into `SseOptions`, at which point the exemption can go. |
| `client-has-no-daemon-import` | no static `@omni-acp/daemon` **import** anywhere in `packages/client/src` (D14) — the name appears legally in doc comments, so this is an import scan, not a substring scan. |
| `sdk-version-pinned`          | every manifest pins `@agentclientprotocol/sdk` to exactly `1.4.0` (D7).                                                                             |
| `dependency-direction`        | the §3.1 DAG holds; `hono`/`yaml` never appear in `client`'s runtime closure.                                                                       |
| ~~`no-message-id`~~ → `message-id-optional` | **M1 replaces it.** F3's guard was scoped to M0. The new guard asserts every `messageId` read is `?? null`-guarded and that `reduceTurn` never *requires* one — v1 types it optional, v2 requires it (§12.4). |
| `no-agent-prose` (M1)         | no source file outside the descriptor dialect module matches an English agent string (`"User refused permission"`, `"Method not found"`, `"Resource not found"`). Classification keys on codes and JSON pointers or it does not exist (§13.4). |
| `descriptor-is-the-only-branch` (M1) | nothing under `packages/core/src/normalizer/**` contains an agent-id string literal — quirks come from the descriptor (§17.1). |
| `seq-single-writer` (extended, M1) | still assigned only inside `packages/core/src/event-log/`, **and** `prune`/`evict` must not renumber. |
| `normalizer-is-pure` (M1)     | `normalizer/map/**` and `turn-lifecycle.ts` import no `node:*`, no `Date`, no `Math.random`. |
| `sse-is-unchanged` (M1)       | `daemon/src/http/sse.ts` is byte-identical to its M0 content — restart-survivable `?since=` must be a driver swap, not an SSE rewrite (§14.8). |
| `exports-are-stable`          | every name in each frozen `index.ts` resolves and is typed. Lives in `tests/integration/src/` and is owned by WP‑6: it is the only place that may import all six barrels (review R15). |

### 10.3 CI matrix

```yaml
strategy: { fail-fast: false, matrix: { os: [ubuntu-latest, macos-latest, windows-latest], node: ['22'] } }
defaults: { run: { shell: bash } }          # one script on all three runners
steps:
  - git config --global core.autocrlf false && git config --global core.longpaths true
  - actions/checkout@v4
  - corepack enable && corepack prepare pnpm@11.25.0 --activate
  - actions/setup-node@v4 { node-version: 22.x, cache: pnpm }
  - pnpm install --frozen-lockfile
  - pnpm -r build
  - pnpm -r test
  - if: failure() → upload `**/vitest-report/**` as an artifact
```

Every `vitest.config.ts` (per package, `tests/integration`, and the root runner) sets
`reporters: ["default", ["junit", { outputFile: "vitest-report/junit.xml" }]]`, so the
failure-artifact step has a file to collect. Before that it silently uploaded nothing on every red
run — worst on windows-latest, which is precisely the failure class the three-OS matrix exists to
catch and the one nobody can reproduce locally (review R2). The root runner's copy is not
redundant: in `projects` mode vitest takes `reporters` from the root config and ignores the
per-project ones.

Platform differences live in `describe.skipIf(process.platform === "win32")` **inside** the suites, where the
reason sits next to the code — never as `if: runner.os == …` branches in the workflow.

Windows hygiene, baked in from the first commit: `.gitattributes` `eol=lf`; `core.longpaths`; every fixture
path via `fileURLToPath`, never string concatenation, never `.pathname`; `listen.port: 0` everywhere;
per-test `mkdtemp` under `os.tmpdir()`; `cwd` assertions compare `realpath`'d paths so
`C:\Users\RUNNER~1` vs `C:\Users\runneradmin` cannot flake. Unit `testTimeout: 5_000`; integration
`60_000` with `retry: 1`; macOS gets a 2× multiplier via `OMNI_TEST_SLOW_FACTOR`.

A separate Linux-only `static` job runs eslint, prettier and `git diff --exit-code pnpm-lock.yaml`.

---

## 11. Decisions where the three proposals disagreed

Grade first, then the rulings. Each proposal's strongest idea is grafted and named.
**§11.1–§11.3 are M0's round and stand unchanged. §11.4–§11.6 are M1's.**

### 11.1 Grading (M0)

| Proposal      | Strongest idea (grafted)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Grade |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| **P1 (api)**  | **The `ROUTES`/op-table discipline and the discovery that v2's `SessionUpdate` has an open arm (F2)** — that single observation is what lets M0 forward v1 payloads through the _canonical_ type instead of inventing a parallel one, and it is why `NormalizedSessionUpdate = V2SessionUpdate` is honest rather than aspirational. Also grafted: `changes` extraction in M0 (F5), the single `src/acp.ts` SDK re-export point, the `?since=` truncation notice, and the `DistributiveOmit` trick that makes stamping a `seq` a compile error. **A**− (docked for the exhaustive `RouteDescriptor`+`satisfies` machinery, which is ceremony a 12-route surface does not repay, and for synthesizing a fake `idle` on crash). |
| **P2 (os)**   | **`PromptAccepted.seq` and "a crash never synthesizes `idle`."** The first removes the subscribe/prompt race with one integer and no pre-existing subscription; the second is the difference between an event log you can trust and one that lies in exactly the case you most need it. Also grafted: the whole Windows analysis (`detached` ⇒ `DETACHED_PROCESS`, the `.cmd`/CVE‑2024‑27980 trap, `treeGone` never optimistic, the three-place honesty contract), the escalation ladder with `closeStdin` first, `stdoutEnded` vs `exited` as two independent signals, and the warning not to copy multica's per-turn stdin close. **A**.                                                                                   |
| **P3 (test)** | **`@omni-acp/testkit` + the shared pure `reduceTurn`.** The testkit is what makes five work packages genuinely file-disjoint (WP‑4 tests against `FakeSupervisor`, WP‑5's HTTP half against `stubDaemon`) and it is why the contracts must live in `protocol` (the DAG argument, §4 — I checked it and it is correct). `reduceTurn` shared by daemon _and_ client satisfies DESIGN §5.5 **by construction** at lower latency than a second round trip. Also grafted: the pure `Normalizer.step()` reducer (timer-free, table-testable), `daemon.fetch(Request)` as the primary seam, `TurnState:"unknown"` (which removes the need for a new error code), and the out-of-band SSE control frames. **A**.                     |

### 11.2 Rulings (M0)

| #   | Question                                                                   | Ruling and why                                                                                                                                                                                                                                                                                                                                                                  |
| --- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Permission responder in M0?                                                | **IN, fixed auto-deny.** Verified (F1): without it the acceptance fixture's `session/prompt` never returns. Fail-closed is the right first posture for a remote-execution daemon; the `"allow"` branch is implemented and unit-tested but unreachable from the wire, so M2 has nothing to invent.                                                                               |
| D2  | New `interactions: "allow_once"` request field (P2)?                       | **No.** It would collide with M2's policy engine. The reject-branch text is a stronger acceptance assertion anyway.                                                                                                                                                                                                                                                             |
| D3  | How to label un-normalized v1 payloads?                                    | **`payloadVersion: 1 \| 2` on the envelope** (P2's field, P1's typing). One field does two jobs: it is the origin signal in M0 and the version signal that makes M1 non-breaking. P3's `origin` is subsumed.                                                                                                                                                                    |
| D4  | Pull the three real renames (`tool_call`→`tool_call_update` etc.) into M0? | **No.** They are most of M1's mapping work and `reduceTurn` handles both spellings. The flag is 12 bytes; the mapping is a milestone.                                                                                                                                                                                                                                           |
| D5  | Event log storage                                                          | **In-memory ring.** Unanimous across proposals. `append` contractually synchronous (because `DatabaseSync` is), plus `runEventLogConformance()` exported in M0 so M1's driver is a one-file swap.                                                                                                                                                                               |
| D6  | Eviction vs close-worker-on-overflow (P3)                                  | **Evict, with a `omni.stream_truncated` control frame.** Closing a live worker because its log grew is a worse failure than a truthful partial replay. P3's objection (no honest HTTP code) is answered out-of-band: the notice is a stream frame, not a status.                                                                                                                |
| D7  | `prompt()` — extra `GET /turns/{id}` (P1/P2) or shared reducer (P3)?       | **Shared pure `reduceTurn` in `protocol`**, plus `PromptAccepted.seq` so the client provably holds the whole turn. §5.5's requirement is "the same aggregate"; one pure function guarantees that more strongly than a round trip, and costs less. An e2e test asserts deep-equality with `GET /turns/{id}`.                                                                     |
| D8  | Crash mid-turn: synthesize `idle`?                                         | **No** (P2). A turn is terminal on `idle` **or** on `worker_state{closed}`; both the daemon and the client implement that rule, so `prompt()` still cannot hang, and `stopReason` stays `null` rather than becoming a lie.                                                                                                                                                      |
| D9  | Windows spawn flags                                                        | **`detached:false, windowsHide:true`** (P2). P1's `detached:true` maps to `DETACHED_PROCESS`, which guarantees a visible console per grandchild and defeats `windowsHide`. Knob retained (`supervisor.windowsHide`) because Node cannot express multica's preferred `CREATE_NEW_CONSOLE + SW_HIDE` (F9).                                                                        |
| D10 | Windows `treeGone`                                                         | **Always `false` in M0** (P2), not "true if the leader poll succeeded" (P3). Conflating "leader gone" with "tree gone" is the exact dishonesty the field exists to prevent; `leaderExited` carries the weaker fact. Job Object deferred to M1/M2 — Node cannot `CREATE_SUSPENDED`, so it needs a native addon or a bundled launcher, which is real work in the wrong milestone. |
| D11 | `.cmd`/`.bat` on Windows                                                   | **Refuse with a `bad_request` naming `process.execPath <module>`**, `allowShimLaunch` off by default (P2's find, P1/P3's flat config shape). Keeps DESIGN §7's YAML shape while capturing the CVE‑2024‑27980 trap that every npx-distributed agent hits.                                                                                                                        |
| D12 | ID typing                                                                  | **Template-literal types** (P2). Real discrimination between `DaemonId`/`WorkerId`/`TurnId` at zero zod friction — P1's brands add ceremony at every parse boundary, P3's plain aliases discriminate nothing. `SessionId` stays an opaque `string`; `Seq` stays unbranded so arithmetic is clean.                                                                               |
| D13 | Where do cross-package interfaces live?                                    | **`@omni-acp/protocol/src/contracts.ts`** (P3). The DAG argument is decisive: `testkit` must produce `Supervisor` values while `core`'s tests consume `testkit`. P1's `core/src/contracts.ts` creates a cycle.                                                                                                                                                                  |
| D14 | A `testkit` package beyond the five named?                                 | **Yes**, private and never published. It is the mechanism that makes the work packages file-disjoint, and P3 verified that a cross-wired `TransformStream` pair drives `acp.agent()` ⇄ `acp.client()` with no process (F7). Flagged explicitly as an addition to the brief's package list.                                                                                      |
| D15 | Normalizer timing                                                          | **Pure `step()` reducer; the Worker owns the timer** (P3). Makes the entire normalizer suite synchronous and table-driven with no fake timers — which is what makes M1's full mapping safe to write.                                                                                                                                                                            |
| D16 | Quiet window default                                                       | **250 ms quiet / 5 000 ms hard.** 250 is the value class multica proved; P3's 150 saves nothing measurable and risks a truncated tail on a slow pipe. Hard cap 5 s rather than 2 s so a legitimately long tail is not cut. Both are config.                                                                                                                                     |
| D17 | Handshake timeout default                                                  | **60 s**, with a per-request `timeoutMs` (1 s–600 s). P3's 120 s default is longer than most proxy idle limits. The daemon sets `server.requestTimeout = 0` because `POST /v1/workers` legitimately holds a request open.                                                                                                                                                       |
| D18 | `cwdRoots` + agent allowlist in M0?                                        | **IN.** An unchecked `cwd` on a daemon that spawns processes is arbitrary code execution on the host; `realpath` + containment is ~10 lines and DESIGN §8 already states it as a property. `maxWorkers` likewise.                                                                                                                                                               |
| D19 | Per-request `env`?                                                         | **OUT** (M2, `strictObject` rejects it). `AgentDescriptor.env` from trusted config is **in** — agents need API keys. This avoids shipping a blacklist we would have to re-litigate.                                                                                                                                                                                             |
| D20 | `POST /cancel` in M0?                                                      | **IN**, though DESIGN §11 does not list it. ~20 lines, and it is the only in-milestone exercise of `session/cancel` plus the `slow.mjs` escalation path that `DELETE` also depends on.                                                                                                                                                                                          |
| D21 | `/v1/health` and `/v1/info`                                                | **Both in.** `health` unauthenticated and returns `{ok:true}` **only** — no `daemonId`, no version (an identifier leak on an unauthenticated route). `info` authenticated, and it is where `ownership` (§6.6) surfaces.                                                                                                                                                         |
| D22 | `GET /v1/agents`                                                           | **IN** — it is `Object.values(catalog)` and both the CLI and the SDK want it. `probed: null` until M1.                                                                                                                                                                                                                                                                          |
| D23 | `OmniACP.local()` — stub or implement?                                     | **Implement `adopt:"never", detach:false`.** ~30 lines, and it is the M0 e2e harness that proves D14 and D15 share one code path from day one. Other modes throw.                                                                                                                                                                                                               |
| D24 | SSE terminal/overflow signalling                                           | **Out-of-band control frames** (`omni.stream_truncated` / `_overflow` / `_end`), no `id:`, not envelopes (P3). P1's "terminal `omni.error` envelope" would have to fabricate a `seq`, which two subscribers would then disagree about.                                                                                                                                          |
| D25 | Test against source (P2's alias) or built `dist` (P3)?                     | **Built `dist`, after `pnpm -r build`.** The acceptance command is literally `pnpm -r build && pnpm -r test`, and testing what we publish catches the wrong-`.js`-specifier and `exports`-map bugs that source aliasing hides — the #1 recurring failure in ESM monorepos. Cost: a broken build yields no test signal, which is a red CI either way.                            |
| D26 | HTTP framework                                                             | **Hono + `@hono/node-server`** (all three; DESIGN §10). `daemon.fetch(Request)` is the primary seam so the whole route suite runs with no port bound, and M4's `AcpServer` mount wants the same `Request`/`Response` model.                                                                                                                                                     |
| D27 | Does `createDaemon` statically import the HTTP module?                     | **Yes, and `daemon.fetch` is always available.** D15 constraint 1 is guaranteed by the `http-has-no-logic` guard plus a `library-only` runtime test that drives the whole lifecycle with `listen:null` and never touches `fetch`. Module-graph purity here would be theatre that costs `fetch`-without-`start()`.                                                               |
| D28 | `exactOptionalPropertyTypes`                                               | **Off** for M0 (P1/P2). The SDK's generated types are pervasively `?: T \| null`. Revisit at M1.                                                                                                                                                                                                                                                                                |
| D29 | New error codes (`agent_not_found`, `turn_not_found`, `not_implemented`)?  | **None.** Unknown agent → 400 (it is a parameter). Unknown turn → `TurnState:"unknown"` at 200 (turn state is derived, and after eviction "unknown" is true). Unimplemented client features throw `bad_request` with a milestone in the message. DESIGN §5.4's table stays exactly as settled.                                                                                  |
| D30 | SDK-side prompt queueing                                                   | **IN, default `queue: true`** — a 5-line per-worker promise chain. DESIGN §9.1 specifies it, so it is not scope creep; `{queue:false}` lets the daemon's `409` surface as `OmniError("worker_busy")`.                                                                                                                                                                           |
| D31 | `server.workers()` returns snapshots or live handles?                      | **Snapshots.** Returning handles would open N SSE streams for a listing. `server.attach(id)` returns the live handle.                                                                                                                                                                                                                                                           |
| D32 | `DELETE` response                                                          | **`200 CloseResult`**, idempotent — not `204`. The body is where `treeGone`/`leaderExited` reach the operator (§6.6).                                                                                                                                                                                                                                                           |

**Amendments — the 2026-09-03 contract + scaffold review.** The rulings above stand. These eight
rows record where the scaffold deviated from this document with a sound reason and the document
was changed to match the code, so that "every signature in §5 becomes a scaffold stub verbatim"
is true again. The review's numbered findings R1–R16 were applied in place, in this file, in
`docs/M0-PLAN.md` and in the stubs; the record is `docs/review/2026-09-03-m0-contract-review.md`.

| #   | Amendment                                                                                                                                                                                                                                                                                                                                                                    |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | `Daemon` / `DaemonDeps` / `AuthContext` / `WorkerRegistry` / `Catalog` / `DaemonEvent` are **declared in `protocol/src/contracts.ts`** and re-exported unchanged from `daemon/src/types.ts`. §5.4 previously declared them in the daemon; §4's rule and testkit's `stubDaemon(): Daemon` (which would otherwise force `testkit → daemon → testkit`) both require the protocol home. The documented import path `./types.js` is unchanged. |
| A2  | `createPlatformOps` is a **`@omni-acp/core` factory (`process/platform.ts`)**, not a `contracts.ts` declaration: that file is types-only (M0-PLAN §1.1). Signature unchanged apart from R8's `deps`.                                                                                                                                                                          |
| A3  | `ResolvedSupervisorConfig` / `ResolvedTurnConfig` / `ResolvedListenConfig` aliases added to `protocol/src/config.ts`; `SupervisorOptions.config` is `ResolvedSupervisorConfig`, not `z.output<typeof SupervisorConfig>`, so `core` takes no zod dependency §3.2 never granted it. Structurally identical.                                                                     |
| A4  | zod 4's `.default()` takes the **output** type, so the literal `.default({})` of §5.1 is rejected for an object schema whose fields all have defaults. `shutdown`, `eventLog`, `supervisor` and `turn` use **`.prefault({})`**, zod 4's exact equivalent of v3's behaviour. `DaemonConfig.parse({tokens:[…]})` yields every documented default.                              |
| A5  | Dependency **versions** were unpinned by this document and are now recorded in §3.2: typescript ^6.0.3 (not 7.x), vitest ^4.1.11, zod ^4.5.4, hono ^4.13.5, @types/node ^22.20.1, yaml ^2.9.0, eslint 10 / typescript-eslint 8 / prettier 3.                                                                                                                                |
| A6  | **`@hono/node-server@^2`**, not `^1`: v2 is the current pairing for hono 4 and what a fresh install resolves; the `serve()` surface WP‑5 needs is unchanged.                                                                                                                                                                                                                 |
| A7  | **No `ulid` package.** §3.2 pins protocol to the SDK + zod, and `createIdGen({now, random})` must be injectable for `seqIds()` and the clock-controlled suites, which `ulid`'s monotonicFactory does not cleanly allow. Hand-rolled in `ids.ts`.                                                                                                                            |
| A8  | The `no-direct-spawn` and `client-has-no-daemon-import` guards are **import/call-site scans, not substring scans**: `SupervisorOptions.spawnFn`'s type position emits nothing, and both module names appear legally in doc comments (§6.1, §10.2).                                                                                                                          |

---

### 11.3 Risks accepted, with their mitigation (M0)

| Risk                                                                                              | Mitigation                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A second `spawn()` reintroduces multica's GH #7522                                                | `no-direct-spawn` guard, demonstrated failing on a planted violation during review                                                                                                            |
| A grandchild holding stdout makes `terminate()` hang forever                                      | `exitGraceMs` + `stdoutEnded`/`exited` as independent signals + `orphan.mjs` regression test                                                                                                  |
| Windows leaves MCP/shell grandchildren after cancel or delete, and the daemon cannot tell you     | Reported honestly in three places (§6.6); Windows CI asserts the _reported_ value matches reality rather than asserting an impossible guarantee                                               |
| A `SIGKILL`ed daemon strands agent trees on POSIX (`detached` ⇒ own session)                      | Best-effort `exit`/`SIGINT`/`SIGTERM` handlers in M0; a pid-ledger startup reaper is M1                                                                                                       |
| `Readable.toWeb` / `Writable.toWeb` are still experimental on Node 22 and propagate errors thinly | Confined to `spawn.ts`; `AcpLink` wires `error`/`close` on the Node streams too, not only the web wrappers; crash and frame-limit tests cover both directions                                 |
| `experimental/v2` may change shape between SDK releases                                           | Pinned to exactly `1.4.0` (test-asserted); M0 uses `experimental/v2` for **types only**, never at runtime; schema JSONs committed under `packages/protocol/schema/` with `PROVENANCE.md` (D7) |
| An agent that never emits a newline is unbounded heap growth                                      | `maxFrameBytes` (32 MiB) `TransformStream` between stdout and `ndJsonStream` → `protocol_error` → kill tree                                                                                   |
| Copying multica's turn teardown would close stdin after every turn and kill long-lived Workers    | `closeStdin()` appears only in `terminate()`; `cancel.itest` asserts a second prompt succeeds after a cancel                                                                                  |

---

### 11.4 M1 grading — the three proposals

Grade first, then the rulings. Each proposal's strongest idea is grafted and named. All three were read
against the shipped code and the corpus, and where a proposal made a checkable claim I checked it.

| Proposal | Strongest idea (grafted) | Grade |
| -------- | ------------------------ | ----- |
| **P1 (normalizer)** | **The three-layer split, and the rule that falls out of it: "the stream is a log of events, not a materialized view."** L1 renames `tool_call` → `tool_call_update` and does *not* merge; merging stays in `reduceTurn`, which F23 shows already implements exactly the right "absent means unchanged" semantics. That single decision is what keeps `?since=` honest — a merging mapper would hand a reconnecting client post-merge snapshots and a *different history* than an observer who never dropped. Also grafted: `mapUpdate` **total + idempotent, switched per field never per version** (F24); the diff rewrite that preserves v1 text under `_meta["omni/v1Diff"]` with a descriptor-driven `fragment` flag (F19 — a consumer that writes a fragment to disk corrupts the file); the **two close-out ladders** that resolve the §6.2 / §6.5 contradiction; `messageId` pass-through with marked deterministic synthesis; `TurnResult.verdict` / `warnings` / `deniedToolCalls` making "end_turn ≠ success" machine-readable **with no new event kind**; the `no-agent-prose` guard; and the observation that replay `messageId`s are byte-identical while the *chunking* differs — which I verified, and which is why a content hash cannot dedup and an id can. **A** (docked for `EventLog.seen` — a dedup index bolted onto the log interface for a policy that should not be the default — and for a `patch` promotion that would give D8 a third source of truth). |
| **P2 (persistence)** | **Two findings that nobody else had, both load-bearing.** First: `runEventLogConformance` asserts **object identity** (`expect(log.read(0)[0]).toBe(e)`), so a deserializing SQLite `read()` fails a suite §8.1 says the M1 driver must pass verbatim — the ring-plus-write-through architecture is therefore a *contract requirement*, not a performance choice (F11, verified at `event-log-conformance.ts:79`). Second: **restoring `head` as `max(seq)` silently restarts a worker's own sequence at 1** once retention has evicted its rows, breaking every live `?since=` cursor and §8.2 rule 2 *inside one worker's log* — the single most dangerous line in M1, and only P2 found it. Also grafted: the rule-numbered pure `classifyResume` with rule 0 (a transport death carries no JSON-RPC code, so never classify from it) and the negative lock on the text matcher; process **fingerprints** with "never signal a pid you cannot prove" and Windows reporting-not-reaping; the gap-free invariant stated once (drop-before-append is legal, store-but-do-not-stream is forbidden); `CloseResult.sessionClosed`; `DELETE` idempotency across a restart from a *persisted* body rather than a recomputed optimistic one; and the data-dir lock. **A**. |
| **P3 (operability)** | **The lease fencing epoch.** Neither other proposal has it, and it is the difference between a lease and an advisory hint: after a steal, the old holder's next call is a `423` rather than a silent hijack of the new holder's turn. Also grafted: the `423`/`422` bodies **carrying `LeaseSnapshot` / `ResumeReport`** (a caller must not need a second round trip against a worker it may no longer control); implicit acquire of an unheld lease; `pinExpiry()` so a lease cannot expire mid-turn; `releaseForHibernate`; **observer mode as an explicit ungated set** (every `GET`, and SSE) — which is D5 read correctly; `classifyProbe` learning the *param name* from `-32602 data.<field>._errors` (F17), which is the cleverest single line in the three documents; the three-source skip taxonomy where **a skip with no source is a failure**; and the independent confirmation that DESIGN §6.2 contradicts CONTRACTS §6.5. **A−** (docked for flipping `eventLog.driver` to sqlite for every embedder including `OmniACP.local()`, and for store-but-do-not-stream, which P2 correctly shows makes two subscribers disagree about the log). |

**A note on where all three converged**, which is itself evidence: the descriptor must express *preference
order over several spellings per capability* rather than one name per capability (F18); error
classification must key on codes and `data` pointers, never on message text (F17); `session/load`'s replay
window is exactly request-to-response (F16); and DESIGN §6.2's close-out chain, read as a per-turn
sequence, would break long-lived Workers. Where three independent readings agree against the letter of the
design doc, the design doc is what gets amended (M1-R4).

### 11.5 M1 rulings

| # | Question | Ruling and why |
| - | -------- | -------------- |
| M1-R1 | SQLite driver: pure store, or write-through behind the ring? | **Write-through behind the existing ring** (P2). Not a preference: F11's object-identity assertion in a suite §8.1 says must pass verbatim makes a deserializing `read()` illegal. Bonus: every fan-out/overflow/re-entrancy subtlety in `memory-log.ts` is untouched. |
| M1-R2 | Restoring `head` after a restart | **`max(durable head_seq, max(seq))`** (P2). `max(seq)` alone resets to 0 after total eviction and restarts one worker's sequence at 1; `head_seq` alone is stale between debounced flushes. Named regression test that fails on a planted `max(seq)`. |
| M1-R3 | `available_commands_update` — 87.8 % of update bytes (F13) | **Stream in full, store by content digest** (P1's mechanism), with **drop-before-append** as the descriptor escape hatch (P2's rule), and **store-but-do-not-stream forbidden** (P2's argument, against P3). Digesting costs nothing (23 payloads → 2), loses no capability, and keeps `read(0)` deep-equal; withholding a stored envelope from the live tail would make `?since=` and the live stream disagree, which is the one corruption `?since=` exists to prevent. |
| M1-R4 | DESIGN §6.2's close-out chain vs CONTRACTS §6.5's "`closeStdin` only in `terminate()`" | **Two ladders** (P1's framing, P3's independent confirmation). `settle` per turn = quiet window only; `close_out` on teardown = quiet → stdin → drain → cancel → terminate. Read per-turn, §6.2 kills turn 2; read as forced termination it is exactly right. §6.5 stands unchanged. |
| M1-R4a | The shipped CLOSE_OUT ladder runs `quiet → cancel → close_stdin → drain → terminate`, transposing rungs 2 and 4 of M1-R4's chain | **The documents are amended, not the code.** `session/cancel` is a REQUEST and it travels on the agent's stdin; rung `close_stdin` means "no more requests are coming", so a cancel spelled after it reaches nobody and its write rejects into a floating promise in `worker.ts`'s `#perform`. The transposition keeps every rung, every grace and every deadline, and keeps corpus finding 14's reason intact because the quiet window is still first. Evidence, as tests rather than argument: `packages/core/test/normalizer/ladder.test.ts` drives the five rungs at the documented deadlines, and `packages/core/test/e2e/close-out-ladder.test.ts` asserts the order FROM THE AGENT'S SIDE — the agent receives `session/cancel` while its stdin is still open. §13.2 and DESIGN §6.2 are rewritten to match. |
| M1-R5 | Replay envelopes: mark, dedup, or drop? | **Mark by default** (`replay: true`, stored + streamed); `drop_duplicates` is opt-in config. Dedup correctness rests on a single agent at a single version (F14, verified but narrow), and a false-positive drop **silently loses real history** — including a session created by another tool, where replay is the *only* source — whereas a marked duplicate is filterable by every consumer. `reduceTurn` skips replay; the SDK filters it; `ResumeReport.replayDropped` makes the choice visible. The envelope field stays the literal `true` M0 reserved; the audit lives on `ResumeReport`. |
| M1-R6 | The `-32002` cwd mismatch: `unknown` (P1/P2) or `rejected_transient` (P3)? | **`unknown`, with `hint: "cwd_mismatch"`.** Both keep the pointer, so the *action* is identical; `unknown` is the honest label for "we could not tell" while `transient` asserts a cause. **And a correction the proposals missed**: F15 — that response appears in **no committed transcript**. It becomes a unit-test regression lock *plus* a compat case that re-observes it live, rather than a quirk asserted from a note. |
| M1-R7 | `rejected_permanent` ⇒ `422`, or P2's `onResumeRejected: "new_session"`? | **`422` only; no `new_session` in M1.** A context-free session that *looks* resumed is undetectable from the outside; D2 says clear the pointer and rebuild *by policy*, and the policy layer is M2. One fewer knob to re-litigate. |
| M1-R8 | Persist the lease across a restart? | **No** (P2's leaning, with P3's audit). A lease over a process that no longer exists is meaningless; but D5 says preemption is audited, so adoption emits `omni.lease{op:"expired", how:"daemon_restart"}` — the transfer is audited rather than silent, which was P2's own objection to its choice. |
| M1-R9 | Orphan processes after an abnormal daemon exit | **Record always; reap only on a matching fingerprint; never on a null fingerprint** (P2), default `reapOrphans:"fingerprint"` — against P3's report-only default. A fingerprint match is *proof*, and leaking agent trees that hold a cwd and an API quota is worse than an audited kill. Windows fingerprints `null`, so Windows reports and does not touch, and `GET /v1/info.orphansAtStart` says so. |
| M1-R10 | `payloadVersion` semantics after M1 | **`2` iff the mapper landed on a known v2 arm; `1` = vendor passthrough** (P1's wording; P3 agreed). This is the flip the field was introduced for, it is additive, and the client's already-written v2 branch takes over. |
| M1-R11 | `TurnResult.patch` from `structuredPatch`? | **`patch` stays `null`** (P2/P3), **and** the verified reconstruction ships as `TurnResult.vendorPatch` (P3's separation, P1's implementation and its `git apply --check` test). D8 guarantees `patch` is accurate or null; a vendor patch we cannot compare against the disk would be a third source of truth. Throwing away a verified extractor would also be waste. |
| M1-R12 | `FileChange` and the lossy diff rewrite | **Preserve v1 text under `_meta["omni/v1Diff"]`; add `operation` and `fragment`** (P1). v2's `Diff` has no `oldText`/`newText` at all, so §6.1's row is lossy unless the text is carried; `fragment` comes from the descriptor because F19 shows the pair is a *widening fragment*, and a consumer that treats it as file content corrupts the file. |
| M1-R13 | Should the mapper merge tool calls, or expose merged state? | **Neither.** P1's layering wins and P3's `Normalizer.toolCallState()` is rejected: it duplicates `reduceTurn`'s fold and reintroduces the materialized-view problem. F23 confirms the projection already merges correctly. |
| M1-R14 | Does the permission responder see v1 or v2? | **The v2-mapped request** (P1). D4's rules are written against v2's tagged `subject`, so mapping first is what lets M2's rule engine match `kind`/`path`/`cmd` with no per-agent branch. Plus P1's structural enforcement of D4 rule 1 — assert `optionId ∈ offered` at the one place that answers — because corpus `09` proves the violation is **invisible in `stopReason`**. |
| M1-R15 | Hibernating an agent that cannot resume | **Refuse and keep the process** (`whenNotResumable:"keep"`, P3), against P2's close-by-default. Hibernating a worker you can never wake is a one-way door that turns a healthy worker into a guaranteed `422` on a timer; memory is the cheaper loss. P2's `"close"` survives as the opt-in and its `idle_timeout` reason stays in the enum. |
| M1-R16 | Probe in M1, or slip it to M2? | **IN**, with P3's battery + cache + `classifyProbe` and P1's result shape. Corpus `08` proves it costs ~0 tokens, and it is the mechanism by which the compat suite computes **honest capability-based skips** — without it, §18.3's `capability` source does not exist and every gap becomes a hand-maintained YAML entry. |
| M1-R17 | `eventLog.driver` default | **`createDaemon()` keeps `"memory"`; `omni-acp start` writes `"sqlite"`.** Against P3's schema-level flip. A long-running daemon must survive a restart; an embedded `OmniACP.local()` in a user's script must not leave a database file or load an experimental module. One default per entry point, no magic in the schema, and `GET /v1/info.persistence.driver` reports which is in force so it is never a guess. |
| M1-R18 | Compat config | **Two files** — `agents.ci.yaml` (hermetic, always runs) and `agents.local.yaml` (real agents, `OMNI_COMPAT_REAL=1`) — with P3's three-source skip taxonomy and mandatory reasons, P2's `expect` block, and `OMNI_COMPAT_REQUIRE=1` so an empty selection fails instead of passing. |
| M1-R19 | How do three work packages avoid fighting over `worker.ts` and `registry.ts`? | **Named seams, and one Land edit each** (P3's shape, simplified). `worker.ts` gains an injected `SessionStrategy` and one `perform(out.action)` line for P1's `TurnOutput.action`; it is edited **once**, by the Land step, then frozen — no `CloseOutStrategy` interface is needed, because the ladder lives in the pure reducer. The lease needs **zero** `worker.ts` edits (F22). `registry.ts` and `create-daemon.ts` transfer to a single owner (the daemon work package) rather than being shared. Details in `docs/M1-PLAN.md` §1.2. |
| M1-R20 | `exactOptionalPropertyTypes` — §1 says "revisit at M1" | **Stays off.** The SDK is still pinned at 1.4.0 with the same pervasively `?: T \| null` generated types, and M1 *adds* optional-field surface (`resume`, `orphan`, `lease`, `crashed`). Revisit at M4 with the v2 SDK. |
| M1-R22 | DESIGN §3.2 gives the `hibernated → starting` trigger as "`prompt` / `attach`"; §15.1 lists `prompt` / `POST …/wake` | **`attach` never wakes.** Attach and SSE are ungated OBSERVER operations (§16.1 rule L2), and forcing a ~7 s npx cold start on a passive observer would contradict D5's "多观察者" and let a reader spend the holder's quota. `POST …/wake` is the explicit lever for an operator who wants the process back. **DESIGN §3.2's `attach` trigger is superseded** (review R10). |
| M1-R23 | `wake` fails the CURRENT ACL: which close reason? | **`acl_revoked`, a new `WorkerCloseReason`** (review R6). Reusing `client_request` would make the audit log say an operator issued a `DELETE` when the config revoked a token's `cwdRoots` between boots. The HTTP answer is unchanged (`403 forbidden`); only the log stops lying. |
| M1-R21 | `requires_action` in M1? | **No** — unanimous. M1's state set is `starting \| ready \| running \| hibernated \| closed`; the policy engine that produces the sixth state is M2, and §15.1 deliberately has no `requires_action → hibernated` row so M2 does not have to rediscover that an unanswered interaction must not be hibernated away. |

### 11.6 M1 risks accepted, with their mitigation

| Risk | Mitigation |
| ---- | ---------- |
| **The acceptance criterion is not falsifiable with one agent.** DESIGN §11 says "the same SDK code behaves identically across the target v1 agents"; four of the five do not exist on this machine and must not be installed. | The suite is **config-driven from day one** and green over ten hermetic fixture agents plus one real one; the four claude-acp corpus gaps are enumerated in the descriptor's `unverified` and **printed as sourced skips in every run**. This is recorded as a *partial* satisfaction of §11's wording, not a claimed one. |
| The ring/disk boundary in `read()` is two sources of truth; an off-by-one duplicates or drops an envelope | The boundary is a single expression; a conformance case reads *across* the floor with the ring sized to 3; plus a randomized append/read/evict fuzz asserting gap-freeness and no duplicates. §14.3 names it as the highest-risk expression in M1. |
| `node:sqlite` is experimental on Node 22 and its API can change | Behind `EventStore`/`WorkerStore`, loaded only when selected, `"memory"` remains the `createDaemon` default — an M1 that ships with SQLite unproven still runs. The warning suppression is surgical and tested in **both** directions. |
| Replay dedup depends on `messageId` stability across processes — verified for exactly one agent at one version | Dedup is **opt-in** (M1-R5). The default marks and stores, which is filterable and lossless. `ResumeReport.replayDropped` makes any drop visible in the log rather than silent. |
| Loosening the resume text matcher to `/resource not found/` would destroy live sessions on a recoverable cwd mismatch | A **negative** unit test asserting the matcher does not match that string, named so the person editing it reads why; plus the live compat case. |
| Windows can neither reap orphans nor fingerprint, so an abnormal daemon exit leaks agent trees there | Consistent with M0's existing `treeGone: false` honesty: reported in `GET /v1/info.orphansAtStart.skipped` and in the `omni.worker_state{daemon_restart}` envelope, never silently swallowed. A Job Object would fix this *and* `treeGone` and is deliberately kept out of M1 (native code, wrong milestone). |
| Persisting worker records makes `daemon.stop()` non-final: a `cwdRoots` or token change between runs could resurrect a worker the current ACL forbids | `wake()` re-runs the **full ACL check against the current config** and closes the worker with `forbidden` if it no longer passes (§15.3 step 2). |
| Boot adoption writes to every abandoned worker's log at startup | `abandoned()` selects only **live**-state rows; a fleet that died with 10 000 live workers is already a different problem. A `bootRecoveryMs` budget is noted for M2 and not built now. |
| Retention deletes a worker row after 7 days, so a long-lived client's saved id becomes a `404` indistinguishable from "never existed" | Accepted, and it is the same ambiguity D13 requires for invisibility. `DaemonInfo.persistence.retentionDays` is published so a client can reason about it. **No tombstone** — a tombstone kept past the event retention is a second retention policy to get wrong. |
| The vendor patch reconstruction assumes LF line endings and text files | The extractor returns `null` rather than a wrong patch when the reconstructed hunk line counts disagree with `oldLines`/`newLines`; the `git apply` assertion is `skipIf(win32)` until a real Windows observation exists. |
| `mcpServers` is still always `[]`, so the MCP `type` injection rule (§12.3 row 22) ships untested against a real server | Implemented and unit-tested, **unreachable from the wire**, and explicitly listed in §2.3 as M2. DESIGN §8 calls `mcpServers` the highest-risk attack surface; shipping it half-tested would be worse than not shipping it. |

---

## 12. Normalizer — the full v1→v2 map (M1)

Supersedes §7.1 and §7.5. §7.2 (the quiet window), §7.3 (the crash rule) and §7.6 (`seq` is assigned
nowhere but `append`) are **unchanged and still binding**.

### 12.1 Three layers, not one `step()`

M0's Normalizer is a single reducer over a turn. M1 needs three separable things, and fusing them is what
would make the corpus impossible to test against:

| Layer | Pure? | What it is | Where |
| --- | --- | --- | --- |
| **L1 map** | pure, stateless per call | one v1 update → one v2 update | `normalizer/map/*.ts`, exposed as `Normalizer.mapUpdate` |
| **L2 lifecycle** | pure, carries state | turn boundary, close-out ladder, replay copy | `normalizer/turn-lifecycle.ts`, `Normalizer.step` |
| **L3 projection** | pure, stateless | tool-call merge, `changes`, `verdict` | `protocol/src/turn.ts`, `reduceTurn` |

**The stream is a log of events, not a materialized view.** L1 renames `tool_call` to `tool_call_update`;
it does **not** merge. Merging happens in L3, where F23 shows it is already implemented with exactly the
right "absent means unchanged" semantics. The corpus makes this non-negotiable: an update carrying only
`{toolCallId, sessionUpdate, _meta}` has to be storable as itself. If L1 merged, `?since=N` would return
post-merge snapshots and a client reconnecting mid-tool-call would see a **different history** than one
connected throughout — which breaks D6's whole promise.

### 12.2 What "idempotent" means here, precisely

`mapUpdate` is **total** (never throws, for any input including `null`) and **idempotent**:
`mapUpdate(mapUpdate(x).payload).payload` is deep-equal to `mapUpdate(x).payload` for every input, and
every rule tests the **target** shape before rewriting. F24 is why: claude-acp already emits `usage_update`
and `config_option_update` and already returns `configOptions` from `session/new`, while answering
`initialize` with `protocolVersion: 1`. So the map is switched **per field, never on a version number**.

### 12.3 The complete map

`=` identity (v1 and v2 types verified structurally equal, and asserted at **compile** time by §12.7's
type-level tests) · `→` rewritten · `⊘` not implemented in M1, with the reason.

| #  | v1 | v2 | Rule |
| -- | -- | -- | ---- |
| 1  | `user_message_chunk` | same | `=` except `messageId` (row 14) |
| 2  | `agent_message_chunk` | same | `=` except `messageId` |
| 3  | `agent_thought_chunk` | same | `=` except `messageId`. **No real-agent sample** — not emitted at default effort. Fixture `thought.mjs` |
| 4  | `tool_call` | `tool_call_update` | `→` **rename the discriminant, and nothing else.** No defaulting, no field synthesis: v1 `ToolCall.title` is required and v2 `ToolCallUpdate.title` optional, and the merge that knows an absent field means unchanged is `reduceTurn` (F23, §12.1) |
| 5  | `tool_call_update` | same | `=` verbatim; `_meta` by identity |
| 6  | `content[i] {type:"diff"}` | `{type:"diff", changes, patch?, _meta}` | `→` §12.5 |
| 7  | `plan` | `plan_update` | `→` `{entries}` → `{plan:{type:"items", planId, entries}}`. `planId` is `plan_<turnId>`, **stable across the turn**, so successive `plan` updates upsert one plan. **No real-agent sample** (two attempts). Fixture `plan.mjs` |
| 8  | `plan_update` | same | `=` when `plan.type` is a string; otherwise treated as row 7 (a v1 agent using the v2 name loosely) |
| 9  | `plan_removed` | same | `=` |
| 10 | `available_commands_update` | same | `=` **on the wire.** §6.1 has no row for it and F13 says it is 87.8 % of update bytes: §14.6 governs storage, and it is streamed in full (ruling M1-R3). **This table row is the decision the corpus README asked for.** |
| 11 | `current_mode_update` | `config_option_update` | `→` `{currentModeId}` → one `configOptions` entry `{id:"mode", name:"Mode", category:"mode", type:"select", currentValue:<id>, options:<from the handshake's `modes.availableModes`, `{id,name,description}` → `{value,name,description}`>}`, plus `_meta["omni/derivedFrom"]: "current_mode_update"`. **If the handshake carried no `modes`, `options: []`** — honest, not invented. No real-agent sample. Fixture `mode.mjs` |
| 12 | `config_option_update` | same | `=` |
| 13 | `session_info_update`, `usage_update`, `compaction_update`, `compaction_summary_chunk` | same | `=` — structurally identical, asserted at compile time (§12.7) |
| 14 | `messageId?` | `messageId` (required) | `→` §12.4 |
| 15 | *(none)* | `state_update{running \| idle}` | `→` synthesized, as in M0. **M1 adds** `usage` on `idle` from the prompt response (F21) and `_meta["omni/warnings"]` (§13.4) |
| 16 | *(none)* | `agent_message` / `user_message` / `agent_thought` / `tool_call_content_chunk` | ⊘ **not synthesized.** These are v2 *upsert* forms with patch semantics and no v1 producer; emitting them would be inventing structure |
| 17 | `terminal_update` / `terminal_output_chunk` | same | ⊘ D3: `clientCapabilities: {}` means no `terminal/*` traffic exists. Confirmed across all 11 corpus runs — the only agent→client methods are `session/update` and `session/request_permission` |
| 18 | unknown `sessionUpdate` | verbatim, `payloadVersion: 1` | pass-through **by identity**; `_meta` preserved because the object is forwarded, not rebuilt |
| 18b | an agent→client **method** in `descriptor.inboundAliases` (e.g. `session/notification`) | `session/update` | the method is renamed to the alias's value **before** this table runs, then mapped by the row its `sessionUpdate` names. Only REGISTERED spellings are aliased; an unregistered agent→client method keeps §7.6's `-32601`, so a typo can never silently swallow updates. `{}` for every agent M1 knows about (DESIGN §1.3, review R4) |

Client→agent, per method:

| #  | v1 | v2 canonical | Rule |
| -- | -- | ------------ | ---- |
| 19 | `initialize{protocolVersion, clientCapabilities, clientInfo}` | `{protocolVersion, capabilities, info}` | outbound rename. v2 `ClientCapabilities` has no `fs`/`terminal` keys, which is exactly D3's `{}` |
| 20 | `InitializeResponse{agentCapabilities, agentInfo}` | `{capabilities, info}` | inbound rename; `loadSession`/`promptCapabilities`/`mcpCapabilities` move under `session` |
| 21 | `promptCapabilities: {image: true}` | `{image: {}}` | **bool → object**: `true` → `{}`, `false`/absent → omitted. Applied to `image`, `audio`, `embeddedContext` |
| 22 | `McpServer` without `type` | `type: "stdio" \| "http"` | injected: `command` ⇒ `"stdio"`, `url` ⇒ `"http"`. **Unreachable in M1** (`mcpServers: []` always) — implemented and unit-tested, gated behind M2's presets |
| 23 | `authenticate{methodId}` / `logout` | `auth/login{methodId}` / `auth/logout` | descriptor spellings, marked `unverified`: claude-acp advertises `auth:{logout:{}}` and `authMethods: []`, and the corpus never exercises it. The compat suite refuses to assert it |
| 24 | `session/load{sessionId,cwd,mcpServers}` | `session/resume{…, replayFrom}` | preference order (§17.3). claude-acp answers **both** (F18) |
| 25 | `session/set_mode{modeId}` | `session/set_config_option{configId:"mode", value}` | preference order; note **both are live on one process** (F18) |
| 26 | *(vendor)* `session/set_model{modelId}` | `session/set_config_option{configId:"model", value}` | preference order; `-32601` here, present on 8 multica runtimes. `prefer.setConfig.onFailure` is **`fail`** — a caller asked for a model and did not get one |
| 26b | *(vendor)* `session/set_options{…}` | passthrough under `prefer.setOptions` | DESIGN §6.2's vendor extension. `-32601` on claude-acp (transcript `08`), and `prefer.setOptions.onFailure` is **`warn`**: an agent that does not implement an extension we offered has done nothing wrong, so the turn carries a `TurnWarning` and does not fail (review R2) |
| 27 | v2 `{type:"id", value}` | v1 `{value}` | outbound **drop** of the `type:"id"` tag: v1's untagged arm is `{value}` and claude-acp accepts it |
| 28 | no `session/list` / `session/close` | synthesized from the registry | only when the capability is absent; claude-acp has real ones (F18) |
| 29 | permission request `{toolCall, options}` | `{title, subject, options}` | §12.6 |

**`payloadVersion`, stated once (ruling M1-R10):** an `acp.session_update` envelope carries `2` **iff**
`mapUpdate` landed on a known v2 arm — mapped or already v2-shaped — and `1` otherwise. That is a stronger
and more useful signal than M0's "agent-forwarded ⇒ 1", and it keeps the field honest for vendor kinds.

### 12.4 `messageId` — pass through, synthesize only when absent

**Do not backfill.** F14: every `agent_message_chunk` and `user_message_chunk` in this corpus carries one,
consecutive chunks of one message **share** it, and the replayed id is byte-identical to the live one.
Agent ids look like `msg_011Ceh…`; a replayed *user* id is a plain UUID.

v2 **requires** the field, so an agent that omits it needs one. Synthesis is deterministic and marked,
never opportunistic: `omni:<turnId>:<kind>:<runOrdinal>`, where `runOrdinal` increments on every kind
change — a stream of id-less chunks is therefore grouped as one message per contiguous run, which is the
only grouping the wire supports. `MappedUpdate.messageId` reports what is in force and a golden test
asserts **0 synthesized ids** for the whole claude-acp corpus (86 of 86 chunks pass through).

### 12.5 The diff block — the row DESIGN §6.1 cannot literally satisfy

v2's `Diff` is `{changes: DiffChange[], patch?: {format, text}}` where
`DiffChange = {operation, path, fileType?, mimeType?}`. **It has no `oldText`/`newText` at all.** So §6.1's
`diff {oldText,newText} → {changes, patch}` is lossy unless the text is put somewhere, and `patch` is not
computable from the standard v1 fields (F19).

```
{type:"diff", path, oldText, newText}
  →  { type: "diff",
       changes: [{ operation: oldText == null ? "add" : "modify", path }],
       _meta: { …original _meta,
                "omni/v1Diff": { oldText, newText, fragment: <descriptor.quirks.diffIsFragment> } } }
```

- **Lossless.** `reduceTurn` reads `_meta["omni/v1Diff"]` to build `TurnResult.changes`, so the M0 wire
  shape of `FileChange` is unchanged by this rewrite, and `fragment` is carried from the **descriptor**,
  never guessed. A consumer that writes a fragment to `path` corrupts the file.
- **`patch` is NOT filled.** D8's guarantee is "accurate or null", and a vendor-reconstructed patch we
  cannot compare against the disk would be a third source of truth (ruling M1-R11). The reconstruction is
  real and verified — `_meta.claudeCode.toolResponse.{structuredPatch, originalFile, content}` produces a
  patch `git apply --check` accepts for both an edit and a creation — so it ships as a descriptor-
  registered extension and surfaces as `TurnResult.vendorPatch`, clearly labelled.
- **`reduceTurn` reads the v2 shape first and the v1 shape second**, because a client may fold a buffer
  that spans an upgrade and a persisted log can hold both.
- A happy consequence worth an assertion: in corpus `04` the **denied** tool call's final update replaces
  `content` with the failure text, so the diff is gone and `TurnResult.changes` is correctly empty.

### 12.6 The permission request

v1 `{sessionId, toolCall, options, _meta}` → v2 `{sessionId, title, subject, options, _meta}`, and the
**responder receives the mapped form** (ruling M1-R14).

- `options` is **never reshaped**. The field is `optionId`, not `id` (corpus finding 5); the three observed
  options pass through untouched, **including an unknown `kind`**, which D4 rule 6 needs in order to fail
  closed.
- `title` precedence is evidence-ordered: `_meta.permission.title` (present on both observed requests) →
  `toolCall.title` (the schema'd field) → a constructed `"<kind>: <name|toolCallId>"`, never empty, because
  v2 requires a string.
- `subject` is `{type:"tool_call", toolCall}` with `toolCall` passed **by identity**, so `kind`,
  `locations`, `content` and `rawInput` — what M2's rule engine matches on — arrive unmodified.
- **Idempotent**: a request that already carries `subject` is returned unchanged.
- **The responder asserts `optionId ∈ offered` before answering.** Corpus `09` is why: an id the agent
  never offered does not fail the turn — each tool call goes `status:"failed"` with a human-readable
  `rawOutput` and the turn still ends `end_turn`. D4 rule 1 therefore **cannot be enforced by watching
  `stopReason`** and must be enforced structurally, at the one place that emits the answer.

### 12.7 Golden tests — three tiers, only the middle one generated

**(a) Hand-written rule expectations — one per row of §12.3.** Input and expected output are both
literals, written from this document and from the SDK's type definitions, **never captured from the
implementation**. This is the tier that can catch a wrong map.

**(b) Corpus conformance — machine-checked properties, no blessed output.** Replay all 216 recorded
updates through `mapUpdate` and assert:

1. every mapped payload passes the SDK's v2 guards for its own arm, **and** `SessionUpdate.isCustom(u)` is
   false — the v2 unions have an open arm, so a guard is *necessary, not sufficient*, and landing on the
   escape hatch must be a failure;
2. content blocks are checked recursively (the open arm otherwise accepts a v1-shaped diff nested inside a
   valid `tool_call_update`);
3. `mapUpdate` is **idempotent** and **total** (property-tested over the corpus and over its own output);
4. `_meta` survives **by identity** wherever the input had one;
5. no `tool_call`, no `plan`, no `current_mode_update` survives the map;
6. `messageId` is synthesized **0 times** for this agent;
7. `payloadVersion === 2` for every kind in the map;
8. `reduceTurn` over the mapped stream reproduces, per scenario, the outcome the corpus README records
   (`stopReason`, tool-call count, final statuses, `changes`).

**(c) Envelope goldens for `reduceTurn`** — M0's existing mechanism, grown from 8 to ≥14 cases, of which 6
are **generated** from the corpus by a checked-in generator run with `--check` in CI. The `.expected.json`
files stay **hand-written**; generating them would make the tier tautological.

**Wire-level**: `wireAgentPath()` replays a recorded transcript over a real pipe as a tier-2 fixture, so the
corpus also exercises the Supervisor, the frame limiter and the AcpLink.

### 12.8 Named golden cases

| Case | Asserts |
| ---- | ------- |
| `01-plain` | `state_update{running}` seq < every agent update < `idle`; `idle.usage` carries the prompt-response `Usage` (F21) |
| `02-read` | `tool_call` → `tool_call_update` on the stream; `reduceTurn` merges 1+3 updates into one call with `kind:"read"` **preserved** through updates that omit it |
| `03-write-allowed` | permission mapped to `{title:"Write hello.txt", subject:{type:"tool_call"}}`; `changes[0].operation === "add"`; `vendorPatch` is a valid git creation patch |
| `04-write-denied` | `stopReason:"end_turn"` **and** `verdict:"partial"`, `deniedToolCalls` non-empty, `changes: []` |
| `06-cancel` | the `usage_update` arriving 53 ms after `session/cancel` has a **lower seq** than `idle` |
| `07-load-replay` | exactly the two updates between request and response carry `replay:true`; the `available_commands_update` 2 ms after the response does not; `ResumeReport.replayedEvents === 2`; pre-hibernate envelopes still readable at their original seqs |
| `08-methods` | `classifyProbe` reproduces all five verdicts, including learning `configId` from `-32602 data.configId._errors` |
| `09-bad-option-id` | the responder **refuses** to send an unoffered `optionId` and answers `-32603`; a planted violation reproduces the recorded `status:"failed"` |
| `10-edit` | `content` widening does not double-count: exactly one `FileChange`, `fragment:true`; `vendorPatch` applies with `git apply` |

---

## 13. Turn close-out — two ladders (M1)

### 13.1 The contradiction, and the ruling

DESIGN §6.2 gives one order: *等静默窗口 → 关 stdin → 带 grace 排空 stdout/stderr → cancel*. CONTRACTS §6.5
rules the opposite: `closeStdin()` appears **only** in `terminate()`, because omni-acp Workers are
long-lived across turns where multica's processes are one-shot, and M0 ships a test asserting a second
`prompt()` succeeds after a `cancel()`.

Both are right about different things. Read as a **per-turn** sequence, §6.2 is wrong: closing stdin ends
the process's ability to receive the next `session/prompt`. Read as the **forced-termination** order it is
exactly right, and it is what M0's cancel path is missing. **M1 ships both, named** (rulings M1-R4 and M1-R4a), and
§6.5's rule is unchanged: `closeStdin()` never appears at turn end.

### 13.2 The two ladders

```
SETTLE — every turn. Unchanged from M0 §7.2 except that `idle` now carries `usage` and warnings.
  prompt_result(stopReason, usage)
    → quiet window (moving deadline, capped at hardMs)
    → state_update{ idle, stopReason, usage, _meta["omni/warnings"] }

CLOSE_OUT — teardown only: DELETE, hibernate, daemon shutdown, cancel timeout.
  close_requested
    rung 1  quiet window, capped at hardMs        # let the last chunk land
    rung 2  action "cancel" → session/cancel, wait cancelGraceMs
    rung 3  action "close_stdin"                  # EOF: no more requests are coming
    rung 4  action "drain", wait drainGraceMs for stdoutEnded, FORWARDING everything
    rung 5  action "terminate" → §6.5's escalation ladder (SIGTERM → grace → SIGKILL / taskkill)
```

Rungs 2 and 4 are **transposed** relative to this document's first draft and to DESIGN §6.2 — see ruling
M1-R4a. `session/cancel` is carried on the agent's **stdin**, so a cancel sent after the `close_stdin` rung
reaches nobody: rung `close_stdin`'s own comment ("EOF: no more requests are coming") forbids a later rung
that sends one.

Corpus finding 14 is what forces the QUIET window to come first: in scenario `06` a `usage_update` arrived
53 ms **after** our `session/cancel` and ~4 ms before the prompt response. Cancelling at the response
boundary — or emitting `idle` the instant `session/prompt` resolves — orders that update *after* an event
that belongs to the turn. That reason is untouched by the transposition, because the quiet window is still
rung 1.

`CloseOutAction` is the **only** side effect the reducer requests; the Worker performs it. The reducer stays
pure, which is what keeps the whole ladder unit-testable with `fakeClock()` and no process, and it means
`worker.ts`'s entire coupling is still four lines:

```
const out = norm.step(input);
log.appendAll(out.emit);          // seq assigned here, synchronously, in array order
rescheduleTick(out.scheduleTickAt);
perform(out.action);              // the ONE new line
```

`drained` (stdout EOF during rung 3) short-circuits to `terminate`: nothing more can arrive.

### 13.3 What the ladder must NOT do

- It must not fabricate a `stopReason`. §7.3's crash rule stands: when the ladder terminates a live turn,
  `idle` carries whatever the prompt response gave us **or `null`** — never an invented `"cancelled"`.
- Rung 1's quiet window is still capped by `hardMs`, so a hung agent cannot hold
  `DELETE /v1/workers/{wid}` open.
- M0's `turn-lifecycle` arms (`prompt_sent`, `agent_update`, `prompt_result`, `prompt_error`,
  `process_gone`, `tick`) keep their semantics **exactly**: the M0 unit tests must pass **unmodified**, and
  that is a work-package acceptance bullet, not an aspiration.

### 13.4 `end_turn` ≠ success — no new event kind

Corpus findings 6 and 7 are the problem statement: a denied tool call and an *invented* `optionId` both end
`stopReason: "end_turn"`, and the only agent-side signal is English prose in `rawOutput`. Four signals,
ranked by how much we trust them, all landing in the same two places — `state_update{idle}._meta["omni/warnings"]`
for advisories, `omni.error` before `idle` for terminal ones:

| Signal | Source | Trust | Effect |
| ------ | ------ | ----- | ------ |
| **Our own denial** | `omni.policy_decision{decision:"deny", toolCallId}` | total — we are the denier | `verdict:"partial"`, `deniedToolCalls += id` |
| **Tool status** | final `tool_call_update.status === "failed"` | total — a schema'd enum | `verdict:"partial"`, `failedToolCalls += id` |
| **Rate limit** | `usage_update._meta` at the descriptor's `rateLimit` pointer (F20) | high — structured, and it arrives **before** the failure | an advisory status → `TurnWarning`; an enumerated terminal status → `omni.error{agent_error}` before `idle` ⇒ `TurnStatus.state === "failed"` |
| **Fatal stderr** | a **complete** stderr line matching the descriptor's `fatalStderr` | low — text | `omni.error{agent_error}` before `idle` |

The only rate-limit status ever observed is `"allowed_warning"` at utilization 0.78 — an advisory. M1
therefore treats exactly one **enumerated** set as terminal (`rejected`, `blocked`, `exhausted`,
`over_limit`) and everything else as advisory, rather than guessing that an unknown status means failure.

`reduceTurn` computes the verdict with **no agent prose anywhere**:

```
failed  = toolCalls where final status === "failed"
denied  = interactions where decision === "deny", joined by toolCallId
verdict = error !== null ? "failed" : (failed ∪ denied) non-empty ? "partial" : "ok"
```

A guard test, `no-agent-prose`, fails the build if any source file outside the descriptor dialect module
matches an English agent string (`"User refused permission"`, `"Method not found"`,
`"Resource not found"`). The classification keys on codes and JSON pointers or it does not exist.

---

## 14. Event-log persistence and retention (M1)

Supersedes §8.1. §8.2 (seq), §8.3 (turn linkage) and §8.4 (SSE) are **unchanged and still binding** —
including every control frame and the exclusive-cursor semantics.

### 14.1 The ring stays, and it is a contract requirement

F11 is decisive: `runEventLogConformance` asserts `log.read(0)[0] === appendedEnvelope` by **object
identity**, and §8.1 says the M1 SQLite driver "must pass it verbatim". A pure-SQLite `read()`
deserialises and returns a different object. Therefore the SQLite driver is **write-through behind the
existing in-memory ring** (ruling M1-R1). Consequences worth stating up front:

- Every subtlety in `memory-log.ts` — fan-out, bounded subscriber queues, overflow, re-entrancy,
  two-phase enqueue-then-deliver — is **unchanged and untouched** by persistence. It moves verbatim into
  `event-log/log-core.ts`; `memory-log.ts` becomes a thin wrapper, and its behaviour and every existing
  test are unchanged. That is the acceptance criterion for the move.
- Disk is consulted **only** when a read falls below the ring's floor — after a restart that is every read
  (the ring is empty); during normal operation it is never.
- Object identity holds for anything still in the ring, which is the only range the conformance suite
  creates.

Measured (F12): 1 000 prepared single-row inserts in 2.5 ms in-memory. A claude-acp turn is ~216
`session/update`s, so the synchronous disk work is single-digit milliseconds spread over a 3–7 s turn. The
synchronous-`append` contract survives intact.

### 14.2 The `ExperimentalWarning`, handled surgically

§8.1's stated reason for deferring SQLite was import noise inside `OmniACP.local()` running in a user's
script. Two mitigations, both required:

1. The import is **lazy and driver-gated**: `driver: "memory"` — still the `createDaemon()` default
   (ruling M1-R17) — never loads `node:sqlite`, so an embedder is silent by default. A test asserts zero
   `ExperimentalWarning`s across a full create-worker-prompt cycle on the memory driver.
2. When SQLite **is** selected, `process.emitWarning` is intercepted **for the duration of that one
   import** and **only** for `type === "ExperimentalWarning"` with `/\bSQLite\b/` in the text; everything
   else — including the agent's warnings and any other `ExperimentalWarning` — passes through untouched,
   and the original is restored in a `finally`. A blanket `--no-warnings` would have hidden the others,
   which is why it is not used. Both directions are tested: the SQLite warning is suppressed, an unrelated
   `ExperimentalWarning` is not.

Opening the database happens **once**, in `createDaemon()` (already async), so per-worker log construction
inside `registry.create()` stays synchronous. Pragmas: `journal_mode = WAL`, `synchronous = NORMAL`
(configurable), `busy_timeout = 5000`, `foreign_keys = ON`, `auto_vacuum = INCREMENTAL` (set before the
first table exists). **If `journal_mode = wal` does not stick — a network or shared-folder `dataDir` is the
known failure mode — `start()` fails loudly** rather than silently running in `journal_mode = memory`.

### 14.3 The append path, and what happens when the disk says no

Order is durable → ring → fan-out, and the reasoning is not symmetrical:

- **durable first** keeps the window in which a `SIGKILL` loses an envelope down to the insert itself
  rather than the whole fan-out;
- **a durable failure must never throw into the caller.** `Worker.#feed` catches, logs and drops, so a
  disk-full would silently eat events. Instead the log **degrades**: it stays correct in RAM, every
  observer keeps receiving, `WorkerSnapshot.persistence` flips to `"degraded"` and stays there,
  `EventStoreDiagnostics.writeFailures` increments and reaches `GET /v1/info`, and **one** in-band
  `omni.error` envelope tells subscribers that this worker's history will not survive a restart;
- **the `seq` is NOT rolled back on failure.** Rolling it back would leave the ring and the disk holding
  different envelopes at the same seq — the one corruption `?since=` cannot recover from.

`read()` becomes a two-source merge with the ring floor as the only branch, capped so the two sources can
never overlap and a seq can never appear twice. `tail` is `max(durable tail, ring floor)`. **This is the
highest-risk expression in M1** and it carries both a boundary test with the ring deliberately sized to 3
and a randomized append/read/evict fuzz asserting gap-freeness and no duplicates.

### 14.4 `seq` continuity across restarts — the bug that eats a whole class of logs

The naive restore is `head = SELECT max(seq) FROM events WHERE worker_id = ?`. **That is wrong**, and it is
the single most dangerous line in this milestone.

Consider a worker with 4 211 events whose rows were evicted by the row cap or by age while the worker row
itself was still inside the 7-day window. `max(seq)` is `NULL` ⇒ `head = 0` ⇒ the next append is **seq 1
again**. Every client holding `?since=3000` silently receives nothing forever, and §8.2 rule 2 ("seq 1 is
always `worker_state{starting}`") becomes a lie **inside one worker's own log**.

So the head is `max(durable head_seq column, max(seq))`:

- `head_seq` alone is stale between debounced flushes;
- `max(seq)` alone resets to 0 once retention has evicted everything.

`head_seq` is flushed on every state transition, on close, on hibernate, and on a debounce (every 256
appends or 5 s). Staleness is harmless because the `max()` covers it; the column only has to be right when
the **rows are gone**, and rows only go away through the retention sweep — which updates `head_seq` and
`tail_seq` **in the same transaction as the DELETE**. The tail is symmetric: `min(seq)` when rows exist,
otherwise `head + 1` — "nothing retained, and here is where the next one will be" — never 1, which would
promise history that no longer exists.

**Named regression test**: append 50 → close → evict everything → reopen → append 1 ⇒ `seq === 51`, and it
must fail on a planted `head = max(seq)`.

### 14.5 Retention — three bounds that are constantly confused

| Bound | Unit | What it protects | Config | Raises `tail`? |
| ----- | ---- | ---------------- | ------ | -------------- |
| **ring** | events in RAM | process memory, fan-out latency | `maxEventsPerWorker` (10 000) | **No** — with a backend the ring is a cache and `tail` comes from disk |
| **row cap** | rows per worker | one chatty agent filling the disk | `maxPersistedEventsPerWorker` (200 000, 0 = off) | Yes |
| **age** | days after **close** | total disk over time | `retentionDays` (7, DESIGN §12) | Yes, then the worker row is dropped |

The M0 ring was the only bound, so `tail` and "ring floor" were the same number; with a backend they part
company, and every conformance assertion is already written to hold either way.

`planRetention()` is **pure** and table-tested; `runRetention()` is the only part that touches I/O.
`evict(workerId, upTo)` is one transaction: `DELETE … WHERE seq <= ?` plus `UPDATE workers SET tail_seq = ?
+ 1`. Age expiry deletes the event rows **and** the worker row, so `GET /v1/workers/{wid}` after 7 days is a
clean `404 worker_not_found` rather than a snapshot pointing at an empty log. Scheduling: one pass at
startup (a daemon down for a month must not carry a month of rows into its first request), then every
`retentionSweepMs`, each followed by a bounded `pragma incremental_vacuum` so pages actually return to the
OS. **A live or hibernated worker is never aged out** — only the row cap applies to it, because a
hibernated worker can still wake and its history is the reason to.

### 14.6 `available_commands_update` — the decision §6.1 left open

F13: **275 270 of 313 643 update bytes (87.8 %)**, 23 notifications, **2 distinct payloads**, largest line
12.7 KB, arriving twice per turn. At 7-day retention it dominates the log.

**Ruling M1-R3: stream in full, store by content digest.** Not dropped (a client rendering a slash-command
palette needs it); not truncated (that would be a lie about the agent's command set); and **never**
store-but-do-not-stream.

The gap-free invariant, stated once so it cannot be eroded — there are exactly two legal answers and a
third that is forbidden:

- ✅ **drop** — decided in the **Normalizer**, from `UpdateRule.stream/store` both false, **before**
  `append()` is ever called. No seq is consumed; the log stays gap-free by construction. That IS the
  operator's escape hatch: an `updates.<kind>` overlay entry with `stream:false, store:false`. There is
  no separate `dropUpdateKinds` field and there never was one (review R9); **no kind carries the
  drop shape by default**.
- ✅ **keep** — stored and streamed like everything else. When `UpdateRule.digest` is set, the payload is
  stored **once** under its sha256 in a side table and the envelope row holds a reference; `read()` and
  `subscribe()` rehydrate, so every reader sees the identical payload it would have seen with no digest at
  all. On this corpus: 23 stored payloads → 2. Envelope count, `seq` and ordering unchanged.
- ❌ **store-but-do-not-stream** — an envelope that consumes a seq but is withheld from the live tail makes
  `?since=N` deliver a gap the client cannot distinguish from loss, and two subscribers who reconnect at
  different times disagree about the log. `resolveDescriptor` **rejects** an `UpdateRule` in that shape. If
  a future milestone wants it, it needs a second sequence space, not a filter.

The conformance suite gains one obligation that makes the optimisation safe to have: **`read(0)` after a
digest round-trip must be deep-equal to what was appended.**

### 14.7 Schema

One database per `dataDir` (`<dataDir>/events.db`), `schema_version` in a `meta` table, forward-only
migrations, and a **startup failure naming the version** when the file's `schema_version` is from the
future — never a silent downgrade.

- `workers` — `worker_id` PK, `daemon_id`, `boot_id`, `agent_id`, `session_id`, `cwd`, `label`,
  `owner_token`, `state`, `close_reason`, `close_result` (JSON), `crashed`, `created_at`, `updated_at`,
  `hibernated_at`, `last_active_ms`, `closed_at_ms`, **`head_seq`**, **`tail_seq`**, `capabilities` (JSON),
  `resume_json`, `orphan_json`, `process_json` (pid + groupId + **fingerprint**), `wake_count`,
  `wake_failures`, `hibernate_idle_ms`. Indexed by `(state, last_active_ms)`, `(boot_id, state)`,
  and partially on `closed_at_ms`.
- `events` — `PRIMARY KEY (worker_id, seq)`, `WITHOUT ROWID`, plus `ts`, `session_id`, `turn_id`, `kind`,
  `payload_version`, `replay`, and either `payload` (JSON, byte-for-byte as the agent sent it) or a
  `digest_ref`. Index on `(worker_id, turn_id, seq)`.
- `payloads` — `sha256` PK, `payload`, `refcount`: §14.6's digest side table.

Three decisions and why: **`WITHOUT ROWID` on `(worker_id, seq)`** because the only access pattern is a
clustered prefix scan; **envelope meta in columns, payload in one blob** because `kind`/`turn_id`/`replay`
are queried and the payload never is — which also means §7.5's forwarding guarantee extends to disk with
no reshaping; **`head_seq` as a column, not `max(seq)`** for §14.4's reason. The `(worker_id, seq)` primary
key is also the backstop against a second daemon: two writers collide on insert with a loud
`SQLITE_CONSTRAINT` rather than silently forking a worker's history.

### 14.8 Restart-survivable `?since=` and lazy rehydration

**What changes in the SSE writer: nothing.** `daemon/src/http/sse.ts` takes an `EventLog` and is agnostic
to where the bytes came from. That the M0 seam was cut at `EventLog` is what makes this a zero-diff file,
and a checksum test asserts it stayed that way.

What changes is that `registry.get()` must produce a handle for a worker this process never created:

- in memory ⇒ as today;
- not in memory ⇒ **lazily** reconstruct from the `WorkerStore` and memoise. Reconstructing every row at
  startup would make a daemon with 10 000 retained workers take minutes to bind a port, and 99 % of them
  are closed and will never be asked for.
- `list()` reads **straight from the store** — a synchronous indexed query, no handle construction — with
  in-memory entries overriding the row, because a live snapshot is fresher than a debounced one.

A rehydrated worker is the **same `Worker` class** constructed in a non-`starting` initial state. Making it
a second class was rejected: `close()`, `wake()`, `snapshot()` and `turn()` would then have two
implementations each, and the second one is where the "DELETE after a restart returns a different body" bug
lives.

### 14.9 What `GET /v1/info` must say

`persistence.driver` (does anything here survive a restart), `persistence.writeFailures` (does it still),
`persistence.sizeBytes`, `persistence.retentionDays`, `persistence.lastSweep`, `bootId`, and
`orphansAtStart {found, reaped, skipped}`. This is §6.6's honesty contract extended: an operator reads
these **before** anything goes wrong, and a Windows operator sees `{found: 3, reaped: 0, skipped: 3}`
rather than a quiet lie.

### 14.10 One daemon per data dir

WAL lets multiple processes write, but two daemons assigning `seq` from the same `head_seq` would fork a
worker's log. Two defences: a `<dataDir>/daemon.lock` written `wx` with `{pid, bootId, startedAt,
hostname}` — a lock whose pid is **provably gone** is broken and retaken, a lock whose pid is **alive** is a
hard startup failure naming the other pid (the same shape `ids-file.ts` already uses, for the same reason);
and the `(worker_id, seq)` primary key as the backstop. The lock is **skipped entirely** for
`driver: "memory"`, because `OmniACP.local()` must stay able to run N instances side by side — the M0
integration suite depends on it.

### 14.11 SQLite conformance

`runEventLogConformance("sqlite(:memory:)")` and `runEventLogConformance("sqlite(file)")` run M0's suite
**verbatim and unedited**, including the object-identity assertion — that is what proves the ring stayed.
`runEventLogPersistenceConformance` adds:

1. append 500 → close the store → reopen ⇒ `head === 500`, `tail === 1`, `read(0)` returns 500 envelopes
   **deep-equal** in `seq`/`ts`/`kind`/`payload` (deep-equal, **not** identity — the suite says which is
   which and why);
2. reopen → append 1 ⇒ `seq === 501`;
3. **evict everything** → reopen → append 1 ⇒ `seq === 501`, **not 1** (§14.4, and it fails on a planted
   `max(seq)`);
4. `_meta` survives the JSON round-trip byte-for-byte, including the 12.7 KB `available_commands_update`
   and the `_meta["_claude/rateLimit"]` block;
5. a `put` that throws ⇒ `persistence === "degraded"`, the append still returns an envelope, the subscriber
   still receives it, `seq` is still gap-free;
6. two `EventLog`s over one store for different workers do not see each other's `head`;
7. a per-append latency budget over 5 000 appends (guards against an accidentally un-prepared statement,
   and against a Windows fsync regression);
8. `close()` on a log leaves the store usable — they have separate lifetimes;
9. a digest round-trip: 23 `available_commands_update` appends store 2 payload rows and `read(0)` is
   deep-equal to what was appended;
10. a read that spans the ring floor with the ring sized to 3, plus the randomized fuzz of §14.3.

---

## 15. Hibernate, wake, and the resume four-state (M1)

### 15.1 The complete worker state table

M1's reachable states are `starting | ready | running | hibernated | closed`. `requires_action` stays
wire-stable and unemitted until M2's policy engine.

| From | To | Trigger | Envelope `reason` | Process | Session ptr | Lease |
| ---- | -- | ------- | ----------------- | ------- | ----------- | ----- |
| — | `starting` | `POST /v1/workers` | `created` | — | — | creator, or none if `lease:"observe"` |
| `starting` | `ready` | handshake ok | `handshake_ok` | live | set | held |
| `starting` | `closed` | handshake fail / timeout | `handshake_error` \| `handshake_timeout` | reaped | — | — |
| `ready` | `running` | `prompt` | `prompt` | live | kept | asserted + **pinned** |
| `running` | `ready` | turn settles | `turn_end` | live | kept | kept, un-pinned |
| **`ready`** | **`hibernated`** | idle timer or `POST …/hibernate`, `resume.method !== null` | **`hibernate`** | **reclaimed** | **kept** | **released** |
| **`ready`** | **`closed`** | idle timer, no resume method, `whenNotResumable:"close"` | **`idle_timeout`** | reclaimed | dropped | released |
| **`ready`** | **`ready`** | idle timer, no resume method, `whenNotResumable:"keep"` (default) | *(none; logged once at info)* | live | kept | kept |
| **`hibernated`** | **`starting`** | `prompt` / `POST …/wake` — **never `attach`** (ruling M1-R22) | **`wake`** | spawning | kept | re-acquirable |
| **`starting`** | **`ready`** | wake ⇒ `landed` \| `unknown` | **`resumed`** (+`resume`) | live | kept | free |
| **`starting`** | **`hibernated`** | wake ⇒ spawn / init / `rejected_transient` failure | **`wake_retry`** (+`resume`) | reclaimed | **kept** | free |
| **`starting`** | **`closed`** | wake ⇒ `rejected_permanent`, or `maxWakeFailures` exhausted | **`not_resumable`** \| **`wake_failed`** (+`resume`) | reclaimed | **cleared** | — |
| **`hibernated`** \| **`starting`** | **`closed`** | wake fails the CURRENT ACL (§15.3 step 2) | **`acl_revoked`** | reclaimed | **dropped** | — |
| `running` | `hibernated` | process death, resume method present | `agent_crashed` (+`crashed:true`) | dead | kept | released |
| `running` | `closed` | process death, not resumable | `agent_crashed` | dead | dropped | — |
| **live** | **`hibernated`** | boot adoption, resumable | **`daemon_restart`** (+`orphan`, `crashed:true`) | orphaned | kept | none |
| **live** | **`closed`** | boot adoption, not resumable | **`orphaned`** (+`orphan`) | orphaned | dropped | none |
| `hibernated` | `closed` | `DELETE` | `client_request` | none | dropped | — |
| any | `closed` | `daemon.stop()` | `daemon_shutdown` | reaped | kept in the row | — |

Five invariants a test asserts after **every** transition:

1. `state === "hibernated"` ⇒ `process === null` **and** `sessionId !== null` **and**
   `capabilities.resume.method !== null`.
2. `crashed` is monotone: once true, never false, across hibernate, wake and restart.
3. `hibernatedAt !== null` ⇔ `state === "hibernated"`.
4. A `hibernated` worker holds **zero** `maxWorkers` slots and exactly one `maxHibernated` slot.
5. Every transition appends **exactly one** `omni.worker_state`, and the log's `previous` chain is a valid
   path through this table.

### 15.2 Hibernate — the order is the correctness argument

**Who writes it.** The four steps below are the Land step's, in `worker.ts`, because every one of them
moves a PRIVATE field of the `Worker` (`#state`, `#proc`, `#link`, `#hibernatedAt`) and that file is
frozen after the Land commit (ruling M1-R19, review R13). What M1-WP-C owns is everything the transition
DELEGATES to: `createHibernateTimer` (which calls it), `SessionStrategy` (which reopens afterwards), and
the tests that assert this order.

The idle timer is armed on every transition **into** `ready` and disarmed on every other state, including
`starting` during a wake. A synchronous `#hibernating` flag is set before the first `await`, exactly like
`#closing`, so a `prompt()` arriving in that window already sees "busy".

1. **NO `session/close`.** That is the difference between hibernate and close: the session pointer is the
   entire value being preserved, and `sessionCapabilities.close` on claude-acp is real and destructive.
2. stdin EOF, then the graceful ladder — the agent gets its normal shutdown; we are not crashing it.
3. **Lease released** (DESIGN §3.2: 进程回收、lease 释放、记录保留). A holder cannot control a worker with
   no process, and holding a lease across a 30-minute sleep is how a lease silently becomes permanent.
4. **The envelope, then the persist.** A crash between them replays as §15.7's adoption path, which
   converges on the same `hibernated` state; persisting first and crashing before the envelope would leave
   a log that never mentions the transition.

A worker whose agent advertises **no** resume spelling is not hibernated by default (ruling M1-R15):
hibernating a worker you can never wake is a one-way door that turns a healthy worker into a guaranteed
`422` on a timer. `hibernate.whenNotResumable: "close"` is the opt-in for operators who would rather lose
the session than the memory.

### 15.3 Wake, and the replay window

```
prompt() on `hibernated`
  ├─ synchronous admission: state = "starting"   (a second concurrent prompt now gets 409)
  ├─ await wake(), single-flight
  │    1. reserve a maxWorkers slot ............................ 429 worker_limit
  │    2. re-run the ACL check against the CURRENT config ...... 403 forbidden
  │    3. supervisor.spawn ..................................... retry
  │    4. initialize, budget = hibernate.wakeTimeoutMs ......... retry
  │    5. pick the resume spelling from descriptor.prefer.resume
  │         none available .................................... DEAD: 422 not_resumable
  │    6. OPEN the replay window; send; CLOSE on the response
  │    7. classifyResume(...) → the four states
  └─ the normal M0 prompt path
```

Step 2 exists because persisting worker records makes `daemon.stop()` non-final: a `cwdRoots` or token
change between runs must not resurrect a worker the present ACL forbids.

**Who writes it.** Steps 1-2 are the registry's (`maxWorkers`, the ACL) and steps 3-7 are the Worker's,
where 3-4 are its own spawn and 5-7 are one call to the injected `SessionStrategy.reopen` inside the replay
window. As with hibernate, the Land step writes the state transitions and the failure mapping of §15.5;
M1-WP-C writes the strategy, `attemptResume`, `classifyResume` and the tests (review R13). `performWake`
takes the `AcpLinkLike` as its FIRST parameter, because a helper that cannot name a link cannot make the
one call it exists for.

**The replay window (D6, confirmed by F16).** It opens when the resume request bytes reach stdin and closes
when its response resolves. The Worker owns it — a boolean set before the write and cleared in a
`finally`, so a **rejected** resume cannot leave the window open and mark the next live turn as replay. The
Normalizer's only job is to **copy the flag** onto every `EventInput` it emits for that update; it carries
no window state, and stays pure.

Two honest caveats, recorded in the descriptor and asserted by the compat suite:

- The replayed stream is **not** a faithful re-emission. claude-acp replays only `user_message_chunk` and
  `agent_message_chunk`; it does **not** replay `usage_update`, `tool_call*` or
  `available_commands_update`. `replay: true` marks *what the agent chose to re-send*, not *what happened*
  — the daemon's own event log stays authoritative for tool calls and usage.
- `session/load` and `session/resume` both return `{sessionId, modes, configOptions}`, contrary to the v1
  schema. The wake reads `configOptions` off that body exactly as it would off `session/new`.

**Replay policy (ruling M1-R5).** Default `mark_all`: replay envelopes are **stored, streamed and marked**.
`reduceTurn` skips them, the SDK's `stream()` filters them by default, and a client that wants the history
asks for it. `drop_duplicates` — dropping a replayed chunk whose `messageId` the log already holds, **before
`append()` so no seq is consumed** — is correct for claude-acp (F14: the id is byte-identical across
processes, while the *chunking* differs, so a per-chunk content hash could not do this) but rests on one
agent at one version, and a false-positive drop silently loses real history where a marked duplicate is
merely filterable. `ResumeReport.replayDropped` makes the choice visible either way.

### 15.4 `classifyResume` — pure, rule-numbered, table-tested

D2's four states are never a boolean, at any layer. The classifier is a pure function of
`{method, requestedSessionId, result, error, replayedEvents, durationMs, quirks}` and its rules are
numbered so `ResumeReport.rule` says **which line fired**.

| rule | Condition | outcome | hint | pointer |
| ---- | --------- | ------- | ---- | ------- |
| 0 | the error carries **no JSON-RPC code** (a dead transport) | `unknown` | `transport` | **kept** |
| 1 | text matches a never-rejected class: rate limit / quota / 429 / auth / expired / 5xx / `ECONN*`/`ETIMEDOUT`/`EAI_AGAIN` / overloaded. **Checked BEFORE rule 2**, because a rate-limit message could otherwise contain a session id and trip it | `rejected_transient` | `rate_limited` | **kept** |
| 2 | D2's permanent rule: `code ∈ {-32603,-32602,-32002,-32000}` **AND** text matches `session not found` \| `no session found` \| `unknown session`. **The conjunction is the entire safety margin** | `rejected_permanent` | `not_found` | **cleared** |
| 3 | `-32601` — the *method* is not implemented, not a rejection of this session; the preference order tries the next spelling and only an exhausted list is fatal | `unknown` | `method_not_found` | **kept** |
| 4 | anything else with a code | `unknown` | `cwd_mismatch` when `quirks.resumeRequiresSameCwd` and the error is a resource-not-found shape, else `unclassified` | **kept** |
| 5 | success, but `result.sessionId !== requested` — our pointer is worthless whatever the agent thinks it did, and we already hold the replacement | `rejected_permanent` | `silently_created` | replaced, `historyLost: true` |
| 6 | success, `quirks.resumeSilentlyCreates`, and the descriptor's `_meta` outcome path is absent or inconclusive | `unknown` | `unclassified` | **kept** |
| 7 | success, id matches (or a v1 `null` body) | `landed` | `ok` | **kept** |
| 8 | *deferred promotion*: the FIRST turn after an `unknown` wake ends `stopReason:"refusal"` with **zero activity** (no text, no thought, no tool call) | `rejected_permanent` | `refusal_no_activity` | **cleared** |

Rule 8 is a **promotion only**: it can never overturn a `landed`, it fires at most once per wake, and it is
implemented in the Worker (it needs a settled turn) rather than in the pure classifier.

**The `-32002` trap, and an honest correction to the corpus README.** The README's finding 10 says
claude-acp answers a **cwd mismatch on a live, healthy session** with
`{code:-32002, message:"Resource not found: <sessionId>", data:{uri:<sessionId>}}`. That string does not
match rule 2's text list, so it falls to rule 4, and the pointer survives — the safe outcome. **But F15
records that this response appears in no committed transcript**: `grep -c "Resource not found" *.jsonl` is
zero across all 11 files. It is an unrecorded observation. M1 therefore does two things:

1. a **unit test with the README's recorded shape** as a regression lock, asserting `unknown` and a kept
   pointer, and a companion assertion that `PERMANENT_TEXT` does **not** match `"Resource not found"` — so
   anyone who "helpfully" broadens the matcher reddens a test whose name explains why they must not. That
   single edit would turn a recoverable cwd mismatch into `rejected_permanent` and destroy a live session
   pointer;
2. a compat-suite case, `resume-cwd-mismatch`, that **re-observes it live** against the real agent, so the
   claim stops being a note and becomes reproducible evidence.

The classification is `unknown` and not `rejected_transient` (ruling M1-R6): both keep the pointer, so the
**action is identical**, and `unknown` is the honest label for "we could not tell" while `transient`
asserts a cause we have not verified. The diagnosis lives in `hint: "cwd_mismatch"`.

**How rule 1 reads D2, recorded because the wording differs (review R5).** D2 says of the rate-limit /
quota / auth / 5xx / network class "永不算 rejected"; rule 1 classifies exactly that class as
`rejected_transient`. The reading is **"never `rejected_permanent`"**, and D2's own table is the warrant:
it defines `rejected_transient` as "现在不行但 session 健康" **with the pointer kept**, which is precisely
a rate limit. The action D2 asks for — keep the pointer, fail this prompt — is what rule 1 produces. The
property test below is stated in exactly those terms, and it is the assertion that matters.

A companion **property test** asserts the rule whose violation destroys a live session pointer: over
generated errors, **no network / timeout / auth / quota / 5xx error ever yields `rejected_permanent`**.

### 15.5 `422 not_resumable` — the complete trigger table

| Situation | State after | HTTP | code |
| --------- | ----------- | ---- | ---- |
| `prompt` / `wake` on `hibernated`, `capabilities.resume.method === null` | `closed(not_resumable)` | **422** | `not_resumable` |
| `prompt` / `wake` on `hibernated`, `sessionId === null` (pointer previously cleared) | `closed(not_resumable)` | **422** | `not_resumable` |
| resume ⇒ `rejected_permanent` (rule 2 or 5) | `closed(not_resumable)`, pointer cleared | **422** | `not_resumable` |
| deferred promotion (rule 8) | `closed(not_resumable)` | — (async) | envelope only |
| `wakeFailures >= maxWakeFailures` | `closed(wake_failed)` | **422** | `not_resumable` |
| resume ⇒ `rejected_transient` | back to `hibernated`, pointer kept | 502 | `agent_error` |
| resume ⇒ `unknown` or `landed` | `ready` | 202 (prompt) / 200 (wake) | — |
| wake spawn failure | back to `hibernated` | 502 | `agent_error` |
| wake `initialize` timeout | back to `hibernated` | 504 | `agent_timeout` |
| wake would exceed `maxWorkers` | stays `hibernated` | 429 | `worker_limit` |
| wake fails the CURRENT ACL | `closed(acl_revoked)` | 403 | `forbidden` |
| `prompt` on `closed` | `closed` | 410 | `worker_closed` |

Every `422` carries the agent's JSON-RPC error verbatim in `acp` where there was one **and** the full
`ResumeReport` in `body.resume`, so `rule` tells an operator which line of the classifier fired.

**`rejected_permanent` is always a 422 in M1** (ruling M1-R7). There is no `new_session` fallback: silently
continuing in a context-free session is a correctness trap the caller cannot observe, D2 says "清掉 session
指针，按策略新建" and the policy layer is M2. `422` is the code DESIGN §5.4 reserved for exactly this.

`rejected_transient` fails the prompt loudly and **keeps the pointer**. That is the conservative half of
D2's "本轮可用新 session，不作废旧指针"; the other half needs the policy layer.

### 15.6 `DELETE` on a hibernated worker, and idempotency across a restart

`session/close` is skipped for a hibernated worker **without a special case**: `#link` is already null, and
the existing `canClose` conjunction is therefore false. We do not pay a 7-second npx cold start to politely
close a session the agent may keep on its own disk anyway. `CloseResult.sessionClosed` says so out loud
instead of leaving the caller to infer it.

Three levels of idempotency, and all three are needed:

1. same handle, same process — M0's `#closePromise` single-flight, unchanged;
2. same process, handle already resolved — `registry.delete` reuses `entry.closing`, unchanged;
3. **across a restart** — `registry.delete` finds no entry, reads the row, sees `state === "closed"` and
   returns the **persisted `CloseResult` byte-for-byte**, without constructing a worker at all. Recomputing
   it would report `treeGone: true` for a tree we never proved gone, which is exactly the optimism §6.6
   forbids. The fallback body, when a boot crashed mid-close and left no `closeResult`, is deliberately
   pessimistic on `treeGone`.

### 15.7 Daemon restart with live processes — they are orphans, and we say so

**The fact.** `PlatformOps.spawnOptions` on POSIX is `{detached: true}`: the child gets its own process
group and is **not** in the daemon's. A `SIGKILL`ed daemon leaves the agent reparented to init and still
running — holding its cwd, its API quota, and possibly a shell it started. On Windows M0 spawns
`detached: false` with no Job Object, so `PlatformOwnership.survivesDaemonKill` is already `true` there
too. A clean `daemon.stop()` reaps everything; only an **abnormal** exit produces orphans.

**The rule.** A restarted daemon must **never** signal a pid it cannot prove is the same process. Linux pid
reuse wraps at `pid_max`; killing a stale pid after a reboot is a coin flip on somebody else's process.

So a **fingerprint** is captured at spawn, while the process is known live, and stored in `ProcessInfo`:

| platform | token | note |
| -------- | ----- | ---- |
| linux | `linux:<btime>:<starttime-ticks>` from `/proc/stat` and `/proc/<pid>/stat` field 22 | both are kernel state and survive a daemon restart; `comm` may contain spaces and parentheses, so the fields are taken after the **last** `)` |
| darwin | `darwin:<lstart-epoch>` via `ps -o lstart= -p <pid>` through the injected `RunUtility` | no new spawn entry point (§6.1, F10) |
| win32 | **`null`, deliberately** | M0's Windows platform already refuses to claim `treeGone` because `taskkill /T` cannot prove it, and a reaper that cannot prove what it killed is exactly what that honesty contract forbids. Windows **reports** the orphan and does not touch it |

**Boot adoption**, run once inside `createDaemon()` before `start()` returns, over every row whose
`boot_id` is not the current one **and** whose state is live:

1. record the `OrphanRecord`; reap it **only** on a fingerprint match (`reapSkipped` otherwise:
   `"policy"` / `"unsupported_platform"` / `"fingerprint_mismatch"` / `"gone"`). A reap kills the **group**,
   not the leader — the same rule as §6.5, because the agent's MCP servers and shells are in that group;
2. **continue the log** — same worker, same seq space (§14.4) — with one `omni.error` saying the daemon
   restarted and this worker's process was not owned by this boot, so a client reconnecting with the cursor
   it held learns what happened **in band, at the next seq it expects**;
3. append `omni.worker_state` with `crashed: true` and reason **`daemon_restart`** when the session is
   resumable (state → `hibernated`) or **`orphaned`** when it is not (state → `closed`). A reader must be
   able to tell "your worker is asleep and will wake" from "your session is gone";
4. emit `omni.lease{op:"expired", how:"daemon_restart"}` — leases are not persisted (ruling M1-R8), and an
   **audited** transfer is the answer to D5's "抢占带审计" across a boot.

A worker that was `starting` when the daemon died has no `sessionId`, so it is not resumable ⇒ `closed` +
`orphaned`. Correct: there is nothing to resume, and a half-initialised process is precisely the kind that
must be reaped.

**Crash-during-hibernation matrix** — every edge converges:

| Event | Detection | Result |
| ----- | --------- | ------ |
| daemon dies while a worker is `hibernated` | `abandoned()` selects only **live** states | **no-op** — the row is already at rest and its `process_json` is null; the new boot simply adopts it |
| daemon dies mid-hibernate (process gone, envelope not yet appended) | the row says `ready`/`running` with a dead pid | adoption; `reapSkipped:"gone"`; converges on `hibernated` + `crashed`. **Same end state**, one extra `omni.error` |
| daemon dies mid-wake (spawned, handshake incomplete) | the row says `starting` with a live pid | reaped by fingerprint; `sessionId` and the resume method are still set ⇒ back to `hibernated`, and `wakeFailures` is **not** incremented — we never learned whether the resume would have worked |
| the agent forgot the session while we slept | only at the next wake | the four-state classifier. This is the classifier's *purpose*, and the honest limit D2 names: the Event Log保得住发生过什么，保不住 agent 进程内的模型上下文 |

Re-running adoption over an already-recovered database is a no-op, because the rows now carry the current
`boot_id`.

---

## 16. Lease — single controller, many observers (M1)

### 16.1 The rules, settled

| # | Rule |
| - | ---- |
| L1 | The lease is **registry state, not process state**. It survives hibernation *as a value* but hibernating **releases** it (DESIGN §3.2). It is **not persisted** across a daemon restart; adoption emits an audited `omni.lease{op:"expired", how:"daemon_restart"}` (ruling M1-R8). |
| L2 | **Gated**: `prompt`, `cancel`, `hibernate`, `wake`, and — in M2 — `config` and `interactions`. **Ungated: every `GET`, and the SSE stream.** That is observer mode, and it is why D5 says 任意数量客户端可 attach. |
| L3 | `DELETE /v1/workers/{wid}` requires the lease **or** `role:"admin"`. D5 does not list it, but deleting someone's worker is strictly worse than prompting it. |
| L4 | Identity is `{tokenId, clientId}`. `clientId: null` is "the token's default client" and is **shared** — a daemon genuinely cannot tell two header-less clients of one token apart. The SDK mints a ULID `Omni-Client-Id` per `connect()`, so two SDK clients of one token are two controllers. `lease.requireClientId: true` makes the header mandatory (`400`); it defaults **false** so raw `curl` and `curl-shapes.itest.ts` keep working. |
| L5 | An **unheld** lease is **implicitly acquired** by the first gated call (`how:"implicit"`). A worker nobody controls should not `423` the first client that reaches for it. |
| L6 | **Expiry never fires mid-turn.** `pinExpiry()` is taken when the turn goes `running` and released when it settles; a pinned lease reports `expiresAt: null`, because an expiry we will not honour is a lie an operator will plan around. |
| L7 | **Fencing.** `LeaseSnapshot.epoch` is monotonic per worker, +1 on every acquire / steal / expiry. A client may send `Omni-Lease-Epoch`; present and stale ⇒ `423`, **even from the right client id**. Without this a stolen-from client silently hijacks the new holder's turn. |
| L8 | **Steal** is always permitted for `role:"admin"` (D13), and for a same-token peer once the holder has been idle `lease.stealAfterIdleMs` (default 0 — D5's plain reading). It bumps the epoch and requires no ceremony beyond the audit. |
| L9 | Every transition appends `omni.lease` to the **worker's own event log**. That log **is** M1's lease audit trail; DESIGN §8's separate audit log is M2. |
| L10 | A `423` body **carries the holder**: `{code:"lease_held", message, lease:{holder, epoch, …}}`. A client that has to re-`GET` the worker to learn who holds it may be told about a third holder by the time it lands. |

### 16.2 Observer mode is proven, not asserted

An integration test opens two SDK `Server`s on one token with distinct client ids, has B `attach` and
stream, has A prompt, and asserts that **B saw every envelope of A's turn** — including the
`omni.lease` records — while B's own `prompt()` returned `423` with
`body.lease.holder.clientId === A`. This is the first thing omni-acp adds over the SDK's own `AcpServer`,
which 409s the second reader.

### 16.3 Why this costs `worker.ts` zero edits

F22: `Worker.prompt()` and `Worker.cancel()` **already** call `this.#deps.lease.assertHolder(who)` as their
first statement, and M0 wrote it that way on purpose ("the interface exists now so that every call site
already branches the way D5's enforcement will require, and M1 is a swap rather than a rewrite"). So D5
enforcement is a change to the factory the registry passes in, plus the epoch plumb-through on `ClientRef`.
That is what keeps the lease work package file-disjoint from the lifecycle one, and it is the M0 DI
paying off.

`alwaysGrantedLease` is **kept**, marked "fixtures and in-process callers only": `createDaemon({listen:null})`
has callers with no client identity.

### 16.4 Conformance

`runLeaseConformance` runs against the `Lease` object **and** against the HTTP surface, so the two cannot
drift: implicit acquire; `423` carrying the holder; steal bumps the epoch and the previous holder's next
call is `423`; a stale `Omni-Lease-Epoch` is `423`; a pin prevents mid-turn expiry under a `ttlMs` shorter
than the turn; hibernate releases; `attach` and SSE are never `423`; an expired lease is acquirable by
anyone; every transition emits exactly one `omni.lease`; `DELETE` requires the lease or admin. The matrix
is 3 clients × {same token, other token, admin} × {acquire, release, steal, expire} × {prompt, cancel,
wake, hibernate, delete, attach}.

M0's `two-workers-do-not-interfere.itest.ts` must still pass **untouched** — that is the compatibility bar
for the whole milestone.

---

## 17. Runtime descriptors, vendor extensions, and the probe (M1)

### 17.1 The one rule

**The descriptor is the only thing the Normalizer branches on.** There is no `if (agentId === "claude-acp")`
anywhere in the mapping path; a compatible fork is a YAML entry, not a commit (DESIGN §7). The
`descriptor-is-the-only-branch` guard greps `packages/core/src/normalizer/**` for agent-id string literals
and fails the build on a hit.

### 17.2 Resolution: builtin ⊕ config ⊕ probe

`resolveDescriptor(builtin, overlay, probe)` is a pure, table-tested merge in that precedence order, and
`RuntimeDescriptor.source` records which layers ran. `descriptorFingerprint()` is a sha256 over command ⊕
args ⊕ descriptor version ⊕ `agentInfo.name/version`; it is both the probe cache key and the audit key, and
it appears in `WorkerSnapshot.runtimeId` so a descriptor change is **visible in the log** rather than a
silent behaviour change. `DEFAULT_V1_PROFILE` is the generic zero-quirk descriptor, so a brand-new agent
works with no descriptor at all.

M1 ships **exactly one** non-default builtin, and every field of it is an observation from the corpus:

```yaml
claude-acp:                      # matches agentInfo.name /^claude-(code|agent)-acp$/, >=0.70.0 <1.0.0
  protocolVersion: 1             # F24: answers 1, speaks v2 in places
  prefer:                            # capability -> { spellings, onFailure }  (review R2)
    resume:    { spellings: [session/resume, session/load],               onFailure: fail }  # F18: both work
    setConfig: { spellings: [session/set_config_option, session/set_mode], onFailure: fail }  # F18: set_model is -32601 here
    setOptions:{ spellings: [session/set_options],                         onFailure: warn }  # -32601 here (08); a vendor extension, so a WARNING
    list:      { spellings: [session/list],                                onFailure: fail }
    close:     { spellings: [session/close],                               onFailure: fail }
  inboundAliases: {}                 # this agent spells `session/update` the standard way (review R4)
  quirks:
    resumeRequiresSameCwd: true      # README §10 — NOT in the committed transcripts (F15); compat re-observes
    loadReturnsBody: true            # F18
    diffIsFragment: true             # F19 — the flag that stops a consumer corrupting the file
    messageIdPresent: true           # F14
    toolCallUpdateIsSparse: true     # corpus finding 3
    permissionRequestShape: v1_tool_call
    sessionGrantKind: none           # no allow_session here ⇒ allow_once is the only safe allow (D4 rule 2)
    configIdField: configId          # F17 — learned from -32602 data.configId._errors
    unknownMethodErrorCode: -32601
  extensions:
    patch:     { pointer: "/claudeCode/toolResponse", as: patch,      dialect: claude_structured_patch }
    rateLimit: { pointer: "/_claude~1rateLimit",      as: rate_limit, dialect: claude_rate_limit }
  updates:
    available_commands_update: { map: null, stream: true, store: true, digest: true }   # F13, §14.6
    # every other kind: the §12.3 default
  errorRules:
    - { id: bad-config-value, code: -32603, dataPointer: "/details",
        dataMatches: "^Invalid value for config option ", classify: bad_request }
    - { id: unknown-method,   code: -32601, dataPointer: "/method",  classify: unsupported_method }
  unverified: [plan, agent_thought_chunk, current_mode_update, mcp, image_content, authenticate,
               tool_failure_on_merits]
```

`unverified` is not decoration: §18.3 makes the compat suite **refuse to assert** those rows for this agent,
so a corpus gap is reported as a gap rather than silently passing.

**This list is the SINGLE SOURCE OF TRUTH for claude-acp's corpus gaps** (review R8). §18.3's `capability`
skip source derives from it; `agents.local.yaml`'s `unverified:` key restates it verbatim so an operator
reading only the YAML sees the same seven rows; and M1-PLAN §5's definition-of-done points here rather than
re-listing a fifth, different subset. A row leaves this list when a real run exercises it — which is the
only event that may ever shorten it.

### 17.3 The vendor-extension registry — preference order, not one name per capability

F18 is the decisive fact: `session/set_mode` **and** `session/set_config_option` are both live on **one**
claude-acp process, and `session/set_model` — which multica saw on 8 runtimes — is `-32601` here. A registry
that maps one capability to one method name cannot express that.

- `mapRequest(canonical, params)` walks the capability's spellings in order, skipping any already known
  unsupported, and applies that spelling's rename / drop / add to the canonical params — e.g. dropping v2's
  `{type:"id"}` tag because v1's untagged arm is `{value}` (row 27).
- `noteUnsupported()` learns a `-32601` **per process** and never persists it: a version bump may add the
  method. The probe's `unsupportedMethods` seeds the set at construction.
- Detection matches on **code + `data.method`**, never on the message. The observed message is
  `"\"Method not found\": session/set_model"` — with embedded quotes — which is not a stable contract, and
  `data.method` carries the same information in a field.
- `classifyError` keys on **code + a JSON pointer into `data`**, because F17 shows a wrong *value* and a
  genuine internal error share `-32603` and are separated only by `data.details`.
- `onFailure` is per capability, and since review R2 it is a FIELD rather than a sentence:
  `MethodPreference.onFailure` (§5.1 `runtime.ts`). `setConfig` (which carries `set_model`) is `fail`;
  `setOptions` is `warn` (DESIGN §6.2). A `warn` failure adds a `TurnWarning` and does not fail the turn;
  a `fail` failure is an `OmniError` the caller sees.

### 17.4 What the probe learns, and how

One throwaway process through `Supervisor.spawn` — never a second spawn site (F10) — with
`clientCapabilities: {}`, then optionally `session/new` in a `mkdtemp` cwd and a side-effect-free method
battery. Corpus `08` is the empirical warrant that this is cheap: **11 probe calls, no `session/prompt`,
≈0 tokens.**

`classifyProbe` has one branch per shape the corpus actually produced (F17):

| response | verdict | what it teaches |
| -------- | ------- | --------------- |
| `-32601` + `data.method` | `not_implemented` | skip this spelling; try the next |
| `-32602` + `data.<field>._errors` | `implemented_other_params` | the method **exists** and the param is named `<field>` — this is how the probe learns `configId` rather than `optionId` |
| `-32603` + `data.details` | `implemented_bad_value` | the method exists and the *value* was wrong |
| any other error | `error` | recorded, not interpreted |
| a result | `implemented` | recorded with the shape |

Operability guarantees, each with a test:

1. **ACL first** — `auth.assertAgent(id)` before anything spawns, so a forbidden agent `403`s before a
   process exists.
2. **Not a spawn back door** — through `Supervisor.spawn` and `Catalog.toSpawnSpec`; `no-direct-spawn`
   stays green.
3. **Bounded** — `probe.maxConcurrent`; probes do not consume `maxWorkers` slots but do honour `signal`
   and `timeoutMs` and **reclaim their tree on every edge** (H5's rule).
4. **The cwd is a `mkdtemp`**, removed afterwards — never the caller's cwd, so a probe cannot mutate a
   workspace. The battery never sends a permission answer and never sends `allow_always`.
5. **Windows honesty** — the probe uses the same `resolveLaunch`, so an `npx` descriptor fails with §6.3's
   `bad_request` naming `process.execPath <module>`, not an `EINVAL` from a `.cmd` shim.
6. **Concurrent probes of one agent share one in-flight process**, and the cache round-trips through
   `<dataDir>/probes/<id>.json` at mode `0600`, invalidated by the descriptor fingerprint. `GET /v1/agents`
   serves `probed` with `args` still redacted — the probe result must not become the leak `catalog.ts`
   closed.

---

## 18. The compat suite — config-driven, one real agent today (M1)

### 18.1 The constraint, stated plainly

**The only real agent available on this machine is `claude-acp`** (`npx -y
@agentclientprotocol/claude-agent-acp@0.73.0`, a logged-in Claude Code). D7's regression target names five
v1 agents; four of them do not exist here and **must not be installed**. So the suite's agent list is
**configuration**, one entry present today, and adding the next agent is a YAML edit with **zero code
changes** — proven by a test, not by intention.

### 18.2 Shape

Every key below exists in `CompatAgentConfig` (`tests/compat/src/config.ts`) and in the two YAML files —
the schema, the example and the data are one thing, not three (review R3, R15).

```yaml
# tests/compat/agents.local.yaml   (real agents; opt-in, never CI)
version: 1
defaults: { handshakeTimeoutMs: 90000, turnTimeoutMs: 180000, cwdStrategy: mkdtemp }
agents:
  - id: claude-acp
    source: command                 # sdk-example | fixture | command
    enabled: true
    command: npx
    args: ["-y", "@agentclientprotocol/claude-agent-acp@0.73.0"]
    # §6.3: on win32 an npx .cmd shim is refused, so the direct-module form is required there.
    windows: { command: "${execPath}", args: ["${npxResolved:@agentclientprotocol/claude-agent-acp@0.73.0}"] }
    requires: { login: "claude-code" }          # unmet ⇒ "skipped: precondition", never a pass
    budgets: { initializeMs: 30000, resumeMs: 30000, turnMs: 300000 }
    expect:
      protocolVersion: 1
      capabilities: { loadSession: true }
      resumeMethod: session/resume
      unsupportedMethods: ["session/set_model", "session/set_options", "session/notification"]
      quirks: { resumeRequiresSameCwd: true }
    skip:                           # the `config` source; every reason >= 10 characters
      - { case: plan-update,         reason: "no todo/plan tool in this build; two deliberate attempts produced no `plan` (corpus 05/05b)" }
      - { case: agent-thought,       reason: "not emitted at default effort (corpus)" }
      - { case: current-mode-update, reason: "session/set_mode answers with the v2 config_option_update (corpus 08)" }
      - { case: git-patch,           reason: "diff blocks are widened fragments; structuredPatch is a vendor extension (F19)" }
    unverified:                     # the `capability` source; MIRRORS §17.2's descriptor, all seven
      [plan, agent_thought_chunk, current_mode_update, mcp, image_content, authenticate,
       tool_failure_on_merits]
  # add the next runtime here. Zero code changes.
```

`tests/compat/agents.ci.yaml` is the hermetic default: the SDK example agent plus the **eight
turn-completing testkit fixtures** — `crash` and `orphan` are deliberately absent, because neither
completes a turn and a case list whose first assertion is "the turn ended" cannot be satisfied by them
(review R20) — so the suite is green on three OSes and **never silently empty**.

Selection: `OMNI_COMPAT_CONFIG=<path>` (default `agents.ci.yaml`) ⊕ `OMNI_COMPAT_AGENTS=<csv>` filter ⊕ each
entry's `enabled`. `OMNI_COMPAT_REAL=1` enables entries that need a login or the network.
`OMNI_COMPAT_REQUIRE=1` **fails** a run whose selection is empty, so a mis-set variable cannot masquerade
as a pass. The suite body is `for (const a of selected) describe(a.id, () => runCases(a))`.

### 18.3 Skips are reported, with a source

Three skip **sources**, and every one prints a reason:

| source | meaning |
| ------ | ------- |
| `config` | an explicit `skip` entry in the YAML. `reason` is **required**, minimum 10 characters |
| `capability` | the **probe** says this runtime lacks what the case requires, or the row appears in the resolved descriptor's `unverified` (§17.2 — the single source of truth; the YAML's `unverified:` restates it and never shortens it) |
| `precondition` | `requires.login` / `requires.env` unsatisfied on this machine |

**A skip with no source is a failure, not a skip.** `compat-report.json` (agent × case × pass/skip/fail +
reason + source) is written unconditionally, uploaded as a CI artifact, and rendered in the job summary, so
`claude-acp`'s four corpus gaps stay visible in every run rather than decaying into silence.

### 18.4 The cases

| id | requires | asserts |
| -- | -------- | ------- |
| `handshake` | — | initialize + `session/new` within budget; `capabilities.raw` non-empty; `runtimeId` stable across two workers |
| `plain-turn` | — | exactly one `state_update{running}` … one `{idle}`; every agent update between them; non-empty `text`; `verdict:"ok"` |
| `tool-turn` | tools | a tool-using prompt yields ≥1 tool call whose final status is terminal, and `changes` matches the workspace. **The prompt is READ-ONLY** (corpus `02`: reads are auto-allowed): M1 wires exactly one permission responder and it is auto-DENY, so a write turn's `changes` is empty by construction and belongs to `permission-deny` instead (review R11) |
| `stream-resume` | — | drop the SSE mid-turn, reconnect with `?since=`; the union's **envelope frames** (`id:`/`event:`/`data:` triples) are identical to an uninterrupted observer's and gap-free. `: hb` comments and the `retry:` / `omni.stream_truncated` / `_overflow` / `_end` control frames are **excluded from the comparison and asserted separately** — segment 2 begins with `retry:` and may carry one `stream_truncated`. A raw byte comparison is unachievable against the checksum-frozen `sse.ts` (review R12) |
| `restart-survives` | — | stop the daemon, restart on the same `dataDir`, `?since=` returns the same envelopes with the same `seq`; a hibernated worker is adopted with `generation` preserved |
| `cancel-late-update` | cancel | corpus 14: an update arriving **after** `session/cancel` is ordered **before** `idle` |
| `tool-merge` | tools | a sparse `tool_call_update` never clears `kind` / `locations` / `title` (corpus finding 3) |
| `permission-deny` | permission | only an **offered** `optionId` is ever sent; `deniedToolCalls` non-empty while `stopReason === "end_turn"` (corpus findings 6, 7) |
| `hibernate-wake` | resume | a small `idleTimeoutMs` forces `hibernated`; the snapshot's `process` goes `null` **and the recorded pid answers `waitGone`** — the compat suite cannot reach `supervisor.live.size` (`createSupervisor` is in `@omni-acp/core`, which `tests/compat` does not depend on, and `createDaemon` never exposes its supervisor), and a dead pid is the stronger claim anyway (review round 1, item 5); the next prompt wakes with `resume.outcome === "landed"`; `seq` continues |
| `resume-cwd-mismatch` | resume | resume with a foreign cwd ⇒ **`unknown`, never `rejected_permanent`**; the pointer survives. **This case is what turns F15's unrecorded README claim into reproducible evidence** |
| `lease` | — | a second client's `prompt` is `423` with `body.lease.holder`; the observer keeps streaming; `steal` bumps the epoch; a stale epoch is `423` |
| `unknown-method` | — | an invented method returns the descriptor's `unknownMethodErrorCode` with `data.method` |
| `idempotent-map` | — | feeding the Normalizer's own v2 output back through it is a **fixed point** (F24) |

**Acceptance for M1 is that the identical SDK script produces the identical observable `TurnResult` shape
and the identical state-envelope sequence for every configured agent** — DESIGN §11's "同一份 SDK 代码对
五个 v1 目标 agent 行为一致" made mechanical, with `verdict` and `stopReason` as the equality surface rather
than raw payloads. With one real agent that criterion is **not falsifiable**, and §11.6 records that
honestly rather than claiming otherwise.
