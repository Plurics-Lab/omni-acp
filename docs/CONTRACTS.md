# omni-acp — M0 Code-Level Contract

> Status: **binding** · 2026-09-03 · derived from `docs/DESIGN.md` v0.8 (D1–D15 settled) and
> `docs/research/2026-09-03-multica-and-registry.md`.
>
> This document is the single source of truth for M0 **shapes**. Every signature in §5 becomes a
> scaffold stub verbatim. Work packages (see `docs/M0-PLAN.md`) fill bodies in; they do not change
> signatures. A signature change is a renegotiation of this document, not a commit.
>
> Where D1–D15 already decided something, this document only makes it typed. Where the three
> M0 proposals disagreed, §11 records the decision and the one-line reason.

---

## 0. Facts verified against the artefacts (not recalled)

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

---

## 2. M0 slice — what is IN

### 2.1 HTTP surface (`/v1`)

All routes except `GET /v1/health` require `Authorization: Bearer <secret>`. `Omni-Client-Id` is recorded
for audit and future lease attribution; it is **not** a visibility boundary (D13).

| #   | Route                                      | Contract                                                                                                                                                                                                                                                                              |
| --- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1  | `GET /v1/health`                           | **Unauthenticated.** `200 {"ok":true}`. Liveness only — no daemonId, no version, no ACL data.                                                                                                                                                                                         |
| H2  | `GET /v1/info`                             | Authenticated. `200 DaemonInfo` — persistent `daemonId`, version, platform, node, `protocolVersions:[1]`, `ownership` (§6).                                                                                                                                                           |
| H3  | `GET /v1/whoami`                           | `200 WhoAmIResponse`. The only call `OmniACP.connect()` makes (DESIGN §8).                                                                                                                                                                                                            |
| H4  | `GET /v1/agents`                           | `200 { agents: AgentCatalogEntry[] }` from static config. `probed: null` in M0.                                                                                                                                                                                                       |
| H5  | `POST /v1/workers`                         | **Synchronously ready**: spawn → `initialize` → `session/new` → `201 WorkerSnapshot{state:"ready"}` with the real handshake `capabilities`. Handshake JSON‑RPC error → `502 agent_error`; budget exceeded → `504 agent_timeout`. **Both reclaim the process tree before responding.** |
| H6  | `GET /v1/workers`                          | `200 { workers: WorkerSnapshot[] }`, filtered by D13 visibility.                                                                                                                                                                                                                      |
| H7  | `GET /v1/workers/{wid}`                    | `200 WorkerSnapshot`, or `404 worker_not_found` (also when invisible — never leak existence).                                                                                                                                                                                         |
| H8  | `POST /v1/workers/{wid}/prompt`            | `202 PromptAccepted { turnId, seq }`. `409 worker_busy` unless state is `ready`; `410 worker_closed`; content pre-checked against the handshake `promptCapabilities` → `400 bad_request`. **M0 accepts only blocks whose `type` is `"text"`**; any other block is `400 bad_request` (§2.3, review R12).                                                                                             |
| H9  | `POST /v1/workers/{wid}/cancel`            | `202 {}`. ACP `session/cancel` notification, then bounded escalation (§6.5). Idempotent; a no-op when not `running`.                                                                                                                                                                  |
| H10 | `GET /v1/workers/{wid}/events?since=<seq>` | SSE. Synchronous backlog replay then live tail (§8).                                                                                                                                                                                                                                  |
| H11 | `GET /v1/workers/{wid}/turns/{turnId}`     | `200 TurnStatus`. Unknown turn → `state:"unknown", result:null` (**not** a 404 — §11 D29).                                                                                                                                                                                            |
| H12 | `DELETE /v1/workers/{wid}`                 | Best-effort `session/close` (skipped unless advertised) → kill tree → `200 CloseResult { workerId, state:"closed", leaderExited, treeGone }`. **Idempotent**: a second call returns the same body.                                                                                    |
| H13 | Auth middleware                            | SHA‑256 of the bearer secret compared with `timingSafeEqual`, **re-evaluated on every request, never cached** (DESIGN §8). Token never appears in a URL or a log line.                                                                                                                |
| H14 | ACL                                        | Agent allowlist and `cwdRoots` (after `realpath`) → `403 forbidden`. Per-token and global `maxWorkers` → `429 worker_limit`.                                                                                                                                                          |
| H15 | Error body                                 | `{ code, message, acp?: { code, message, data } }`, produced by exactly one mapper over `ERROR_STATUS` (§9).                                                                                                                                                                          |

