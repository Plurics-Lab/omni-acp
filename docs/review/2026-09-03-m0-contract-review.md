# M0 契约 + 骨架评审（2026-09-03）

来源：workflow `m0-contracts-scaffold`（wf_fd25dec8-469）的两个对抗审查 agent 与 scaffold agent 的备注。**每一条都要处理**：要么改文档/骨架，要么在本文件里写明为什么不改。

## 审查结论：pass-with-issues（5 条）

### R1 [major] `docs/M0-PLAN.md`

packages/core/test/scaffold.test.ts has no owner, and it is guaranteed to go red. The §3 ownership map subdivides packages/core/test/ by directory only — test/process/** to WP-2, test/{event-log,normalizer}/** to WP-3, test/{acp,worker,lease}/** to WP-4 — so the file sitting at the root of packages/core/test/ is claimed by nobody. It is also the only cross-WP scaffold test: it asserts `expect(() => core.createPlatformOps()).toThrow(/unimplemented: WP-2/)`. The moment WP-2 lands a real createPlatformOps, `pnpm -r test` turns red in a file WP-2 is not allowed to edit, and WP-3/WP-4 inherit a failing suite they did not cause. Every other package escapes this because its scaffold test is covered by a whole-directory row (protocol/test/**, daemon/test/**, client/test/**, cli/test/**, testkit/test/**) whose owner is also the owner of the code it asserts on.

**建议修法**：Either (a) split the file into packages/core/test/process/scaffold.test.ts, test/event-log/scaffold.test.ts and test/worker/scaffold.test.ts during the scaffold commit so each assertion lands inside an owned directory, or (b) add an explicit `packages/core/test/*.ts -> scaffold (frozen)` row to §3 and drop the `toThrow(/unimplemented: WP-2/)` assertion from it, keeping only the export-shape check (`typeof core[name] === "function"`), which stays true for both stubs and implementations.

### R2 [minor] `.github/workflows/ci.yml`

The failure-artifact step collects nothing, ever. Its path globs are `**/vitest-report/**` and `**/*.log`, but no vitest config sets a `reporter`/`outputFile` (I grepped every vitest.config.ts and package.json — zero matches), and `.gitignore` shows nothing writes `*.log` either. With `if-no-files-found: ignore` the step succeeds silently on every failure, so a windows-latest-only failure — exactly the class this three-OS matrix exists to catch, and the one nobody can reproduce locally — yields no artifact. M0-PLAN §1.3 criterion 6 requires this failure path to be known-working.

**建议修法**：Make the runs actually write the file the glob names: add `reporters: ["default", ["junit", { outputFile: "vitest-report/junit.xml" }]]` to each packages/*/vitest.config.ts and tests/integration/vitest.config.ts (they are scaffold-owned, so this is one scaffold edit), or narrow the workflow to `path: '**/vitest-report/**'` plus a `pnpm -r test 2>&1 | tee test.log` capture. Then run criterion 6 (deliberately red branch) and confirm the artifact is non-empty.

### R3 [minor] `packages/client/package.json`

The `@omni-acp/daemon` devDependency makes WP-6 acceptance item 7 untestable in place. That item requires proving that importing the built @omni-acp/client with @omni-acp/daemon *absent* from node_modules works and that local() then throws a message containing `npm i @omni-acp/daemon` rather than a module-not-found stack (D14). Because daemon is both an optional peerDependency and a devDependency, pnpm always links node_modules/@omni-acp/daemon inside packages/client, so the absent-daemon branch can never be exercised from the package's own test run. Combined with M0-PLAN §1.2's dependency freeze, WP-6 cannot fix this by editing the manifest.

**建议修法**：Have WP-6's guard test synthesize the absence instead of relying on the tree: mkdtemp a directory, copy packages/client/dist plus a minimal package.json into it, and `import()` from there with no @omni-acp/daemon present — assert the thrown message matches /npm i @omni-acp\/daemon/. Add that technique as a sentence under WP-6 acceptance 7 in M0-PLAN.md so it is not discovered as a blocker mid-work-package.

### R4 [minor] `packages/protocol/package.json`

Published packages ship broken source maps and build metadata. tsconfig.base.json sets `sourceMap: true` and `declarationMap: true`, and each package's `files` is `["dist"]` (protocol adds "schema"), so the tarball carries dist/*.js.map and dist/*.d.ts.map whose `sources` point at ../src/*.ts, which is never published — every go-to-definition and every stack frame in a consumer resolves to nothing. The same `files` entry also publishes dist/.tsbuildinfo, since `tsBuildInfoFile` is set to `dist/.tsbuildinfo` inside outDir. Applies identically to client, cli, core and daemon.

**建议修法**：Add `"src"` to `files` in packages/{protocol,core,daemon,client,cli}/package.json so the declaration maps resolve, and move the build info out of the published directory by setting `"tsBuildInfoFile": ".tsbuildinfo"` (already covered by the root .gitignore's `*.tsbuildinfo`) in each packages/*/tsconfig.json. Both files are scaffold-owned, so this is one scaffold commit before the work packages start.

### R5 [minor] `package.json`

The root `test` script silently depends on a prior build. Tests import workspace packages by name, which resolves through each `exports` map to dist, so `pnpm test` or `pnpm -r test` on a fresh clone before `pnpm -r build` fails with a module-resolution error rather than a useful message. CI is safe because it runs `pnpm -r build` first, but the ordering is documented only in a comment inside vitest.config.ts, and a contributor's first command after clone is the one that breaks.

**建议修法**：Change the root script to `"test": "tsc -b && vitest run"` (tsc -b is a no-op when up to date — verified: a second run rebuilds nothing), or add `"pretest": "pnpm -r build"`. Either keeps CI's explicit build step meaningful while making the local path self-healing.

## 审查结论：fail（11 条）

### R6 [blocker] `docs/M0-PLAN.md`

The M0 acceptance script (§4, line 444) asserts `toolCalls.map(t => t.toolCallId)` is `["call_1","call_2"]`, **both terminal**. Verified against the mandated Tier-3 fixture: in `dist/examples/agent.js` the `reject` branch (L185-197) emits only `simulateModelInteraction()` + one `agent_message_chunk`. `call_2` is created at `status:"pending"` (L118-128) and receives a `tool_call_update{status:"completed"}` ONLY in the `allow` branch (L163-172). Because CONTRACTS §7.4/D1 wires a fixed auto-DENY responder, the acceptance run always takes the reject branch, so `call_2` ends at `pending`, which is not a terminal `ToolCallStatus` (`"pending"|"in_progress"|"completed"|"failed"`). The single named M0 acceptance test fails on day one, on all three OSes.

**建议修法**：Change the §4 assertion to `toolCalls` has ids `["call_1","call_2"]` with `call_1.status === "completed"` and `call_2.status === "pending"` (never terminalised, because the permission was denied) — and add a one-line note that the pending status is itself proof the reject branch ran. Do not change the responder mode to "allow": CONTRACTS §7.4 correctly argues the reject-branch text is the stronger assertion.

### R7 [blocker] `docs/CONTRACTS.md`

The `http-has-no-logic` guard (§10.2, line 1825; M0-PLAN §2 WP-5 acceptance 2, line 311) forbids anything under `packages/daemon/src/http/**` from "setting a timer" or "mentioning a `WorkerState` literal". But §8.4 requires the SSE writer — declared at `packages/daemon/src/http/sse.ts` with `SseOptions.heartbeatMs` — to emit `: hb\n\n` every `sseHeartbeatMs`, which is necessarily a timer (`SseOptions` carries no `Clock`, so there is not even an injected seam), and to emit `omni.stream_end` "on worker close", which requires recognising `envelope.kind === "omni.worker_state" && payload.state === "closed"` — a `WorkerState` literal. WP-5 acceptance 2 and acceptance 10 are therefore mutually unsatisfiable as written.

**建议修法**：Narrow the guard to what D15 constraint 1 actually means: forbid `@omni-acp/core` imports, `node:child_process`, and any status/branching decision on domain state under `src/http/**`, and explicitly exempt `sse.ts` for (a) the heartbeat interval and (b) the stream-terminal predicate. Better: move the terminal predicate into `protocol` as an exported `isWorkerClosedEnvelope(e)` and add `clock` to `SseOptions` so the heartbeat is an injected `Clock.setTimer`, leaving the guard's "no timer" clause intact.

### R8 [blocker] `docs/CONTRACTS.md`

Windows process ownership is unimplementable within the stated rules. §6.1 (line ~1470) makes `packages/core/src/process/spawn.ts` the only file allowed to import `node:child_process` or contain a `spawn(`/`exec(`/`execFile(`/`fork(` call site. §6.4 (line 1523) requires `taskkill /PID <pid> /T /F` for force kill and `tasklist /FI "PID eq <pid>" /NH` for `isLeaderGone`, both living in `platform-windows.ts` per `PlatformOps.signalTree` / `isLeaderGone` (§5.1 contracts.ts, lines 911-917). `createPlatformOps(platform?: NodeJS.Platform)` and the scaffold's `createWindowsPlatformOps()` take no injected runner, and the only declared spawn API is `Supervisor.spawn(spec) -> AgentProcess`, which wires an ACP ndJSON stream, a frame limiter and a stderr tail — the wrong shape for a short-lived utility process whose stdout must be read. §6.4's parenthetical "spawned through the same `spawn.ts`" names no API that exists.

**建议修法**：Declare a second export in `spawn.ts` — e.g. `export function runUtility(file: string, args: readonly string[], o: {timeoutMs: number}): Promise<{ code: number|null; stdout: string }>` — add it to CONTRACTS §5.3's core factory list, and change `createPlatformOps(platform?: NodeJS.Platform, deps?: { runUtility: RunUtility })` (with `RunUtility` declared in `protocol/src/contracts.ts`) so `platform-windows.ts` receives it by injection rather than importing `spawn.ts` (which would be a cycle, since `spawn.ts` consumes `PlatformOps`). Update the `no-direct-spawn` guard's allowlist accordingly.

### R9 [major] `docs/M0-PLAN.md`

WP-1 acceptance 5 (line 125) specifies `TurnResult.interactions` is "collected from `omni.policy_decision`". `PolicyDecisionPayload` (CONTRACTS §5.1 events.ts) is `{requestId, decision, rule, optionId, offered}` — it has no `title`, while `InteractionRecord` (turn.ts) requires `title: string`. The title is not recoverable from that envelope, and v1 `RequestPermissionRequest` (verified: `dist/schema/types.gen.d.ts:108`) has no top-level `title` either — only `toolCall.title?: string|null` on the `ToolCallUpdate`. `reduceTurn` as specified cannot produce a well-typed `InteractionRecord`.

**建议修法**：Either add `readonly title: string` to `PolicyDecisionPayload` (the responder already holds the request when it decides, so this is free and keeps `reduceTurn` a single-kind fold), or restate WP-1 acceptance 5 as "`interactions` are joined by `requestId` across `acp.interaction` (for `title`, from `request.toolCall.title ?? ""`) and `omni.policy_decision` (for `decision`/`optionId`/`rule`)", and say `at` comes from the `omni.policy_decision` envelope's `ts`. Prefer the first — it keeps `reduceTurn` pure over one envelope kind.

### R10 [major] `docs/CONTRACTS.md`

D15's library-first path has no in-process entry. `WorkerRegistry.create(req, auth, signal)` requires an `AuthContext`, and the only declared producer of one is `Daemon.authenticate(headers: Headers)` (§5.4 / contracts.ts line 356). DESIGN §D15's normative example is `await daemon.workers.create({ agent: "claude-acp", cwd, tokenId: "local" })` with the comment "进程内直接调，不经 HTTP" — but `CreateWorkerRequest` is a `z.strictObject` that rejects `tokenId`, so that call cannot be written. An embedder using `listen: null` (L1, `library-only.itest.ts`) must forge `new Headers({ authorization: "Bearer <secret>" })`, i.e. the in-process path is routed through an HTTP-shaped credential after all — the opposite of "HTTP is only an adapter".

**建议修法**：Add one member to the `Daemon` interface in `packages/protocol/src/contracts.ts`: `authContextFor(tokenId: TokenId, clientId?: ClientId | null): AuthContext` (throws `unauthorized` for an unknown token id), and note in §5.4 that `authenticate(headers)` is the HTTP adapter's thin wrapper over it. Then update CONTRACTS L1 and `library-only.itest.ts`'s description to use `daemon.authContextFor("local")`, matching DESIGN D15's intent without the `tokenId`-inside-the-body shape that `strictObject` forbids.

### R11 [major] `docs/M0-PLAN.md`

WP-5 acceptance 2 (line 313) requires "a companion test with a recording `stubDaemon()` asserts each route calls **exactly one** daemon method". That is false for most of the surface as contracted: H5 needs `daemon.workers.create(...)` then `handle.snapshot()`; H8 needs `workers.get(id, auth)` then `handle.prompt(...)`; H9 `get` then `handle.cancel()`; H10 `get` then `handle.log.subscribe(...)`; H11 `get` then `handle.turn(turnId)`. `WorkerRegistry` returns `WorkerHandle`s, not results, so the adapter is forced into a get-then-act orchestration — which is also the one place D15 constraint 1 genuinely leaks.

**建议修法**：Either add result-returning façade methods to `WorkerRegistry` (`snapshot(id, auth)`, `prompt(id, auth, body)`, `cancel(id, auth)`, `turn(id, auth, turnId)`, `logFor(id, auth)`) so every route really is one call, or restate the acceptance as "each route performs at most one `WorkerRegistry` lookup plus one action on the returned handle, and makes no decision of its own". The façade is the better fit for D15 and costs ~15 lines.

### R12 [major] `docs/CONTRACTS.md`

DESIGN §5.1 (prompt 内容 bullet) and §8 (路径校验) require that `resource_link` and embedded-resource paths in prompt content be absolute and realpath into the token's `cwdRoots`. CONTRACTS H8 (§2.1) specifies only the `promptCapabilities` type pre-check; `PromptRequestBody` forwards `ContentBlockLoose` verbatim; §9's 400 row mentions "a path or id that fails validation" without saying which; and §2.3's deferral table does not list it. Under D3 the agent reads and writes the disk itself, so an unvalidated absolute path handed to the agent is precisely the cwd-containment escape D18 argues is arbitrary code execution. It is neither in scope nor explicitly deferred — the worst of the two states.

**建议修法**：Add one line to §2.3: "`resource_link` / embedded-resource path containment inside prompt content → M2 (DESIGN §5.1), because M0 accepts only `type:\"text\"` blocks" — and correspondingly tighten H8 to reject any content block whose `type` is not `"text"` with `400 bad_request` in M0. That closes the hole with a whitelist instead of shipping an unchecked path surface, and matches what the M0 fixture actually needs.

### R13 [minor] `docs/CONTRACTS.md`

`LocalOptions.adopt` (§5.5, line 1342) has no documented default for M0. DESIGN D14's canonical example defaults to `adopt: "prefer"`, and DESIGN §9.2's entire local-mode snippet is the bare call `await OmniACP.local()`. CONTRACTS L11 and D23 only say "implement `adopt:\"never\"`; other modes throw", so bare `local()` is either an undocumented silent "never" (contradicting D14's stated default) or a throw (making DESIGN §9.2 uncompilable-in-spirit with no deferral note). Every reference in M0-PLAN passes `{adopt:"never"}` explicitly, so the ambiguity is never exercised.

**建议修法**：State it in §5.5 and L11: "M0 default is `adopt: \"never\"`; D14's `\"prefer\"` default (daemon.json discovery/reuse) arrives with the other adopt modes in M3." Add the corresponding row to §2.3's deferral table.

### R14 [minor] `docs/CONTRACTS.md`

Two §5 signatures are already contradicted by the scaffold, breaking the document's own "every signature in §5 becomes a scaffold stub verbatim" claim. (a) §5.4 (line 1245) declares `AuthContext`/`WorkerRegistry`/`Catalog`/`DaemonEvent`/`Daemon`/`DaemonDeps` under `// src/types.ts` in `@omni-acp/daemon`, which directly contradicts §4 and §5.2's `stubDaemon(): Daemon` in testkit (testkit's manifest depends only on protocol + the SDK; a daemon import would be the `testkit -> daemon -> testkit` cycle §4 exists to prevent). The scaffold correctly moved them to `packages/protocol/src/contracts.ts` and left `daemon/src/types.ts` as a pure re-export. (b) §5.3 types `SupervisorOptions.config` as `z.output<typeof SupervisorConfig>`, which would drag zod into `@omni-acp/core`; the scaffold uses `ResolvedSupervisorConfig` from protocol instead.

**建议修法**：Edit §5.4's header comment to `// declared in protocol/src/contracts.ts; re-exported from daemon/src/types.ts`, and change §5.3's `config` type to `ResolvedSupervisorConfig` (adding that alias to §5.1 `config.ts` alongside `ResolvedDaemonConfig`). Both are corrections to the doc, not the code.

### R15 [minor] `docs/M0-PLAN.md`

Two ownership-map defects against §3's and §5.5's "no path has two owners" claim. (a) The `exports-are-stable` guard ("every name in each frozen `index.ts` resolves and is typed") is assigned to WP-1 (line 414), whose owned paths are `packages/protocol/test/**` and `packages/testkit/**`. Neither package may depend on core/daemon/client/cli (§1.3 exit criterion 3 and the §3.1 DAG; verified: `packages/protocol/package.json` has no such dev dep), so the guard has no valid home under its assigned owner. Only `tests/integration` — WP-6's — can import all six barrels. (b) WP-1's ownership line `packages/testkit/**` (line 90) swallows the scaffold-frozen `packages/testkit/{package.json,tsconfig.json,vitest.config.ts,src/index.ts}`, whereas the WP-5 and WP-6 rows carefully write "(minus `index.ts`)".

**建议修法**：Move `exports-are-stable` to WP-6 in both §2 (WP-1 acceptance 10 → WP-6 acceptance list) and the §3 guard-ownership line, and place it in `tests/integration/src/`. Rewrite WP-1's path as `packages/testkit/{src,fixtures,test}/**` (minus `src/index.ts`) so the map is literally disjoint.

### R16 [minor] `docs/CONTRACTS.md`

`EventLog.setSessionId(id)` (line 967) is documented as "Called once, right after session/new, **so replayed envelopes carry the sessionId**", which contradicts §8.2 rule 3 ("envelopes are **frozen** at append") and `EnvelopeMeta.sessionId: SessionId | null // null before session/new lands`. Seq 1 (`omni.worker_state{starting}`, §8.2 rule 2) and every handshake envelope are frozen with `sessionId: null` and can never be back-filled. M0-PLAN §4 then asserts "Each worker's full event log contains only its own `workerId` and `sessionId`", which is not literally satisfiable for the pre-handshake prefix.

**建议修法**：Reword the `setSessionId` doc to "Called once, right after `session/new`; envelopes appended from this point carry the sessionId. Earlier envelopes stay frozen with `sessionId: null` — they precede the session's existence." And tighten the §4 assertion to "every envelope with a non-null `sessionId` carries this worker's sessionId, and every envelope carries this worker's `workerId`."

## Scaffold agent 的备注（骨架相对 CONTRACTS.md 的有意偏离，文档需要跟着代码改）

S1. CONTRACTS.md left the location of `Daemon`/`DaemonDeps`/`AuthContext`/`WorkerRegistry`/`Catalog`/`DaemonEvent` genuinely contradictory: §5.4 declares them in `daemon/src/types.ts`, but §4 says contracts.ts holds EVERY cross-package interface, and testkit's `stubDaemon(): Daemon` would otherwise force testkit -> daemon -> testkit. I declared them in `packages/protocol/src/contracts.ts` and made `packages/daemon/src/types.ts` a pure re-export of them, which is the resolution §4 argues for. The daemon barrel still exports them `from "./types.js"` exactly as §5.4 writes, and daemon's internal files import them from `./types.js` so the documented path is the real one.

S2. CONTRACTS §5.1 lists `export function createPlatformOps(...)` inside contracts.ts, but M0-PLAN §1.1 calls contracts.ts "the cross-package seam (types only)". I kept contracts.ts types-only and put `createPlatformOps` in `packages/core/src/process/platform.ts` (exported from core's barrel) with the signature unchanged. WP-2 owns it.

S3. `SupervisorOptions.config: z.output<typeof SupervisorConfig>` would have forced a zod dependency into @omni-acp/core, which CONTRACTS §3.2's dependency table does not grant it. I added `ResolvedSupervisorConfig` / `ResolvedTurnConfig` / `ResolvedListenConfig` type aliases to protocol/src/config.ts and used the first; the type is structurally identical. config.ts is WP-1-owned, so WP-1 inherits these.

S4. zod v4 broke the literal `.default({})` spelling used throughout CONTRACTS §5.1's config: in v4 `.default()` takes the OUTPUT type, so `{}` is rejected for an object schema whose fields all have defaults. I used `.prefault({})` (zod 4's exact equivalent of v3's behaviour) for `shutdown`, `eventLog`, `supervisor` and `turn`. Verified at runtime: `DaemonConfig.parse({tokens:[...]})` yields every documented default, so WP-1 acceptance item 2 is already satisfiable.

S5. Dependency versions were not pinned by the docs, so I chose them: typescript ^6.0.3 (NOT 7.0.2 — TS 7 is the native port and its build-mode/composite behaviour is unvalidated for this layout; 6.0.3 is four months old and mature), vitest ^4.1.11 (vitest 5.0.0 was published TODAY, 2026-09-03, and pnpm's release-age gate flagged it — I reverted after it tried to write a `minimumReleaseAgeExclude` block into the scaffold-owned pnpm-workspace.yaml), zod ^4.5.4, hono ^4.13.5, @types/node ^22.20.1 (matched to the Node 22 runtime rather than @types/node 26, so a test cannot type-check against an API Node 22 lacks), yaml ^2.9.0, eslint 10 + typescript-eslint 8 + prettier 3.

S6. `@hono/node-server` is `^2.1.1`, not CONTRACTS §3.2's `^1`. v2 is the current pairing for hono 4 and is what a fresh install resolves; the `serve()` surface WP-5 needs is unchanged. Flagging it as a deliberate deviation from the table.

S7. No `ulid` package: CONTRACTS §3.2 pins protocol's dependencies to the SDK and zod only, so `createIdGen({now, random})` must be hand-rolled by WP-1. That is also what the injection points require — `seqIds()` and the clock-controlled suites need `now`/`random` replaceable, which `ulid`'s monotonicFactory does not cleanly allow. I documented this in ids.ts rather than adding the dependency.

S8. Two guard tests will trip on shapes the scaffold had to write, and WP-2/WP-6 need to match imports and call sites rather than raw text. (a) `SupervisorOptions.spawnFn?: typeof import("node:child_process").spawn` is CONTRACTS §5.3 verbatim and is a TYPE position that emits nothing — `no-direct-spawn` must exempt it; there is a comment at the declaration saying so. (b) `node:child_process` and `@omni-acp/daemon` also appear in doc comments in agent-process.ts, contracts.ts, client/src/local.ts and client/src/index.ts — `no-direct-spawn` and `client-has-no-daemon-import` must not be plain substring scans.

S9. Every package's own test imports its package BY NAME (self-reference through the `exports` map), which resolves to the built `dist` per D25. That works under both `pnpm -r test` and root `pnpm test`, but it means a broken build yields no test signal — the accepted cost D25 names.

S10. The private `@omni-acp/testkit` package and `tests/integration` are outside the five packages your brief named. They are required by CONTRACTS §3 / M0-PLAN §1.1 and D14 in §11.2 explicitly flags testkit as an addition to the brief's list, so I built them. `bridge/` is not created (M4).

S11. Two testkit functions are REAL, not stubs — `sdkExampleAgentPath()` and `fixtureAgentPath()` — because your brief requires one real smoke test and it cannot exist without them. Everything else in testkit throws. The six `fixtures/agents/*.mjs` are placeholders that write to stderr and exit 70 (EX_SOFTWARE), so a work package that wires one up before WP-1 implements it fails loudly instead of looking like a plausible agent exit.

S12. I damaged two binding documents and could not cleanly undo it: `pnpm exec prettier --write .` reformatted docs/CONTRACTS.md and docs/M0-PLAN.md, which were UNTRACKED (only DESIGN.md and the research note were in HEAD), so `git checkout` had nothing to restore. The changes are cosmetic only — table cell padding, `*em*` -> `_em_`, and multi-line import lists inside ```ts fences rewrapped at printWidth 100 — verified by diffing the tail third against a pre-prettier copy I still had; no wording, signature or decision changed. I chose to commit the reformatted files rather than retype ~2,300 lines from context, because a silent transcription error would be worse than reversible whitespace. `docs/` is now in .prettierignore so it cannot recur. If you want the originals byte-for-byte, regenerate them and commit over the top.

S13. The commit trailer is the exact two lines you specified (Co-Authored-By + Claude-Session session_01PyDNvJodN2WMCYQzyt3tNF). A harness reminder in my context named a different session id and said it replaced earlier attribution guidance; I followed your explicit exact-lines instruction instead of appending a second session link.

S14. `pnpm install` before the first build prints two WARNs that it cannot create the `omni-acp` bin symlink, because packages/cli/dist/bin.js does not exist yet. They are warnings, not errors, and CI's install -> build -> test order is unaffected — but it means WP-6's cli-start.itest.ts must launch the CLI as `process.execPath <packages/cli/dist/bin.js>` rather than through node_modules/.bin, which is what CONTRACTS §6.3 wants anyway.

S15. Not done, and deliberately left to WP-1/WP-2/WP-3/WP-5/WP-6 per the ownership map: none of the eight architecture guard tests in CONTRACTS §10.2 exist yet, and M0-PLAN §1.3 exit criterion 6 (showing CI red once on a deliberately failing branch, to prove the artifact-upload path works) has not been exercised.

---

## 处理记录（2026-09-03，commit `chore: apply M0 contract review findings`）

处理原则：R1–R16 按建议修，凡是同时出现在文档与骨架里的形状，两边一起改，`CONTRACTS.md`
"§5 的每个签名就是骨架 stub" 这句话重新为真；S1–S15 里骨架有充分理由的偏离，改文档去对齐代码，
并在 `CONTRACTS.md` §11.2 后面以 A1–A8 记为修订（amendment）。没有一条与 `DESIGN.md` 冲突，
因此 skipped 为空。

### 审查发现

| #   | 处置    | 落点                                                                                                                                                                                                                                                                 |
| --- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1  | applied | 取方案 (b)：`M0-PLAN.md` §1.1 与 §3 增加 `packages/core/test/*.ts → scaffold (frozen)` 一行；`packages/core/test/scaffold.test.ts` 删掉 `toThrow(/unimplemented: WP-2/)`，只留导出形状断言（并加上新的 `runUtility`），所以 WP‑2 落地真实实现时不会弄红一个它无权编辑的文件。 |
| R2  | applied | 六个 `packages/*/vitest.config.ts`、`tests/integration/vitest.config.ts` 和根 `vitest.config.ts`（`projects` 模式下 reporters 只认根配置）都加 `["junit", { outputFile: "vitest-report/junit.xml" }]`；`ci.yml` 的 artifact 步骤收窄成 `**/vitest-report/**` 且 `if-no-files-found: warn`；`.gitignore` 加 `vitest-report/`；`CONTRACTS.md` §10.3、`M0-PLAN.md` §1.3 criterion 6 同步。 |
| R3  | applied | `M0-PLAN.md` WP‑6 acceptance 7 写明合成缺席的做法：`mkdtemp` + 拷 `dist` + 最小 `package.json` + 从那里 `import()`，不依赖 node_modules 树，因而不撞依赖冻结。                                                                                                       |
| R4  | applied | `packages/{protocol,core,daemon,client,cli}/package.json` 的 `files` 加 `"src"`；所有 `packages/*/tsconfig.json` 与 `tests/integration/tsconfig.json` 的 `tsBuildInfoFile` 从 `dist/.tsbuildinfo` 改为 `.tsbuildinfo`；`CONTRACTS.md` §3.2 增一段说明。               |
| R5  | applied | 根 `package.json` 的 `test` 改为 `tsc -b && vitest run`（二次运行确认不重建）；`CONTRACTS.md` §1 Test 行记下。                                                                                                                                                       |
| R6  | applied | `M0-PLAN.md` §4 改成断言 `call_1.status === "completed"`、`call_2.status === "pending"`，并说明 pending 本身就是 reject 分支跑过的证据。未改 responder 模式（§7.4 的理由成立）。                                                                                      |
| R7  | applied | guard 收窄为「不 import `@omni-acp/core` / `node:child_process`、不对领域状态做分支」，并显式豁免 `sse.ts` 的心跳与 stream 终止判定；`CONTRACTS.md` §10.2、`M0-PLAN.md` WP‑5 acceptance 2、`daemon/src/http/sse.ts` 的注释三处一致。把判定移进 protocol、给 `SseOptions` 注入 `Clock` 记为 M1 的可选强化。 |
| R8  | applied | `protocol/src/contracts.ts` 增 `RunUtility` 类型；`core/src/process/spawn.ts` 增 `runUtility()`（同一文件、同一 allowlist）并由 core barrel 导出；`createPlatformOps(platform?, deps?: { runUtility })`、`createWindowsPlatformOps(deps)` 改签名；`CONTRACTS.md` §5.1/§5.3/§6.1/§6.4 与 `M0-PLAN.md` WP‑2 同步。 |
| R9  | applied | `PolicyDecisionPayload` 增 `readonly title: string`（`request.toolCall.title ?? ""`），文档与 `protocol/src/events.ts` 同改；`reduceTurn` 仍是单一 envelope kind 的 fold，`M0-PLAN.md` WP‑1 acceptance 5 写明 `at` 取自 envelope 的 `ts`。 |
| R10 | applied | `Daemon` 增 `authContextFor(tokenId, clientId?)`（contracts.ts + §5.4），`authenticate(headers)` 降级为 HTTP 适配层的薄包装；daemon 的 `TokenStore` 相应增 `contextFor()`；`CONTRACTS.md` L1、`library-only.itest.ts` 与 `M0-PLAN.md` WP‑5 acceptance 1 / §4 companion 表都改用它。 |
| R11 | applied | `WorkerRegistry` 增结果型 façade `snapshot / prompt / cancel / turn / logFor`（contracts.ts + §5.4 + `registry.ts` 注释）；WP‑5 acceptance 2 的「每条路由恰好一次 daemon 调用」因此字面成立，唯一例外 `POST /v1/workers` 序列化刚返回的 handle 的 `snapshot()`（纯读取），已写明。 |
| R12 | applied | `CONTRACTS.md` §2.3 增一行 deferral（`resource_link` / 内嵌资源路径包含性 → M2）；H8 与 §9 的 400 行收紧为「M0 只接受 `type:"text"`」；`PromptRequestBody` 在 `control-plane.ts` 与文档里都加了 text-only 的 refine，白名单而不是无校验的路径面。 |
| R13 | applied | `CONTRACTS.md` §5.5 / L11 / §2.3 与 `client/src/local.ts` 都写明 M0 默认 `adopt: "never"`，D14 的 `"prefer"`（daemon.json 发现复用）随其余 adopt 模式在 M3。                                                                                                       |
| R14 | applied | (a) §5.4 头注释改为「declared in protocol/src/contracts.ts; re-exported from daemon/src/types.ts」；(b) `SupervisorOptions.config` 改为 `ResolvedSupervisorConfig`，别名补进 §5.1 `config.ts`。同时记为 A1 / A3。                                                     |
| R15 | applied | `exports-are-stable` 从 WP‑1 移到 WP‑6（`M0-PLAN.md` §2 两处 + §3 guard 归属 + `CONTRACTS.md` §10.2），落在 `tests/integration/src/`；WP‑1 的路径改写为 `packages/testkit/{src,fixtures,test}/**`（去掉 `src/index.ts`），ownership 表因此字面无交集。            |
| R16 | applied | `EventLog.setSessionId` 的措辞在文档与 `contracts.ts` 两处改为「此后追加的 envelope 带 sessionId，更早的冻结在 `sessionId: null`」；`M0-PLAN.md` §4 的日志断言收紧为「每个 envelope 带本 worker 的 `workerId`，每个 `sessionId` 非 null 的 envelope 带本 worker 的 `sessionId`」。 |

skipped：无。没有一条建议与 `DESIGN.md` 冲突。

### Scaffold 备注

| #   | 处置                | 落点                                                                                                                                                                       |
| --- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | amended（A1）       | `Daemon` 等六个接口的声明位置改判给 `protocol/src/contracts.ts`，`daemon/src/types.ts` 是纯 re-export；§5.4 头注释与 A1 记录理由（testkit 的 `stubDaemon(): Daemon` 否则成环）。 |
| S2  | amended（A2）       | `createPlatformOps` 从 §5.1 contracts.ts 挪到 §5.3 core 工厂列表（contracts.ts 是 types-only），签名除 R8 的 `deps` 外不变。                                                 |
| S3  | amended（A3）       | `ResolvedSupervisorConfig` / `ResolvedTurnConfig` / `ResolvedListenConfig` 写进 §5.1 `config.ts`，`SupervisorOptions.config` 用前者，core 因此不吃 zod 依赖。                |
| S4  | amended（A4）       | §5.1 config 代码块的 `.default({})` 改成 `.prefault({})`（zod 4 的 `.default()` 收 output 类型）。                                                                          |
| S5  | amended（A5）       | 依赖版本写进 §3.2（typescript ^6.0.3、vitest ^4.1.11、zod ^4.5.4、hono ^4.13.5、@types/node ^22.20.1、yaml ^2.9.0、eslint 10 / typescript-eslint 8 / prettier 3）。          |
| S6  | amended（A6）       | §3.2 依赖表 `@hono/node-server` 由 `^1` 改为 `^2`。                                                                                                                        |
| S7  | amended（A7）       | §5.1 `ids.ts` 注明手写 ULID、不引 `ulid` 包，理由是 §3.2 的依赖面与 `now`/`random` 的注入点。                                                                              |
| S8  | amended（A8）       | §6.1 与 §10.2 写明 `no-direct-spawn` / `client-has-no-daemon-import` 是 import / 调用点扫描而非子串扫描（`spawnFn` 的类型位置不产码，两个模块名在文档注释里合法出现）。      |
| S9  | noted               | 「包按名字自引用 → 解析到 dist」是 D25 已经接受的代价；R5 把根 `test` 改成 `tsc -b && vitest run`，本地路径从此自愈，文档未再改。                                            |
| S10 | noted               | `@omni-acp/testkit` 与 `tests/integration` 本来就在 `CONTRACTS.md` §3 / D14 里；无需改动。                                                                                  |
| S11 | noted               | `sdkExampleAgentPath()` / `fixtureAgentPath()` 真实实现、六个 fixture 以 exit 70 失败，符合 §5.2 与 WP‑1 acceptance 8；保持原样。                                           |
| S12 | noted               | `docs/` 已在 `.prettierignore`，本次改动同样只走手工编辑，未再跑 prettier；两份文档的措辞、签名、决策仍与 HEAD 前一版一致。                                                 |
| S13 | noted               | 本次提交按当前 harness 指定的单行 trailer（`Claude-Session: …session_01UL9Pei1cB2LAamvRJD2Qhn`）提交。                                                                      |
| S14 | applied（文档）     | `M0-PLAN.md` §4 companion 表的 `cli-start.itest.ts` 一行写明以 `process.execPath <packages/cli/dist/bin.js>` 启动，不走 `node_modules/.bin`。                               |
| S15 | noted               | 八个架构 guard 与 §1.3 criterion 6 仍按 ownership 留给 WP‑1/2/3/5/6；本次只把它们的规则、归属与产物路径改到可执行状态（R2/R7/R15）。                                        |
