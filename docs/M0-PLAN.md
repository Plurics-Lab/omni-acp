# omni-acp — M0 Delivery Plan

> Companion to `docs/CONTRACTS.md` (binding shapes) and `docs/DESIGN.md` v0.8 (binding decisions).
> This document says **who builds what, in which files, and what "done" means**.

---

## 1. The scaffold step — run once, alone, before any work package

**The scaffold is not a work package.** It is a single preparatory commit by one owner. It produces
everything that would otherwise be a guaranteed merge conflict, and it produces **every source file as a
signature-complete stub whose body throws**, so that `pnpm -r build && pnpm -r test` is green on all three
OSes before a single line of behaviour exists.

### 1.1 What the scaffold produces (and nobody else ever edits)

**Permanently scaffold-owned — frozen for the whole of M0:**

```
package.json  pnpm-workspace.yaml  pnpm-lock.yaml
tsconfig.base.json  tsconfig.json  vitest.config.ts
.npmrc  .gitattributes  .editorconfig  .prettierrc  eslint.config.js  .gitignore
.github/workflows/ci.yml
packages/*/package.json      packages/*/tsconfig.json      packages/*/vitest.config.ts
packages/*/src/index.ts                     ← re-export barrels, re-export-only
packages/protocol/src/contracts.ts          ← the cross-package seam (types only)
packages/protocol/src/acp.ts                ← the single ACP-SDK re-export point (types only)
packages/protocol/schema/{v1.schema.json, v2.schema.unstable.json, PROVENANCE.md}
tests/integration/package.json  tests/integration/tsconfig.json  tests/integration/vitest.config.ts
```

**Created by the scaffold, then handed over permanently:** every other `packages/**/src/**/*.ts` and
`tests/integration/src/*.itest.ts`, each with the exact signature from `CONTRACTS.md` §5 and a body of
`throw new OmniError("internal", "unimplemented: WP-n")`, plus one `it.todo()` per acceptance criterion
below. After the scaffold lands, **ownership of each stub transfers to its work package and no two work
packages ever touch the same file.**

### 1.2 Two hard freezes that make parallel work possible

- **Dependency freeze.** Every runtime and dev dependency of every package is declared by the scaffold. No
  work package adds, removes or bumps a dependency, or touches `pnpm-lock.yaml`. A needed dependency is a
  request to the scaffold owner, not an edit.
- **Barrel + contract freeze.** `packages/*/src/index.ts`, `protocol/src/contracts.ts` and
  `protocol/src/acp.ts` are written once and never edited. A change to any of them is a renegotiation of
  `CONTRACTS.md`, not a commit.

### 1.3 Scaffold exit criteria

1. `pnpm -r build && pnpm -r test` green on ubuntu-latest, macos-latest **and** windows-latest, with every
   body throwing and every test `todo`.
2. `tsc -b` is incremental: a no-op second run rebuilds nothing.
3. `@omni-acp/protocol` has no import from any other `@omni-acp/*` package; `contracts.ts` compiles
   standalone.
4. `ERROR_STATUS` is total over `OmniErrorCode` at **compile** time (a `Record`, not a `Partial`).
5. The dependency DAG of `CONTRACTS.md` §3.1 holds.
6. The CI workflow has been shown red once on a deliberately failing branch, so the failure path
   (artifact upload) is known to work.

---

## 2. Work packages

Six packages. After the scaffold lands they are **file-disjoint** and run in parallel. The only shared
artefact is `protocol/src/contracts.ts`, which is frozen.

WP‑1 is on the critical path: everything else's _tests_ consume `@omni-acp/testkit`. WP‑1 should land in two
commits — protocol runtime first, testkit second — so WP‑2…WP‑6 can start against the protocol half
immediately.

```
scaffold ──► WP-1 (protocol runtime + testkit) ──┬──► WP-2  supervisor
                                                 ├──► WP-3  event log + normalizer
                                                 ├──► WP-4  worker kernel
                                                 ├──► WP-5  daemon + HTTP
                                                 └──► WP-6  client + CLI + integration   ← join point
```