### 2.2 Library / core

| #   | Item                                                                                                                                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1  | `createDaemon(config, deps?)` — every capability reachable **in-process**; `listen: null` ⇒ no socket, `daemon.url === null`, full worker lifecycle still works (D15 constraint 1, proven at runtime). An in-process caller takes its `AuthContext` from `daemon.authContextFor(tokenId)` — never by forging a `Bearer` header (review R10).                                                                                                                                |
| L2  | `daemon.fetch(Request): Promise<Response>` — the HTTP adapter as a web-standard handler, usable with **no port bound**. Every route test uses it.                                                                                                                                                                                     |
| L3  | **Supervisor**: one `spawn()` entry point (test-enforced, F10), platform ops chosen at construction, escalation ladder, tree-gone confirmation, stderr tail ring, crash detection.                                                                                                                                                    |
| L4  | **Worker Registry**: create/get/list/delete, D13 visibility, id allocation, teardown on `daemon.stop()`.                                                                                                                                                                                                                              |
| L5  | **Event Log**: in-memory ring per worker, **synchronous** monotonic `seq`, gap-free `subscribe(since)`.                                                                                                                                                                                                                               |
| L6  | **Normalizer**: a pure `step()` reducer that synthesizes **only** the v2 prompt lifecycle (`state_update{running\|idle}`). Everything else is forwarded verbatim (§7).                                                                                                                                                                |
| L7  | **Baseline permission responder** (F1): D4 hard rules 1/3/4/5/6, no rule engine. Fixed auto-**deny**.                                                                                                                                                                                                                                 |
| L8  | **Lease**: interface present, `alwaysGrantedLease` implementation. D5 enforcement is M1.                                                                                                                                                                                                                                              |
| L9  | **`reduceTurn`** — one pure aggregator in `@omni-acp/protocol`, used by the daemon for H11 **and** by the client SDK for `prompt()`. DESIGN §5.5 by construction, not by convention.                                                                                                                                                  |
| L10 | **`@omni-acp/client`**: `OmniACP.connect()`, `Server.createAgent/attach/workers/agents/close`, `Worker.prompt/stream/events/cancel/close/on`.                                                                                                                                                                                         |
| L11 | **`OmniACP.local({adopt:"never", detach:false})` implemented**, and `adopt` **defaults to `"never"` in M0** — dynamic `import("@omni-acp/daemon")` → `createDaemon` → `start` on `127.0.0.1:0` → generated admin token → ordinary `connect()` over loopback. Other `adopt` modes and `detach:true` throw. This is the M0 e2e harness, so D14+D15 share one code path from day one. |
| L12 | **`@omni-acp/cli`**: `omni-acp start [--config f.yaml] [--host] [--port] [--data-dir]`, `--version`, `--help`; SIGINT/SIGTERM/SIGBREAK → `daemon.stop({graceful:true})` once.                                                                                                                                                         |
| L13 | Three-OS CI matrix, green, from the first commit.                                                                                                                                                                                                                                                                                     |

### 2.3 What is OUT of M0 — deferred, one line each