WP‑2…WP‑5 compile and unit-test against scaffold stubs and testkit fakes from day one; only the `*.itest.ts`
suites need the graph resolved.

---

### WP-1 — protocol runtime and testkit

**Owns exclusively**

```
packages/protocol/src/{ids,errors,events,worker,turn,control-plane,config}.ts
packages/protocol/test/**
packages/testkit/src/**
packages/testkit/fixtures/**
packages/testkit/test/**
```

(`protocol/src/{contracts,acp}.ts` and every `index.ts` remain frozen.)

**Depends on** nothing but the scaffold.

**Description.** Implements the runtime half of `@omni-acp/protocol`: ULID `IdGen` and the id
guards/assertions, `OmniError` + `ERROR_STATUS` + `OmniError.from`, the zod schemas for `DaemonConfig` /
`CreateWorkerRequest` / `PromptRequestBody` and `eventEnvelopeSchema`, `hashSecret`/`verifySecret`, and —
the substantial piece — **`reduceTurn` / `turnStatus`**, the one pure aggregator used by both the daemon and
the client SDK (`CONTRACTS.md` §5.1 `src/turn.ts`, DESIGN §5.5).

Then builds `@omni-acp/testkit`: `memoryStreamPair()`, `scriptedAgent()`, `fakeSupervisor()` /
`FakeAgentProcess`, `fakeClock()`, `seqIds()`, `nullLogger()`, `stubDaemon()`, the SSE parser/collector,
per-OS `isAlive`/`waitGone`, `sdkExampleAgentPath()`, the six `.mjs` fixture agents, and
`runEventLogConformance()`.

**Acceptance**

1. `ERROR_STATUS` is exhaustive over `OMNI_ERROR_CODES` at compile time and asserted at runtime; every
   `OmniError.from` input class maps as specified (`AcpRequestError` → `agent_error` carrying `acp`,
   AbortError → `agent_timeout`, unknown → `internal`).
2. `DaemonConfig.parse({tokens:[…]})` yields **every** default in `CONTRACTS.md` §5.1; `secret` **and**
   `secretSha256` together is a load error; `eventLog.driver:"sqlite"` parses but is documented as
   runtime-rejected; `CreateWorkerRequest` rejects an unknown key, a non-empty `mcp`, and
   `onUnresolved:"park"`.
3. `verifySecret` uses `timingSafeEqual`; `hashSecret` is a plain sha256 hex.
4. Template-literal ids discriminate: assigning a `DaemonId` where a `WorkerId` is expected fails to compile
   (a `@ts-expect-error` fixture).
5. **`reduceTurn` golden tests, ≥8 recorded transcripts**: text concatenation in seq order; tool-call upsert
   by `toolCallId` keeping the last status; `changes` extracted from `ToolCallContent{type:"diff"}` with
   `oldText ?? null` (F5); `usage` sourced from the **last `usage_update`**, never from `idle.usage` (F4);
   `interactions` collected from `omni.policy_decision`; `patch === null`; a turn terminated by
   `worker_state{closed}` yields `stopReason: null` and a non-null `error`; a turn id never seen yields
   `turnStatus.state === "unknown"` with `result: null`.
6. `reduceTurn` is pure: the same envelopes twice produce deep-equal results, and it **never reads
   `messageId`** — asserted by a transcript in which every chunk omits it (F3).
7. **testkit self-test**: `scriptedAgent()` over `memoryStreamPair()` drives a full
   `initialize` → `session/new` → `session/prompt` → `stopReason` exchange in <10 ms with no process.
8. `sdkExampleAgentPath()` resolves and `stat`s successfully on all three OSes, derived from the SDK's main
   entry — **not** from an unexported subpath (F8) and not via `URL.pathname`.
9. `fakeClock().advance()` fires timers deterministically; `seqIds()` produces `d_…001`, `w_…001`, `t_…001`.
10. Architecture guards land and pass: `sdk-version-pinned`, `dependency-direction`, `exports-are-stable`,
    `no-message-id`.