| Deferred                                                                                                                                                                                                                            | To                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| Full v1→v2 map: `tool_call`→`tool_call_update`, `plan`→`plan_update`, `current_mode_update`→`config_option_update`, `messageId` backfill, diff→`patch`, bool→object capabilities, MCP `type` injection, `authenticate`→`auth/login` | M1 (DESIGN §6.1)        |
| `session/load` / `session/resume`, `replay:true` marking, resume four-state, `hibernated`, `422 not_resumable`                                                                                                                      | M1 (D2/D6)              |
| Event-log persistence (`node:sqlite`), 7-day retention, restart-survivable `?since=`                                                                                                                                                | M1 (D6)                 |
| Lease acquire/release/steal, `423 lease_held` (code reserved, never returned in M0)                                                                                                                                                 | M1 (D5)                 |
| Turn close-out beyond the quiet window (close stdin → drain with grace → cancel)                                                                                                                                                    | M1 (DESIGN §6.2)        |
| Vendor extension registry (`session/set_model`, `session/notification` alias), Runtime descriptors, quirk table                                                                                                                     | M1/M2 (DESIGN §6.2, L1) |
| Policy rule engine, `onUnresolved: park\|fail`, `policyCeiling` enforcement, `POST …/interactions/{reqId}`, `requires_action`                                                                                                       | M2 (D4/D10)             |
| `resource_link` / embedded-resource path containment inside prompt content (DESIGN §5.1) — M0 accepts only `type:"text"` blocks, so there is no unchecked path surface to contain (review R12) | M2 (DESIGN §5.1) |
| `adopt: "prefer" \| "require"` — `daemon.json` discovery/reuse. M0's default is `adopt: "never"`; the other modes throw `bad_request` naming M3 (review R13) | M3 (D14) |
| `mcpServers` presets + `mcpCapabilities` filtering — M0 **always sends `mcpServers: []`**                                                                                                                                           | M2 (DESIGN §8)          |
| Per-request `CreateWorkerRequest.env` + blacklist, credential store                                                                                                                                                                 | M2                      |
| Webhooks, `POST /v1/runs`, Run API, idle watchdog dual budget                                                                                                                                                                       | M2 (D9, L8)             |
| git diff provider → `TurnResult.patch` (`null` in M0)                                                                                                                                                                               | M2 (D8)                 |
| `POST /v1/workers/{wid}/config`, `GET /v1/fs/*`, TLS/mTLS, token issue/revoke                                                                                                                                                       | M2–M4                   |
| `POST /v1/agents/{id}/probe`, `agents: "auto"` discovery, registry install                                                                                                                                                          | M1 / M4 (DESIGN §7)     |
| `Fleet`, `server.runs`                                                                                                                                                                                                              | M3                      |
| `/acp/{agentId}`, `AcpServer`, WebSocket, `@omni-acp/bridge`, Client Host `fs/*`+`terminal/*`, v2→v1                                                                                                                                | M4 (D12/D3)             |
| cgroup v2 / Job Object resource limits                                                                                                                                                                                              | M2+                     |

**Acceptance (DESIGN §11, made mechanical):** against `dist/examples/agent.js`, create two workers with
different `cwd`s, prompt each once **concurrently**, both return `stopReason:"end_turn"`, both texts contain
the reject-branch sentence (proving the permission was actually answered), the two `sessionId`s and pids
differ, every envelope in each worker's log carries that worker's `workerId` and — where `sessionId` is
non-null — that worker's `sessionId` (the pre-handshake prefix is frozen at `null`, §8.2 rule 3), the `seq`
is gap-free from 1, and both process trees are reaped after `close()`. Full script in `docs/M0-PLAN.md` §4.

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
    ├── testkit/      @omni-acp/testkit       PRIVATE, never published
    │   ├── src/{index,memory-stream,scripted-agent,fake-supervisor,fake-clock,seq-ids,
    │   │         stub-daemon,sse,process-tree,paths,event-log-conformance}.ts
    │   └── fixtures/agents/{echo,crash,slow,chatty,orphan,noisy}.mjs
    ├── core/         @omni-acp/core          published
    │   └── src/
    │       ├── index.ts                       re-export barrel (frozen by scaffold)
    │       ├── process/{spawn,platform,platform-posix,platform-windows,
    │       │            agent-process,stderr-tail,frame-limit,supervisor}.ts
    │       ├── event-log/memory-log.ts
    │       ├── normalizer/{normalizer,turn-lifecycle}.ts
    │       ├── acp/link.ts
    │       ├── worker/{worker,handshake,permission-responder}.ts
    │       └── lease/always-granted.ts
    ├── daemon/       @omni-acp/daemon         published
    │   └── src/
    │       ├── index.ts                       frozen barrel
    │       ├── {create-daemon,types,registry,catalog,auth,ids-file,clock,logger}.ts
    │       └── http/{app,routes,auth-middleware,sse,errors}.ts
    ├── client/       @omni-acp/client         published
    │   └── src/{index,omni-acp,server,worker,transport,sse-parse,local}.ts
    └── cli/          @omni-acp/cli            published, bin `omni-acp`
        └── src/{bin,main,args,yaml-config}.ts
└── tests/integration/  @omni-acp/integration-tests   PRIVATE
    └── src/*.itest.ts
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
| 422  | `not_resumable`          | **reserved** — never returned in M0 (M1)                                                                                                                                                                    |
| 423  | `lease_held`             | **reserved** — never returned in M0 (M1)                                                                                                                                                                    |
| 429  | `worker_limit`           | per-token or global `maxWorkers` exceeded                                                                                                                                                                   |
| 502  | `agent_error`            | spawn failure, handshake JSON-RPC error, mid-turn crash, oversized frame                                                                                                                                    |
| 504  | `agent_timeout`          | handshake exceeded `timeoutMs`                                                                                                                                                                              |
| 500  | `internal`               | anything unclassified; the message is generic, the detail is logged not returned                                                                                                                            |

No codes are added to DESIGN §5.4's settled table. Two consequences:

- **Unknown agent id → `400 bad_request`**, not a new `agent_not_found`: an agent id is a request parameter,
  which is exactly what DESIGN's 400 row describes.
- **Unknown turn id → `200 { state:"unknown", result:null }`**, not a 404: turn state is _derived from the
  log_, and after eviction "unknown" is the honest answer. `TurnState` carries it (§5.1 `src/turn.ts`).
- **Client-side unimplemented features** (`local({adopt:"prefer"})`, `lease.acquire()`) throw
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
| `no-message-id`               | no source file outside `packages/protocol/src/acp.ts` reads `messageId` (F3).                                                                       |
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

### 11.1 Grading

| Proposal      | Strongest idea (grafted)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Grade |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| **P1 (api)**  | **The `ROUTES`/op-table discipline and the discovery that v2's `SessionUpdate` has an open arm (F2)** — that single observation is what lets M0 forward v1 payloads through the _canonical_ type instead of inventing a parallel one, and it is why `NormalizedSessionUpdate = V2SessionUpdate` is honest rather than aspirational. Also grafted: `changes` extraction in M0 (F5), the single `src/acp.ts` SDK re-export point, the `?since=` truncation notice, and the `DistributiveOmit` trick that makes stamping a `seq` a compile error. **A**− (docked for the exhaustive `RouteDescriptor`+`satisfies` machinery, which is ceremony a 12-route surface does not repay, and for synthesizing a fake `idle` on crash). |
| **P2 (os)**   | **`PromptAccepted.seq` and "a crash never synthesizes `idle`."** The first removes the subscribe/prompt race with one integer and no pre-existing subscription; the second is the difference between an event log you can trust and one that lies in exactly the case you most need it. Also grafted: the whole Windows analysis (`detached` ⇒ `DETACHED_PROCESS`, the `.cmd`/CVE‑2024‑27980 trap, `treeGone` never optimistic, the three-place honesty contract), the escalation ladder with `closeStdin` first, `stdoutEnded` vs `exited` as two independent signals, and the warning not to copy multica's per-turn stdin close. **A**.                                                                                   |
| **P3 (test)** | **`@omni-acp/testkit` + the shared pure `reduceTurn`.** The testkit is what makes five work packages genuinely file-disjoint (WP‑4 tests against `FakeSupervisor`, WP‑5's HTTP half against `stubDaemon`) and it is why the contracts must live in `protocol` (the DAG argument, §4 — I checked it and it is correct). `reduceTurn` shared by daemon _and_ client satisfies DESIGN §5.5 **by construction** at lower latency than a second round trip. Also grafted: the pure `Normalizer.step()` reducer (timer-free, table-testable), `daemon.fetch(Request)` as the primary seam, `TurnState:"unknown"` (which removes the need for a new error code), and the out-of-band SSE control frames. **A**.                     |

### 11.2 Rulings

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

### 11.3 Risks accepted, with their mitigation

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