---

### WP-2 — Supervisor and process ownership

**Owns exclusively**

```
packages/core/src/process/**            spawn.ts platform.ts platform-posix.ts platform-windows.ts
                                        agent-process.ts stderr-tail.ts frame-limit.ts supervisor.ts
packages/core/test/process/**
```

**Depends on** WP‑1 (`@omni-acp/protocol` types + testkit fixture agents). Nothing from WP‑3/4/5/6.

**Description.** The OS layer of `CONTRACTS.md` §6: `createPlatformOps()` chosen once at construction,
`createSupervisor()` as the single `node:child_process` entry point, `resolveLaunch` with PATH/PATHEXT and
the `.cmd`/`.bat` refusal, the escalation ladder with tree-gone confirmation, the frame-limiting
`TransformStream`, and the UTF‑8-safe stderr tail ring.

**Acceptance**

1. `createSupervisor()` selects `PlatformOps` **at construction**; a source test asserts `platform-windows.ts`
   contains no `kill(-` and `platform-posix.ts` no `taskkill`.
2. **`no-direct-spawn` guard passes and is demonstrated failing on a planted violation during review**
   (multica GH #7522, F10).
3. Injected-`spawnFn` unit test asserts, on every OS: `shell: false`, `detached === (platform !== "win32")`,
   `windowsHide: true` on win32, `stdio: ["pipe","pipe","pipe"]`, and a complete `env`.
4. `AgentProcess.stream` drives a real ndJSON `initialize` round trip against `fixtures/agents/echo.mjs` on
   all three OSes, with the `ndJsonStream(write, read)` argument order pinned (F6).
5. **Tree kill, portable oracle**: `orphan.mjs` spawns a grandchild appending to `$MARKER_FILE` every 100 ms;
   after `terminate()`, the file **stops growing within 2 s**. Runs identically on all three OSes and needs
   no pid introspection — which is precisely what Windows cannot give us.
6. POSIX: `treeGone === true` and `kill(-pgid, 0)` throws `ESRCH` after `terminate()`.
   Windows: `treeGone === false`, `escalatedTo === "taskkill"`, `leaderExited === true` per `tasklist`.
7. `treeGone` is **never** `true` when confirmation timed out.
8. `resolveLaunch` throws `bad_request` naming `process.execPath <module>` when PATHEXT resolution lands on
   `.cmd`/`.bat` and `allowShimLaunch` is false; with it true, the `%ComSpec% /d /s /c` form spawns.
9. **Zombie case**: a fixture that exits while a grandchild holds the inherited stdout does **not** hang
   `terminate()`; `exitGraceMs` elapses, the force rung runs, the call returns within 3 s.
10. `terminate()` called twice concurrently runs the ladder once; both callers get the same `KillOutcome`.
11. Frame limit: a frame > `maxFrameBytes` errors the stdout stream; measured heap does not grow past the
    bound.
12. `StderrTail`: truncation lands on a UTF‑8 rune boundary, `snapshot()` hides an incomplete trailing rune,
    `finalize()` flushes a newline-less last line.
13. `supervisor.shutdown()` reclaims every live tree; `supervisor.live.size === 0`.

---

### WP-3 — Event log and Normalizer

**Owns exclusively**

```
packages/core/src/event-log/**          memory-log.ts
packages/core/src/normalizer/**         normalizer.ts turn-lifecycle.ts
packages/core/test/event-log/**
packages/core/test/normalizer/**
```

**Depends on** WP‑1 (`EventLog`/`Normalizer` contracts, `runEventLogConformance`, `fakeClock`). Nothing else.

**Description.** `createMemoryEventLog()` per `CONTRACTS.md` §8 — synchronous `append` as the sole assigner
of `seq`, frozen envelopes, ring eviction with an honest `tail`, gap-free `subscribe(since)` in one
synchronous critical section, bounded subscriber queues. And `createNormalizer()` — a **pure, timer-free,
async-free** `step()` reducer implementing exactly §7's two synthesized events plus the quiet window.

**Acceptance**

1. `runEventLogConformance("memory", …)` passes: monotone gap-free seq under 1 000 interleaved appends from
   two simulated turns; exclusive `since`; replay from `0`, mid, `head`, and below `tail`; five concurrent
   subscribers all seeing a strictly `+1` sequence; `close()` idempotent and ending every subscription;
   envelopes frozen.
2. Ring eviction raises `tail`; a subscriber with `since < tail` is signalled (the log surfaces it; the SSE
   frame is WP‑5's job).
3. A subscriber that never drains is terminated at `subscriberQueueSize` **and the producer's append latency
   is unchanged** — asserted, not eyeballed.
4. **`seq-single-writer` guard passes and fails on a planted assignment** outside `event-log/`.
5. `Normalizer` unit suite contains **no `await` and no timer** — mechanically asserted by a source scan.
   Table-driven over the full `TurnInput` × state cross-product, asserting `emit`, `scheduleTickAt`,
   `state`, `settled`.
6. `step({type:"prompt_sent"})` emits exactly one `state_update{state:"running"}` with `payloadVersion: 2`,
   matching the SDK's v2 `RunningStateUpdate` shape.
7. **Quiet window**: with `quietMs: 250`, an `agent_update` at T+400 after `prompt_result` at T is emitted
   **before** `idle`, and `idle` lands at T+650, not T. Deleting the quiet window makes this fail.
8. `hardMs` caps a permanently chatty agent: `idle` is emitted no later than `promptResultAt + hardMs`.
9. **`process_gone` emits `omni.error` and NO `state_update{idle}`** (`CONTRACTS.md` §7.3). `prompt_error`
   emits `omni.error` **then** `state_update{idle, stopReason:null}`.
10. Every non-`agent_update` terminal input leaves `state === "idle"` and `turnId === null`.
11. Pass-through preserves `_meta` by forwarding the object identity, and stamps `payloadVersion: 1`.

---

### WP-4 — Worker kernel: AcpLink, handshake, responder, lease, Worker

**Owns exclusively**

```
packages/core/src/acp/**                link.ts
packages/core/src/worker/**             worker.ts handshake.ts permission-responder.ts
packages/core/src/lease/**              always-granted.ts
packages/core/test/{acp,worker,lease}/**
```

**Depends on** WP‑1 (contracts + `fakeSupervisor` + `scriptedAgent` + `fakeClock`). **Consumes `Supervisor`,
`EventLog` and `Normalizer` only as interfaces** — it uses testkit fakes and an array-backed log, so it merges
independently of WP‑2 and WP‑3.

**Description.** The deepest package. `openAcpLink()` over `AgentProcess.stream`; the
`initialize{protocolVersion:1, clientCapabilities:{}}` → `session/new{mcpServers:[]}` handshake with the
budget and full tree reclamation on every failure edge; `createBaselineResponder()` implementing D4's six
hard rules; `alwaysGrantedLease()`; and `createWorker()` — the state machine, the prompt path, the tick
scheduler that drives the Normalizer, the crash classifier (§6.7), and cancel escalation (§6.5).

**Acceptance**

1. `createWorker()` against `scriptedAgent()` reaches `ready` and reports the real handshake capabilities
   (`loadSession: false` for the M0 fixture).
2. **`state_update{running}` is appended BEFORE the stdin write** — asserted by a fake `AgentProcess` that
   records the interleaving of `log.append` and the stream write.
3. `PromptAccepted.seq` equals the seq of that `state_update{running}`.
4. Handshake failure, timeout and abort each: reject with the correct `OmniError` code
   (`agent_error` / `agent_timeout`), append `omni.error` + `omni.worker_state{closed, …}`, and leave
   `fakeSupervisor.allTreesReclaimed() === true`.
5. `prompt()` on a `running` worker throws `worker_busy`; on a closed worker `worker_closed`. The
   check-and-set is synchronous: 50 concurrent prompts yield exactly one acceptance.
6. **`createBaselineResponder` — one test per D4 hard rule** (six tests): never fabricates an `optionId`;
   picks the offered `reject_once` in deny mode; picks `allow_once` (never `allow_always`) in allow mode;
   returns `response: null` (⇒ caller replies `-32603`) when nothing acceptable is offered; **never**
   `outcome:"cancelled"`; treats an unknown `kind` as non-grant.
7. Answering a permission appends `acp.interaction{status:"answered"}` **and**
   `omni.policy_decision{rule:"m0:auto-deny"}`.
8. **Crash mid-turn** emits `omni.error` (with a non-empty `stderrTail`) then
   `omni.worker_state{closed, agent_crashed, exit:{code}}`, and **no `state_update{idle}`**; the pending
   prompt path settles rather than hanging.
9. An unknown agent→client request receives `-32601` and the turn still completes.
10. `cancel()`: `session/cancel` is sent first and the process is **still alive** afterwards — a second
    `prompt()` succeeds. If no prompt response arrives inside `cancelGraceMs`, the worker escalates to
    `terminate({force:true})` and closes with `cancel_timeout`.
11. `close()` is idempotent, never leaves the turn promise pending, and returns a `CloseResult` whose
    `treeGone`/`leaderExited` come straight from the `KillOutcome`.
12. Illegal state transitions are unreachable through the public API (property test over the state table).

---

### WP-5 — Daemon library and HTTP adapter

**Owns exclusively**

```
packages/daemon/src/{create-daemon,types,registry,catalog,auth,ids-file,clock,logger}.ts
packages/daemon/src/http/{app,routes,auth-middleware,sse,errors}.ts
packages/daemon/test/**
```

(`packages/daemon/src/index.ts` is frozen.)

**Depends on** WP‑1 (protocol + `fakeSupervisor` + `stubDaemon`) and the WP‑2/3/4 factory **signatures**
(available as scaffold stubs). Its two halves are independently testable — the HTTP half against
`stubDaemon()`, the library half against `fakeSupervisor()` — so they can land as two commits.

**Description.** `createDaemon()`: config resolution, persistent `daemonId` in `dataDir`, `TokenStore` with
per-request SHA‑256 verification, `AuthContext` with the D13 visibility rule and the `realpath`+containment
`cwdRoots` check, `Catalog` as the only producer of `SpawnSpec`, `WorkerRegistry` with per-token and global
`maxWorkers`, `stop()` teardown ordering, and the `on("worker.state"|"worker.event")` emitter.

Then the HTTP adapter: **every route is parse (zod) → call one `daemon` method → serialize**, with a single
error mapper over `ERROR_STATUS` and the SSE writer of `CONTRACTS.md` §8.4. `daemon.fetch(Request)` is the
primary entry; binding a socket is what `listen != null` adds.

**Acceptance**

1. **`createDaemon({ listen: null })`** runs the entire worker lifecycle — create, prompt, events, turn,
   delete — with `daemon.url === null` and **no socket bound** (D15 constraint 1, proven at runtime).
2. **`http-has-no-logic` guard passes**: nothing under `src/http/**` imports `@omni-acp/core`, spawns, sets a
   timer, or mentions a `WorkerState` literal. A companion test with a recording `stubDaemon()` asserts each
   route calls **exactly one** daemon method.
3. Every route H1–H15 of `CONTRACTS.md` §2.1 exists with the stated status codes, and **every route test
   drives `daemon.fetch(new Request(...))` — zero `listen`, zero ports**.
4. Auth: missing / malformed / unknown / right-prefix-wrong-secret all → `401 {code:"unauthorized"}`;
   comparison is `timingSafeEqual`; the token never appears in a URL or a log line; `/v1/health` is the only
   unauthenticated route and returns `{ok:true}` and nothing else.
5. `authenticate()` is re-evaluated per call: mutating the token table changes the next verdict with no
   restart (DESIGN §8).
6. Visibility (D13): a `user` token sees only its own workers and gets `worker_not_found` — **not
   `forbidden`** — for another token's; an `admin` token sees all.
7. ACL: unknown agent → `400`; `realpath(cwd)` outside `cwdRoots` → `403`, including a **symlink-escape**
   case on POSIX; per-token and global `maxWorkers` → `429`, with the counter decremented on close
   _including a crash-close_.
8. `POST /v1/workers` returns `502` on a handshake JSON-RPC error and `504` when `timeoutMs` elapses, and in
   both cases `fakeSupervisor.allTreesReclaimed()` is true.
9. Error mapping is a table test over every `OmniErrorCode`; every body matches `{code, message, acp?}`.
   Malformed JSON, wrong content type and an unknown body key all yield `400`, never `500`.
10. **SSE**: exact `id:`/`event:`/`data:` bytes; `retry:` preamble; heartbeat cadence; `?since=` exclusive;
    `Last-Event-ID` fallback and `?since=` precedence; `omni.stream_truncated` when `since < tail` (stream
    stays open); `omni.stream_overflow` on a slow reader; `omni.stream_end` on worker close; client abort
    closes the subscription — asserted by `log.subscriberCount` returning to 0.
11. `DELETE` is idempotent (identical `CloseResult` twice); its body and `omni.worker_state{closed}` and
    `GET /v1/info` all carry the ownership honesty fields (§6.6).
12. `stop({graceful:true})` closes every SSE subscription, then every worker, then the socket; leaves zero
    live processes; is idempotent.
13. `daemonId` is a `d_`-prefixed ULID persisted in `dataDir` and stable across `createDaemon` calls.
14. `Daemon` structurally satisfies the interface — an explicit `const _: Daemon = daemon` in a test.

---

### WP-6 — Client SDK, CLI, and the integration suite

**Owns exclusively**

```
packages/client/src/{omni-acp,server,worker,transport,sse-parse,local}.ts
packages/client/test/**
packages/cli/src/{bin,main,args,yaml-config}.ts
packages/cli/test/**
tests/integration/src/**
```

(`packages/client/src/index.ts` is frozen.)

**Depends on** WP‑1 (protocol types, `reduceTurn`, `stubDaemon`) plus the HTTP contract of §2.1. Unit tests
run against `stubDaemon()`'s `fetch` and a fake transport; the `*.itest.ts` suites are the **join point** and
need WP‑2…WP‑5 merged.

**Description.** `OmniACP.connect()` (one `GET /v1/whoami`, result exposed as `server.me`), the `Server` and
`Worker` handles, the SSE reader with `?since=` resume, `prompt()` implemented as _POST → subscribe at
`accepted.seq - 1` → collect until this turn is terminal → `reduceTurn()` locally_ (the same pure function
the daemon uses), `stream()`, SDK-side prompt serialization, and `OmniACP.local({adopt:"never"})` via dynamic
`import("@omni-acp/daemon")`.

Then the CLI shell: pure `parseArgs`, pure `yamlToDaemonConfig` (the **only** place YAML exists, D15
constraint 3), and `main()` with signal handling.

Then the integration suite of §4.

**Acceptance**

1. `OmniACP.connect({ fetch: daemon.fetch })` exercises the whole SDK against an in-process daemon with
   **no network at all**; `connect()` issues exactly one request (`GET /v1/whoami`).
2. **`prompt()` returns a `TurnResult` deep-equal to `GET /v1/workers/{id}/turns/{turnId}`'s `result`** — the
   shared-`reduceTurn` guarantee (DESIGN §5.5), asserted directly.
3. `prompt()` subscribes with `since = accepted.seq - 1`, and **settles when the worker closes mid-turn**
   rather than waiting for an `idle` that will never come (§7.3).
4. SSE reconnect: a chaos test that drops the connection 5× mid-turn still yields a gap-free, duplicate-free
   envelope sequence identical to a reference full-replay stream.
5. `409` surfaces as a thrown `OmniError("worker_busy")` when `{queue:false}`; with the default
   `{queue:true}`, two back-to-back `prompt()` calls both succeed in order.
6. `stream()` yields `text` deltas in seq order and a terminal `done` whose result deep-equals `prompt()`'s.
7. **`client-has-no-daemon-import` guard passes**; importing the built `@omni-acp/client` with
   `@omni-acp/daemon` absent from `node_modules` works, and `local()` then throws an error whose message
   contains `npm i @omni-acp/daemon` — not a module-not-found stack (D14).
8. `local({adopt:"never"})` starts an embedded daemon on `127.0.0.1:0`, `server.url` matches
   `http://127.0.0.1:\d+`, a raw `fetch` with a bad token gets `401` (proving it is real loopback HTTP, not
   an in-memory shortcut), and `server.close()` stops the daemon and reclaims the trees.
   `adopt:"prefer"|"require"` and `detach:true` throw with a message naming M3.
9. `parseArgs` table test; an unknown flag exits `2` with usage; CLI flags override YAML.
10. `omni-acp start --port 0` as a **real child process** on all three OSes: `/v1/health` returns 200; SIGINT
    (POSIX) / SIGINT + SIGBREAK (Windows) calls `daemon.stop({graceful:true})` exactly once, exits 0, and
    leaves no orphan processes.
11. The integration suite of §4 is green on all three OSes.

---

## 3. Ownership map (no path appears twice)

| Path                                                                                                                                                               | Owner                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------- |
| root configs, `.github/**`, all `package.json` / `tsconfig.json` / `vitest.config.ts`, all `src/index.ts`, `protocol/src/{contracts,acp}.ts`, `protocol/schema/**` | **scaffold (frozen)** |
| `packages/protocol/src/{ids,errors,events,worker,turn,control-plane,config}.ts`, `packages/protocol/test/**`, `packages/testkit/**`                                | WP‑1                  |
| `packages/core/src/process/**`, `packages/core/test/process/**`                                                                                                    | WP‑2                  |
| `packages/core/src/{event-log,normalizer}/**`, `packages/core/test/{event-log,normalizer}/**`                                                                      | WP‑3                  |
| `packages/core/src/{acp,worker,lease}/**`, `packages/core/test/{acp,worker,lease}/**`                                                                              | WP‑4                  |
| `packages/daemon/src/**` (minus `index.ts`), `packages/daemon/test/**`                                                                                             | WP‑5                  |
| `packages/client/src/**` (minus `index.ts`), `packages/client/test/**`, `packages/cli/src/**`, `packages/cli/test/**`, `tests/integration/src/**`                  | WP‑6                  |

Guard tests live with their owner: `no-direct-spawn` → WP‑2, `seq-single-writer` → WP‑3,
`http-has-no-logic` → WP‑5, `client-has-no-daemon-import` → WP‑6, and
`sdk-version-pinned` / `dependency-direction` / `exports-are-stable` / `no-message-id` → WP‑1.

---

## 4. The integration acceptance script

`tests/integration/src/two-workers-do-not-interfere.itest.ts` — DESIGN §11's M0 criterion, made mechanical.
Tier‑3 fixture: the SDK's own unmodified `dist/examples/agent.js`, launched as
`process.execPath <sdkExampleAgentPath()>` so it is shim-free on all three OSes (F8, D11).

**Setup.** Two `mkdtemp` directories under `os.tmpdir()`, both registered as `cwdRoots` on a single token.
`createDaemon({ listen: {host:"127.0.0.1", port:0}, tokens:[…], agents:[{ id:"example", command: process.execPath, args:[sdkExampleAgentPath()] }] })`, then `daemon.start()`, then
`OmniACP.connect({ url: daemon.url, token })`.

**Act.** Create both workers concurrently (`Promise.all`), then prompt both concurrently:
`Promise.all([w1.prompt("who are you?"), w2.prompt("who are you?")])`.

**Assert — identity and isolation**

- `w1.id !== w2.id`, `w1.sessionId !== w2.sessionId`, `w1.snapshot.process.pid !== w2.snapshot.process.pid`.
- `r1.turnId !== r2.turnId`.
- Each worker's full event log contains **only** its own `workerId` and `sessionId`, and its `seq` sequence
  is exactly `1..n` with no gaps — the non-interference claim proven on the logs, not on vibes.

**Assert — the turn actually ran to completion**

- `stopReason === "end_turn"` for both.
- `text` contains _"I'll help you with that"_ **and** _"I'll skip the configuration update"_ — the second
  string is only produced by the agent's `reject` branch, so it proves the permission request was genuinely
  answered (F1). This is a stronger assertion than the allow branch.
- `toolCalls.map(t => t.toolCallId)` is `["call_1", "call_2"]`, both terminal.
- `interactions` contains exactly one record with `{decision:"deny", rule:"m0:auto-deny", optionId:"reject"}`.
- `changes` and `patch` are `[]` and `null` (M0, D8).
- Each log contains exactly one `state_update{running}` and one `state_update{idle}` for that turn, with
  `seq(running) < seq(every agent update of that turn) < seq(idle)`.
- `await w1.turn(r1.turnId)` returns a `result` **deep-equal** to `r1` (DESIGN §5.5, one aggregate).

**Assert — teardown**

- `await w1.close()` / `w2.close()` return `CloseResult`; on POSIX `treeGone === true`, on Windows
  `treeGone === false` and `leaderExited === true` — the _reported_ value is asserted to match reality via
  `waitGone(pid)`, never an impossible guarantee.
- `daemon.stop()` leaves `supervisor.live.size === 0`.

**Companion integration files** (same suite, same fixtures):

| File                          | Proves                                                                                                                                                      |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `curl-shapes.itest.ts`        | M0's own milestone wording — raw `fetch` against every route, asserting the literal JSON shapes of §2.1 with no SDK in the loop                             |
| `library-only.itest.ts`       | `createDaemon({listen:null})` runs the full lifecycle with `url === null` (D15 constraint 1, at runtime)                                                    |
| `sse-resume.itest.ts`         | drop the stream mid-turn, reconnect with `?since=`, union is gap-free and equals a full-replay reference                                                    |
| `crash.itest.ts`              | `crash.mjs`: `prompt()` settles rather than hangs; `worker_state{closed, agent_crashed}`; **no `state_update{idle}`**; tree reclaimed                       |
| `cancel.itest.ts`             | `session/cancel` → `stopReason:"cancelled"`, process still alive, a second prompt succeeds; `slow.mjs` drives the `cancelGraceMs` escalation to a tree kill |
| `tree-kill.itest.ts`          | `orphan.mjs` marker-file oracle — the grandchild stops writing within 2 s of `DELETE`, on all three OSes                                                    |
| `handshake-failures.itest.ts` | `502` and `504` paths, with no orphan process in either case                                                                                                |
| `local-mode.itest.ts`         | `OmniACP.local({adopt:"never"})` end-to-end against the SDK example agent, plus the bad-token `401` proving real loopback HTTP                              |
| `cli-start.itest.ts`          | `omni-acp start --port 0` as a real child; health 200; clean signal shutdown; no orphans                                                                    |

**Budget.** The SDK example agent costs ~5 s per turn (5 × 1 000 ms of simulated latency); two in parallel
≈ 6 s. Integration `testTimeout: 60_000`, `retry: 1`, whole suite comfortably under 3 minutes per OS.

---

## 5. Definition of done for M0

1. `pnpm -r build && pnpm -r test` green on ubuntu-latest, macos-latest and windows-latest.
2. Every acceptance item in §2 passes, and every architecture guard in `CONTRACTS.md` §10.2 passes —
   with `no-direct-spawn` and `seq-single-writer` each demonstrated failing on a planted violation.
3. `two-workers-do-not-interfere.itest.ts` green against the unmodified SDK example agent on all three OSes.
4. Zero orphan processes after any suite, on any OS.
5. No file in the repository has two owners, and `pnpm-lock.yaml` has exactly one author.
